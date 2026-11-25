import type { MiddlewareHandler } from "hono";
import type { AuthSessionResponse, UserProfile, UserRole } from "@slipgate/contracts";
import { PasswordAttemptGuard } from "../security/attempts.ts";
import { signJwt, verifyJwt, verifyPasswordOrDummy, type JwtClaims } from "../security/crypto.ts";
import type { SessionState } from "../store/ops_types.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

async function sha256Hex(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isGroupManagerAllowedRequest(method: string, path: string): boolean {
  if (method === "GET") {
    if (
      path === "/api/v1/admin/groups" ||
      path === "/api/v1/admin/accounts" ||
      path === "/api/v1/admin/users" ||
      path === "/api/v1/admin/usage" ||
      path === "/api/v1/admin/usage/query" ||
      path === "/api/v1/admin/usage/stats"
    ) {
      return true;
    }
    return /^\/api\/v1\/admin\/groups\/[^/]+$/.test(path);
  }
  if (method === "PATCH") {
    return /^\/api\/v1\/admin\/groups\/[^/]+$/.test(path);
  }
  return false;
}

export interface AuthEnv {
  Variables: {
    /** Verified token claims, with `role` and `email` replaced by the user's current values. */
    authUser: JwtClaims;
  };
}

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/**
 * How long one token's session state (user role/status/token version, denylist hit) is reused
 * before the store is read again. Writes made through this process invalidate it immediately; the
 * TTL only bounds how long a change made by another process (or a restore) takes to apply.
 */
export const SESSION_STATE_TTL_MS = 5_000;
const MAX_CACHED_SESSIONS = 10_000;

export interface SessionRejection {
  status: 401;
  error: "unauthorized" | "session_revoked" | "account_suspended";
  message: string;
}

/** An access token for `user` at its current token version (or `tokenVersion`, when the caller just set it). */
export async function issueAccessToken(
  store: ControlStore,
  jwtSecret: string,
  user: { id: string; email: string; role: UserRole },
  tokenVersion?: number,
): Promise<{ token: string; expiresAtIso: string; claims: JwtClaims }> {
  let ver = tokenVersion;
  if (ver === undefined) {
    const state = await store.ops.getSessionState(user.id);
    if (!state.user) throw new StoreError("not_found", "User no longer exists");
    ver = state.user.tokenVersion;
  }
  return signJwt({ sub: user.id, email: user.email, role: user.role, ver }, jwtSecret);
}

/**
 * Console sessions: issuing, per-request validation and revocation.
 *
 * Every authenticated request re-checks its token against the store: the user must still exist
 * and be active, the token's version must equal the user's current token version, and the token id
 * must not have been signed out. The role (and email) handlers see come from the store, never from
 * the token, so a demotion applies to the next request. The state is cached per token for
 * SESSION_STATE_TTL_MS and dropped at once by `invalidate()` after any write that changes it.
 *
 * Logout semantics: `revoke()` (POST /api/v1/auth/logout) ends only the presented token, through a
 * per-token denylist kept until the token expires; `revokeAll()` (sign out of all devices) bumps
 * the token version, which ends every token of the user at once.
 */
export class SessionManager {
  /** jti -> cached lookup (the promise is shared by concurrent requests of the same token). */
  private readonly cache = new Map<string, { userId: string; at: number; state: Promise<SessionState> }>();
  /** Failed-password limits shared by sign-in and every authenticated password check. */
  readonly attempts: PasswordAttemptGuard;

  constructor(
    private readonly store: ControlStore,
    private readonly jwtSecret: string,
    private readonly opts: { cacheTtlMs?: number; attempts?: PasswordAttemptGuard } = {},
  ) {
    this.attempts = opts.attempts ?? new PasswordAttemptGuard();
  }

  private sessionState(userId: string, jti: string): Promise<SessionState> {
    const now = Date.now();
    const ttl = this.opts.cacheTtlMs ?? SESSION_STATE_TTL_MS;
    const hit = this.cache.get(jti);
    if (hit && hit.userId === userId && now - hit.at < ttl) return hit.state;
    if (hit) this.cache.delete(jti);
    while (this.cache.size >= MAX_CACHED_SESSIONS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    const state = this.store.ops.getSessionState(userId, jti);
    const entry = { userId, at: now, state };
    this.cache.set(jti, entry);
    // A failed lookup is never cached (the request itself fails closed with the error).
    state.catch(() => {
      if (this.cache.get(jti) === entry) this.cache.delete(jti);
    });
    return state;
  }

  /** The request's current claims, or why its bearer token is refused. */
  async authenticate(authorization: string | undefined): Promise<{ claims: JwtClaims } | { rejection: SessionRejection }> {
    const reject = (error: SessionRejection["error"], message: string) => ({ rejection: { status: 401 as const, error, message } });
    const token = extractBearer(authorization);
    if (!token) return reject("unauthorized", "Missing bearer token");
    const claims = await verifyJwt(token, this.jwtSecret);
    if (!claims) return reject("unauthorized", "Invalid or expired token");
    const { user, revoked } = await this.sessionState(claims.sub, claims.jti);
    if (!user) return reject("unauthorized", "User no longer exists");
    if (revoked) return reject("session_revoked", "This session was signed out");
    // 401 (not 403) so the console drops the session, the same as an expired token.
    if (user.status !== "active") return reject("account_suspended", "Account is suspended");
    if (user.tokenVersion !== claims.ver) return reject("session_revoked", "This session has ended, sign in again");
    return {
      claims: {
        ...claims,
        role: user.role,
        email: user.email,
        managedGroupIds: user.managedGroupIds ?? [],
        authKind: "jwt",
      },
    };
  }

  /** Any signed-in, active user. */
  requireAuth(): MiddlewareHandler<AuthEnv> {
    return async (c, next) => {
      const result = await this.authenticate(c.req.header("Authorization"));
      if ("rejection" in result) {
        return c.json({ error: result.rejection.error, message: result.rejection.message }, result.rejection.status);
      }
      c.set("authUser", result.claims);
      await next();
    };
  }

  /** A signed-in, active user whose current role (from the store) is admin. */
  requireAdmin(): MiddlewareHandler<AuthEnv> {
    return async (c, next) => {
      const authHeader = c.req.header("Authorization");
      const adminApiKey = c.req.header("X-Admin-Api-Key")?.trim();
      if (!authHeader && adminApiKey) {
        const keyRecord = await this.store.userAttributes.findActiveAdminApiKeyByHash(await sha256Hex(adminApiKey));
        if (!keyRecord) {
          return c.json({ error: "unauthorized", message: "Invalid or expired admin API key" }, 401);
        }
        const owner = await this.store.getUserById(keyRecord.userId);
        if (!owner || owner.role !== "admin") {
          return c.json({ error: "unauthorized", message: "Admin API key owner is not an administrator" }, 401);
        }
        if (owner.status !== "active") {
          return c.json({ error: "account_suspended", message: "Account suspended" }, 403);
        }
        void this.store.userAttributes.touchAdminApiKeyLastUsed(keyRecord.id).catch(() => undefined);
        const nowSec = Math.floor(Date.now() / 1000);
        c.set("authUser", {
          sub: owner.id,
          email: owner.email,
          role: "admin",
          ver: 0,
          jti: keyRecord.id,
          iat: nowSec,
          exp: nowSec + 300,
          authKind: "admin_api_key",
        });
        await next();
        return;
      }

      const result = await this.authenticate(authHeader);
      if ("rejection" in result) {
        return c.json({ error: result.rejection.error, message: result.rejection.message }, result.rejection.status);
      }
      if (result.claims.role === "group_manager" && isGroupManagerAllowedRequest(c.req.method, c.req.path)) {
        c.set("authUser", result.claims);
        await next();
        return;
      }
      if (result.claims.role !== "admin") {
        return c.json({ error: "forbidden", message: "Administrator role required" }, 403);
      }
      c.set("authUser", result.claims);
      await next();
    };
  }

  /** Drops cached session state of these users; call after any write to their role, status, password or token version. */
  invalidate(...userIds: string[]): void {
    if (userIds.length === 0) return;
    const ids = new Set(userIds);
    for (const [jti, entry] of this.cache) if (ids.has(entry.userId)) this.cache.delete(jti);
  }

  /**
   * Re-checks a signed-in user's password (change password, two-factor setup / disable, audit-log
   * clear, credential export) under the per-user attempt limit, so a stolen session can't be turned
   * into an unlimited password oracle. The attempt is reserved before the hash is read, so
   * concurrent guesses can't outrun the count. `ip` is the request's clientIp().
   * `retryAfterSeconds` is set when the check was refused without looking at the password.
   */
  async confirmPassword(
    userId: string,
    ip: string,
    password: string,
  ): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number | null }> {
    const start = this.attempts.beginSessionCheck(userId, ip);
    if (!start.ok) return { ok: false, retryAfterSeconds: start.retryAfterSeconds };
    const ok = await start.attempt.run(async () => verifyPasswordOrDummy(password, await this.store.ops.getPasswordHash(userId)));
    return ok ? { ok: true } : { ok: false, retryAfterSeconds: null };
  }

  /**
   * A signed-in session for `user` (sign-in, registration, setup, password change). Pass the token
   * version that was read together with the credential just checked (sign-in) or just written
   * (password change, sign-out-everywhere): a session must never be signed at a version newer than
   * the password it was granted for.
   */
  async issue(user: UserProfile, tokenVersion?: number): Promise<AuthSessionResponse> {
    const { token, expiresAtIso } = await issueAccessToken(this.store, this.jwtSecret, user, tokenVersion);
    return { accessToken: token, expiresAtIso, user };
  }

  /**
   * Server-side logout of the presented token (denylisted until it expires). Idempotent: a token
   * that is already expired or invalid has nothing left to sign out. False when no token was sent.
   */
  async logout(authorization: string | undefined): Promise<boolean> {
    const token = extractBearer(authorization);
    if (!token) return false;
    const claims = await verifyJwt(token, this.jwtSecret);
    if (!claims) return true;
    await this.store.ops.revokeToken(claims.jti, claims.sub, new Date(claims.exp * 1000).toISOString());
    this.cache.delete(claims.jti);
    return true;
  }

  /** Sign out of all devices: bumps the token version (ending every token) and returns the new version. */
  async revokeAll(userId: string): Promise<number> {
    const version = await this.store.ops.bumpTokenVersion(userId);
    this.invalidate(userId);
    if (version === null) throw new StoreError("not_found", "User no longer exists");
    return version;
  }
}
