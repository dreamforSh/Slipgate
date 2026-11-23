import { describe, expect, it } from "bun:test";
import { createBffApp } from "../app.ts";
import { FlowStateMap, placeholderEmail } from "../routes/oauth.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";

/** Postgres-backed runs inject a store factory through a test preload; default is in-memory. */
const storeFactory = (globalThis as { __slipgateTestStoreFactory?: () => Promise<ControlStore> }).__slipgateTestStoreFactory;

const JSON_HEADERS = { "Content-Type": "application/json" };
const ORIGIN = "http://portal.test";
const SITE = "https://login.portal.test";

type App = ReturnType<typeof createBffApp>;
type Profile = Record<string, unknown>;
interface Grant {
  challenge: string;
  profile: Profile;
  /** GitHub-style /user/emails answer. */
  emails?: unknown;
}
interface Flow {
  code: string;
  state: string;
  redirectUri: string;
}
interface Completion {
  status: number;
  body: { accessToken?: string; redirect?: string; error?: string };
}

const s256 = async (verifier: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A browser in front of the in-process app: a per-host cookie jar that honours Path and Max-Age=0. */
class Browser {
  private readonly jar = new Map<string, { host: string; path: string; name: string; value: string }>();
  /** Raw Set-Cookie lines of the last response. */
  lastSetCookie: string[] = [];

  constructor(private readonly app: App) {}

  cookie(host: string, name: string): string | undefined {
    return this.jar.get(`${host}|${name}`)?.value;
  }

  plant(host: string, name: string, value: string, path = "/") {
    this.jar.set(`${host}|${name}`, { host, path, name, value });
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    const cookie = [...this.jar.values()]
      .filter((c) => c.host === u.host && (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith("/") ? c.path : `${c.path}/`)))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const headers = new Headers(init.headers);
    if (cookie) headers.set("Cookie", cookie);
    const res = await this.app.request(url, { ...init, headers });
    this.lastSetCookie = res.headers.getSetCookie();
    for (const line of this.lastSetCookie) {
      const [pair = "", ...attrs] = line.split(";").map((s) => s.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const path = attrs.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) || "/";
      if (attrs.some((a) => a.toLowerCase() === "max-age=0")) this.jar.delete(`${u.host}|${name}`);
      else this.jar.set(`${u.host}|${name}`, { host: u.host, path, name, value });
    }
    return res;
  }
}

/** Fresh app with a fake identity provider and an enabled generic OIDC provider. */
async function setup() {
  const grants = new Map<string, Grant>(); // code -> grant
  const tokens = new Map<string, Grant>(); // access token -> grant
  const calls = { githubEmails: 0 };
  const idp = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://idp.test/token") {
      const form = new URLSearchParams(String(init?.body));
      const code = form.get("code") ?? "";
      const grant = grants.get(code);
      grants.delete(code);
      if (!grant || grant.challenge !== (await s256(form.get("code_verifier") ?? "")) || form.get("client_secret") !== "idp-secret") {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const token = `at-${crypto.randomUUID()}`;
      tokens.set(token, grant);
      return Response.json({ access_token: token, token_type: "Bearer" });
    }
    const grant = tokens.get(new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "");
    if (!grant) return new Response("unauthorized", { status: 401 });
    if (url === "https://idp.test/userinfo" || url === "https://idp.test/gh/user") return Response.json(grant.profile);
    if (url === "https://idp.test/gh/user/emails") {
      calls.githubEmails++;
      return Response.json(grant.emails ?? []);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const store = storeFactory ? await storeFactory() : new MemoryControlStore();
  const app = createBffApp({
    store,
    jwtSecret: "oauth-test-jwt-secret-32-bytes-minimum",
    vaultSecret: "oauth-test-vault-secret-32-bytes-minimum",
    oauthFetch: idp,
  });
  const api = async <T>(method: string, path: string, token?: string, body?: unknown) => {
    const headers: Record<string, string> = { ...JSON_HEADERS };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await app.request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as T };
  };

  const init = await api<{ accessToken: string }>("POST", "/api/v1/setup/initialize", undefined, {
    siteName: "OAuth",
    adminEmail: "admin@oauth.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  const adminToken = init.body.accessToken;
  expect((await api<{ items: unknown[] }>("GET", "/api/v1/auth/oauth/providers")).body.items).toEqual([]);
  const cfg = await api<{ item: { clientSecretSet: boolean } }>("PATCH", "/api/v1/admin/oauth/providers/oidc", adminToken, {
    enabled: true,
    displayName: "Corp SSO",
    clientId: "slipgate",
    clientSecret: "idp-secret",
    authorizeUrl: "https://idp.test/authorize",
    tokenUrl: "https://idp.test/token",
    userinfoUrl: "https://idp.test/userinfo",
  });
  expect(cfg.body.item.clientSecretSet).toBe(true);
  const enableGithub = async () => {
    const gh = await api<{ item: { clientSecretSet: boolean } }>("PATCH", "/api/v1/admin/oauth/providers/github", adminToken, {
      enabled: true,
      clientId: "gh-client",
      clientSecret: "idp-secret",
      authorizeUrl: "https://idp.test/authorize",
      tokenUrl: "https://idp.test/token",
      userinfoUrl: "https://idp.test/gh/user",
    });
    expect(gh.body.item.clientSecretSet).toBe(true);
  };

  /** Opens /start in `browser`; the IdP (after consent) issues a code that resolves to `profile`. */
  const start = async (browser: Browser, profile: Profile, opts: { provider?: string; query?: string; origin?: string; emails?: unknown } = {}) => {
    const res = await browser.fetch(`${opts.origin ?? ORIGIN}/api/v1/auth/oauth/${opts.provider ?? "oidc"}/start?${opts.query ?? "redirect=/usage"}`);
    expect(res.status).toBe(302);
    const authorize = new URL(res.headers.get("location")!);
    expect(authorize.origin + authorize.pathname).toBe("https://idp.test/authorize");
    const code = `code-${crypto.randomUUID()}`;
    grants.set(code, { challenge: authorize.searchParams.get("code_challenge")!, profile, emails: opts.emails });
    return { code, state: authorize.searchParams.get("state")!, redirectUri: authorize.searchParams.get("redirect_uri")! } satisfies Flow;
  };
  /** The provider sends `browser` back to the callback with the flow's code. */
  const callback = async (browser: Browser, flow: Flow) => {
    const res = await browser.fetch(`${flow.redirectUri}?code=${encodeURIComponent(flow.code)}&state=${flow.state}`);
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location")!);
  };
  const signIn = async (browser: Browser, profile: Profile, opts: Parameters<typeof start>[2] = {}) =>
    callback(browser, await start(browser, profile, opts));
  /** The landing page at `loc` (/oauth/complete#code=…) trades its hand-off code in `browser`. */
  const complete = async (browser: Browser, loc: URL): Promise<Completion> => {
    const code = new URLSearchParams(loc.hash.slice(1)).get("code") ?? "";
    const res = await browser.fetch(`${loc.origin}/api/v1/auth/oauth/complete`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ code }) });
    return { status: res.status, body: (await res.json()) as Completion["body"] };
  };
  /** The session token a successful sign-in at `loc` hands to `browser`. */
  const session = async (browser: Browser, loc: URL): Promise<string> => {
    expect(loc.pathname).toBe("/oauth/complete");
    const done = await complete(browser, loc);
    expect(done.status).toBe(200);
    return done.body.accessToken!;
  };
  const me = async (token: string) => (await api<{ user: { id: string; email: string; username: string } }>("GET", "/api/v1/auth/me", token)).body.user;
  const linkedOf = async (token: string) =>
    (await api<{ linked: { provider: string; subject: string }[] }>("GET", "/api/v1/user/oauth", token)).body.linked;
  const register = async (email: string, password = "UserPassword123!") => {
    const res = await api<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", undefined, { email, password });
    expect(res.status).toBeLessThan(300);
    return res.body;
  };
  /** Asks for a link ticket with `token`'s session from `browser` (the console's same-origin fetch). */
  const linkTicket = async (browser: Browser, token: string, provider = "oidc", origin = ORIGIN) => {
    const res = await browser.fetch(`${origin}/api/v1/user/oauth/${provider}/link`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}`, Origin: origin },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { url: string }).url;
  };

  return {
    app,
    store,
    api,
    adminToken,
    calls,
    enableGithub,
    start,
    callback,
    signIn,
    complete,
    session,
    me,
    linkedOf,
    register,
    linkTicket,
    browser: () => new Browser(app),
  };
}

const errorOf = (loc: URL) => loc.searchParams.get("oauth_error");

describe("third-party sign-in", () => {
  it("runs the PKCE code flow, creates accounts and supports profile linking", async () => {
    const t = await setup();
    const providers = await t.api<{ items: { id: string; displayName: string }[] }>("GET", "/api/v1/auth/oauth/providers");
    expect(providers.body.items).toEqual([{ id: "oidc", displayName: "Corp SSO" }]);
    const browser = t.browser();

    // New user via SSO lands on /oauth/complete with a one-time code and trades it for a session
    // and the requested redirect.
    const first = await t.signIn(browser, { sub: "u-1", email: "new@corp.test", email_verified: true, name: "New Person" });
    expect(first.pathname).toBe("/oauth/complete");
    // The callback does not touch the binding cookie.
    expect(browser.lastSetCookie.find((l) => l.startsWith("slipgate_oauth="))).toBeUndefined();
    const done = await t.complete(browser, first);
    expect(done.body.redirect).toBe("/usage");
    expect(await t.me(done.body.accessToken!)).toMatchObject({ email: "new@corp.test", username: "New Person" });

    // The binding cookie: HttpOnly, SameSite=Lax, scoped to the OAuth routes; not Secure on plain http.
    await t.start(browser, { sub: "unused" });
    const line = browser.lastSetCookie.find((l) => l.startsWith("slipgate_oauth="))!;
    expect(line).toContain("Path=/api/v1/auth/oauth");
    expect(line).toContain("HttpOnly");
    expect(line).toContain("SameSite=Lax");
    expect(line).not.toContain("Secure");

    // Same subject again: same account.
    const again = await t.signIn(browser, { sub: "u-1", email: "changed@corp.test" });
    expect((await t.me(await t.session(browser, again))).email).toBe("new@corp.test");

    // Replayed or forged state is rejected.
    const forged = await browser.fetch(`${ORIGIN}/api/v1/auth/oauth/oidc/callback?code=x&state=deadbeef`);
    expect(forged.headers.get("location")).toContain("oauth_error=state_invalid");

    // Profile linking with a ticket from the account's own browser, then unlinking.
    const reg = await t.register("pw@corp.test");
    const userBrowser = t.browser();
    const url = await t.linkTicket(userBrowser, reg.accessToken);
    const linkLoc = await t.signIn(userBrowser, { sub: "u-9", email: "other@corp.test" }, { query: url.split("?")[1]! });
    expect(linkLoc.pathname).toBe("/profile");
    expect(linkLoc.searchParams.get("oauth_linked")).toBe("oidc");
    expect((await t.linkedOf(reg.accessToken)).map((l) => l.subject)).toEqual(["u-9"]);
    const elsewhere = t.browser();
    const viaLink = await t.signIn(elsewhere, { sub: "u-9" });
    expect((await t.me(await t.session(elsewhere, viaLink))).id).toBe(reg.user.id);
    await t.api("DELETE", "/api/v1/user/oauth/oidc", reg.accessToken);
    expect(await t.linkedOf(reg.accessToken)).toEqual([]);

    // Sign-up closed: no new accounts.
    await t.api("PATCH", "/api/v1/admin/settings", t.adminToken, { allowRegistration: false });
    const closed = await t.signIn(browser, { sub: "u-3", email: "late@corp.test", email_verified: true });
    expect(errorOf(closed)).toBe("signup_closed");
  });

  it("never attaches an identity to an existing account by email (F10, F11)", async () => {
    const t = await setup();
    // Pre-account hijacking: someone registered the victim's address with a password they know.
    const squat = await t.register("victim@corp.test");

    // Verified (boolean or string), unverified, missing or odd-cased: none of them takes the account.
    for (const profile of [
      { sub: "v-1", email: "victim@corp.test", email_verified: true },
      { sub: "v-1", email: "victim@corp.test", email_verified: "true" },
      { sub: "v-1", email: "victim@corp.test", email_verified: "false" },
      { sub: "v-1", email: "  VICTIM@corp.test " },
    ]) {
      const loc = await t.signIn(t.browser(), profile);
      expect(loc.pathname).toBe("/login");
      expect(errorOf(loc)).toBe("email_registered");
      expect(loc.hash).toBe("");
    }
    expect(await t.linkedOf(squat.accessToken)).toEqual([]);

    // nOAuth: an IdP that lets users set any address without asserting verification cannot reach
    // the admin account (no email_verified claim at all).
    const evil = await t.signIn(t.browser(), { sub: "evil", email: "admin@oauth.test" });
    expect(errorOf(evil)).toBe("email_registered");
    expect(evil.hash).toBe("");
    expect(await t.linkedOf(t.adminToken)).toEqual([]);

    // The owner signs in with the password and links the provider from the profile page; from then
    // on the provider signs into that account.
    const ownerBrowser = t.browser();
    const url = await t.linkTicket(ownerBrowser, squat.accessToken);
    const linked = await t.signIn(ownerBrowser, { sub: "v-1", email: "victim@corp.test", email_verified: true }, { query: url.split("?")[1]! });
    expect(linked.searchParams.get("oauth_linked")).toBe("oidc");
    const later = t.browser();
    const signedIn = await t.signIn(later, { sub: "v-1", email: "victim@corp.test", email_verified: true });
    expect((await t.me(await t.session(later, signedIn))).id).toBe(squat.user.id);
  });

  it("keeps a provider email on a new account only when the provider asserts it is verified (F10)", async () => {
    const t = await setup();
    const cases: [Profile, string][] = [
      [{ sub: "n-1", email: "missing@corp.test" }, "oidc-n-1@users.noreply.slipgate"],
      [{ sub: "n-2", email: "string-false@corp.test", email_verified: "false" }, "oidc-n-2@users.noreply.slipgate"],
      [{ sub: "n-3", email: "false@corp.test", email_verified: false }, "oidc-n-3@users.noreply.slipgate"],
      [{ sub: "n-4", email: "truthy@corp.test", email_verified: 1 }, "oidc-n-4@users.noreply.slipgate"],
      [{ sub: "n-5", email: "cognito@corp.test", email_verified: "true" }, "cognito@corp.test"],
      [{ sub: "n-6", email: "google@corp.test", email_verified: true }, "google@corp.test"],
    ];
    for (const [profile, address] of cases) {
      const browser = t.browser();
      const loc = await t.signIn(browser, profile);
      expect((await t.me(await t.session(browser, loc))).email).toBe(address);
    }
    // The unproven address was not squatted: its owner can still register it.
    await t.register("missing@corp.test");
  });

  it("gives every new account a placeholder address of its own, even when one was registered first (F10)", async () => {
    const t = await setup();
    expect(placeholderEmail("github", "583231")).toBe("github-583231@users.noreply.slipgate");
    expect(placeholderEmail("oidc", "x".repeat(41))).toMatch(/^oidc\.[0-9a-f]{32}@users\.noreply\.slipgate$/);
    expect(placeholderEmail("oidc", "a|b")).not.toBe(placeholderEmail("oidc", "a/b"));

    // LinuxDo and GitHub ids are public, so someone registers the placeholder of a future user. The
    // API refuses the reserved domain now (auth_guards.ts); an account from before that still can.
    const squat = await t.api<{ error?: string }>("POST", "/api/v1/auth/register", undefined, {
      email: "oidc-sq-1@users.noreply.slipgate",
      password: "UserPassword123!",
    });
    expect(squat.body.error).toBe("email_reserved");
    await t.store.registerUser("oidc-sq-1@users.noreply.slipgate", "legacy-hash");
    const victim = t.browser();
    const loc = await t.signIn(victim, { sub: "sq-1", email: "sq@corp.test" });
    const token = await t.session(victim, loc);
    expect((await t.me(token)).email).toMatch(/^oidc-sq-1\.[0-9a-f]{8}@users\.noreply\.slipgate$/);
    // And signs in to that same account again afterwards.
    const back = t.browser();
    expect((await t.me(await t.session(back, await t.signIn(back, { sub: "sq-1" })))).id).toBe((await t.me(token)).id);

    // Subjects that only differ in characters an address cannot hold get distinct accounts.
    const emails: string[] = [];
    for (const sub of ["a|b", "a/b"]) {
      const browser = t.browser();
      emails.push((await t.me(await t.session(browser, await t.signIn(browser, { sub, email: "odd@corp.test" })))).email);
    }
    expect(emails[0]).toMatch(/^oidc\.[0-9a-f]{32}@users\.noreply\.slipgate$/);
    expect(emails[1]).toMatch(/^oidc\.[0-9a-f]{32}@users\.noreply\.slipgate$/);
    expect(emails[0]).not.toBe(emails[1]);
  });

  it("leaves no half-created account behind when attaching the identity fails (F10)", async () => {
    const t = await setup();
    const ops = t.store.ops;
    const original = ops.linkIdentity.bind(ops);
    let step: "fail" | "race" | "pass" = "fail";
    const winner = await t.register("winner@corp.test");
    ops.linkIdentity = async (userId, provider, subject) => {
      if (step === "fail") {
        step = "pass";
        throw new Error("transient");
      }
      if (step === "race") {
        // A concurrent callback of the same identity got there first.
        step = "pass";
        await original(winner.user.id, provider, subject);
      }
      return original(userId, provider, subject);
    };

    // A failed attach removes the new account, so the address does not block the retry.
    const failed = await t.signIn(t.browser(), { sub: "race-1", email: "race@corp.test", email_verified: true });
    expect(errorOf(failed)).toBe("signup_failed");
    expect(await t.store.findUserByEmail("race@corp.test")).toBeFalsy();
    const retry = t.browser();
    const ok = await t.signIn(retry, { sub: "race-1", email: "race@corp.test", email_verified: true });
    expect((await t.me(await t.session(retry, ok))).email).toBe("race@corp.test");

    // Lost the race: the extra account goes, and the sign-in lands in the one holding the identity.
    step = "race";
    const raced = t.browser();
    const loc = await t.signIn(raced, { sub: "race-2", email: "race2@corp.test", email_verified: true });
    expect((await t.me(await t.session(raced, loc))).id).toBe(winner.user.id);
    expect(await t.store.findUserByEmail("race2@corp.test")).toBeFalsy();
  });

  it("trusts GitHub addresses only when its emails API lists them as verified", async () => {
    const t = await setup();
    await t.enableGithub();
    const viaGithub = async (profile: Profile, emails: unknown) => {
      const browser = t.browser();
      const loc = await t.signIn(browser, profile, { provider: "github", emails });
      return (await t.me(await t.session(browser, loc))).email;
    };
    // Public address that the emails API does not confirm.
    expect(await viaGithub({ id: 101, login: "octo", email: "octo@corp.test" }, [{ email: "octo@corp.test", primary: true, verified: false }])).toBe(
      "github-101@users.noreply.slipgate",
    );
    // Private address: the verified primary one.
    expect(
      await viaGithub({ id: 102, login: "cat", email: null }, [
        { email: "old@corp.test", primary: false, verified: true },
        { email: "cat@corp.test", primary: true, verified: true },
      ]),
    ).toBe("cat@corp.test");
    // Public address confirmed by the API.
    expect(await viaGithub({ id: 103, login: "pub", email: "Pub@corp.test" }, [{ email: "pub@corp.test", primary: false, verified: true }])).toBe(
      "pub@corp.test",
    );
    // Emails API unavailable (scope missing): nothing is verified.
    expect(await viaGithub({ id: 104, login: "noscope", email: "noscope@corp.test" }, { message: "Not Found" })).toBe(
      "github-104@users.noreply.slipgate",
    );
    expect(t.calls.githubEmails).toBe(4);

    // The emails API is only asked when an account may be created: not for a returning identity...
    expect(await viaGithub({ id: 102, login: "cat", email: null }, [{ email: "cat@corp.test", primary: true, verified: true }])).toBe("cat@corp.test");
    // ...nor for a link from the profile page.
    const owner = await t.register("gh-owner@corp.test");
    const browser = t.browser();
    const url = await t.linkTicket(browser, owner.accessToken, "github");
    const linked = await t.signIn(browser, { id: 105, login: "owner" }, { provider: "github", query: url.split("?")[1]!, emails: [] });
    expect(linked.searchParams.get("oauth_linked")).toBe("github");
    expect(t.calls.githubEmails).toBe(4);
  });

  it("binds sign-in to the browser that started it (F12 login CSRF)", async () => {
    const t = await setup();
    const attacker = t.browser();
    const victim = t.browser();

    // The attacker starts a flow, consents with their own account and stops before the callback.
    const stolen = await t.start(attacker, { sub: "attacker", email: "attacker@corp.test", email_verified: true });
    // The victim opens the callback URL: no binding cookie, so no session.
    const csrf = await t.callback(victim, stolen);
    expect(csrf.pathname).toBe("/login");
    expect(errorOf(csrf)).toBe("browser_mismatch");
    expect(csrf.hash).toBe("");
    // The state is one-shot: the attempt burned it.
    expect(errorOf(await t.callback(attacker, stolen))).toBe("state_invalid");

    // A victim whose browser holds its own binding cookie is no better target.
    await t.start(victim, { sub: "victim" });
    expect(victim.cookie("portal.test", "slipgate_oauth")).toBeTruthy();
    const stolen2 = await t.start(attacker, { sub: "attacker", email: "attacker@corp.test", email_verified: true });
    expect(errorOf(await t.callback(victim, stolen2))).toBe("browser_mismatch");

    // Nor is a well-formed guess of the cookie.
    const stolen3 = await t.start(attacker, { sub: "attacker", email: "attacker@corp.test", email_verified: true });
    const guesser = t.browser();
    guesser.plant("portal.test", "slipgate_oauth", "A".repeat(43), "/api/v1/auth/oauth");
    expect(errorOf(await t.callback(guesser, stolen3))).toBe("browser_mismatch");

    // Nor a browser that carries the attacker's nonce next to its own (a cookie planted for a more
    // specific path or a parent domain): two binding cookies are trusted as neither.
    const stolen4 = await t.start(attacker, { sub: "attacker", email: "attacker@corp.test", email_verified: true });
    const nonce = attacker.cookie("portal.test", "slipgate_oauth")!;
    const tossed = await t.app.request(`${stolen4.redirectUri}?code=${stolen4.code}&state=${stolen4.state}`, {
      headers: { Cookie: `slipgate_oauth=${nonce}; slipgate_oauth=${victim.cookie("portal.test", "slipgate_oauth")}` },
    });
    expect(errorOf(new URL(tossed.headers.get("location")!))).toBe("browser_mismatch");

    // The browser that started the flow completes it, and parallel flows in it share one cookie.
    const one = await t.start(attacker, { sub: "attacker", email: "attacker@corp.test", email_verified: true });
    const cookie = attacker.cookie("portal.test", "slipgate_oauth");
    const two = await t.start(attacker, { sub: "attacker" });
    expect(attacker.cookie("portal.test", "slipgate_oauth")).toBe(cookie);
    expect(await t.session(attacker, await t.callback(attacker, two))).toBeTruthy();
    expect(await t.session(attacker, await t.callback(attacker, one))).toBeTruthy();
  });

  it("hands the session only to the browser that started the sign-in (F12 landing page)", async () => {
    const t = await setup();
    const attacker = t.browser();
    const victim = t.browser();

    // A finished sign-in never puts a session token in the URL, only a one-time hand-off code.
    const loc = await t.signIn(attacker, { sub: "attacker", email: "attacker@corp.test", email_verified: true });
    expect(loc.pathname).toBe("/oauth/complete");
    const fragment = new URLSearchParams(loc.hash.slice(1));
    expect(fragment.get("token")).toBeNull();
    expect(fragment.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The attacker sends the landing link to a victim: that browser gets no session from it...
    const stolen = await t.complete(victim, loc);
    expect(stolen.status).toBe(403);
    expect(stolen.body.error).toBe("browser_mismatch");
    expect(stolen.body.accessToken).toBeUndefined();
    // ...and the code is spent, for the attacker too.
    expect((await t.complete(attacker, loc)).body.error).toBe("state_invalid");

    // A victim with a binding cookie of its own, or a guessed one, fares no better.
    await t.start(victim, { sub: "victim" });
    const loc2 = await t.signIn(attacker, { sub: "attacker" });
    expect((await t.complete(victim, loc2)).body.error).toBe("browser_mismatch");
    const guesser = t.browser();
    guesser.plant("portal.test", "slipgate_oauth", "A".repeat(43), "/api/v1/auth/oauth");
    expect((await t.complete(guesser, await t.signIn(attacker, { sub: "attacker" }))).status).toBe(403);

    // A session token where a hand-off code belongs (the old `#token=` link) is not one.
    const pw = await t.register("pw@corp.test");
    const forged = await t.complete(victim, new URL(`${ORIGIN}/oauth/complete#${new URLSearchParams({ code: pw.accessToken })}`));
    expect(forged.status).toBe(400);
    expect(forged.body.accessToken).toBeUndefined();
    expect((await t.complete(victim, new URL(`${ORIGIN}/oauth/complete#code=nope`))).body.error).toBe("state_invalid");

    // The starting browser gets the session and the redirect it asked for.
    const ok = await t.complete(attacker, await t.signIn(attacker, { sub: "attacker" }));
    expect(ok.status).toBe(200);
    expect(ok.body.redirect).toBe("/usage");
    const account = await t.me(ok.body.accessToken!);
    expect(account.email).toBe("attacker@corp.test");

    // Suspended between the callback and the hand-off: no session.
    const pendingLoc = await t.signIn(attacker, { sub: "attacker" });
    expect((await t.api("PATCH", `/api/v1/admin/users/${account.id}`, t.adminToken, { status: "suspended" })).status).toBe(200);
    const late = await t.complete(attacker, pendingLoc);
    expect(late.status).toBe(403);
    expect(late.body.error).toBe("suspended");
  });

  it("binds profile linking to the browser that asked for the ticket (F12 forced linking)", async () => {
    const t = await setup();
    const owner = await t.register("owner@corp.test");
    const attackerBrowser = t.browser();
    const victimBrowser = t.browser();

    // The ticket request itself issues the binding cookie, scoped to the OAuth routes.
    const url = await t.linkTicket(attackerBrowser, owner.accessToken);
    const line = attackerBrowser.lastSetCookie.find((l) => l.startsWith("slipgate_oauth="))!;
    expect(line).toContain("Path=/api/v1/auth/oauth");
    expect(line).toContain("HttpOnly");

    // The link URL sent to a victim: refused before the provider is ever involved.
    const res = await victimBrowser.fetch(`${ORIGIN}${url}`);
    expect(res.status).toBe(302);
    const refused = new URL(res.headers.get("location")!);
    expect(refused.pathname).toBe("/profile");
    expect(errorOf(refused)).toBe("browser_mismatch");
    // The ticket was single-use.
    expect((await attackerBrowser.fetch(`${ORIGIN}${url}`)).status).toBe(400);

    // The provider authorize URL of a started link flow sent to a victim: the callback is refused.
    const url2 = await t.linkTicket(attackerBrowser, owner.accessToken);
    const flow = await t.start(attackerBrowser, { sub: "victim-gh", email: "victim@corp.test", email_verified: true }, { query: url2.split("?")[1]! });
    const forced = await t.callback(victimBrowser, flow);
    expect(forced.pathname).toBe("/profile");
    expect(errorOf(forced)).toBe("browser_mismatch");
    expect(await t.linkedOf(owner.accessToken)).toEqual([]);

    // The owner's own browser links fine.
    const url3 = await t.linkTicket(attackerBrowser, owner.accessToken);
    const ok = await t.signIn(attackerBrowser, { sub: "owner-sso" }, { query: url3.split("?")[1]! });
    expect(ok.searchParams.get("oauth_linked")).toBe("oidc");
    expect((await t.linkedOf(owner.accessToken)).map((l) => l.subject)).toEqual(["owner-sso"]);
  });

  it("hops to the API base URL origin first so the binding cookie lands where the callback does", async () => {
    const t = await setup();
    await t.api("PATCH", "/api/v1/admin/settings", t.adminToken, { apiBaseUrl: SITE });
    const browser = t.browser();

    const hop = await browser.fetch(`${ORIGIN}/api/v1/auth/oauth/oidc/start?redirect=/usage`);
    expect(hop.status).toBe(302);
    const target = new URL(hop.headers.get("location")!);
    expect(target.origin + target.pathname).toBe(`${SITE}/api/v1/auth/oauth/oidc/start`);
    expect(target.searchParams.get("redirect")).toBe("/usage");
    expect(target.searchParams.get("hop")).toBe("1");
    expect(browser.lastSetCookie).toEqual([]);

    // On https the binding is a __Host- cookie: Secure, Path=/, no Domain.
    const flow = await t.start(browser, { sub: "hop-1", email: "hop@corp.test", email_verified: true }, { origin: SITE, query: target.search.slice(1) });
    const line = browser.lastSetCookie.find((l) => l.startsWith("__Host-slipgate_oauth="))!;
    expect(line).toContain("Secure");
    expect(line).toContain("Path=/;");
    expect(line).not.toContain("Domain");
    expect(flow.redirectUri).toBe(`${SITE}/api/v1/auth/oauth/oidc/callback`);
    const done = await t.callback(browser, flow);
    expect(done.origin + done.pathname).toBe(`${SITE}/oauth/complete`);
    expect(await t.session(browser, done)).toBeTruthy();

    // Behind a proxy that rewrites Host the hop happens once, never in a loop.
    const looped = await browser.fetch(`${ORIGIN}/api/v1/auth/oauth/oidc/start?hop=1`);
    expect(new URL(looped.headers.get("location")!).origin).toBe("https://idp.test");

    // The right host over plain http (the proxy says so): hop to https, where a Secure cookie sticks.
    const insecure = await browser.fetch(`${SITE}/api/v1/auth/oauth/oidc/start?redirect=/usage`, { headers: { "X-Forwarded-Proto": "http" } });
    const upgraded = new URL(insecure.headers.get("location")!);
    expect(upgraded.origin + upgraded.pathname).toBe(`${SITE}/api/v1/auth/oauth/oidc/start`);
    expect(upgraded.searchParams.get("hop")).toBe("1");
    const secure = await browser.fetch(`${SITE}/api/v1/auth/oauth/oidc/start`, { headers: { "X-Forwarded-Proto": "https" } });
    expect(new URL(secure.headers.get("location")!).origin).toBe("https://idp.test");

    // A plain-named cookie (which a sibling subdomain could plant) is not the binding on https.
    const attacker = t.browser();
    const stolen = await t.start(attacker, { sub: "hop-2" }, { origin: SITE, query: "hop=1" });
    const victim = t.browser();
    victim.plant("login.portal.test", "slipgate_oauth", attacker.cookie("login.portal.test", "__Host-slipgate_oauth")!, "/api/v1/auth/oauth");
    expect(errorOf(await t.callback(victim, stolen))).toBe("browser_mismatch");
  });

  it("refuses link tickets to a console opened off the API base URL origin", async () => {
    const t = await setup();
    await t.api("PATCH", "/api/v1/admin/settings", t.adminToken, { apiBaseUrl: SITE });
    const owner = await t.register("split@corp.test");
    const browser = t.browser();
    const ask = (url: string, headers: Record<string, string>) =>
      browser.fetch(`${url}/api/v1/user/oauth/oidc/link`, { method: "POST", headers: { ...JSON_HEADERS, Authorization: `Bearer ${owner.accessToken}`, ...headers } });

    // Console on another host, or on the site's host over plain http: a clear refusal, no ticket.
    for (const [url, headers] of [
      [ORIGIN, { Origin: ORIGIN }],
      [SITE, { Origin: "http://login.portal.test" }],
      [SITE, { "X-Forwarded-Proto": "http" }],
    ] as [string, Record<string, string>][]) {
      const res = await ask(url, headers);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "link_wrong_host", origin: SITE });
      expect(browser.lastSetCookie).toEqual([]);
    }

    // The browser's Origin decides over a proxy that misreports the scheme (TLS ended in front of it).
    const res = await ask(SITE, { Origin: SITE, "X-Forwarded-Proto": "http" });
    expect(res.status).toBe(200);
    expect(browser.lastSetCookie.find((l) => l.startsWith("__Host-slipgate_oauth="))).toContain("Secure");

    // On the site's origin the whole link flow works.
    const url = await t.linkTicket(browser, owner.accessToken, "oidc", SITE);
    const linked = await t.signIn(browser, { sub: "split-1" }, { origin: SITE, query: url.split("?")[1]! });
    expect(linked.origin + linked.pathname).toBe(`${SITE}/profile`);
    expect(linked.searchParams.get("oauth_linked")).toBe("oidc");
    expect((await t.linkedOf(owner.accessToken)).map((l) => l.subject)).toEqual(["split-1"]);
  });

  it("rate-limits link tickets per account and /start per client address (F30)", async () => {
    const t = await setup();
    const owner = await t.register("limit@corp.test");
    const browser = t.browser();
    for (let i = 0; i < 30; i++) await t.linkTicket(browser, owner.accessToken);
    const refused = await browser.fetch(`${ORIGIN}/api/v1/user/oauth/oidc/link`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${owner.accessToken}` },
    });
    expect(refused.status).toBe(403);

    // A client that is not a trusted proxy cannot pick a fresh /start bucket with X-Forwarded-For.
    const peer = { requestIP: () => ({ address: "203.0.113.9" }) };
    const startFrom = (xff: string) => t.app.request(`${ORIGIN}/api/v1/auth/oauth/oidc/start`, { headers: { "X-Forwarded-For": xff } }, peer);
    for (let i = 0; i < 30; i++) expect((await startFrom(`198.51.100.${i}`)).status).toBe(302);
    expect((await startFrom("198.51.100.250")).status).toBe(403);
  });
});

describe("FlowStateMap", () => {
  it("expires records, reads them once and prunes from the old end", () => {
    const map = new FlowStateMap<{ expiresAt: number; v: string }>(100);
    map.set("a", { expiresAt: 100, v: "a" }, 0);
    map.set("b", { expiresAt: 200, v: "b" }, 0);
    expect(map.take("a", 150)).toBeUndefined(); // expired: gone and not returned
    expect(map.size).toBe(1);
    expect(map.take("b", 150)?.v).toBe("b");
    expect(map.take("b", 150)).toBeUndefined(); // one-shot
    map.set("c", { expiresAt: 300, v: "c" }, 0);
    map.set("d", { expiresAt: 400, v: "d" }, 0);
    map.set("e", { expiresAt: 900, v: "e" }, 350); // prunes c, keeps d and e
    expect(map.size).toBe(2);
    expect(map.take("d", 350)?.v).toBe("d");
  });

  it("caps the number of records, dropping the oldest first", () => {
    const map = new FlowStateMap<{ expiresAt: number; i: number }>(1_000);
    for (let i = 0; i < 200_000; i++) map.set(`k${i}`, { expiresAt: 10_000, i }, 0);
    expect(map.size).toBe(1_000);
    expect(map.take("k198999", 0)).toBeUndefined();
    expect(map.take("k199000", 0)?.i).toBe(199_000);
    expect(map.take("k199999", 0)?.i).toBe(199_999);
  });
});
