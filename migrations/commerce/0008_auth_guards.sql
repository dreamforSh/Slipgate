-- Lane A1. Idempotent DDL (IF NOT EXISTS / guarded DO blocks); the BFF applies the same statements at startup.
-- May touch any schema; files run in compose mount order.
--
-- Registration email guards (services/bff-ts/src/store/auth_guards_store.ts PG_AUTH_GUARDS_SCHEMA_SQL):
--   * commerce.email_alias_identity(email): the "inbox identity" used to refuse a second
--     self-registration of one mailbox (lower-cased, trailing FQDN dot dropped, "+tag" stripped when
--     something precedes the "+", Gmail / googlemail.com local dots removed and the domain folded to
--     gmail.com). Mirrors normalizeEmailForAliasDedup in packages/contracts/src/auth_guards.ts.
--   * commerce.email_domain_rev(email): the reversed, lower-cased mail domain, so "this registrable
--     domain or any subdomain of it" is an index prefix probe (per-domain sign-up quota).
-- Both are expression indexes only: stored addresses are unchanged and existing rows (even ones
-- that are already aliases of each other) stay valid; registration serialises on advisory locks.
-- The functions are created when missing only; a body change must ship under a new name + index.
-- Everything else of this lane (captcha config, sign-up allowlist, login agreement documents,
-- backend mode) lives in the commerce.portal_settings JSON blobs and needs no DDL.

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
                  FROM (SELECT lower(btrim(addr, E' \t\r\n')) AS e, position('@' IN lower(btrim(addr, E' \t\r\n'))) AS at) u
              ) t
          ) s
      $fn$
    $create$;
  END IF;
  IF to_regprocedure('commerce.email_domain_rev(text)') IS NULL THEN
    EXECUTE $create$
      CREATE FUNCTION commerce.email_domain_rev(addr text) RETURNS text
        LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
        SELECT reverse(rtrim(split_part(lower(btrim(addr, E' \t\r\n')), '@', 2), '.'))
      $fn$
    $create$;
  END IF;
END
$guard$;

CREATE INDEX IF NOT EXISTS idx_commerce_users_email_alias
    ON commerce.users (commerce.email_alias_identity(email));
CREATE INDEX IF NOT EXISTS idx_commerce_users_email_domain_rev
    ON commerce.users (commerce.email_domain_rev(email) text_pattern_ops);
