import type postgres from "postgres";
import { normalizeEmailForAliasDedup, splitEmailForPolicy } from "@slipgate/contracts";
import { StoreError } from "./types.ts";

/**
 * Store side of the registration email guards (see auth_guards.ts for the policy): one inbox may
 * hold one self-registered account (alias identity: +tag, Gmail dots, googlemail.com, trailing
 * FQDN dot), and under the per-domain quota an unlisted registrable domain may hold one account.
 *
 * Postgres checks and inserts in one transaction under transaction-scoped advisory locks keyed by
 * the inbox identity (and the domain), so concurrent sign-ups of variants of one inbox, or of two
 * addresses at one quota domain, can't both pass: the second waits for the first to commit and
 * then sees its row. Both lookups are index probes (migration 0008: expression indexes on
 * commerce.email_alias_identity(email) and commerce.email_domain_rev(email)). The memory store
 * checks and inserts with no await in between.
 */

/** What registerUser enforces besides the exact-address uniqueness it always had. */
export interface RegistrationGuard {
  /** Registrable domain that must have no account yet (per-domain quota), or null. */
  domainLimit: string | null;
}

export type RegistrationConflict = "email_exists" | "email_alias_exists" | "email_domain_limit";

const CONFLICT_MESSAGES: Record<RegistrationConflict, string> = {
  email_exists: "Email is already registered",
  email_alias_exists: "An account already uses this mailbox (addresses differing only by +tag or Gmail dots are the same inbox)",
  email_domain_limit: "This email domain already has an account; it is not on the sign-up allowlist",
};

/** A refused registration; `reason` is the error code the routes answer with. */
export class RegistrationGuardError extends StoreError {
  constructor(readonly reason: RegistrationConflict) {
    super("conflict", CONFLICT_MESSAGES[reason]);
    this.name = "RegistrationGuardError";
  }
}

export function registrationConflictMessage(reason: RegistrationConflict): string {
  return CONFLICT_MESSAGES[reason];
}

/** Whether a stored address's domain is `domain` or one of its subdomains. */
function inDomain(email: string, domain: string): boolean {
  const d = splitEmailForPolicy(email)?.domain;
  return d !== undefined && (d === domain || d.endsWith(`.${domain}`));
}

/** The memory store's check over its users (call it and insert with no await in between). */
export function memoryRegistrationConflict(
  users: Iterable<{ email: string }>,
  email: string,
  guard: RegistrationGuard,
): RegistrationConflict | null {
  const exact = email.toLowerCase();
  const identity = normalizeEmailForAliasDedup(email);
  let alias = false;
  let domainTaken = false;
  for (const u of users) {
    const stored = u.email.toLowerCase();
    if (stored === exact) return "email_exists";
    if (!alias && normalizeEmailForAliasDedup(stored) === identity) alias = true;
    if (!domainTaken && guard.domainLimit && inDomain(stored, guard.domainLimit)) domainTaken = true;
  }
  if (alias) return "email_alias_exists";
  if (domainTaken) return "email_domain_limit";
  return null;
}

/**
 * Same statements as migrations/commerce/0008_auth_guards.sql, applied at startup. The functions
 * are created only when missing (no catalog churn, no race between replicas starting together):
 * a change to either body must ship under a new function name with a new index.
 */
export const PG_AUTH_GUARDS_SCHEMA_SQL = `
DO $guard$
BEGIN
  IF to_regprocedure('commerce.email_alias_identity(text)') IS NULL THEN
    EXECUTE $create$
      CREATE FUNCTION commerce.email_alias_identity(addr text) RETURNS text
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
        SELECT CASE
                 WHEN s.at = 0 OR s.loc = '' OR s.dom = '' OR position('@' IN s.dom) > 0 THEN s.e
                 WHEN s.dom IN ('gmail.com', 'googlemail.com')
                   THEN COALESCE(NULLIF(replace(s.base, '.', ''), ''), s.base) || '@gmail.com'
                 ELSE s.base || '@' || s.dom
               END
          FROM (
            SELECT t.e, t.at, t.loc,
                   CASE WHEN t.at > 0 THEN rtrim(substr(t.e, t.at + 1), '.') ELSE '' END AS dom,
                   CASE WHEN position('+' IN t.loc) > 1 THEN substr(t.loc, 1, position('+' IN t.loc) - 1) ELSE t.loc END AS base
              FROM (
                SELECT u.e, u.at, CASE WHEN u.at > 0 THEN substr(u.e, 1, u.at - 1) ELSE '' END AS loc
                  FROM (SELECT lower(btrim(addr, E' \\t\\r\\n')) AS e, position('@' IN lower(btrim(addr, E' \\t\\r\\n'))) AS at) u
              ) t
          ) s
      $fn$
    $create$;
  END IF;
  IF to_regprocedure('commerce.email_domain_rev(text)') IS NULL THEN
    EXECUTE $create$
      CREATE FUNCTION commerce.email_domain_rev(addr text) RETURNS text
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
        SELECT reverse(rtrim(split_part(lower(btrim(addr, E' \\t\\r\\n')), '@', 2), '.'))
      $fn$
    $create$;
  END IF;
END
$guard$;

CREATE INDEX IF NOT EXISTS idx_commerce_users_email_alias
    ON commerce.users (commerce.email_alias_identity(email));
CREATE INDEX IF NOT EXISTS idx_commerce_users_email_domain_rev
    ON commerce.users (commerce.email_domain_rev(email) text_pattern_ops);
`;

/** Two-int advisory lock spaces (distinct from postgres_ops.ts' 74_210_036 and the settlement key). */
const ALIAS_LOCK_SPACE = 74_210_041;
const DOMAIN_LOCK_SPACE = 74_210_042;

type Sql = ReturnType<typeof postgres>;

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The Postgres check. With `lock` (inside registerUser's transaction) it first takes the identity
 * lock and, under a domain quota, the domain lock (always in that order, so two sign-ups can't
 * wait on each other), then reads.
 */
export async function pgRegistrationConflict(
  sql: Sql,
  email: string,
  guard: RegistrationGuard,
  lock: boolean,
): Promise<RegistrationConflict | null> {
  if (lock) {
    await sql`SELECT pg_advisory_xact_lock(${ALIAS_LOCK_SPACE}::int, hashtext(commerce.email_alias_identity(${email}::text)))`;
    if (guard.domainLimit) await sql`SELECT pg_advisory_xact_lock(${DOMAIN_LOCK_SPACE}::int, hashtext(${guard.domainLimit}::text))`;
  }
  const rows = await sql<{ email: string }[]>`
    SELECT email FROM commerce.users
     WHERE commerce.email_alias_identity(email) = commerce.email_alias_identity(${email}::text)
     LIMIT 20
  `;
  const exact = email.toLowerCase();
  if (rows.some((r) => r.email.toLowerCase() === exact)) return "email_exists";
  if (rows.length > 0) return "email_alias_exists";
  if (guard.domainLimit) {
    const reversed = [...guard.domainLimit.toLowerCase()].reverse().join("");
    const taken = await sql<{ one: number }[]>`
      SELECT 1 AS one FROM commerce.users
       WHERE commerce.email_domain_rev(email) = ${reversed}
          OR commerce.email_domain_rev(email) LIKE ${`${escapeLike(reversed)}.%`} ESCAPE '\\'
       LIMIT 1
    `;
    if (taken.length > 0) return "email_domain_limit";
  }
  return null;
}
