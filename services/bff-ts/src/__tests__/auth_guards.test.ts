import { describe, expect, it } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  isRegistrationEmailSuffixAllowed,
  isReservedEmail,
  loginAgreementRevision,
  normalizeEmailForAliasDedup,
  normalizeLoginAgreementDocuments,
  normalizeRegistrationEmailSuffix,
  PortalSettingsSchema,
  registrableEmailDomain,
  registrationEmailDomain,
  type AuthSessionResponse,
  type CaptchaConfig,
  type CaptchaTestResult,
  type LegalDocumentResponse,
  type PortalSettings,
  type PublicSettings,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import type { MailMessage } from "../mail/smtp.ts";
import { aliyunSignedHeaders, tencentSignedHeaders, TURNSTILE_VERIFY_URL } from "../security/captcha.ts";
import { totpAt, TOTP_STEP_SECONDS } from "../security/totp.ts";
import { pgRegistrationConflict, RegistrationGuardError } from "../store/auth_guards_store.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";

/**
 * Auth guards (lane A1): captcha on login / sign-up / email codes / forgot password / OAuth start
 * (Turnstile, Tencent, Aliyun, verification calls stubbed through `captchaFetch`), the sign-up
 * email policy (allowlist, per-domain quota, inbox aliases, reserved domain), the login agreement
 * documents and backend (admin-only) mode. Runs on Postgres too when a preload installs a factory.
 */

type StoreFactory = () => Promise<ControlStore>;
const storeFactory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
const onPostgres = Boolean(storeFactory);

const JSON_HEADERS = { "Content-Type": "application/json" };
const ADMIN_PASSWORD = "AdminPassword123!";
const USER_PASSWORD = "UserPassword123!";
const ORIGIN = "http://portal.test";

const fromPeer = (address: string) => ({ requestIP: () => ({ address, family: "IPv4", port: 40000 }) });
const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/* ---------------------------------------------------------------------------------------- */
/* Fake captcha providers                                                                    */
/* ---------------------------------------------------------------------------------------- */

const TENCENT = { appId: "190000001", appSecretKey: "tc-app-secret", secretId: "AKIDtencent", secretKey: "tc-cloud-secret" };
const ALIYUN = { accessKeyId: "LTAIaliyun", accessKeySecret: "ali-secret", sceneId: "scene-1", prefix: "pfx1" };

/** Independent TC3-HMAC-SHA256 check of a request the BFF sent. */
function tencentSignatureValid(headers: Headers, body: string, secretKey: string): boolean {
  const auth = headers.get("authorization") ?? "";
  const m = /^TC3-HMAC-SHA256 Credential=([^/]+)\/(\d{4}-\d{2}-\d{2})\/captcha\/tc3_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return false;
  const [, , date, signed, signature] = m;
  const ts = headers.get("x-tc-timestamp") ?? "";
  if (new Date(Number(ts) * 1000).toISOString().slice(0, 10) !== date) return false;
  const canonicalHeaders = `content-type:${headers.get("content-type")}\nhost:${headers.get("host")}\nx-tc-action:${(headers.get("x-tc-action") ?? "").toLowerCase()}\n`;
  const canonical = `POST\n/\n\n${canonicalHeaders}\n${signed}\n${sha256Hex(body)}`;
  const toSign = `TC3-HMAC-SHA256\n${ts}\n${date}/captcha/tc3_request\n${sha256Hex(canonical)}`;
  const kDate = createHmac("sha256", `TC3${secretKey}`).update(date!).digest();
  const kService = createHmac("sha256", kDate).update("captcha").digest();
  const kSigning = createHmac("sha256", kService).update("tc3_request").digest();
  return createHmac("sha256", kSigning).update(toSign).digest("hex") === signature;
}

/** Independent ACS3-HMAC-SHA256 check of a request the BFF sent. */
function aliyunSignatureValid(headers: Headers, body: string, secret: string): boolean {
  const auth = headers.get("authorization") ?? "";
  const m = /^ACS3-HMAC-SHA256 Credential=([^,]+),SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return false;
  const [, , signed, signature] = m;
  if (headers.get("x-acs-content-sha256") !== sha256Hex(body)) return false;
  const names = signed!.split(";");
  const canonicalHeaders = names.map((n) => `${n}:${(headers.get(n) ?? "").trim()}\n`).join("");
  const canonical = `POST\n/\n\n${canonicalHeaders}\n${signed}\n${sha256Hex(body)}`;
  const toSign = `ACS3-HMAC-SHA256\n${sha256Hex(canonical)}`;
  return createHmac("sha256", secret).update(toSign).digest("hex") === signature;
}

function fakeProviders() {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const state = { down: false };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    // What the wire carries: fetch fills Host in from the URL.
    if (!headers.has("host")) headers.set("host", new URL(url).host);
    calls.push({ url, headers, body });
    if (state.down) throw new Error("connect ECONNREFUSED");
    if (url === TURNSTILE_VERIFY_URL) {
      const form = new URLSearchParams(body);
      if (form.get("secret") !== "ts-secret") return Response.json({ success: false, "error-codes": ["invalid-input-secret"] });
      if (form.get("response") === "good-token") return Response.json({ success: true, hostname: "portal.test" });
      return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
    }
    if (url === "https://captcha.tencentcloudapi.com/" || url === "https://captcha.intl.tencentcloudapi.com/") {
      if (!(headers.get("authorization") ?? "").includes(`Credential=${TENCENT.secretId}/`) || !tencentSignatureValid(headers, body, TENCENT.secretKey)) {
        return Response.json({ Response: { Error: { Code: "AuthFailure.SignatureFailure", Message: "bad signature" }, RequestId: "r1" } });
      }
      const p = JSON.parse(body) as Record<string, unknown>;
      if (p.CaptchaAppId !== Number(TENCENT.appId) || p.AppSecretKey !== TENCENT.appSecretKey) {
        return Response.json({ Response: { CaptchaCode: 100, CaptchaMsg: "appid-secretkey-ticket mismatch", RequestId: "r2" } });
      }
      const pass = p.Ticket === "good-ticket" && p.Randstr === "rs-1" && p.CaptchaType === 9;
      return Response.json({ Response: { CaptchaCode: pass ? 1 : 9, CaptchaMsg: pass ? "OK" : "ticket invalid", RequestId: "r3" } });
    }
    if (url === "https://captcha.cn-shanghai.aliyuncs.com/" || url === "https://captcha.ap-southeast-1.aliyuncs.com/") {
      if (!(headers.get("authorization") ?? "").includes(`Credential=${ALIYUN.accessKeyId},`)) {
        return Response.json({ Code: "InvalidAccessKeyId.NotFound", Message: "Specified access key is not found." }, { status: 404 });
      }
      if (!aliyunSignatureValid(headers, body, ALIYUN.accessKeySecret)) {
        return Response.json({ Code: "SignatureDoesNotMatch", Message: "signature mismatch" }, { status: 400 });
      }
      const form = new URLSearchParams(body);
      const pass = form.get("CaptchaVerifyParam") === "good param+/=" && form.get("SceneId") === ALIYUN.sceneId;
      return Response.json({ RequestId: "a1", Success: true, Code: "Success", Result: { VerifyResult: pass, VerifyCode: pass ? "T001" : "F002" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, state };
}

/* ---------------------------------------------------------------------------------------- */
/* App bootstrap                                                                             */
/* ---------------------------------------------------------------------------------------- */

async function bootstrap() {
  const store = storeFactory ? await storeFactory() : new MemoryControlStore();
  const providers = fakeProviders();
  const mails: MailMessage[] = [];
  const app = createBffApp({
    store,
    jwtSecret: "auth-guards-jwt-secret-32-bytes-minimum",
    vaultSecret: "auth-guards-vault-secret-32-bytes-minimum",
    captchaFetch: providers.fetchImpl,
    mailDelivery: async (_cfg, msg) => {
      mails.push(msg);
    },
  });
  const call = async <T = Record<string, unknown>>(
    method: string,
    path: string,
    init: { token?: string; body?: unknown; peer?: string; headers?: Record<string, string> } = {},
  ) => {
    const headers: Record<string, string> = { ...JSON_HEADERS, ...(init.headers ?? {}) };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    const res = await app.request(
      `${ORIGIN}${path}`,
      { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
      init.peer ? fromPeer(init.peer) : undefined,
    );
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  };
  const init = await call<AuthSessionResponse>("POST", "/api/v1/setup/initialize", {
    body: { siteName: "Guards", adminEmail: "admin@guards.test", adminPassword: ADMIN_PASSWORD, allowRegistration: true },
  });
  expect(init.status).toBe(201);
  const admin = init.body.accessToken;
  const register = (email: string, extra: Record<string, unknown> = {}, peer?: string) =>
    call<AuthSessionResponse & { error?: string; message?: string; allowedSuffixes?: string[] }>("POST", "/api/v1/auth/register", {
      body: { email, password: USER_PASSWORD, ...extra },
      peer,
    });
  const login = (email: string, password: string, extra: Record<string, unknown> = {}) =>
    call<AuthSessionResponse & { error?: string; captchaPass?: string }>("POST", "/api/v1/auth/login", { body: { email, password, ...extra } });
  const patchSettings = async (patch: Record<string, unknown>) => {
    const res = await call<PortalSettings & { error?: string; message?: string }>("PATCH", "/api/v1/admin/settings", { token: admin, body: patch });
    return res;
  };
  const publicSettings = async () => (await call<PublicSettings>("GET", "/api/v1/public/settings")).body;
  const patchCaptcha = (body: Record<string, unknown>) =>
    call<CaptchaConfig & { error?: string; message?: string; missing?: string[] }>("PATCH", "/api/v1/admin/captcha", { token: admin, body });
  const enableTurnstile = async (scopes: Record<string, boolean> = {}) => {
    const res = await patchCaptcha({ provider: "turnstile", turnstileSiteKey: "0x4site", turnstileSecretKey: "ts-secret", scopes });
    expect(res.status).toBe(200);
    return res.body;
  };
  const enableMail = async () => {
    const res = await call("PATCH", "/api/v1/admin/email/config", {
      token: admin,
      body: { enabled: true, host: "smtp.guards.test", fromAddress: "noreply@guards.test" },
    });
    expect(res.status).toBe(200);
  };
  return { app, store, providers, mails, call, admin, register, login, patchSettings, publicSettings, patchCaptcha, enableTurnstile, enableMail };
}

/* ---------------------------------------------------------------------------------------- */
/* Pure helpers                                                                              */
/* ---------------------------------------------------------------------------------------- */

/** Address -> inbox identity (Linksyncx NormalizeEmailForAliasDedup cases). */
const ALIAS_CASES: [string, string][] = [
  ["User+Tag@Example.com", "user@example.com"],
  ["user+a+b@example.com", "user@example.com"],
  ["+tag@example.com", "+tag@example.com"],
  ["u.s.e.r@gmail.com", "user@gmail.com"],
  ["U.S.E.R+promo@GoogleMail.com", "user@gmail.com"],
  ["first.last@outlook.com", "first.last@outlook.com"],
  ["user@gmail.com.", "user@gmail.com"],
  ["user@example.com..", "user@example.com"],
  ["...@gmail.com", "...@gmail.com"],
  [".+x@gmail.com", ".@gmail.com"],
  ["  Mixed.Case@Example.ORG\t", "mixed.case@example.org"],
  ["no-at-sign", "no-at-sign"],
  ["@example.com", "@example.com"],
  ["user@", "user@"],
  ["a@b@c.com", "a@b@c.com"],
  ["user@.", "user@."],
];

describe("auth guard helpers", () => {
  it("normalises inbox aliases like Linksyncx (plus tags, Gmail dots, googlemail, FQDN dot)", () => {
    for (const [input, want] of ALIAS_CASES) expect(normalizeEmailForAliasDedup(input)).toBe(want);
  });

  it("finds registrable domains and the reserved placeholder domain", () => {
    expect(registrableEmailDomain("mail.dept.example.com")).toBe("example.com");
    expect(registrableEmailDomain("example.com.")).toBe("example.com");
    expect(registrableEmailDomain("cs.tsinghua.edu.cn")).toBe("tsinghua.edu.cn");
    expect(registrableEmailDomain("a.b.co.uk")).toBe("b.co.uk");
    expect(registrableEmailDomain("edu.cn")).toBe("edu.cn");
    expect(registrationEmailDomain("x@Mail.Example.COM")).toBe("example.com");
    expect(registrationEmailDomain("broken")).toBe("");
    expect(isReservedEmail("github-1@users.noreply.slipgate")).toBe(true);
    expect(isReservedEmail("x@USERS.noreply.slipgate.")).toBe(true);
    expect(isReservedEmail("x@a.users.noreply.slipgate")).toBe(true);
    expect(isReservedEmail("x@users.noreply.slipgate.example.com")).toBe(false);
  });

  it("normalises allowlist entries and matches exact and wildcard suffixes", () => {
    expect(normalizeRegistrationEmailSuffix("Example.COM")).toBe("@example.com");
    expect(normalizeRegistrationEmailSuffix("@corp.test")).toBe("@corp.test");
    expect(normalizeRegistrationEmailSuffix("*.EDU.cn")).toBe("*.edu.cn");
    expect(normalizeRegistrationEmailSuffix("  ")).toBe("");
    for (const bad of ["*.", "a@b.com", "@@b.com", "nodot", "-bad.com", "*.bad_.com"]) expect(normalizeRegistrationEmailSuffix(bad)).toBeNull();
    const list = ["@corp.test", "*.edu.cn"];
    expect(isRegistrationEmailSuffixAllowed("a@corp.test", list)).toBe(true);
    expect(isRegistrationEmailSuffixAllowed("a@CORP.test.", list)).toBe(true);
    expect(isRegistrationEmailSuffixAllowed("a@sub.corp.test", list)).toBe(false);
    expect(isRegistrationEmailSuffixAllowed("a@edu.cn", list)).toBe(true);
    expect(isRegistrationEmailSuffixAllowed("a@cs.pku.edu.cn", list)).toBe(true);
    expect(isRegistrationEmailSuffixAllowed("a@notedu.cn", list)).toBe(false);
    expect(isRegistrationEmailSuffixAllowed("anything@else.test", [])).toBe(true);
    const parsed = PortalSettingsSchema.shape.registrationEmailSuffixAllowlist.safeParse(["Corp.test", "@corp.test", "", "*.edu.cn"]);
    expect(parsed.success && parsed.data).toEqual(["@corp.test", "*.edu.cn"]);
    expect(PortalSettingsSchema.shape.registrationEmailSuffixAllowlist.safeParse(["bad entry"]).success).toBe(false);
  });

  it("normalises agreement documents and moves the revision with any change", () => {
    const docs = normalizeLoginAgreementDocuments([
      { id: "Terms Of Service", title: " Terms ", contentMd: "# Terms" },
      { id: "", title: "隐私政策", contentMd: "privacy" },
      { id: "terms/of.service", title: "Dup", contentMd: "x" },
      { id: "x", title: "", contentMd: "" },
      { id: "__Priv__", title: "Privacy", contentMd: "p" },
    ]) as { id: string; title: string }[];
    expect(docs.map((d) => d.id)).toEqual(["terms-of-service", expect.stringMatching(/^doc-[0-9a-f]{10}$/), "terms-of-service-2", "priv"]);
    expect(docs[0]!.title).toBe("Terms");
    const base = [{ id: "terms", title: "Terms", contentMd: "a" }];
    const rev = loginAgreementRevision("2026-03-31", base);
    expect(rev).toMatch(/^[0-9a-f]{16}$/);
    expect(loginAgreementRevision("2026-03-31", base)).toBe(rev);
    expect(loginAgreementRevision("2026-04-01", base)).not.toBe(rev);
    expect(loginAgreementRevision("2026-03-31", [{ ...base[0]!, contentMd: "b" }])).not.toBe(rev);
  });

  it("signs Tencent and Aliyun calls the way the providers check them", () => {
    const body = JSON.stringify({ Ticket: "t" });
    const tc = new Headers(tencentSignedHeaders({ secretId: "id", secretKey: "key", region: "intl" }, body, 1_700_000_000));
    expect(tc.get("host")).toBe("captcha.intl.tencentcloudapi.com");
    expect(tc.get("x-tc-version")).toBe("2019-07-22");
    expect(tencentSignatureValid(tc, body, "key")).toBe(true);
    expect(tencentSignatureValid(tc, body, "other")).toBe(false);
    const form = "CaptchaVerifyParam=a%20b&SceneId=s";
    const ali = new Headers(aliyunSignedHeaders({ accessKeyId: "id", accessKeySecret: "sec", region: "sgp" }, form, "2026-11-22T10:00:00Z", "n1"));
    expect(ali.get("host")).toBe("captcha.ap-southeast-1.aliyuncs.com");
    expect(ali.get("x-acs-version")).toBe("2023-03-05");
    expect(aliyunSignatureValid(ali, form, "sec")).toBe(true);
    expect(aliyunSignatureValid(ali, `${form}x`, "sec")).toBe(false);
  });
});

/* ---------------------------------------------------------------------------------------- */
/* Captcha                                                                                   */
/* ---------------------------------------------------------------------------------------- */

describe("captcha", () => {
  it("saves a provider only with complete, accepted credentials and never returns or audits the secret", async () => {
    const t = await bootstrap();
    const missing = await t.patchCaptcha({ provider: "turnstile", turnstileSiteKey: "0x4site" });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe("captcha_not_configured");
    expect(missing.body.missing).toEqual(["turnstileSecretKey"]);
    const refused = await t.patchCaptcha({ provider: "turnstile", turnstileSiteKey: "0x4site", turnstileSecretKey: "wrong" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("captcha_invalid_credentials");
    // Nothing was saved by the refused attempts.
    expect((await t.call<CaptchaConfig>("GET", "/api/v1/admin/captcha", { token: t.admin })).body.provider).toBe("none");
    t.providers.state.down = true;
    const unreachable = await t.patchCaptcha({ provider: "turnstile", turnstileSiteKey: "0x4site", turnstileSecretKey: "ts-secret" });
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.error).toBe("captcha_unavailable");
    t.providers.state.down = false;

    const saved = await t.enableTurnstile();
    expect(saved.provider).toBe("turnstile");
    expect(saved.turnstileSecretKeySet).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("ts-secret");
    const view = await t.call<CaptchaConfig>("GET", "/api/v1/admin/captcha", { token: t.admin });
    expect(view.body.turnstileSecretKeySet).toBe(true);
    expect(JSON.stringify(view.body)).not.toContain("ts-secret");
    // Stored encrypted.
    expect(JSON.stringify(await t.store.ops.getBlob("captcha_config"))).not.toContain("ts-secret");
    const audit = await t.call("GET", "/api/v1/admin/audit-logs?pageSize=50", { token: t.admin });
    expect(JSON.stringify(audit.body)).toContain("/api/v1/admin/captcha");
    expect(JSON.stringify(audit.body)).not.toContain("ts-secret");
    // Users can't read or change it.
    const user = await t.register("plain@guards.test", { captcha: { turnstileToken: "good-token" } });
    expect(user.status).toBe(201);
    expect((await t.call("GET", "/api/v1/admin/captcha", { token: user.body.accessToken })).status).toBe(403);
    expect((await t.call("PATCH", "/api/v1/admin/captcha", { token: user.body.accessToken, body: { provider: "none" } })).status).toBe(403);
    // Clearing the secret of the active provider is refused; switching off is not.
    expect((await t.patchCaptcha({ turnstileSecretKey: "" })).body.error).toBe("captcha_not_configured");
    expect((await t.patchCaptcha({ provider: "none" })).body.provider).toBe("none");
  });

  it("publishes the widget parameters and enforces the challenge on login (fail-closed)", async () => {
    const t = await bootstrap();
    const before = await t.publicSettings();
    expect(before.captcha.provider).toBe("none");
    const user = await t.register("alice@guards.test");
    expect(user.status).toBe(201);
    await t.enableTurnstile();
    const pub = await t.publicSettings();
    expect(pub.captcha).toMatchObject({ provider: "turnstile", turnstileSiteKey: "0x4site", scopes: { login: true, register: true, oauth: false } });
    expect(JSON.stringify(pub)).not.toContain("ts-secret");

    expect((await t.login("alice@guards.test", USER_PASSWORD)).body.error).toBe("captcha_required");
    const wrong = await t.login("alice@guards.test", USER_PASSWORD, { captcha: { turnstileToken: "bad-token" } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe("captcha_invalid");
    const ok = await t.login("alice@guards.test", USER_PASSWORD, { captcha: { turnstileToken: "good-token" } });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    // The client address goes to the provider when there is a socket peer.
    const viaPeer = await t.app.request(
      `${ORIGIN}/api/v1/auth/login`,
      { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ email: "alice@guards.test", password: USER_PASSWORD, captcha: { turnstileToken: "good-token" } }) },
      fromPeer("203.0.113.9"),
    );
    expect(viaPeer.status).toBe(200);
    expect(new URLSearchParams(t.providers.calls.at(-1)!.body).get("remoteip")).toBe("203.0.113.9");

    t.providers.state.down = true;
    const down = await t.login("alice@guards.test", USER_PASSWORD, { captcha: { turnstileToken: "good-token" } });
    expect(down.status).toBe(503);
    expect(down.body.error).toBe("captcha_unavailable");
    t.providers.state.down = false;

    // A scope that is off needs no challenge.
    expect((await t.patchCaptcha({ scopes: { login: false } })).status).toBe(200);
    expect((await t.login("alice@guards.test", USER_PASSWORD)).status).toBe(200);
    // The operator bypass switches every challenge off (and the widget in public settings).
    await t.patchCaptcha({ scopes: { login: true } });
    process.env.SLIPGATE_CAPTCHA_BYPASS = "1";
    try {
      expect((await t.login("alice@guards.test", USER_PASSWORD)).status).toBe(200);
      expect((await t.publicSettings()).captcha.provider).toBe("none");
    } finally {
      delete process.env.SLIPGATE_CAPTCHA_BYPASS;
    }
  });

  it("hands the two-factor step a one-time pass instead of a second challenge", async () => {
    const t = await bootstrap();
    const user = await t.register("totp@guards.test");
    const token = user.body.accessToken;
    const setup = await t.call<{ secret: string }>("POST", "/api/v1/user/totp/setup", { token, body: { password: USER_PASSWORD } });
    expect(setup.status).toBe(200);
    const step = () => Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    expect((await t.call("POST", "/api/v1/user/totp/enable", { token, body: { code: await totpAt(setup.body.secret, step() - 1) } })).status).toBe(200);
    await t.enableTurnstile();

    const first = await t.login("totp@guards.test", USER_PASSWORD, { captcha: { turnstileToken: "good-token" } });
    expect(first.body.error).toBe("totp_required");
    expect(first.body.captchaPass).toBeTruthy();
    // A wrong code spends the pass but hands out a new one.
    const wrong = await t.login("totp@guards.test", USER_PASSWORD, { totpCode: "000000", captcha: { pass: first.body.captchaPass } });
    expect(wrong.body.error).toBe("invalid_totp");
    expect(wrong.body.captchaPass).toBeTruthy();
    // Spent passes and passes of another account don't count.
    expect((await t.login("totp@guards.test", USER_PASSWORD, { totpCode: "000000", captcha: { pass: first.body.captchaPass } })).body.error).toBe(
      "captcha_required",
    );
    expect((await t.login("admin@guards.test", ADMIN_PASSWORD, { captcha: { pass: wrong.body.captchaPass } })).body.error).toBe("captcha_required");
    const pass = (await t.login("totp@guards.test", USER_PASSWORD, { captcha: { turnstileToken: "good-token" } })).body.captchaPass;
    const done = await t.login("totp@guards.test", USER_PASSWORD, { totpCode: await totpAt(setup.body.secret, step()), captcha: { pass } });
    expect(done.status).toBe(200);
    expect(done.body.accessToken).toBeTruthy();
  });

  it("guards sign-up, email codes and forgot password; an email code covers the sign-up challenge", async () => {
    const t = await bootstrap();
    await t.enableMail();
    await t.patchSettings({ apiBaseUrl: "https://portal.guards.test" });
    await t.enableTurnstile();
    expect((await t.register("bob@guards.test")).body.error).toBe("captcha_required");
    expect((await t.register("bob@guards.test", { captcha: { turnstileToken: "bad" } })).body.error).toBe("captcha_invalid");
    expect((await t.register("bob@guards.test", { captcha: { turnstileToken: "good-token" } })).status).toBe(201);

    expect((await t.call("POST", "/api/v1/auth/email-code", { body: { email: "carol@guards.test" } })).body).toMatchObject({ error: "captcha_required" });
    expect((await t.call("POST", "/api/v1/auth/forgot-password", { body: { email: "bob@guards.test" } })).body).toMatchObject({ error: "captcha_required" });
    const forgot = await t.call("POST", "/api/v1/auth/forgot-password", { body: { email: "bob@guards.test", captcha: { turnstileToken: "good-token" } } });
    expect(forgot.status).toBe(200);
    expect(t.mails.some((m) => m.to === "bob@guards.test")).toBe(true);

    await t.patchSettings({ emailVerificationRequired: true });
    const sent = await t.call("POST", "/api/v1/auth/email-code", { body: { email: "carol@guards.test", captcha: { turnstileToken: "good-token" } } });
    expect(sent.status).toBe(200);
    const code = /(\d{6})/.exec(t.mails.at(-1)!.subject)![1]!;
    // The code proves the challenge solved when it was sent: no second widget on the form.
    const carol = await t.register("carol@guards.test", { emailCode: code });
    expect(carol.status).toBe(201);
    // Without the email-code scope a code doesn't stand in for the challenge.
    await t.patchCaptcha({ scopes: { emailCode: false } });
    const sentAgain = await t.call("POST", "/api/v1/auth/email-code", { body: { email: "dave@guards.test" } });
    expect(sentAgain.status).toBe(200);
    const code2 = /(\d{6})/.exec(t.mails.at(-1)!.subject)![1]!;
    expect((await t.register("dave@guards.test", { emailCode: code2 })).body.error).toBe("captcha_required");
  });

  it("verifies Tencent tickets and Aliyun params with signed calls", async () => {
    const t = await bootstrap();
    const user = await t.register("tc@guards.test");
    expect(user.status).toBe(201);
    const badKeys = await t.patchCaptcha({
      provider: "tencent",
      tencentAppId: TENCENT.appId,
      tencentAppSecretKey: TENCENT.appSecretKey,
      tencentSecretId: TENCENT.secretId,
      tencentSecretKey: "wrong-cloud-key",
    });
    expect(badKeys.body.error).toBe("captcha_invalid_credentials");
    expect((await t.patchCaptcha({ provider: "tencent", tencentAppId: "0", tencentAppSecretKey: "x", tencentSecretId: "y", tencentSecretKey: "z" })).body.missing).toEqual([
      "tencentAppId",
    ]);
    const tencent = await t.patchCaptcha({
      provider: "tencent",
      tencentAppId: TENCENT.appId,
      tencentAppSecretKey: TENCENT.appSecretKey,
      tencentSecretId: TENCENT.secretId,
      tencentSecretKey: TENCENT.secretKey,
    });
    expect(tencent.status).toBe(200);
    expect(tencent.body).toMatchObject({ provider: "tencent", tencentAppSecretKeySet: true, tencentSecretIdSet: true, tencentSecretKeySet: true });
    expect((await t.publicSettings()).captcha).toMatchObject({ provider: "tencent", tencentAppId: TENCENT.appId, tencentRegion: "cn", turnstileSiteKey: "" });
    expect((await t.login("tc@guards.test", USER_PASSWORD, { captcha: {} })).body.error).toBe("captcha_required");
    // A ticket without its randstr is an incomplete (invalid) answer.
    expect((await t.login("tc@guards.test", USER_PASSWORD, { captcha: { tencentTicket: "good-ticket" } })).body.error).toBe("captcha_invalid");
    expect((await t.login("tc@guards.test", USER_PASSWORD, { captcha: { tencentTicket: "trerror_1001", tencentRandstr: "rs-1" } })).body.error).toBe(
      "captcha_invalid",
    );
    expect((await t.login("tc@guards.test", USER_PASSWORD, { captcha: { tencentTicket: "bad", tencentRandstr: "rs-1" } })).body.error).toBe("captcha_invalid");
    expect((await t.login("tc@guards.test", USER_PASSWORD, { captcha: { tencentTicket: "good-ticket", tencentRandstr: "rs-1" } })).status).toBe(200);
    const test = await t.call<CaptchaTestResult>("POST", "/api/v1/admin/captcha/test", { token: t.admin, body: {} });
    expect(test.body).toMatchObject({ ok: true, provider: "tencent", mode: "credentials" });

    const aliBad = await t.patchCaptcha({
      provider: "aliyun",
      aliyunAccessKeyId: "LTAIwrong",
      aliyunAccessKeySecret: ALIYUN.accessKeySecret,
      aliyunSceneId: ALIYUN.sceneId,
      aliyunPrefix: ALIYUN.prefix,
    });
    expect(aliBad.body.error).toBe("captcha_invalid_credentials");
    const ali = await t.patchCaptcha({
      provider: "aliyun",
      aliyunAccessKeyId: ALIYUN.accessKeyId,
      aliyunAccessKeySecret: ALIYUN.accessKeySecret,
      aliyunSceneId: ALIYUN.sceneId,
      aliyunPrefix: ALIYUN.prefix,
      aliyunRegion: "sgp",
    });
    expect(ali.status).toBe(200);
    expect((await t.publicSettings()).captcha).toMatchObject({ provider: "aliyun", aliyunSceneId: ALIYUN.sceneId, aliyunPrefix: ALIYUN.prefix, aliyunRegion: "sgp", tencentAppId: "" });
    expect((await t.login("tc@guards.test", USER_PASSWORD, { captcha: { aliyunVerifyParam: "forged" } })).body.error).toBe("captcha_invalid");
    expect((await t.login("tc@guards.test", USER_PASSWORD, { captcha: { aliyunVerifyParam: "good param+/=" } })).status).toBe(200);
    expect(t.providers.calls.at(-1)!.url).toBe("https://captcha.ap-southeast-1.aliyuncs.com/");
    const tokenTest = await t.call<CaptchaTestResult>("POST", "/api/v1/admin/captcha/test", {
      token: t.admin,
      body: { captcha: { aliyunVerifyParam: "forged" } },
    });
    expect(tokenTest.body).toMatchObject({ ok: false, mode: "token", error: "captcha_invalid" });
  });

  it("gates the OAuth sign-in start behind a one-time pass when the oauth scope is on", async () => {
    const t = await bootstrap();
    await t.enableTurnstile({ oauth: true });
    const start = (query: string) => t.app.request(`${ORIGIN}/api/v1/auth/oauth/oidc/start?${query}`);
    // No pass: back to the login page with the error (before the provider is even looked at).
    const refused = await start("redirect=/usage");
    expect(refused.status).toBe(302);
    expect(new URL(refused.headers.get("location")!).searchParams.get("oauth_error")).toBe("captcha_required");
    expect((await t.call("POST", "/api/v1/auth/captcha/pass", { body: { scope: "oauth" } })).body).toMatchObject({ error: "captcha_required" });
    const issued = await t.call<{ required: boolean; pass: string }>("POST", "/api/v1/auth/captcha/pass", {
      body: { scope: "oauth", captcha: { turnstileToken: "good-token" } },
    });
    expect(issued.body.required).toBe(true);
    // The pass gets past the gate (the provider itself is not configured here: 404 from /start).
    expect((await start(`captcha_pass=${issued.body.pass}`)).status).toBe(404);
    // One time only.
    const again = await start(`captcha_pass=${issued.body.pass}`);
    expect(new URL(again.headers.get("location")!).searchParams.get("oauth_error")).toBe("captcha_required");
    await t.patchCaptcha({ scopes: { oauth: false } });
    expect((await t.call("POST", "/api/v1/auth/captcha/pass", { body: { scope: "oauth" } })).body).toMatchObject({ required: false, pass: null });
    expect((await start("redirect=/usage")).status).toBe(404);
  });
});

/* ---------------------------------------------------------------------------------------- */
/* Sign-up email policy                                                                      */
/* ---------------------------------------------------------------------------------------- */

describe("sign-up email policy", () => {
  it("rejects the reserved placeholder domain on sign-up and admin user creation", async () => {
    const t = await bootstrap();
    const reg = await t.register("someone@users.noreply.slipgate");
    expect(reg.status).toBe(400);
    expect(reg.body.error).toBe("email_reserved");
    const created = await t.call("POST", "/api/v1/admin/users", {
      token: t.admin,
      body: { email: "x@sub.users.noreply.slipgate", password: USER_PASSWORD },
    });
    expect(created.status).toBe(400);
    expect(created.body.error).toBe("email_reserved");
  });

  it("enforces the suffix allowlist and the one-account-per-unlisted-domain quota", async () => {
    const t = await bootstrap();
    const bad = await t.patchSettings({ registrationEmailSuffixAllowlist: ["not a domain"] });
    expect(bad.status).toBe(400);
    const saved = await t.patchSettings({ registrationEmailSuffixAllowlist: ["Corp.TEST", "*.edu.cn", "@corp.test"] });
    expect(saved.status).toBe(200);
    expect(saved.body.registrationEmailSuffixAllowlist).toEqual(["@corp.test", "*.edu.cn"]);
    const pub = await t.publicSettings();
    expect(pub.registrationEmailSuffixAllowlist).toEqual(["@corp.test", "*.edu.cn"]);
    expect(pub.registrationEmailDomainQuotaEnabled).toBe(false);

    expect((await t.register("a@corp.test")).status).toBe(201);
    expect((await t.register("b@cs.pku.edu.cn")).status).toBe(201);
    expect((await t.register("c@edu.cn")).status).toBe(201);
    const sub = await t.register("d@sub.corp.test");
    expect(sub.status).toBe(400);
    expect(sub.body.error).toBe("email_suffix_not_allowed");
    expect(sub.body.allowedSuffixes).toEqual(["@corp.test", "*.edu.cn"]);
    expect((await t.register("e@other.test")).body.error).toBe("email_suffix_not_allowed");
    // Admins are exempt.
    expect((await t.call("POST", "/api/v1/admin/users", { token: t.admin, body: { email: "f@other.test", password: USER_PASSWORD } })).status).toBe(201);

    await t.patchSettings({ registrationEmailDomainQuotaEnabled: true });
    // other.test already has an account (the admin-created one).
    const taken = await t.register("g@other.test");
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("email_domain_limit");
    expect((await t.register("h@fresh.test")).status).toBe(201);
    // Subdomains count toward their registrable domain.
    expect((await t.register("i@mail.fresh.test")).body.error).toBe("email_domain_limit");
    expect((await t.register("j@x.another.co.uk")).status).toBe(201);
    expect((await t.register("k@y.another.co.uk")).body.error).toBe("email_domain_limit");
    expect((await t.register("l@other.co.uk")).status).toBe(201);
    // Listed domains are never limited.
    expect((await t.register("m@corp.test")).status).toBe(201);

    // Email codes are not mailed to addresses that could not register.
    await t.enableMail();
    const code = await t.call("POST", "/api/v1/auth/email-code", { body: { email: "n@fresh.test" } });
    expect(code.status).toBe(409);
    expect(code.body.error).toBe("email_domain_limit");
    await t.patchSettings({ registrationEmailDomainQuotaEnabled: false });
    expect((await t.call("POST", "/api/v1/auth/email-code", { body: { email: "n@nowhere.test" } })).body.error).toBe("email_suffix_not_allowed");
    // An existing account has its own code, distinct from the resend cooldown's plain `conflict`.
    const registered = await t.call("POST", "/api/v1/auth/email-code", { body: { email: "a@corp.test" } });
    expect(registered.status).toBe(409);
    expect(registered.body.error).toBe("email_registered");
    expect((await t.call("POST", "/api/v1/auth/email-code", { body: { email: "new@corp.test" } })).status).toBe(200);
    const again = await t.call("POST", "/api/v1/auth/email-code", { body: { email: "new@corp.test" } });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("conflict");
    await t.patchSettings({ allowRegistration: false });
    expect((await t.call("POST", "/api/v1/auth/email-code", { body: { email: "new2@corp.test" } })).status).toBe(403);
  });

  it("refuses a second account for one inbox (+tags, Gmail dots, googlemail.com, FQDN dot)", async () => {
    const t = await bootstrap();
    expect((await t.register("john.doe+promo@gmail.com")).status).toBe(201);
    // (Trailing-dot addresses never pass request validation; the helper tests cover them.)
    for (const variant of ["johndoe@googlemail.com", "J.O.H.N.D.O.E@gmail.com", "johndoe+again@gmail.com", "john.doe@googlemail.com"]) {
      const res = await t.register(variant);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("email_alias_exists");
    }
    // The exact address keeps its old answer.
    const exact = await t.register("JOHN.DOE+PROMO@gmail.com");
    expect(exact.status).toBe(409);
    expect(exact.body.error).toBe("conflict");
    expect((await t.register("bob@corp.test")).status).toBe(201);
    expect((await t.register("bob+x@corp.test")).body.error).toBe("email_alias_exists");
    // Dots matter outside the Gmail family.
    expect((await t.register("b.o.b@corp.test")).status).toBe(201);
    // Sign-in uses the address as registered.
    expect((await t.login("john.doe+promo@gmail.com", USER_PASSWORD)).status).toBe(200);
  });

  it("limits sign-up attempts per client address and refuses early while sign-up is closed", async () => {
    const t = await bootstrap();
    for (let i = 0; i < 5; i++) expect((await t.register(`r${i}@limit.test`, {}, "198.51.100.7")).status).toBe(201);
    const sixth = await t.register("r5@limit.test", {}, "198.51.100.7");
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toBe("too_many_attempts");
    expect(sixth.headers.get("retry-after")).toBe("60");
    expect((await t.register("r6@limit.test", {}, "198.51.100.8")).status).toBe(201);
    await t.patchSettings({ allowRegistration: false });
    await t.enableTurnstile();
    // No challenge is asked for a sign-up that can't happen.
    const closed = await t.register("r7@limit.test", {}, "198.51.100.9");
    expect(closed.status).toBe(403);
    expect(closed.body.error).toBe("forbidden");
  });

  it("checks and inserts atomically in the store (one winner among concurrent variants)", async () => {
    const t = await bootstrap();
    const variants = ["race.one@gmail.com", "raceone@googlemail.com", "r.a.c.e.one+1@gmail.com", "RACEONE@gmail.com."];
    const results = await Promise.allSettled(variants.map((email) => t.store.registerUser(email, "hash", { domainLimit: null })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(RegistrationGuardError);
        expect((r.reason as RegistrationGuardError).reason).toBe("email_alias_exists");
      }
    }
    const domains = await Promise.allSettled(
      ["one@quota.test", "two@mail.quota.test", "three@quota.test"].map((email) => t.store.registerUser(email, "hash", { domainLimit: "quota.test" })),
    );
    expect(domains.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await t.store.registrationEmailConflict("four@QUOTA.test", { domainLimit: "quota.test" })).toBe("email_domain_limit");
    expect(await t.store.registrationEmailConflict("four@other.test", { domainLimit: "other.test" })).toBeNull();
    // Without a guard (admin paths, old callers) only the exact address is unique.
    expect((await t.store.registerUser("raceone+admin@gmail.com", "hash")).email).toBe("raceone+admin@gmail.com");
  });

  it.skipIf(!onPostgres)("mirrors the alias identity in SQL and takes the advisory locks (Postgres)", async () => {
    const t = await bootstrap();
    const sql = (t.store as unknown as { sql: import("postgres").Sql }).sql;
    for (const [input] of ALIAS_CASES) {
      const rows = await sql<{ id: string }[]>`SELECT commerce.email_alias_identity(${input}::text) AS id`;
      expect(`${input} -> ${rows[0]!.id}`).toBe(`${input} -> ${normalizeEmailForAliasDedup(input)}`);
    }
    const rev = await sql<{ d: string }[]>`SELECT commerce.email_domain_rev('A@Mail.Example.COM.') AS d`;
    expect(rev[0]!.d).toBe("moc.elpmaxe.liam");
    const held = await sql.begin(async (tx) => {
      await pgRegistrationConflict(tx as unknown as import("postgres").Sql, "lock@quota2.test", { domainLimit: "quota2.test" }, true);
      return tx<{ classid: number }[]>`
        SELECT classid::int AS classid FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted ORDER BY classid
      `;
    });
    expect(held.map((r) => r.classid)).toEqual([74_210_041, 74_210_042]);
    const plan = await sql.unsafe(
      "EXPLAIN SELECT email FROM commerce.users WHERE commerce.email_alias_identity(email) = commerce.email_alias_identity('x@y.test')",
    );
    expect(JSON.stringify(plan)).toMatch(/idx_commerce_users_email_alias|Seq Scan/);
  });
});

/* ---------------------------------------------------------------------------------------- */
/* Login agreement and legal pages                                                           */
/* ---------------------------------------------------------------------------------------- */

describe("login agreement", () => {
  it("validates, publishes document links with a revision and serves each document", async () => {
    const t = await bootstrap();
    const empty = await t.patchSettings({ loginAgreementEnabled: true });
    expect(empty.status).toBe(400);
    expect(empty.body.message).toContain("loginAgreementDocuments");
    expect((await t.patchSettings({ loginAgreementMode: "popup" })).status).toBe(400);
    expect((await t.patchSettings({ loginAgreementUpdatedAt: "31/03/2026" })).status).toBe(400);
    expect((await t.patchSettings({ loginAgreementDocuments: [{ id: "a", title: "", contentMd: "text without title" }] })).status).toBe(400);

    const saved = await t.patchSettings({
      loginAgreementEnabled: true,
      loginAgreementMode: "checkbox",
      loginAgreementUpdatedAt: "2026-03-31",
      loginAgreementDocuments: [
        { id: "Terms Of Service", title: "Terms of Service", contentMd: "# Terms\n\nBe nice." },
        { id: "", title: "Privacy", contentMd: "We keep little." },
      ],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.loginAgreementDocuments.map((d) => d.id)).toEqual(["terms-of-service", "privacy"]);

    const pub = await t.publicSettings();
    expect(pub).toMatchObject({ loginAgreementEnabled: true, loginAgreementMode: "checkbox", loginAgreementUpdatedAt: "2026-03-31" });
    expect(pub.loginAgreementDocuments).toEqual([
      { id: "terms-of-service", title: "Terms of Service" },
      { id: "privacy", title: "Privacy" },
    ]);
    expect(JSON.stringify(pub)).not.toContain("Be nice.");
    const rev1 = pub.loginAgreementRevision;
    expect(rev1).toMatch(/^[0-9a-f]{16}$/);

    const doc = await t.call<LegalDocumentResponse>("GET", "/api/v1/public/legal/privacy");
    expect(doc.status).toBe(200);
    expect(doc.body).toMatchObject({ id: "privacy", title: "Privacy", contentMd: "We keep little.", updatedAt: "2026-03-31", revision: rev1 });
    expect((await t.call("GET", "/api/v1/public/legal/nope")).status).toBe(404);

    // A new date (or any text change) is a new revision: consent is asked again.
    await t.patchSettings({ loginAgreementUpdatedAt: "2026-04-01" });
    const rev2 = (await t.publicSettings()).loginAgreementRevision;
    expect(rev2).not.toBe(rev1);
    await t.patchSettings({
      loginAgreementDocuments: [
        { id: "terms-of-service", title: "Terms of Service", contentMd: "# Terms\n\nBe very nice." },
        { id: "privacy", title: "Privacy", contentMd: "We keep little." },
      ],
    });
    expect((await t.publicSettings()).loginAgreementRevision).not.toBe(rev2);

    // Switched off: no prompt, but the documents stay readable.
    await t.patchSettings({ loginAgreementEnabled: false });
    const off = await t.publicSettings();
    expect(off.loginAgreementEnabled).toBe(false);
    expect(off.loginAgreementDocuments).toHaveLength(2);
    expect((await t.call("GET", "/api/v1/public/legal/terms-of-service")).status).toBe(200);
  });
});

/* ---------------------------------------------------------------------------------------- */
/* Backend (admin-only) mode                                                                 */
/* ---------------------------------------------------------------------------------------- */

describe("backend mode", () => {
  it("lets only administrators sign in and use the console, and closes sign-up and public pages", async () => {
    const t = await bootstrap();
    await t.enableMail();
    await t.patchSettings({ apiBaseUrl: "https://portal.guards.test" });
    const user = await t.register("eve@guards.test");
    expect(user.status).toBe(201);
    const userToken = user.body.accessToken;
    expect((await t.call("GET", "/api/v1/user/groups", { token: userToken })).status).toBe(200);
    // A reset link mailed before the switch.
    await t.call("POST", "/api/v1/auth/forgot-password", { body: { email: "eve@guards.test" } });
    const resetToken = /token=([0-9a-f]+)/.exec(t.mails.at(-1)!.html)![1]!;

    expect((await t.patchSettings({ backendModeEnabled: true })).status).toBe(200);
    const pub = await t.publicSettings();
    expect(pub).toMatchObject({ backendModeEnabled: true, allowRegistration: false, modelPlazaEnabled: false, statusPageEnabled: false });

    // Existing sessions of users stop working; administrators keep going.
    const blocked = await t.call("GET", "/api/v1/user/groups", { token: userToken });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error).toBe("backend_mode");
    expect((await t.call("GET", "/api/v1/auth/me", { token: userToken })).body.error).toBe("backend_mode");
    expect((await t.call("GET", "/api/v1/auth/me", { token: t.admin })).status).toBe(200);
    expect((await t.call("GET", "/api/v1/user/groups", { token: t.admin })).status).toBe(200);

    // Sign-in: refused for users only after the password checked out.
    expect((await t.login("eve@guards.test", "wrong-password")).body.error).toBe("invalid_credentials");
    const login = await t.login("eve@guards.test", USER_PASSWORD);
    expect(login.status).toBe(403);
    expect(login.body.error).toBe("backend_mode");
    expect((await t.login("admin@guards.test", ADMIN_PASSWORD)).status).toBe(200);

    // Self-service sign-up flows.
    expect((await t.register("frank@guards.test")).body.error).toBe("backend_mode");
    expect((await t.call("POST", "/api/v1/auth/email-code", { body: { email: "frank@guards.test" } })).body.error).toBe("backend_mode");
    // Forgot password: same answer for everyone, mail only for administrators.
    const mailsBefore = t.mails.length;
    expect((await t.call("POST", "/api/v1/auth/forgot-password", { body: { email: "eve@guards.test" } })).status).toBe(200);
    expect(t.mails.length).toBe(mailsBefore);
    expect((await t.call("POST", "/api/v1/auth/forgot-password", { body: { email: "admin@guards.test" } })).status).toBe(200);
    expect(t.mails.at(-1)!.to).toBe("admin@guards.test");
    const reset = await t.call("POST", "/api/v1/auth/reset-password", { body: { token: resetToken, password: "NewPassword123!" } });
    expect(reset.status).toBe(403);
    expect(reset.body.error).toBe("backend_mode");

    // Public pages: closed to anonymous visitors, open to a signed-in administrator.
    expect((await t.call("GET", "/api/v1/public/models")).body.error).toBe("backend_mode");
    expect((await t.call("GET", "/api/v1/public/status")).status).toBe(403);
    expect((await t.call("GET", "/api/v1/public/home")).status).toBe(403);
    expect((await t.call("GET", "/api/v1/public/models", { token: t.admin })).status).toBe(200);
    expect((await t.call("GET", "/api/v1/public/models", { token: userToken })).status).toBe(403);
    expect((await t.call("GET", "/api/v1/public/settings")).status).toBe(200);

    // Switched off again: the old session works again (it was never revoked).
    await t.patchSettings({ backendModeEnabled: false });
    expect((await t.call("GET", "/api/v1/user/groups", { token: userToken })).status).toBe(200);
    expect((await t.call("GET", "/api/v1/public/home")).status).toBe(200);
  });

  it("refuses OAuth sign-ins of users and every OAuth sign-up while on", async () => {
    const t = await bootstrap();
    const grants = new Map<string, Record<string, unknown>>();
    const tokens = new Map<string, Record<string, unknown>>();
    const idp = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://idp.test/token") {
        const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
        const profile = grants.get(code);
        if (!profile) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const token = `at-${crypto.randomUUID()}`;
        tokens.set(token, profile);
        return Response.json({ access_token: token });
      }
      const profile = tokens.get(new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "");
      return profile ? Response.json(profile) : new Response("unauthorized", { status: 401 });
    }) as typeof fetch;
    const store = t.store;
    const app = createBffApp({
      store,
      jwtSecret: "auth-guards-jwt-secret-32-bytes-minimum",
      vaultSecret: "auth-guards-vault-secret-32-bytes-minimum",
      oauthFetch: idp,
      captchaFetch: t.providers.fetchImpl,
    });
    const api = async (method: string, path: string, token?: string, body?: unknown) => {
      const headers: Record<string, string> = { ...JSON_HEADERS };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await app.request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect(
      (
        await api("PATCH", "/api/v1/admin/oauth/providers/oidc", t.admin, {
          enabled: true,
          clientId: "slipgate",
          clientSecret: "idp-secret",
          authorizeUrl: "https://idp.test/authorize",
          tokenUrl: "https://idp.test/token",
          userinfoUrl: "https://idp.test/userinfo",
        })
      ).status,
    ).toBe(200);
    /** One OAuth round trip; returns where the callback sent the browser. */
    const signIn = async (profile: Record<string, unknown>) => {
      let cookie = "";
      const startRes = await app.request(`${ORIGIN}/api/v1/auth/oauth/oidc/start?redirect=/usage`);
      expect(startRes.status).toBe(302);
      cookie = (startRes.headers.getSetCookie()[0] ?? "").split(";")[0]!;
      const authorize = new URL(startRes.headers.get("location")!);
      const code = `code-${crypto.randomUUID()}`;
      grants.set(code, profile);
      const cb = await app.request(`${authorize.searchParams.get("redirect_uri")}?code=${code}&state=${authorize.searchParams.get("state")}`, {
        headers: { Cookie: cookie },
      });
      expect(cb.status).toBe(302);
      return new URL(cb.headers.get("location")!);
    };
    // Sign up with the provider while the mode is off: an account for sub-1.
    const first = await signIn({ sub: "sub-1", email: "oauth-user@corp.test", email_verified: true });
    expect(first.pathname).toBe("/oauth/complete");

    // Sign-up policy applies to provider sign-ups too.
    await t.patchSettings({ registrationEmailSuffixAllowlist: ["@corp.test"] });
    expect((await signIn({ sub: "sub-2", email: "x@other.test", email_verified: true })).searchParams.get("oauth_error")).toBe("email_suffix_not_allowed");
    expect((await signIn({ sub: "sub-3" })).searchParams.get("oauth_error")).toBe("email_suffix_not_allowed");
    expect((await signIn({ sub: "sub-4", email: "oauth-user+2@corp.test", email_verified: true })).searchParams.get("oauth_error")).toBe(
      "email_alias_exists",
    );
    await t.patchSettings({ registrationEmailSuffixAllowlist: [] });
    expect((await signIn({ sub: "sub-6", email: "x@users.noreply.slipgate", email_verified: true })).searchParams.get("oauth_error")).toBe(
      "email_reserved",
    );

    // Through this app, so its own settings cache is dropped at once.
    expect((await api("PATCH", "/api/v1/admin/settings", t.admin, { backendModeEnabled: true })).status).toBe(200);
    expect((await signIn({ sub: "sub-1" })).searchParams.get("oauth_error")).toBe("backend_mode");
    expect((await signIn({ sub: "sub-9", email: "new@corp.test", email_verified: true })).searchParams.get("oauth_error")).toBe("backend_mode");
  });
});
