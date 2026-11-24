import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  OAuthContinueSignupRequestSchema,
  OAuthPendingSignupSummarySchema,
  OAuthProviderConfigSchema,
  OAuthProviderIdSchema,
  UpdateOAuthProviderRequestSchema,
  type OAuthProviderConfig,
  type OAuthProviderId,
  type PublicOAuthProvider,
} from "@slipgate/contracts";
import { WindowLimiter } from "../insights.ts";
import { issueAccessToken, type AuthEnv } from "../middleware/auth.ts";
import { clientIp, safeRequestOrigin, trustsForwardedHeaders } from "../security/client_ip.ts";
import { decryptSecret, encryptSecret, hashPassword } from "../security/crypto.ts";
import { ssrfSafeFetch } from "../security/ssrf.ts";
import { StoreError, type ControlStore } from "../store/types.ts";
import { applySignupDefaults } from "../signup_defaults.ts";
import type { AuthGuards } from "../auth_guards.ts";

/**
 * Third-party sign-in over OAuth 2.0 authorization code + PKCE (GitHub, Google, LinuxDo or any
 * OIDC provider). Identities are matched by (provider, subject) only. A provider email that belongs
 * to an existing account is never linked automatically (Slipgate does not record whether a local
 * address was ever proven): the owner signs in as usual and links the provider from the profile.
 * New users are created only when both the provider and the portal allow sign-up, and keep the
 * provider email only when the provider asserts it is verified. Every flow is bound to the browser
 * that started it by an HttpOnly cookie nonce, up to and including the hand-off of the session:
 * the callback never puts a token in the URL, only a one-time code that /complete exchanges for
 * one in that same browser. Accounts with two-factor authentication must use password + code.
 */

const BLOB_KEY = "oauth_providers";
const STATE_TTL_MS = 10 * 60_000;
const LINK_TICKET_TTL_MS = 5 * 60_000;
/** Pending invite-required OAuth signups wait up to 10 minutes before expiring. */
const PENDING_SIGNUP_TTL_MS = 10 * 60_000;
/** The landing page redeems its hand-off code as soon as it loads. */
const HANDOFF_TTL_MS = 2 * 60_000;
/** Hard caps on the in-memory flow records; once full, the oldest records are dropped first. */
const MAX_PENDING_STATES = 10_000;
const MAX_LINK_TICKETS = 5_000;
const MAX_HANDOFFS = 10_000;
/**
 * Browser binding: a random nonce in an HttpOnly, SameSite=Lax cookie. Its SHA-256 is stored with
 * every link ticket, pending state and sign-in hand-off and must match at /start (links), /callback
 * and /complete, so a link URL, callback URL or hand-off code taken to another browser is useless
 * there. On https it is a `__Host-` cookie (Secure, Path=/, no Domain attribute), which a sibling
 * subdomain or a plain-http response cannot plant; on plain http it is scoped to the OAuth routes.
 */
const BINDING_COOKIE = "slipgate_oauth";
const BINDING_COOKIE_PATH = "/api/v1/auth/oauth";
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
/** Placeholder address domain of accounts whose provider gave no verified email (never delivered). */
const PLACEHOLDER_DOMAIN = "users.noreply.slipgate";

type Preset = Omit<OAuthProviderConfig, "id" | "enabled" | "clientId" | "clientSecretSet" | "allowSignup">;

const PRESETS: Record<OAuthProviderId, Preset> = {
  github: {
    displayName: "GitHub",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
    scopes: "read:user user:email",
    idField: "id",
    emailField: "email",
    nameField: "login",
  },
  google: {
    displayName: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: "openid email profile",
    idField: "sub",
    emailField: "email",
    nameField: "name",
  },
  linuxdo: {
    displayName: "LINUX DO",
    authorizeUrl: "https://connect.linux.do/oauth2/authorize",
    tokenUrl: "https://connect.linux.do/oauth2/token",
    userinfoUrl: "https://connect.linux.do/api/user",
    scopes: "user",
    idField: "id",
    emailField: "email",
    nameField: "username",
  },
  wechat: {
    displayName: "WeChat",
    authorizeUrl: "https://open.weixin.qq.com/connect/qrconnect",
    tokenUrl: "https://api.weixin.qq.com/sns/oauth2/access_token",
    userinfoUrl: "https://api.weixin.qq.com/sns/userinfo",
    scopes: "snsapi_login",
    idField: "unionid",
    emailField: "email",
    nameField: "nickname",
  },
  dingtalk: {
    displayName: "DingTalk",
    authorizeUrl: "https://login.dingtalk.com/oauth2/auth",
    tokenUrl: "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
    userinfoUrl: "https://api.dingtalk.com/v1.0/contact/users/me",
    scopes: "openid",
    idField: "unionId",
    emailField: "email",
    nameField: "nick",
  },
  oidc: {
    displayName: "SSO",
    authorizeUrl: "",
    tokenUrl: "",
    userinfoUrl: "",
    scopes: "openid email profile",
    idField: "sub",
    emailField: "email",
    nameField: "name",
  },
};

interface PendingState {
  provider: OAuthProviderId;
  verifier: string;
  redirect: string;
  linkUserId: string | null;
  /** SHA-256 (hex) of the browser-binding nonce of the browser that called /start. */
  binding: string;
  expiresAt: number;
}

interface LinkTicket {
  userId: string;
  provider: OAuthProviderId;
  /** SHA-256 (hex) of the browser-binding nonce of the browser that asked for the ticket. */
  binding: string;
  expiresAt: number;
}

/** A finished sign-in waiting for the landing page of the browser that started it. */
interface Handoff {
  userId: string;
  /** The flow's binding: only that browser can redeem the code. */
  binding: string;
  redirect: string;
  expiresAt: number;
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => Number.parseInt(x, 16)));
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bindingHash = (nonce: string) => createHash("sha256").update(nonce).digest("hex");

/** Constant-time check that `nonce` (the request's binding cookie) is the one `expected` was made from. */
function sameBinding(expected: string, nonce: string | undefined): boolean {
  if (!nonce || !NONCE_RE.test(nonce)) return false;
  const want = Buffer.from(expected, "hex");
  const got = Buffer.from(bindingHash(nonce), "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}

/** `email_verified` as providers send it: a boolean, or the string "true"/"false" (Cognito and friends). */
function assertsVerified(claim: unknown): boolean {
  return claim === true || (typeof claim === "string" && claim.trim().toLowerCase() === "true");
}

function normalizeEmail(raw: unknown): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return email.length <= 254 && EMAIL_RE.test(email) ? email : "";
}

function extractAvatarUrl(profile: unknown): string {
  for (const field of ["avatar_url", "picture", "headimgurl", "avatarUrl"]) {
    const raw = pick(profile, field);
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length <= 512 && /^https?:\/\//i.test(trimmed)) return trimmed;
  }
  return "";
}

/**
 * The never-delivered address of an account whose provider gave no verified email. A short plain
 * subject stays readable (`github-583231`); anything else is hashed (`oidc.<hex>`, the dot keeps
 * the two forms apart), so subjects that only differ in dropped characters cannot collide. These
 * addresses are predictable, so `salt` gives a fresh one when somebody registered it first.
 */
export function placeholderEmail(provider: OAuthProviderId, subject: string, salt = ""): string {
  const local = /^[A-Za-z0-9_-]{1,40}$/.test(subject)
    ? `${provider}-${subject}`
    : `${provider}.${createHash("sha256").update(subject).digest("hex").slice(0, 32)}`;
  return `${local}${salt ? `.${salt}` : ""}@${PLACEHOLDER_DOMAIN}`;
}

/**
 * Short-lived OAuth flow records (pending states, link tickets) keyed by a random token. Every
 * record in one map gets the same TTL, so insertion order is expiry order: pruning only looks at
 * the oldest records (amortised O(1) per insert, never a walk over live ones) and a hard cap drops
 * the oldest first, so a flood of /start calls can neither grow memory nor slow inserts down.
 */
export class FlowStateMap<V extends { expiresAt: number }> {
  private readonly items = new Map<string, V>();

  constructor(private readonly cap: number) {}

  get size(): number {
    return this.items.size;
  }

  set(key: string, value: V, nowMs = Date.now()): void {
    this.prune(nowMs);
    for (const oldest of this.items.keys()) {
      if (this.items.size < this.cap) break;
      this.items.delete(oldest);
    }
    this.items.set(key, value);
  }

  /** One-shot read: the record is removed whether or not it is still live. */
  take(key: string, nowMs = Date.now()): V | undefined {
    const value = this.items.get(key);
    if (value === undefined) return undefined;
    this.items.delete(key);
    return value.expiresAt > nowMs ? value : undefined;
  }

  /** Drops expired records from the old end and stops at the first live one. */
  private prune(nowMs: number): void {
    for (const [key, value] of this.items) {
      if (value.expiresAt > nowMs) break;
      this.items.delete(key);
    }
  }
}

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function safeRedirect(raw: string | undefined): string {
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "";
}

export interface OAuthRouteContext {
  store: ControlStore;
  vaultSecret: string;
  jwtSecret: string;
  fetchImpl?: typeof fetch;
  /** Captcha pass at sign-in start, sign-up email policy and backend mode (auth_guards.ts). */
  guards?: AuthGuards;
  syncDataPlane?: () => Promise<void>;
}

export function registerOAuthRoutes(app: Hono<AuthEnv>, ctx: OAuthRouteContext) {
  const { store, vaultSecret, jwtSecret } = ctx;
  const doFetch = ctx.fetchImpl ?? fetch;
  const pending = new FlowStateMap<PendingState>(MAX_PENDING_STATES);
  const linkTickets = new FlowStateMap<LinkTicket>(MAX_LINK_TICKETS);
  const handoffs = new FlowStateMap<Handoff>(MAX_HANDOFFS);
  const limiter = new WindowLimiter(30, 10 * 60_000);

  /** The binding cookie for `base`: `__Host-` prefixed (Secure, Path=/) on https, route-scoped on http. */
  function bindingCookie(base: string): { name: string; path: string; secure: boolean } {
    return base.startsWith("https://")
      ? { name: `__Host-${BINDING_COOKIE}`, path: "/", secure: true }
      : { name: BINDING_COOKIE, path: BINDING_COOKIE_PATH, secure: false };
  }

  /**
   * The request's binding nonce. Two cookies of that name mean one was planted (another path or a
   * parent domain on plain http), and neither is trusted then.
   */
  function readBinding(c: Context, base: string): string | undefined {
    const { name } = bindingCookie(base);
    const header = c.req.header("cookie") ?? "";
    const copies = header.split(";").filter((part) => part.trim().startsWith(`${name}=`)).length;
    return copies === 1 ? getCookie(c, name) : undefined;
  }

  /**
   * This browser's binding nonce: the current cookie when it is well formed (parallel tabs share
   * it), otherwise a fresh one. The cookie is (re)issued with a full flow lifetime either way.
   */
  function bindBrowser(c: Context, base: string): string {
    const current = readBinding(c, base);
    const nonce = current && NONCE_RE.test(current) ? current : b64url(crypto.getRandomValues(new Uint8Array(32)));
    const { name, path, secure } = bindingCookie(base);
    setCookie(c, name, nonce, { path, httpOnly: true, sameSite: "Lax", secure, maxAge: STATE_TTL_MS / 1000 });
    return nonce;
  }

  /**
   * Whether the browser reached this request on another origin than `base`: another host (as the
   * proxy forwarded it), or another scheme when the proxy says which one it served (without
   * X-Forwarded-Proto the scheme is unknown and only the host counts).
   */
  function offCanonicalOrigin(c: Context, base: string): boolean {
    try {
      const canonical = new URL(base);
      const current = new URL(safeRequestOrigin(c));
      if (trustsForwardedHeaders(c) && c.req.header("x-forwarded-proto")) {
        if (current.protocol !== canonical.protocol) return true;
      }
      return current.host !== canonical.host;
    } catch {
      return false;
    }
  }

  /**
   * The console origin a same-origin fetch came from, when it is not the configured API base URL
   * (where every flow ends up). The browser's Origin header is used when present: it is exactly
   * what the browser shows, whatever the proxies in between say about scheme and host.
   */
  async function consoleOffBase(c: Context): Promise<string | null> {
    const settings = await store.ops.getSettings();
    if (!/^https?:\/\//i.test(settings.apiBaseUrl)) return null; // flows follow the request's own origin
    const base = settings.apiBaseUrl.replace(/\/+$/, "");
    const origin = c.req.header("origin");
    try {
      const want = new URL(base).origin;
      if (origin && origin !== "null") return new URL(origin).origin === want ? null : want;
      return offCanonicalOrigin(c, base) ? want : null;
    } catch {
      return null;
    }
  }

  /**
   * A verified address from GitHub's emails API: `claimed` (the /user email) when it is listed as
   * verified, else the verified primary one when nothing was claimed; "" otherwise. The API sits
   * next to the configured profile URL (GitHub Enterprise included), and the token is never sent
   * anywhere else.
   */
  async function githubVerifiedEmail(userinfoUrl: string, accessToken: string, claimed: string): Promise<string> {
    if (!/\/user\/?$/.test(userinfoUrl)) return "";
    try {
      const emailsUrl = userinfoUrl.replace(/\/user\/?$/, "/user/emails");
      const reqInit: RequestInit = {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", "User-Agent": "Slipgate" },
        signal: AbortSignal.timeout(10_000),
      };
      const res = doFetch === fetch ? await ssrfSafeFetch(emailsUrl, reqInit, doFetch) : await doFetch(emailsUrl, reqInit);
      if (!res.ok) return "";
      const list: unknown = await res.json().catch(() => null);
      if (!Array.isArray(list)) return "";
      for (const item of list as { email?: unknown; primary?: unknown; verified?: unknown }[]) {
        const address = normalizeEmail(item?.email);
        if (!address || item.verified !== true) continue;
        if (claimed ? address === claimed : item.primary === true) return address;
      }
      return "";
    } catch {
      return "";
    }
  }

  async function loadAll(): Promise<{ configs: OAuthProviderConfig[]; secrets: Map<OAuthProviderId, string> }> {
    const blob = (await store.ops.getBlob(BLOB_KEY)) ?? {};
    const saved = (blob.providers ?? {}) as Record<string, Record<string, unknown>>;
    const configs: OAuthProviderConfig[] = [];
    const secrets = new Map<OAuthProviderId, string>();
    for (const id of OAuthProviderIdSchema.options) {
      const s = saved[id] ?? {};
      let secret = "";
      if (typeof s.clientSecretEnc === "string" && s.clientSecretEnc) {
        secret = await decryptSecret(fromHex(s.clientSecretEnc), vaultSecret).catch(() => "");
      }
      secrets.set(id, secret);
      const parsed = OAuthProviderConfigSchema.safeParse({
        enabled: false,
        clientId: "",
        allowSignup: true,
        ...PRESETS[id],
        ...s,
        id,
        clientSecretSet: Boolean(secret),
      });
      if (parsed.success) configs.push(parsed.data);
    }
    return { configs, secrets };
  }

  function usable(cfg: OAuthProviderConfig, secret: string) {
    return cfg.enabled && Boolean(cfg.clientId && secret && cfg.authorizeUrl && cfg.tokenUrl && cfg.userinfoUrl);
  }

  async function baseUrl(c: Context) {
    const settings = await store.ops.getSettings();
    if (/^https?:\/\//i.test(settings.apiBaseUrl)) return settings.apiBaseUrl.replace(/\/+$/, "");
    return safeRequestOrigin(c);
  }

  function parseProvider(raw: string): OAuthProviderId {
    const parsed = OAuthProviderIdSchema.safeParse(raw);
    if (!parsed.success) throw new StoreError("not_found", "Unknown sign-in provider");
    return parsed.data;
  }

  /* ---------------- Admin ---------------- */

  app.get("/api/v1/admin/oauth/providers", async (c) => c.json({ items: (await loadAll()).configs }));

  app.patch("/api/v1/admin/oauth/providers/:id", async (c) => {
    const id = parseProvider(c.req.param("id"));
    const parsed = UpdateOAuthProviderRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new StoreError("bad_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const blob = (await store.ops.getBlob(BLOB_KEY)) ?? {};
    const providers = { ...((blob.providers ?? {}) as Record<string, Record<string, unknown>>) };
    const { clientSecret, ...rest } = parsed.data;
    const next: Record<string, unknown> = { ...(providers[id] ?? {}), ...rest };
    if (clientSecret !== undefined) next.clientSecretEnc = clientSecret ? toHex(await encryptSecret(clientSecret, vaultSecret)) : "";
    providers[id] = next;
    await store.ops.setBlob(BLOB_KEY, { ...blob, providers });
    return c.json({ item: (await loadAll()).configs.find((p) => p.id === id) });
  });

  /* ---------------- Public ---------------- */

  app.get("/api/v1/auth/oauth/providers", async (c) => {
    const { configs, secrets } = await loadAll();
    const items: PublicOAuthProvider[] = configs
      .filter((p) => usable(p, secrets.get(p.id) ?? ""))
      .map((p) => ({ id: p.id, displayName: p.displayName || PRESETS[p.id].displayName }));
    return c.json({ items });
  });

  app.get("/api/v1/auth/oauth/:id/start", async (c) => {
    const id = parseProvider(c.req.param("id"));
    const base = await baseUrl(c);
    // The binding cookie has to live on the origin the provider sends the browser back to (the API
    // base URL when one is set), so hop there first. `hop=1` ends the hop behind a proxy that
    // rewrites Host; the flow then simply fails closed at the callback if the hosts really differ.
    if (c.req.query("hop") !== "1" && offCanonicalOrigin(c, base)) {
      const query = new URLSearchParams(c.req.query());
      query.set("hop", "1");
      return c.redirect(`${base}/api/v1/auth/oauth/${id}/start?${query.toString()}`, 302);
    }
    if (!limiter.allow(`start:${clientIp(c)}`)) throw new StoreError("forbidden", "Too many attempts");
    // Sign-in starts (not profile links, which need a session's ticket) need the one-time pass of a
    // solved captcha while the oauth scope is on (POST /api/v1/auth/captcha/pass).
    if (!c.req.query("link_ticket") && ctx.guards && !(await ctx.guards.oauthStartAllowed(c.req.query("captcha_pass")))) {
      return c.redirect(`${base}/login?oauth_error=captcha_required`, 302);
    }
    const { configs, secrets } = await loadAll();
    const cfg = configs.find((p) => p.id === id)!;
    if (!usable(cfg, secrets.get(id) ?? "")) throw new StoreError("not_found", "This sign-in method is not enabled");
    let linkUserId: string | null = null;
    const ticket = c.req.query("link_ticket");
    if (ticket) {
      const t = linkTickets.take(ticket);
      if (!t || t.provider !== id) throw new StoreError("bad_request", "The link request expired, try again");
      // Only the browser that asked for the ticket (holding the account's session) may use it: a
      // link URL passed to someone else must not attach their provider account to the requester.
      if (!sameBinding(t.binding, readBinding(c, base))) return c.redirect(`${base}/profile?oauth_error=browser_mismatch`, 302);
      linkUserId = t.userId;
    }
    const binding = bindingHash(bindBrowser(c, base));
    const state = toHex(crypto.getRandomValues(new Uint8Array(24)));
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    pending.set(state, {
      provider: id,
      verifier,
      redirect: safeRedirect(c.req.query("redirect")),
      linkUserId,
      binding,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    const url = new URL(cfg.authorizeUrl);
    url.searchParams.set("client_id", cfg.clientId);
    if (id === "wechat") url.searchParams.set("appid", cfg.clientId);
    url.searchParams.set("redirect_uri", `${base}/api/v1/auth/oauth/${id}/callback`);
    url.searchParams.set("response_type", "code");
    if (cfg.scopes) url.searchParams.set("scope", cfg.scopes);
    if (id === "dingtalk") url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return c.redirect(url.toString(), 302);
  });

  app.get("/api/v1/auth/oauth/:id/callback", async (c) => {
    const base = await baseUrl(c);
    const id = OAuthProviderIdSchema.safeParse(c.req.param("id"));
    const entry = pending.take(c.req.query("state") ?? "");
    // Profile links report back on the profile page, sign-ins on the login page.
    const back = entry?.linkUserId ? "/profile" : "/login";
    const fail = (code: string) => c.redirect(`${base}${back}?oauth_error=${encodeURIComponent(code)}`, 302);
    if (!id.success || !entry || entry.provider !== id.data) return fail("state_invalid");
    // The callback must come from the browser that started the flow: otherwise a stopped flow's
    // callback URL signs the victim into the attacker's account (login CSRF) or links the victim's
    // provider account to the attacker's profile.
    if (!sameBinding(entry.binding, readBinding(c, base))) return fail("browser_mismatch");
    if (c.req.query("error")) return fail("denied");
    const code = c.req.query("code");
    if (!code) return fail("denied");
    const { configs, secrets } = await loadAll();
    const cfg = configs.find((p) => p.id === id.data)!;
    const secret = secrets.get(id.data) ?? "";
    if (!usable(cfg, secret)) return fail("disabled");

    // Exchange the code (form-encoded, JSON answer; WeChat & DingTalk use provider params).
    let accessToken = "";
    let providerOpenId = "";
    try {
      let tokenTarget = cfg.tokenUrl;
      let tokenInit: RequestInit;
      if (id.data === "wechat") {
        const u = new URL(cfg.tokenUrl);
        u.searchParams.set("appid", cfg.clientId);
        u.searchParams.set("secret", secret);
        u.searchParams.set("code", code);
        u.searchParams.set("grant_type", "authorization_code");
        tokenTarget = u.toString();
        tokenInit = {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        };
      } else if (id.data === "dingtalk") {
        tokenInit = {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            clientId: cfg.clientId,
            clientSecret: secret,
            code,
            grantType: "authorization_code",
          }),
          signal: AbortSignal.timeout(15_000),
        };
      } else {
        tokenInit = {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: `${base}/api/v1/auth/oauth/${id.data}/callback`,
            client_id: cfg.clientId,
            client_secret: secret,
            code_verifier: entry.verifier,
          }).toString(),
          signal: AbortSignal.timeout(15_000),
        };
      }
      const tokenRes = doFetch === fetch ? await ssrfSafeFetch(tokenTarget, tokenInit, doFetch) : await doFetch(tokenTarget, tokenInit);
      const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
        access_token?: string;
        accessToken?: string;
        openid?: string;
      };
      accessToken = tokenJson.access_token ?? tokenJson.accessToken ?? "";
      providerOpenId = tokenJson.openid ?? "";
    } catch {
      return fail("token_failed");
    }
    if (!accessToken) return fail("token_failed");

    let profile: unknown;
    try {
      let infoTarget = cfg.userinfoUrl;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": "Slipgate",
      };
      if (id.data === "wechat") {
        const u = new URL(cfg.userinfoUrl);
        if (!u.searchParams.has("access_token")) u.searchParams.set("access_token", accessToken);
        if (providerOpenId && !u.searchParams.has("openid")) u.searchParams.set("openid", providerOpenId);
        if (!u.searchParams.has("lang")) u.searchParams.set("lang", "zh_CN");
        infoTarget = u.toString();
      } else if (id.data === "dingtalk") {
        headers["x-acs-dingtalk-access-token"] = accessToken;
      }
      const infoInit: RequestInit = { headers, signal: AbortSignal.timeout(15_000) };
      const infoRes = doFetch === fetch ? await ssrfSafeFetch(infoTarget, infoInit, doFetch) : await doFetch(infoTarget, infoInit);
      if (!infoRes.ok) return fail("userinfo_failed");
      profile = await infoRes.json();
    } catch {
      return fail("userinfo_failed");
    }
    let subject = String(pick(profile, cfg.idField) ?? "").trim();
    if (!subject && id.data === "wechat") subject = String(pick(profile, "openid") ?? providerOpenId).trim();
    if (!subject && id.data === "dingtalk") subject = String(pick(profile, "openId") ?? "").trim();
    if (!subject) return fail("userinfo_failed");

    // Linking from the profile page.
    if (entry.linkUserId) {
      try {
        await store.ops.linkIdentity(entry.linkUserId, id.data, subject);
      } catch {
        return c.redirect(`${base}/profile?oauth_error=already_linked`, 302);
      }
      return c.redirect(`${base}/profile?oauth_linked=${id.data}`, 302);
    }

    let userId = await store.ops.findUserIdByIdentity(id.data, subject);
    if (!userId) {
      let email = normalizeEmail(pick(profile, cfg.emailField));
      const name = String(pick(profile, cfg.nameField) ?? "").trim().slice(0, 64);
      const avatarUrl = extractAvatarUrl(profile);
      // Verified only on an explicit assertion. A missing claim, "false" or anything else is not one.
      let emailVerified = false;
      if (id.data === "github") {
        // GitHub's /user has no verification flag (and hides private addresses): its emails API
        // says which addresses are verified. Asked only here, where the answer matters.
        const confirmed = await githubVerifiedEmail(cfg.userinfoUrl, accessToken, email);
        if (confirmed) email = confirmed;
        emailVerified = Boolean(confirmed);
      } else {
        emailVerified = assertsVerified(pick(profile, "email_verified"));
      }
      // Never attach an identity to an existing account by email. Slipgate does not record whether
      // a local address was ever proven (registration may skip the code, admins create users), so a
      // matching address, verified by the provider or not, may belong to whoever registered it
      // first; and not every provider verifies its addresses. The owner signs in the usual way and
      // links the provider from the profile page instead.
      if (email && (await store.findUserByEmail(email))) return fail("email_registered");
      const settings = await store.ops.getSettings();
      if (!cfg.allowSignup || !settings.allowRegistration) return fail("signup_closed");
      // Only a provider-verified address becomes the account email: an unproven one could claim (and
      // later reset the password of) a mailbox that belongs to someone else.
      const trusted = email && emailVerified ? email : "";
      // Backend mode, reserved domain, allowlist / per-domain quota and an account of the same inbox.
      const refusal = ctx.guards ? await ctx.guards.oauthSignupRefusal(trusted, settings) : null;
      if (refusal) return fail(refusal);

      if (settings.inviteRequired) {
        const continueToken = b64url(crypto.getRandomValues(new Uint8Array(32)));
        const tokenHash = createHash("sha256").update(continueToken).digest("hex");
        await store.ops.createPendingOAuthSignup({
          tokenHash,
          provider: id.data,
          subject,
          suggestedEmail: trusted,
          suggestedUsername: name,
          avatarUrl,
          bindingHash: entry.binding,
          redirectPath: entry.redirect || "/dashboard",
          expiresAtIso: new Date(Date.now() + PENDING_SIGNUP_TTL_MS).toISOString(),
        });
        return c.redirect(`${base}/oauth/complete#${new URLSearchParams({ continue: continueToken }).toString()}`, 302);
      }

      let createdNewUser = false;
      for (let attempt = 0; !userId; attempt++) {
        try {
          const created = await store.ops.createUser({
            email: trusted || placeholderEmail(id.data, subject, attempt ? toHex(crypto.getRandomValues(new Uint8Array(4))) : ""),
            username: name,
            avatarUrl,
            emailVerified: Boolean(trusted),
            role: "user",
            notes: `Signed up with ${cfg.displayName || id.data}`,
            allowedGroupIds: [],
            // Random, never shown: the account signs in with the provider (or resets by email).
            passwordHash: await hashPassword(toHex(crypto.getRandomValues(new Uint8Array(24)))),
            initialBalanceNano: BigInt(settings.defaultBalanceNanoUsd),
          });
          userId = created.id;
          createdNewUser = true;
        } catch (err) {
          const conflict = err instanceof StoreError && err.code === "conflict";
          // A verified address taken meanwhile: lost a race with a registration of it.
          if (conflict && trusted) return fail("email_registered");
          // Placeholders are predictable, so someone may have registered this one first: the
          // next attempt gets a random suffix.
          if (!conflict || attempt >= 2) return fail("signup_failed");
        }
      }
      try {
        await store.ops.linkIdentity(userId, id.data, subject);
      } catch {
        // Another callback of the same identity won the race: drop this account (best effort, it
        // was never used) and sign in to the one that holds the identity.
        createdNewUser = false;
        await store.ops.deleteUser(userId).catch(() => undefined);
        userId = await store.ops.findUserIdByIdentity(id.data, subject);
        if (!userId) return fail("signup_failed");
      }
      if (createdNewUser) {
        await applySignupDefaults(store, userId, settings, ctx.syncDataPlane);
      }
    }
    const user = await store.getUserById(userId);
    if (!user) return fail("signup_failed");
    if (user.status !== "active") return fail("suspended");
    if (user.role !== "admin" && (await ctx.guards?.backendMode())) return fail("backend_mode");
    if (user.totpEnabled) return fail("totp_required");
    // No token in the URL: the landing page trades this one-time code for a session, and only in
    // the browser that started the flow. A token in the fragment would let anyone send a victim a
    // link that silently signs them in to the sender's account (login CSRF).
    const handoff = b64url(crypto.getRandomValues(new Uint8Array(32)));
    handoffs.set(handoff, { userId: user.id, binding: entry.binding, redirect: entry.redirect, expiresAt: Date.now() + HANDOFF_TTL_MS });
    return c.redirect(`${base}/oauth/complete#${new URLSearchParams({ code: handoff }).toString()}`, 302);
  });

  /**
   * The landing page's exchange of its hand-off code for a session. Same-origin fetch from the
   * page the callback redirected to, so it carries the binding cookie of the browser that started
   * the flow; any other browser (or a guessed cookie) gets nothing, and the code is spent either way.
   */
  app.post("/api/v1/auth/oauth/complete", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const code = body && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
    const entry = typeof code === "string" && code.length <= 128 ? handoffs.take(code) : undefined;
    const refuse = (error: string, message: string, status: 400 | 403) => c.json({ error, message }, status);
    if (!entry) return refuse("state_invalid", "The sign-in request expired, start again", 400);
    if (!sameBinding(entry.binding, readBinding(c, await baseUrl(c)))) {
      return refuse("browser_mismatch", "Sign-in must finish in the browser that started it", 403);
    }
    const user = await store.getUserById(entry.userId);
    if (!user) return refuse("session", "The account no longer exists", 400);
    if (user.status !== "active") return refuse("suspended", "Account is suspended", 403);
    if (user.role !== "admin" && (await ctx.guards?.backendMode())) {
      return refuse("backend_mode", "Backend mode is on: only administrators can sign in", 403);
    }
    if (user.totpEnabled) return refuse("totp_required", "Sign in with email, password and two-factor code", 403);
    await store.ops.touchLastLogin(user.id);
    // Same token as a password sign-in: carries the user's token version, so it can be revoked.
    const { token } = await issueAccessToken(store, jwtSecret, user);
    return c.json({ accessToken: token, redirect: entry.redirect });
  });

  app.get("/api/v1/auth/oauth/pending/:token", async (c) => {
    const rawToken = c.req.param("token");
    if (!rawToken || rawToken.length > 256) {
      return c.json({ error: "state_invalid", message: "The sign-up continuation request expired" }, 400);
    }
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const rec = await store.ops.getPendingOAuthSignup(tokenHash);
    if (!rec) {
      return c.json({ error: "state_invalid", message: "The sign-up continuation request expired" }, 400);
    }
    if (!sameBinding(rec.bindingHash, readBinding(c, await baseUrl(c)))) {
      return c.json({ error: "browser_mismatch", message: "Sign-up must finish in the browser that started it" }, 403);
    }
    const [{ configs }, settings] = await Promise.all([loadAll(), store.ops.getSettings()]);
    const cfg = configs.find((p) => p.id === rec.provider);
    const summary = OAuthPendingSignupSummarySchema.parse({
      provider: rec.provider,
      displayName: cfg?.displayName || PRESETS[rec.provider].displayName,
      suggestedUsername: rec.suggestedUsername,
      avatarUrl: rec.avatarUrl,
      inviteRequired: settings.inviteRequired,
      promoCodeEnabled: settings.promoCodeEnabled,
    });
    return c.json(summary);
  });

  app.post("/api/v1/auth/oauth/continue", async (c) => {
    const rawBody = await c.req.json().catch(() => null);
    const parsed = OAuthContinueSignupRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: "Invalid continuation parameters" }, 400);
    }
    const req = parsed.data;
    const tokenHash = createHash("sha256").update(req.token).digest("hex");
    const pendingRec = await store.ops.getPendingOAuthSignup(tokenHash);
    if (!pendingRec) {
      return c.json({ error: "state_invalid", message: "The sign-up continuation request expired" }, 400);
    }
    if (!sameBinding(pendingRec.bindingHash, readBinding(c, await baseUrl(c)))) {
      return c.json({ error: "browser_mismatch", message: "Sign-up must finish in the browser that started it" }, 403);
    }
    const settings = await store.ops.getSettings();
    if (!settings.allowRegistration) {
      return c.json({ error: "signup_closed", message: "Registration is disabled" }, 403);
    }
    if (await ctx.guards?.backendMode()) {
      return c.json({ error: "backend_mode", message: "Backend mode is on: only administrators can sign in" }, 403);
    }
    if (settings.inviteRequired) {
      if (!req.inviteCode || !(await store.ops.isInvitationCodeUsable(req.inviteCode))) {
        return c.json({ error: "invite_required", message: "A valid invitation code is required to register" }, 400);
      }
    }
    const promoCode = settings.promoCodeEnabled && req.promoCode ? req.promoCode : undefined;
    if (promoCode) {
      const check = await store.ops.checkPromoCode(promoCode);
      if (!check.valid) {
        return c.json({ error: "invalid_promo_code", message: `Promo code is ${check.reason.replace("_", " ")}` }, 400);
      }
    }
    const existingByIdentity = await store.ops.findUserIdByIdentity(pendingRec.provider, pendingRec.subject);
    if (existingByIdentity) {
      await store.ops.consumePendingOAuthSignup(tokenHash);
      const existingUser = await store.getUserById(existingByIdentity);
      if (!existingUser || existingUser.status !== "active") {
        return c.json({ error: "signup_failed", message: "Could not complete sign-in" }, 400);
      }
      if (existingUser.totpEnabled) {
        return c.json({ error: "totp_required", message: "Sign in with email, password and two-factor code" }, 403);
      }
      await store.ops.touchLastLogin(existingUser.id);
      const { token } = await issueAccessToken(store, jwtSecret, existingUser);
      return c.json({ accessToken: token, redirect: pendingRec.redirectPath });
    }
    const trusted = pendingRec.suggestedEmail;
    if (trusted && (await store.findUserByEmail(trusted))) {
      return c.json({ error: "email_registered", message: "An account with that email already exists" }, 409);
    }
    const refusal = ctx.guards ? await ctx.guards.oauthSignupRefusal(trusted, settings) : null;
    if (refusal) {
      return c.json({ error: refusal, message: "Sign-up is not permitted for this address" }, 403);
    }

    const consumed = await store.ops.consumePendingOAuthSignup(tokenHash);
    if (!consumed) {
      return c.json({ error: "state_invalid", message: "The sign-up continuation request expired" }, 400);
    }

    const { configs } = await loadAll();
    const cfg = configs.find((p) => p.id === consumed.provider);
    const username = req.username?.trim() || consumed.suggestedUsername;

    const createAccount = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await store.ops.createUser({
            email: trusted || placeholderEmail(consumed.provider, consumed.subject, attempt ? toHex(crypto.getRandomValues(new Uint8Array(4))) : ""),
            username,
            avatarUrl: consumed.avatarUrl,
            emailVerified: Boolean(trusted),
            role: "user",
            notes: `Signed up with ${cfg?.displayName || PRESETS[consumed.provider].displayName}`,
            allowedGroupIds: [],
            passwordHash: await hashPassword(toHex(crypto.getRandomValues(new Uint8Array(24)))),
            initialBalanceNano: BigInt(settings.defaultBalanceNanoUsd),
          });
        } catch (err) {
          const isConflict = err instanceof StoreError && err.code === "conflict";
          if ((isConflict && trusted) || !isConflict || attempt >= 2) throw err;
        }
      }
      throw new StoreError("conflict", "Could not allocate account");
    };

    const created = settings.inviteRequired
      ? await store.ops.registerWithInvitation(req.inviteCode ?? "", createAccount)
      : await createAccount();
    if (!created) {
      return c.json({ error: "invite_required", message: "A valid invitation code is required to register" }, 400);
    }

    await store.ops.applyRegistrationExtras(created.id, {
      username,
      promoCode,
      affCode: settings.affiliateEnabled ? req.affCode : undefined,
    });
    await store.ops.linkIdentity(created.id, consumed.provider, consumed.subject).catch(() => undefined);
    await applySignupDefaults(store, created.id, settings, ctx.syncDataPlane);
    await store.ops.touchLastLogin(created.id);
    const finalUser = (await store.getUserById(created.id)) ?? created;
    const { token } = await issueAccessToken(store, jwtSecret, finalUser);
    return c.json({ accessToken: token, redirect: consumed.redirectPath });
  });

  /* ---------------- Self-service linking ---------------- */

  app.get("/api/v1/user/oauth", async (c) => {
    const { configs, secrets } = await loadAll();
    const linked = await store.ops.listIdentities(c.get("authUser").sub);
    return c.json({
      providers: configs.filter((p) => usable(p, secrets.get(p.id) ?? "")).map((p) => ({ id: p.id, displayName: p.displayName })),
      linked,
    });
  });

  app.post("/api/v1/user/oauth/:id/link", async (c) => {
    const id = parseProvider(c.req.param("id"));
    const userId = c.get("authUser").sub;
    if (!limiter.allow(`link:${userId}`) || !limiter.allow(`link-ip:${clientIp(c)}`)) {
      throw new StoreError("forbidden", "Too many attempts");
    }
    // The flow ends on the API base URL origin, and the ticket only works where its binding cookie
    // lives: a console opened elsewhere (another host, or http while the site is https) cannot
    // link, so say so here rather than bouncing to a profile page on another origin.
    const canonical = await consoleOffBase(c);
    if (canonical) {
      return c.json({ error: "link_wrong_host", message: `Open the console at ${canonical} to link a sign-in method`, origin: canonical }, 409);
    }
    // The console's same-origin fetch stores the binding cookie; /start then accepts the ticket only
    // from this browser.
    const binding = bindingHash(bindBrowser(c, await baseUrl(c)));
    const ticket = toHex(crypto.getRandomValues(new Uint8Array(24)));
    linkTickets.set(ticket, { userId, provider: id, binding, expiresAt: Date.now() + LINK_TICKET_TTL_MS });
    return c.json({ url: `/api/v1/auth/oauth/${id}/start?link_ticket=${ticket}&redirect=/profile` });
  });

  app.delete("/api/v1/user/oauth/:id", async (c) => {
    const id = parseProvider(c.req.param("id"));
    await store.ops.unlinkIdentity(c.get("authUser").sub, id);
    return c.json({ unlinked: true });
  });
}
