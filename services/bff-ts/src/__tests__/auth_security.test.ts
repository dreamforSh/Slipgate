import { describe, expect, it } from "bun:test";
import { configuredPublicBaseUrl, type AuditLogItem, type AuthSessionResponse, type PublicSettings } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import type { MailMessage } from "../mail/smtp.ts";
import { SessionManager } from "../middleware/auth.ts";
import { FailureLimiter, PasswordAttemptGuard } from "../security/attempts.ts";
import { parseCidr, parseTrustedProxies, rateLimitBucket, resolveClientIp } from "../security/client_ip.ts";
import { hashPassword, signJwt, verifyJwt } from "../security/crypto.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";

/**
 * Sessions and authentication hardening: per-request session validation and token versions
 * (F04 / G13), server-side logout and sign-out-everywhere, trusted-proxy client addresses (F14),
 * password-attempt limits (F15), reset links from the configured URL only (F03) and the race-free
 * last-admin guard (F35). Runs against Postgres too when a test preload installs a store factory.
 */

type StoreFactory = () => Promise<ControlStore>;
const storeFactory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;

const JSON_HEADERS = { "Content-Type": "application/json" };
const JWT_SECRET = "auth-security-jwt-secret-32-bytes-min";
const ADMIN_PASSWORD = "AdminPassword123!";
const USER_PASSWORD = "UserPassword123!";

/** The socket peer as Bun.serve reports it (requests from app.request() have none otherwise). */
const fromPeer = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 40000 }) });

async function bootstrap(opts: { mail?: MailMessage[] } = {}) {
  const store = storeFactory ? await storeFactory() : new MemoryControlStore();
  const app = createBffApp({
    store,
    jwtSecret: JWT_SECRET,
    vaultSecret: "auth-security-vault-secret-32-bytes-m",
    mailDelivery: opts.mail
      ? async (_cfg, msg) => {
          opts.mail!.push(msg);
        }
      : undefined,
  });
  const call = async <T = Record<string, unknown>>(
    method: string,
    path: string,
    init: { token?: string; body?: unknown; headers?: Record<string, string>; peer?: string } = {},
  ) => {
    const headers: Record<string, string> = { ...JSON_HEADERS, ...(init.headers ?? {}) };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    const res = await app.request(
      path,
      { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
      init.peer ? fromPeer(init.peer) : undefined,
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T, headers: res.headers };
  };
  const init = await call<AuthSessionResponse>("POST", "/api/v1/setup/initialize", {
    body: { siteName: "Auth Test", adminEmail: "admin@auth.test", adminPassword: ADMIN_PASSWORD, allowRegistration: true },
  });
  expect(init.status).toBe(201);
  const admin = init.body.accessToken;
  const login = (email: string, password: string, extra: { peer?: string; headers?: Record<string, string> } = {}) =>
    call<AuthSessionResponse & { error?: string }>("POST", "/api/v1/auth/login", { body: { email, password }, ...extra });
  const register = async (email: string) => {
    const res = await call<AuthSessionResponse>("POST", "/api/v1/auth/register", { body: { email, password: USER_PASSWORD } });
    expect(res.status).toBe(201);
    return res.body;
  };
  const createAdmin = async (email: string) => {
    const res = await call<{ user: { id: string } }>("POST", "/api/v1/admin/users", {
      token: admin,
      body: { email, password: ADMIN_PASSWORD, role: "admin" },
    });
    expect(res.status).toBe(201);
    const session = await login(email, ADMIN_PASSWORD);
    expect(session.status).toBe(200);
    return { id: res.body.user.id, token: session.body.accessToken };
  };
  const me = async (token: string) => (await call<{ error?: string }>("GET", "/api/v1/auth/me", { token })).status;
  return { store, app, call, admin, login, register, createAdmin, me };
}

/** An HS256 token with an arbitrary payload, signed with the app's secret. */
async function forge(payload: Record<string, unknown>): Promise<string> {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
  const head = b64(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64(sig)}`;
}

describe("access tokens", () => {
  it("carry a token version and a unique id, and tokens without them are refused", async () => {
    const a = await signJwt({ sub: "usr_1", email: "a@x.test", role: "user", ver: 3 }, JWT_SECRET);
    const b = await signJwt({ sub: "usr_1", email: "a@x.test", role: "user", ver: 3 }, JWT_SECRET);
    expect(a.claims.ver).toBe(3);
    expect(a.claims.jti).not.toBe(b.claims.jti);
    expect((await verifyJwt(a.token, JWT_SECRET))?.jti).toBe(a.claims.jti);

    const now = Math.floor(Date.now() / 1000);
    const base = { sub: "usr_1", email: "a@x.test", role: "user", iat: now, exp: now + 600 };
    expect(await verifyJwt(await forge(base), JWT_SECRET)).toBeNull();
    expect(await verifyJwt(await forge({ ...base, ver: 0 }), JWT_SECRET)).toBeNull();
    expect(await verifyJwt(await forge({ ...base, jti: "0123456789abcdef0123" }), JWT_SECRET)).toBeNull();
    expect(await verifyJwt(await forge({ ...base, ver: -1, jti: "0123456789abcdef0123" }), JWT_SECRET)).toBeNull();
    expect(await verifyJwt(await forge({ ...base, ver: 0, jti: "0123456789abcdef0123" }), JWT_SECRET)).not.toBeNull();
    expect(await verifyJwt(`${"a".repeat(5000)}.b.c`, JWT_SECRET)).toBeNull();
  });

  it("a validly signed token for an older token version is refused by the API", async () => {
    const t = await bootstrap();
    const bob = await t.register("bob@auth.test");
    const now = Math.floor(Date.now() / 1000);
    const legacy = await forge({ sub: bob.user.id, email: bob.user.email, role: "user", iat: now, exp: now + 600 });
    expect(await t.me(legacy)).toBe(401);
    expect(await t.me(bob.accessToken)).toBe(200);
  });
});

describe("per-request session validation (F04)", () => {
  it("a suspended admin's token stops working at once and cannot reactivate itself", async () => {
    const t = await bootstrap();
    const b = await t.createAdmin("b@auth.test");
    expect((await t.call("GET", "/api/v1/admin/users", { token: b.token })).status).toBe(200);

    expect((await t.call("PATCH", `/api/v1/admin/users/${b.id}`, { token: t.admin, body: { status: "suspended" } })).status).toBe(200);
    const refused = await t.call<{ error: string }>("GET", "/api/v1/admin/users", { token: b.token });
    expect(refused.status).toBe(401);
    // The self-restore of the finding: B's old token can no longer reach the admin API.
    expect((await t.call("PATCH", `/api/v1/admin/users/${b.id}`, { token: b.token, body: { status: "active" } })).status).toBe(401);
    expect((await t.call("POST", "/api/v1/admin/users", { token: b.token, body: { email: "x@auth.test", password: ADMIN_PASSWORD, role: "admin" } })).status).toBe(401);
    // Suspended users are refused on the self-service API too.
    expect((await t.call("GET", "/api/v1/user/wallet", { token: b.token })).status).toBe(401);

    // Reactivation does not revive tokens issued before the suspension.
    await t.call("PATCH", `/api/v1/admin/users/${b.id}`, { token: t.admin, body: { status: "active" } });
    expect((await t.call("GET", "/api/v1/admin/users", { token: b.token })).status).toBe(401);
    expect((await t.login("b@auth.test", ADMIN_PASSWORD)).status).toBe(200);
  });

  it("a demoted admin loses the admin API at once, and a deleted admin can create nobody", async () => {
    const t = await bootstrap();
    const b = await t.createAdmin("b@auth.test");
    await t.call("PATCH", `/api/v1/admin/users/${b.id}`, { token: t.admin, body: { role: "user" } });
    expect((await t.call("PATCH", `/api/v1/admin/users/${b.id}`, { token: b.token, body: { role: "admin" } })).status).toBe(401);
    const relogin = await t.login("b@auth.test", ADMIN_PASSWORD);
    // A fresh session takes the role from the store: user, so the admin API answers 403.
    expect(relogin.body.user.role).toBe("user");
    expect((await t.call("GET", "/api/v1/admin/users", { token: relogin.body.accessToken })).status).toBe(403);
    expect((await t.call("GET", "/api/v1/user/wallet", { token: relogin.body.accessToken })).status).toBe(200);

    const c = await t.createAdmin("c@auth.test");
    expect((await t.call("DELETE", `/api/v1/admin/users/${c.id}`, { token: t.admin })).status).toBe(200);
    const created = await t.call("POST", "/api/v1/admin/users", { token: c.token, body: { email: "y@auth.test", password: ADMIN_PASSWORD, role: "admin" } });
    expect(created.status).toBe(401);
    expect(await t.me(c.token)).toBe(401);
  });

  it("bulk suspension and an admin password reset end the user's sessions; other edits do not", async () => {
    const t = await bootstrap();
    const alice = await t.register("alice@auth.test");
    const bob = await t.register("bob@auth.test");
    await t.call("PATCH", `/api/v1/admin/users/${alice.user.id}`, { token: t.admin, body: { notes: "vip", username: "Alice" } });
    expect(await t.me(alice.accessToken)).toBe(200);

    await t.call("PATCH", `/api/v1/admin/users/${alice.user.id}`, { token: t.admin, body: { password: "ResetByAdmin123" } });
    expect(await t.me(alice.accessToken)).toBe(401);

    const batch = await t.call<{ changed: number }>("POST", "/api/v1/admin/users/batch-status", {
      token: t.admin,
      body: { userIds: [bob.user.id], status: "suspended" },
    });
    expect(batch.body.changed).toBe(1);
    expect(await t.me(bob.accessToken)).toBe(401);
    await t.call("POST", "/api/v1/admin/users/batch-status", { token: t.admin, body: { userIds: [bob.user.id], status: "active" } });
    expect(await t.me(bob.accessToken)).toBe(401);
    expect((await t.login("bob@auth.test", USER_PASSWORD)).status).toBe(200);
  });

  it("caches session state briefly, and invalidate() applies a change at once", async () => {
    const store = new MemoryControlStore();
    await store.initializeSetup(
      { siteName: "Cache", adminEmail: "root@cache.test", adminPassword: ADMIN_PASSWORD, allowRegistration: true },
      await hashPassword(ADMIN_PASSWORD),
    );
    const user = await store.registerUser("u@cache.test", await hashPassword(USER_PASSWORD));
    const sessions = new SessionManager(store, JWT_SECRET, { cacheTtlMs: 60 });
    const session = await sessions.issue(user);
    const auth = () => sessions.authenticate(`Bearer ${session.accessToken}`);
    expect("claims" in (await auth())).toBe(true);

    // A write made elsewhere (another process) shows up once the short TTL runs out.
    await store.ops.setUsersStatus([user.id], "suspended");
    expect("claims" in (await auth())).toBe(true);
    await Bun.sleep(80);
    const after = await auth();
    expect("rejection" in after && after.rejection.error).toBe("account_suspended");

    // A write made through this process invalidates at once.
    await store.ops.setUsersStatus([user.id], "active");
    const fresh = await sessions.issue(user);
    const authFresh = () => sessions.authenticate(`Bearer ${fresh.accessToken}`);
    expect("claims" in (await authFresh())).toBe(true);
    await store.ops.bumpTokenVersion(user.id);
    sessions.invalidate(user.id);
    const revoked = await authFresh();
    expect("rejection" in revoked && revoked.rejection.error).toBe("session_revoked");
  });
});

describe("logout, sign-out everywhere and password changes (G13)", () => {
  it("logout revokes only the presented token, server-side", async () => {
    const t = await bootstrap();
    await t.register("dana@auth.test");
    const laptop = (await t.login("dana@auth.test", USER_PASSWORD)).body.accessToken;
    const phone = (await t.login("dana@auth.test", USER_PASSWORD)).body.accessToken;

    const out = await t.call<{ loggedOut: boolean }>("POST", "/api/v1/auth/logout", { token: laptop });
    expect(out.status).toBe(200);
    expect(out.body.loggedOut).toBe(true);
    const refused = await t.call<{ error: string }>("GET", "/api/v1/auth/me", { token: laptop });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("session_revoked");
    expect(await t.me(phone)).toBe(200);

    // Idempotent: the same (or an expired / garbled) token signs out without error.
    expect((await t.call("POST", "/api/v1/auth/logout", { token: laptop })).status).toBe(200);
    expect((await t.call("POST", "/api/v1/auth/logout", { token: "not.a.token" })).status).toBe(200);
    expect((await t.call("POST", "/api/v1/auth/logout")).status).toBe(401);
  });

  it("sign out of all devices ends every session, optionally keeping this one", async () => {
    const t = await bootstrap();
    await t.register("erin@auth.test");
    const a = (await t.login("erin@auth.test", USER_PASSWORD)).body.accessToken;
    const b = (await t.login("erin@auth.test", USER_PASSWORD)).body.accessToken;

    const kept = await t.call<{ revoked: boolean; session: AuthSessionResponse | null }>("POST", "/api/v1/user/sessions/revoke-all", {
      token: a,
      body: { keepCurrent: true },
    });
    expect(kept.status).toBe(200);
    expect(kept.body.session?.user.email).toBe("erin@auth.test");
    expect(await t.me(a)).toBe(401);
    expect(await t.me(b)).toBe(401);
    const current = kept.body.session!.accessToken;
    expect(await t.me(current)).toBe(200);

    const all = await t.call<{ revoked: boolean; session: AuthSessionResponse | null }>("POST", "/api/v1/user/sessions/revoke-all", { token: current });
    expect(all.status).toBe(200);
    expect(all.body.session).toBeNull();
    expect(await t.me(current)).toBe(401);
    expect((await t.call("POST", "/api/v1/user/sessions/revoke-all", { token: current })).status).toBe(401);
    expect((await t.call("POST", "/api/v1/user/sessions/revoke-all", { token: (await t.login("erin@auth.test", USER_PASSWORD)).body.accessToken, body: { keepCurrent: "yes" } })).status).toBe(400);
  });

  it("changing the password ends other sessions and hands this one a fresh token", async () => {
    const t = await bootstrap();
    await t.register("finn@auth.test");
    const here = (await t.login("finn@auth.test", USER_PASSWORD)).body.accessToken;
    const elsewhere = (await t.login("finn@auth.test", USER_PASSWORD)).body.accessToken;

    const changed = await t.call<{ ok: boolean; session: AuthSessionResponse }>("POST", "/api/v1/user/password", {
      token: here,
      body: { currentPassword: USER_PASSWORD, newPassword: "NewPassword456!" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.ok).toBe(true);
    expect(await t.me(here)).toBe(401);
    expect(await t.me(elsewhere)).toBe(401);
    expect(await t.me(changed.body.session.accessToken)).toBe(200);
    expect((await t.login("finn@auth.test", USER_PASSWORD)).status).toBe(401);
    expect((await t.login("finn@auth.test", "NewPassword456!")).status).toBe(200);
  });

  it("a sign-in checked against a password that changes before its token is signed gets a dead token", async () => {
    const t = await bootstrap();
    await t.register("mo@auth.test");
    const store = t.store as ControlStore;
    const read = store.findUserByEmail.bind(store);
    let raceOnce = true;
    // The owner changes the password right after the sign-in read the old hash (and before the
    // session is signed): the race of a leaked password against a password change.
    store.findUserByEmail = async (email: string) => {
      const record = await read(email);
      if (record && raceOnce && record.email === "mo@auth.test") {
        raceOnce = false;
        await store.ops.setPasswordHash(record.id, await hashPassword("ChangedPassword123!"));
      }
      return record;
    };
    const raced = await t.login("mo@auth.test", USER_PASSWORD);
    expect(raced.status).toBe(200); // the old password was right when it was checked...
    expect(await t.me(raced.body.accessToken)).toBe(401); // ...but its session belongs to the old password
    const fresh = await t.login("mo@auth.test", "ChangedPassword123!");
    expect(fresh.status).toBe(200);
    expect(await t.me(fresh.body.accessToken)).toBe(200);
  });
});

describe("password attempt limits (F15)", () => {
  it("locks one account from one address after repeated wrong passwords, while its owner elsewhere still signs in", async () => {
    const t = await bootstrap();
    await t.register("gail@auth.test");
    await t.register("hank@auth.test");
    const attacker = "198.51.100.66";
    for (let i = 0; i < 10; i++) {
      expect((await t.login("gail@auth.test", `wrong-${i}`, { peer: attacker })).status).toBe(401);
    }
    // Locked for this pair, even with the right password.
    const locked = await t.login("gail@auth.test", USER_PASSWORD, { peer: attacker });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe("too_many_attempts");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // Knowing the email is not enough to lock its owner out: other addresses are unaffected.
    expect((await t.login("gail@auth.test", USER_PASSWORD, { peer: "203.0.113.5" })).status).toBe(200);
    expect((await t.login("hank@auth.test", USER_PASSWORD, { peer: attacker })).status).toBe(200);
    // Unknown accounts are throttled the same way (no hint that the address doesn't exist).
    for (let i = 0; i < 10; i++) await t.login("ghost@auth.test", "nope", { peer: "198.51.100.67" });
    expect((await t.login("ghost@auth.test", "nope", { peer: "198.51.100.67" })).status).toBe(429);
  });

  it("evaluates at most the limit of a burst of concurrent guesses (reserved before hashing)", async () => {
    const t = await bootstrap();
    await t.register("burst@auth.test");
    // 30 wrong passwords and the right one, all sent at once from one address.
    const burst = await Promise.all([
      ...Array.from({ length: 30 }, (_, i) => t.login("burst@auth.test", `wrong-${i}`, { peer: "198.51.100.90" })),
      t.login("burst@auth.test", USER_PASSWORD, { peer: "198.51.100.90" }),
    ]);
    const evaluated = burst.filter((r) => r.status !== 429);
    expect(evaluated).toHaveLength(10);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(21);
    for (const r of burst.filter((r) => r.status === 429)) expect(r.body.error).toBe("too_many_attempts");

    // The per-address limit holds under a burst across accounts too.
    const spread = await Promise.all(
      Array.from({ length: 45 }, (_, i) => t.login(`spread${i % 9}@auth.test`, "guess", { peer: "198.51.100.91" })),
    );
    expect(spread.filter((r) => r.status === 401)).toHaveLength(30);
    expect(spread.filter((r) => r.status === 429)).toHaveLength(15);
  });

  it("an address the account signed in from keeps working while many addresses guess, and recovery lifts the rest", async () => {
    const t = await bootstrap();
    const nia = await t.register("nia@auth.test");
    const home = "192.0.2.10";
    expect((await t.login("nia@auth.test", USER_PASSWORD, { peer: home })).status).toBe(200);
    // 100 failures spread over ten addresses: the account-wide limit.
    for (let a = 0; a < 10; a++) {
      const peer = `203.0.113.${a + 1}`;
      await Promise.all(Array.from({ length: 10 }, (_, i) => t.login("nia@auth.test", `guess-${a}-${i}`, { peer })));
    }
    // A new address is held back, even with the right password...
    expect((await t.login("nia@auth.test", USER_PASSWORD, { peer: "198.51.100.150" })).status).toBe(429);
    // ...but not the address the owner signed in from.
    expect((await t.login("nia@auth.test", USER_PASSWORD, { peer: home })).status).toBe(200);

    // An administrator setting a new password lifts every sign-in limit on the account.
    expect((await t.call("PATCH", `/api/v1/admin/users/${nia.user.id}`, { token: t.admin, body: { password: "AdminReset123!" } })).status).toBe(200);
    expect((await t.login("nia@auth.test", "AdminReset123!", { peer: "198.51.100.150" })).status).toBe(200);
    expect((await t.login("nia@auth.test", "AdminReset123!", { peer: "203.0.113.1" })).status).toBe(200);
  }, 60_000);

  it("limits failures per client address across accounts, and a rotated X-Forwarded-For does not escape it", async () => {
    const t = await bootstrap();
    await t.register("ivy@auth.test");
    // Through the edge (loopback peer): the client is the right-most untrusted hop; the left-most
    // entry is whatever the client sent and rotates on every request.
    for (let i = 0; i < 30; i++) {
      const res = await t.login(`victim${i % 5}@auth.test`, "guess", {
        peer: "127.0.0.1",
        headers: { "X-Forwarded-For": `10.${i}.0.1, 203.0.113.${i}, 192.0.2.77` },
      });
      expect(res.status).toBe(401);
    }
    const blocked = await t.login("ivy@auth.test", USER_PASSWORD, {
      peer: "127.0.0.1",
      headers: { "X-Forwarded-For": "8.8.8.8, 192.0.2.77" },
    });
    expect(blocked.status).toBe(429);
    // A direct, untrusted peer cannot pick its bucket with forwarding headers either.
    expect((await t.login("ivy@auth.test", USER_PASSWORD, { peer: "192.0.2.77", headers: { "X-Forwarded-For": "1.2.3.4" } })).status).toBe(429);
    // Another client is unaffected.
    expect((await t.login("ivy@auth.test", USER_PASSWORD, { peer: "127.0.0.1", headers: { "X-Forwarded-For": "192.0.2.78" } })).status).toBe(200);
  });

  it("limits the password checks of a signed-in session too", async () => {
    const t = await bootstrap();
    const jo = await t.register("jo@auth.test");
    for (let i = 0; i < 10; i++) {
      const res = await t.call("POST", "/api/v1/user/password", {
        token: jo.accessToken,
        body: { currentPassword: `wrong-${i}`, newPassword: "Whatever123!" },
      });
      expect(res.status).toBe(403);
    }
    const locked = await t.call<{ message: string }>("POST", "/api/v1/user/password", {
      token: jo.accessToken,
      body: { currentPassword: USER_PASSWORD, newPassword: "Whatever123!" },
    });
    expect(locked.status).toBe(403);
    expect(locked.body.message).toContain("Too many");
    expect((await t.call("POST", "/api/v1/user/totp/setup", { token: jo.accessToken, body: { password: USER_PASSWORD } })).status).toBe(403);
    // The password was not changed by any of it.
    expect((await t.login("jo@auth.test", USER_PASSWORD)).status).toBe(200);
  });

  it("a burst of concurrent session password checks is evaluated at most up to the limit", async () => {
    const t = await bootstrap();
    const kai = await t.register("kai@auth.test");
    const burst = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        t.call<{ message: string }>("POST", "/api/v1/user/totp/setup", { token: kai.accessToken, body: { password: `wrong-${i}` } }),
      ),
    );
    expect(burst.every((r) => r.status === 403)).toBe(true);
    expect(burst.filter((r) => r.body.message === "Password is incorrect")).toHaveLength(10);
    expect(burst.filter((r) => r.body.message.includes("Too many"))).toHaveLength(30);
  });

  it("the credential export's password confirmation is limited like every other session password check", async () => {
    const t = await bootstrap();
    for (let i = 0; i < 10; i++) {
      const res = await t.call<{ error: string }>("POST", "/api/v1/admin/accounts/export", { token: t.admin, body: { password: `wrong-${i}` } });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("invalid_password");
    }
    const locked = await t.call<{ error: string }>("POST", "/api/v1/admin/accounts/export", { token: t.admin, body: { password: ADMIN_PASSWORD } });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe("too_many_attempts");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // It shares the per-user budget with the other session password checks.
    // (The audit-log clear takes a two-factor code, never a password: two-factor setup checks one.)
    const setup = await t.call<{ message: string }>("POST", "/api/v1/user/totp/setup", { token: t.admin, body: { password: ADMIN_PASSWORD } });
    expect(setup.status).toBe(403);
    expect(setup.body.message).toContain("Too many wrong passwords");
  });

  it("FailureLimiter holds reserved slots until settled, counts failures per window and caps keys", () => {
    const limiter = new FailureLimiter(2, 1000, 3);
    expect(limiter.retryAfterMs("a", 0)).toBe(0);
    const first = limiter.reserve("a", 0);
    const second = limiter.reserve("a", 0);
    // Full of attempts still being checked: refused (briefly) before either has failed.
    expect(limiter.retryAfterMs("a", 0)).toBe(1000);
    limiter.settle(first, false, 5); // a right password frees its slot
    expect(limiter.retryAfterMs("a", 5)).toBe(0);
    limiter.settle(second, true, 5);
    limiter.fail("a", 10);
    expect(limiter.retryAfterMs("a", 20)).toBe(980);
    expect(limiter.retryAfterMs("a", 1000)).toBe(0);
    // A slot whose window ended while it ran still counts its failure, in the new window.
    const late = limiter.reserve("b", 1000);
    expect(limiter.retryAfterMs("b", 2500)).toBe(0);
    limiter.settle(late, true, 2500);
    limiter.fail("b", 2500);
    expect(limiter.retryAfterMs("b", 2600)).toBe(900);
    // A success that leaves nothing behind drops the key.
    limiter.settle(limiter.reserve("c", 2600), false, 2600);
    expect(limiter.size).toBe(1);
    for (const k of ["k1", "k2", "k3", "k4"]) limiter.fail(k, 3000);
    expect(limiter.size).toBe(3);
  });

  it("PasswordAttemptGuard: per-pair lock, known-address exemption, session checks and clearing", () => {
    let now = 0;
    const guard = new PasswordAttemptGuard({ pairLimit: 2, ipLimit: 3, accountLimit: 4, sessionLimit: 2, windowMs: 1000, now: () => now });
    const signIn = (email: string, ip: string, ok: boolean) => {
      const start = guard.beginSignIn(email, ip);
      if (!start.ok) return start.retryAfterSeconds;
      if (ok) start.attempt.succeeded();
      else start.attempt.failed();
      return 0;
    };
    expect(signIn("a@x.test", "home", true)).toBe(0); // "home" is now known for a@x.test
    expect(signIn("a@x.test", "ip1", false)).toBe(0);
    expect(signIn("a@x.test", "ip1", false)).toBe(0);
    expect(signIn("a@x.test", "ip1", true)).toBe(1); // pair locked, right password or not
    expect(signIn("a@x.test", "ip2", false)).toBe(0);
    expect(signIn("a@x.test", "ip2", false)).toBe(0);
    expect(signIn("a@x.test", "ip3", true)).toBe(1); // 4 failures: account-wide limit for new addresses
    expect(signIn("a@x.test", "home", true)).toBe(0); // the known address is exempt
    expect(signIn("b@x.test", "ip1", false)).toBe(0); // ip1's 3rd failure: address-wide limit
    expect(signIn("c@x.test", "ip1", true)).toBe(1);

    guard.clearSignIn("A@x.test");
    expect(signIn("a@x.test", "ip3", true)).toBe(0);
    expect(signIn("a@x.test", "ip2", true)).toBe(0);
    expect(signIn("a@x.test", "ip1", true)).toBe(1); // ip1's own address-wide count stays

    // Session checks: per user, released slots don't count, and the address limit doesn't refuse them.
    const check = () => guard.beginSessionCheck("usr_1", "ip1");
    const held = check();
    if (!held.ok) throw new Error("expected a slot");
    held.attempt.release();
    for (let i = 0; i < 2; i++) {
      const s = check();
      if (!s.ok) throw new Error("expected a slot");
      s.attempt.failed();
    }
    expect(check().ok).toBe(false);
    now = 1000;
    expect(check().ok).toBe(true);
  });

  it("runs a check on a reservation: a throw frees the slot without counting", async () => {
    const guard = new PasswordAttemptGuard({ sessionLimit: 1 });
    const start = guard.beginSessionCheck("usr_2", "ip");
    if (!start.ok) throw new Error("expected a slot");
    await expect(start.attempt.run(async () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    const again = guard.beginSessionCheck("usr_2", "ip");
    expect(again.ok).toBe(true);
  });
});

describe("client address (F14)", () => {
  const proxies = parseTrustedProxies(undefined);

  it("honours forwarding headers only from trusted proxies, reading the chain from the right", () => {
    expect(resolveClientIp("203.0.113.9", "1.1.1.1", "2.2.2.2", proxies)).toBe("203.0.113.9");
    expect(resolveClientIp("127.0.0.1", "6.6.6.6, 198.51.100.7", null, proxies)).toBe("198.51.100.7");
    expect(resolveClientIp("127.0.0.1", "6.6.6.6, 198.51.100.7, 172.18.0.2", null, proxies)).toBe("198.51.100.7");
    expect(resolveClientIp("::ffff:127.0.0.1", "198.51.100.7:51234", null, proxies)).toBe("198.51.100.7");
    expect(resolveClientIp("127.0.0.1", null, "198.51.100.8", proxies)).toBe("198.51.100.8");
    expect(resolveClientIp("127.0.0.1", "[2001:db8::1]:443", null, proxies)).toBe("2001:db8::1");
    // A garbled hop next to the proxy stops the walk at the last trusted address.
    expect(resolveClientIp("127.0.0.1", "198.51.100.7, not-an-ip", null, proxies)).toBe("127.0.0.1");
    // Internal callers (every hop trusted) are keyed on the outermost internal address.
    expect(resolveClientIp("127.0.0.1", "10.0.0.5", null, proxies)).toBe("10.0.0.5");
    // No socket peer: headers are never trusted.
    expect(resolveClientIp(null, "1.1.1.1", "2.2.2.2", proxies)).toBe("unknown");
    expect(resolveClientIp("127.0.0.1", "6.6.6.6", null, parseTrustedProxies("none"))).toBe("127.0.0.1");
    expect(resolveClientIp("203.0.113.9", "6.6.6.6", null, parseTrustedProxies("203.0.113.0/24"))).toBe("6.6.6.6");
  });

  it("buckets IPv6 clients by /64 for rate limits", () => {
    expect(rateLimitBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
    expect(rateLimitBucket("2001:db8:1:2::9")).toBe("2001:db8:1:2::/64");
    expect(rateLimitBucket("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(rateLimitBucket("198.51.100.7")).toBe("198.51.100.7");
    expect(rateLimitBucket("unknown")).toBe("unknown");
  });

  it("rotating IPv6 source addresses inside one /64 does not escape a limiter, and the audit log keeps the exact address", async () => {
    const t = await bootstrap();
    for (let i = 0; i < 30; i++) {
      const res = await t.call("GET", `/api/v1/public/promo/NOPE${i}`, { peer: `2001:db8:5:6::${(i + 1).toString(16)}` });
      expect(res.status).toBe(200);
    }
    expect((await t.call("GET", "/api/v1/public/promo/NOPE", { peer: "2001:db8:5:6:ffff::1" })).status).toBe(403);
    expect((await t.call("GET", "/api/v1/public/promo/NOPE", { peer: "2001:db8:5:7::1" })).status).toBe(200);

    await t.call("PATCH", "/api/v1/admin/settings", { token: t.admin, peer: "2001:db8:5:6::abcd", body: { siteSubtitle: "y" } });
    const logs = await t.call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs", { token: t.admin });
    expect(logs.body.items[0]!.ip).toBe("2001:db8:5:6::abcd");
  });

  it("parses CIDRs", () => {
    expect(parseCidr("10.0.0.0/8")).not.toBeNull();
    expect(parseCidr("fc00::/7")).not.toBeNull();
    expect(parseCidr("::1")).not.toBeNull();
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("300.0.0.1")).toBeNull();
    expect(parseCidr("1.2.3.4/8/9")).toBeNull();
  });

  it("keys the public limiters and the audit log on the real client", async () => {
    const t = await bootstrap();
    for (let i = 0; i < 30; i++) {
      const res = await t.call("GET", `/api/v1/public/promo/NOPE${i}`, { peer: "192.0.2.10", headers: { "X-Forwarded-For": `100.64.${i}.1` } });
      expect(res.status).toBe(200);
    }
    expect((await t.call("GET", "/api/v1/public/promo/NOPE", { peer: "192.0.2.10", headers: { "X-Forwarded-For": "9.9.9.9" } })).status).toBe(403);

    await t.call("PATCH", "/api/v1/admin/settings", { token: t.admin, peer: "192.0.2.20", headers: { "X-Forwarded-For": "1.2.3.4" }, body: { siteSubtitle: "x" } });
    const logs = await t.call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs", { token: t.admin });
    expect(logs.body.items[0]!.ip).toBe("192.0.2.20");
  });
});

describe("password reset links (F03)", () => {
  async function withMail() {
    const outbox: MailMessage[] = [];
    const t = await bootstrap({ mail: outbox });
    await t.call("PATCH", "/api/v1/admin/email/config", {
      token: t.admin,
      body: { enabled: true, host: "smtp.example.com", port: 587, security: "starttls", fromAddress: "noreply@example.com" },
    });
    return { ...t, outbox };
  }

  it("refuses to mail a reset link until the public URL is configured, whatever the Host headers say", async () => {
    const t = await withMail();
    await t.register("kim@auth.test");
    expect((await t.call<PublicSettings>("GET", "/api/v1/public/settings")).body.passwordResetEnabled).toBe(false);
    const evil = { Host: "evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" };
    const refused = await t.call("POST", "/api/v1/auth/forgot-password", { headers: evil, body: { email: "kim@auth.test" } });
    expect(refused.status).toBe(400);
    expect(t.outbox).toHaveLength(0);

    await t.call("PATCH", "/api/v1/admin/settings", { token: t.admin, body: { apiBaseUrl: "https://console.example.com/" } });
    expect((await t.call<PublicSettings>("GET", "/api/v1/public/settings")).body.passwordResetEnabled).toBe(true);
    expect((await t.call("POST", "/api/v1/auth/forgot-password", { headers: evil, body: { email: "kim@auth.test" } })).status).toBe(200);
    const html = t.outbox.at(-1)!.html;
    expect(html).toContain("https://console.example.com/reset-password?token=");
    expect(html).not.toContain("evil.example");
  });

  it("derives the console base from the API base URL, dropping a trailing /v1", () => {
    expect(configuredPublicBaseUrl({ apiBaseUrl: "https://api.example.com/v1/" })).toBe("https://api.example.com");
    expect(configuredPublicBaseUrl({ apiBaseUrl: "https://api.example.com/V1" })).toBe("https://api.example.com");
    expect(configuredPublicBaseUrl({ apiBaseUrl: "https://example.com/gateway/v1?x=1#y" })).toBe("https://example.com/gateway");
    expect(configuredPublicBaseUrl({ apiBaseUrl: "https://example.com/v10" })).toBe("https://example.com/v10");
    expect(configuredPublicBaseUrl({ apiBaseUrl: "/v1" })).toBeNull();
    expect(configuredPublicBaseUrl({ apiBaseUrl: "https://user:pw@example.com" })).toBeNull();
  });

  it("caps reset mails per address and ends every session on reset", async () => {
    const t = await withMail();
    await t.call("PATCH", "/api/v1/admin/settings", { token: t.admin, body: { apiBaseUrl: "https://console.example.com" } });
    const lee = await t.register("lee@auth.test");
    for (let i = 0; i < 5; i++) {
      // Each request from another address: the per-address cap still holds.
      const res = await t.call("POST", "/api/v1/auth/forgot-password", { peer: `198.51.100.${i + 1}`, body: { email: "lee@auth.test" } });
      expect(res.status).toBe(200);
    }
    expect(t.outbox).toHaveLength(3);

    // A locked-out account is unlocked by a successful reset.
    for (let i = 0; i < 10; i++) await t.login("lee@auth.test", `bad-${i}`);
    expect((await t.login("lee@auth.test", USER_PASSWORD)).status).toBe(429);
    const token = /token=([0-9a-f]{64})/.exec(t.outbox.at(-1)!.html)![1]!;
    expect((await t.call("POST", "/api/v1/auth/reset-password", { body: { token, password: "ResetPassword789" } })).status).toBe(200);
    expect(await t.me(lee.accessToken)).toBe(401);
    expect((await t.login("lee@auth.test", "ResetPassword789")).status).toBe(200);
  });
});

/**
 * Outcome checks only. The write skew of F35 needs two transactions interleaving on separate
 * Postgres connections; neither the memory store (synchronous) nor PGlite (one connection, one
 * transaction at a time) can interleave them, so these tests also pass without the advisory lock
 * in PostgresOpsStore.updateUser / deleteUser. The lock itself is reviewed, not exercised, here.
 */
describe("last administrator guard (F35, outcome checks)", () => {
  it("concurrent demotions leave exactly one active admin", async () => {
    const t = await bootstrap();
    const b = await t.createAdmin("b@auth.test");
    const adminId = (await t.call<{ user: { id: string } }>("GET", "/api/v1/auth/me", { token: t.admin })).body.user.id;
    const results = await Promise.allSettled([
      t.store.ops.updateUser(b.id, { role: "user" }),
      t.store.ops.updateUser(adminId, { role: "user" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code?: string }).code).toBe("conflict");
    expect(await t.store.ops.countAdmins()).toBe(1);
  });

  it("a concurrent demote and delete over HTTP leave exactly one active admin", async () => {
    const t = await bootstrap();
    const b = await t.createAdmin("b@auth.test");
    const adminId = (await t.call<{ user: { id: string } }>("GET", "/api/v1/auth/me", { token: t.admin })).body.user.id;
    const [one, two] = await Promise.all([
      t.call("DELETE", `/api/v1/admin/users/${b.id}`, { token: t.admin }),
      t.call("PATCH", `/api/v1/admin/users/${adminId}`, { token: b.token, body: { role: "user" } }),
    ]);
    expect([one.status, two.status].filter((s) => s === 200)).toHaveLength(1);
    expect(await t.store.ops.countAdmins()).toBe(1);
  });
});
