import type { Context, Hono, MiddlewareHandler } from "hono";
import type { z } from "zod";
import {
  CaptchaConfigSchema,
  CaptchaPassRequestSchema,
  CaptchaTestRequestSchema,
  DEFAULT_CAPTCHA_CONFIG,
  DISABLED_PUBLIC_CAPTCHA,
  isRegistrationEmailSuffixAllowed,
  isReservedEmail,
  loginAgreementRevision,
  registrationEmailDomain,
  UpdateCaptchaConfigRequestSchema,
  type CaptchaConfig,
  type CaptchaPassResponse,
  type CaptchaProof,
  type CaptchaProvider,
  type CaptchaScope,
  type CaptchaTestResult,
  type LegalDocumentResponse,
  type PortalSettings,
  type PublicCaptcha,
} from "@slipgate/contracts";
import { WindowLimiter } from "./insights.ts";
import type { AuthEnv, SessionManager } from "./middleware/auth.ts";
import { FlowStateMap } from "./routes/oauth.ts";
import {
  checkCaptchaCredentials,
  proofHasAnswer,
  verifyCaptchaProof,
  type CaptchaFetch,
  type ResolvedCaptcha,
} from "./security/captcha.ts";
import { clientAddress, clientIp } from "./security/client_ip.ts";
import { decryptSecret, encryptSecret } from "./security/crypto.ts";
import { registrationConflictMessage, type RegistrationConflict, type RegistrationGuard } from "./store/auth_guards_store.ts";
import { StoreError, type ControlStore } from "./store/types.ts";

/**
 * Sign-in / sign-up guards (Linksyncx parity): captcha on login, sign-up, sign-up email codes,
 * forgot password and OAuth start; the sign-up email policy (suffix allowlist, one account per
 * unlisted domain, inbox alias de-duplication, the reserved placeholder domain); backend
 * (admin-only) mode; and the login agreement's public legal documents.
 *
 * Every check here is fail-closed: a captcha that is switched on but can't be verified (provider
 * unreachable, secrets unreadable) refuses the request with 503 captcha_unavailable instead of
 * waving it through. The one escape hatch is the SLIPGATE_CAPTCHA_BYPASS=1 environment variable,
 * for an operator locked out by a broken provider (it turns every challenge off, and the public
 * settings stop showing the widget).
 */

const BLOB_KEY = "captcha_config";
/** Secrets of the captcha config: stored AES-GCM encrypted (hex) as `<name>Enc`, never returned. */
const SECRET_FIELDS = ["turnstileSecretKey", "tencentAppSecretKey", "tencentSecretId", "tencentSecretKey", "aliyunAccessKeySecret"] as const;
type SecretField = (typeof SECRET_FIELDS)[number];
type CaptchaSecrets = Record<SecretField, string>;
/** Non-secret fields kept in the blob as is. */
const PLAIN_FIELDS = [
  "provider",
  "turnstileSiteKey",
  "tencentAppId",
  "tencentRegion",
  "aliyunAccessKeyId",
  "aliyunSceneId",
  "aliyunPrefix",
  "aliyunRegion",
] as const;

/** One-time passes (login two-factor step, OAuth start) live this long. */
export const CAPTCHA_PASS_TTL_MS = 5 * 60_000;
const MAX_PASSES = 20_000;
/** Sign-up attempts per client address and minute (whatever the outcome). */
export const REGISTER_ATTEMPTS_PER_MINUTE = 5;
/** Portal settings reads behind the per-request guards are shared this long (writes here invalidate at once). */
const SETTINGS_TTL_MS = 3_000;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => Number.parseInt(x, 16)));
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A refusal: the JSON body and status a guarded route answers with. */
export interface GuardRefusal {
  status: 400 | 403 | 409 | 429 | 503;
  error: string;
  message: string;
  retryAfterSeconds?: number;
  /** The allowlist, with email_suffix_not_allowed (so the form can say which domains work). */
  allowedSuffixes?: string[];
}

export function refusalResponse(c: Context, refusal: GuardRefusal): Response {
  if (refusal.retryAfterSeconds) c.header("Retry-After", String(refusal.retryAfterSeconds));
  const { status, retryAfterSeconds: _r, ...body } = refusal;
  return c.json(body, status);
}

export const BACKEND_MODE_REFUSAL: GuardRefusal = {
  status: 403,
  error: "backend_mode",
  message: "Backend mode is on: sign-up and self-service are disabled and only administrators can sign in",
};

export type CaptchaGate = { ok: true; enforced: boolean } | { ok: false; response: Response };

interface CaptchaState {
  config: CaptchaConfig;
  secrets: CaptchaSecrets;
  /** Secrets that are stored but could not be decrypted (vault key changed): unusable, fail-closed. */
  unreadable: SecretField[];
  blob: Record<string, unknown>;
}

interface PassRecord {
  scope: CaptchaScope;
  subject: string;
  expiresAt: number;
}

function bad(issues: z.ZodIssue[]): never {
  throw new StoreError("bad_request", issues.slice(0, 3).map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "));
}

async function jsonBody<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) bad(parsed.error.issues);
  return parsed.data;
}

function bypassed(): boolean {
  return process.env.SLIPGATE_CAPTCHA_BYPASS === "1";
}

/** The credentials one provider needs; null (with what is missing) when incomplete. */
function resolveProvider(
  provider: Exclude<CaptchaProvider, "none">,
  config: CaptchaConfig,
  secrets: CaptchaSecrets,
): { resolved: ResolvedCaptcha } | { missing: string[] } {
  const missing: string[] = [];
  const need = (value: string, name: string) => {
    if (!value) missing.push(name);
  };
  switch (provider) {
    case "turnstile":
      need(config.turnstileSiteKey, "turnstileSiteKey");
      need(secrets.turnstileSecretKey, "turnstileSecretKey");
      return missing.length ? { missing } : { resolved: { provider, creds: { secretKey: secrets.turnstileSecretKey } } };
    case "tencent":
      if (!/^[1-9]\d{0,19}$/.test(config.tencentAppId)) missing.push("tencentAppId");
      need(secrets.tencentAppSecretKey, "tencentAppSecretKey");
      need(secrets.tencentSecretId, "tencentSecretId");
      need(secrets.tencentSecretKey, "tencentSecretKey");
      return missing.length
        ? { missing }
        : {
            resolved: {
              provider,
              creds: {
                appId: config.tencentAppId,
                appSecretKey: secrets.tencentAppSecretKey,
                secretId: secrets.tencentSecretId,
                secretKey: secrets.tencentSecretKey,
                region: config.tencentRegion,
              },
            },
          };
    case "aliyun":
      need(config.aliyunAccessKeyId, "aliyunAccessKeyId");
      need(secrets.aliyunAccessKeySecret, "aliyunAccessKeySecret");
      need(config.aliyunSceneId, "aliyunSceneId");
      need(config.aliyunPrefix, "aliyunPrefix");
      return missing.length
        ? { missing }
        : {
            resolved: {
              provider,
              creds: {
                accessKeyId: config.aliyunAccessKeyId,
                accessKeySecret: secrets.aliyunAccessKeySecret,
                sceneId: config.aliyunSceneId,
                region: config.aliyunRegion,
              },
            },
          };
  }
}

/** Fields whose change makes a save re-check the provider's credentials. */
const CREDENTIAL_FIELDS: Record<Exclude<CaptchaProvider, "none">, (keyof CaptchaConfig | SecretField)[]> = {
  turnstile: ["turnstileSiteKey", "turnstileSecretKey"],
  tencent: ["tencentAppId", "tencentRegion", "tencentAppSecretKey", "tencentSecretId", "tencentSecretKey"],
  aliyun: ["aliyunAccessKeyId", "aliyunAccessKeySecret", "aliyunSceneId", "aliyunRegion"],
};

export interface AuthGuardsOptions {
  store: ControlStore;
  vaultSecret: string;
  sessions: SessionManager;
  /** Test hook: replaces fetch for the captcha providers' verification calls. */
  fetchImpl?: CaptchaFetch;
}

export class AuthGuards {
  private readonly store: ControlStore;
  private readonly vaultSecret: string;
  private readonly sessions: SessionManager;
  private readonly doFetch: CaptchaFetch;
  private readonly passes = new FlowStateMap<PassRecord>(MAX_PASSES);
  private readonly registerLimiter = new WindowLimiter(REGISTER_ATTEMPTS_PER_MINUTE, 60_000);
  private readonly passLimiter = new WindowLimiter(30, 60_000);
  private settingsCache: { at: number; value: Promise<PortalSettings> } | null = null;
  private captchaCache: { at: number; value: Promise<CaptchaState> } | null = null;

  constructor(opts: AuthGuardsOptions) {
    this.store = opts.store;
    this.vaultSecret = opts.vaultSecret;
    this.sessions = opts.sessions;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /* ---------------- Settings ---------------- */

  /** Portal settings for the per-request guards: shared for a few seconds, dropped on admin writes. */
  settings(): Promise<PortalSettings> {
    const now = Date.now();
    if (this.settingsCache && now - this.settingsCache.at < SETTINGS_TTL_MS) return this.settingsCache.value;
    const value = this.store.ops.getSettings();
    const entry = { at: now, value };
    this.settingsCache = entry;
    value.catch(() => {
      if (this.settingsCache === entry) this.settingsCache = null;
    });
    return value;
  }

  /** Drops the cached portal settings and captcha config (after any admin write in this process). */
  invalidateSettings(): void {
    this.settingsCache = null;
    this.captchaCache = null;
  }

  async backendMode(): Promise<boolean> {
    return (await this.settings()).backendModeEnabled;
  }

  /**
   * After requireAuth: while backend mode is on, only administrators get through (sessions of
   * other users issued before the switch stop working at once).
   */
  backendModeUserGuard(): MiddlewareHandler<AuthEnv> {
    return async (c, next) => {
      const claims = c.get("authUser");
      if (claims?.role !== "admin" && (await this.backendMode())) return refusalResponse(c, BACKEND_MODE_REFUSAL);
      await next();
    };
  }

  /** Anonymous public pages: closed in backend mode, except to a signed-in administrator. */
  backendModePublicGuard(): MiddlewareHandler<AuthEnv> {
    return async (c, next) => {
      if (await this.backendMode()) {
        const auth = c.req.header("Authorization") ? await this.sessions.authenticate(c.req.header("Authorization")) : null;
        if (!auth || !("claims" in auth) || auth.claims.role !== "admin") return refusalResponse(c, BACKEND_MODE_REFUSAL);
      }
      await next();
    };
  }

  /* ---------------- Captcha config ---------------- */

  /**
   * The captcha config with decrypted secrets, shared for a few seconds like the settings (every
   * guarded request and every public settings read needs it); admin writes here drop it at once.
   */
  private loadCaptcha(): Promise<CaptchaState> {
    const now = Date.now();
    if (this.captchaCache && now - this.captchaCache.at < SETTINGS_TTL_MS) return this.captchaCache.value;
    const value = this.readCaptcha();
    const entry = { at: now, value };
    this.captchaCache = entry;
    value.catch(() => {
      if (this.captchaCache === entry) this.captchaCache = null;
    });
    return value;
  }

  private async readCaptcha(): Promise<CaptchaState> {
    const blob = (await this.store.ops.getBlob(BLOB_KEY)) ?? {};
    const secrets = Object.fromEntries(SECRET_FIELDS.map((f) => [f, ""])) as CaptchaSecrets;
    const unreadable: SecretField[] = [];
    for (const field of SECRET_FIELDS) {
      const enc = blob[`${field}Enc`];
      if (typeof enc !== "string" || !enc) continue;
      try {
        secrets[field] = await decryptSecret(fromHex(enc), this.vaultSecret);
      } catch {
        unreadable.push(field);
      }
    }
    const scopes = blob.scopes && typeof blob.scopes === "object" ? (blob.scopes as Record<string, unknown>) : {};
    const candidate = {
      ...DEFAULT_CAPTCHA_CONFIG,
      ...Object.fromEntries(PLAIN_FIELDS.filter((f) => blob[f] !== undefined).map((f) => [f, blob[f]])),
      scopes: { ...DEFAULT_CAPTCHA_CONFIG.scopes, ...scopes },
      turnstileSecretKeySet: Boolean(secrets.turnstileSecretKey),
      tencentAppSecretKeySet: Boolean(secrets.tencentAppSecretKey),
      tencentSecretIdSet: Boolean(secrets.tencentSecretId),
      tencentSecretKeySet: Boolean(secrets.tencentSecretKey),
      aliyunAccessKeySecretSet: Boolean(secrets.aliyunAccessKeySecret),
    };
    const parsed = CaptchaConfigSchema.safeParse(candidate);
    // A blob this build can't read keeps the provider it names (fail-closed: enforcement then
    // finds the config unusable) rather than silently switching the challenge off.
    const config = parsed.success
      ? parsed.data
      : { ...DEFAULT_CAPTCHA_CONFIG, provider: CaptchaConfigSchema.shape.provider.catch("none").parse(blob.provider) };
    return { config, secrets, unreadable, blob };
  }

  /** Admin view: GET /api/v1/admin/captcha (always read fresh). */
  async captchaConfig(): Promise<CaptchaConfig> {
    return (await this.readCaptcha()).config;
  }

  /** What the login page needs to render the widget ("none" while off or bypassed). */
  async publicCaptcha(): Promise<PublicCaptcha> {
    if (bypassed()) return { ...DISABLED_PUBLIC_CAPTCHA };
    const { config } = await this.loadCaptcha();
    if (config.provider === "none") return { ...DISABLED_PUBLIC_CAPTCHA, scopes: { ...config.scopes } };
    const only = <T>(provider: CaptchaProvider, value: T, empty: T) => (config.provider === provider ? value : empty);
    return {
      provider: config.provider,
      scopes: { ...config.scopes },
      turnstileSiteKey: only("turnstile", config.turnstileSiteKey, ""),
      tencentAppId: only("tencent", config.tencentAppId, ""),
      tencentRegion: config.tencentRegion,
      aliyunSceneId: only("aliyun", config.aliyunSceneId, ""),
      aliyunPrefix: only("aliyun", config.aliyunPrefix, ""),
      aliyunRegion: config.aliyunRegion,
    };
  }

  /** PATCH /api/v1/admin/captcha: validate, check the credentials with the provider when they changed, save. */
  async updateCaptcha(c: Context): Promise<Response> {
    const req = await jsonBody(c, UpdateCaptchaConfigRequestSchema);
    const current = await this.readCaptcha();
    const next: CaptchaConfig = {
      ...current.config,
      ...Object.fromEntries(PLAIN_FIELDS.filter((f) => req[f] !== undefined).map((f) => [f, req[f]])),
      scopes: { ...current.config.scopes, ...req.scopes },
    };
    const secrets: CaptchaSecrets = { ...current.secrets };
    const touched = new Set<string>();
    for (const field of SECRET_FIELDS) {
      const value = req[field];
      if (value === undefined) continue;
      if (value !== current.secrets[field] || current.unreadable.includes(field)) touched.add(field);
      secrets[field] = value;
    }
    for (const field of PLAIN_FIELDS) if (req[field] !== undefined && req[field] !== current.config[field]) touched.add(field);

    if (next.provider !== "none") {
      const resolved = resolveProvider(next.provider, next, secrets);
      if ("missing" in resolved) {
        return c.json(
          { error: "captcha_not_configured", message: `Fill in before switching ${next.provider} on: ${resolved.missing.join(", ")}`, missing: resolved.missing },
          400,
        );
      }
      // A wrong key would lock every sign-in out (the check is fail-closed): ask the provider first.
      const changed = current.config.provider !== next.provider || CREDENTIAL_FIELDS[next.provider].some((f) => touched.has(f));
      if (changed) {
        const check = await checkCaptchaCredentials(this.doFetch, resolved.resolved);
        if (!check.ok) {
          return check.kind === "bad_credentials"
            ? c.json({ error: "captcha_invalid_credentials", message: `${next.provider} refused the credentials: ${check.detail}` }, 400)
            : c.json({ error: "captcha_unavailable", message: `Could not reach ${next.provider} to check the credentials: ${check.detail}` }, 502);
        }
      }
    }

    const blob: Record<string, unknown> = { ...current.blob };
    for (const field of PLAIN_FIELDS) blob[field] = next[field];
    blob.scopes = next.scopes;
    for (const field of SECRET_FIELDS) {
      if (!touched.has(field)) continue;
      blob[`${field}Enc`] = secrets[field] ? toHex(await encryptSecret(secrets[field], this.vaultSecret)) : "";
    }
    await this.store.ops.setBlob(BLOB_KEY, blob);
    this.captchaCache = null;
    return c.json(await this.captchaConfig());
  }

  /** POST /api/v1/admin/captcha/test */
  async testCaptcha(c: Context): Promise<Response> {
    const req = await jsonBody(c, CaptchaTestRequestSchema);
    const state = await this.readCaptcha();
    const provider = req.provider ?? state.config.provider;
    const mode = req.captcha && provider !== "none" && proofHasAnswer(provider, req.captcha) ? "token" : "credentials";
    const result = (ok: boolean, error: string | null, detail: string): CaptchaTestResult => ({ ok, provider, mode, error, detail });
    if (provider === "none") return c.json(result(false, "captcha_not_configured", "No captcha provider is switched on"));
    const resolved = resolveProvider(provider, state.config, state.secrets);
    if ("missing" in resolved) return c.json(result(false, "captcha_not_configured", `Missing: ${resolved.missing.join(", ")}`));
    if (mode === "token") {
      const outcome = await verifyCaptchaProof(this.doFetch, resolved.resolved, req.captcha!, clientAddress(c));
      if (outcome.ok) return c.json(result(true, null, "The challenge answer was verified"));
      return c.json(result(false, outcome.kind === "rejected" ? "captcha_invalid" : "captcha_unavailable", outcome.detail));
    }
    const check = await checkCaptchaCredentials(this.doFetch, resolved.resolved);
    if (check.ok) return c.json(result(true, null, check.detail));
    return c.json(result(false, check.kind === "bad_credentials" ? "captcha_invalid_credentials" : "captcha_unavailable", check.detail));
  }

  /* ---------------- Captcha enforcement ---------------- */

  /**
   * The captcha check of one guarded request. Not enforced (ok, enforced false) while no provider
   * is on, the scope is off, or the bypass is set. A valid one-time `pass` for this scope and
   * subject stands in for a fresh answer. `coveredByEmailCode`: sign-up with an email code while
   * verification is on skips the second challenge when sending the code needed one (the code
   * itself is checked by the route).
   */
  async captcha(c: Context, scope: CaptchaScope, proof: CaptchaProof | undefined, subject = "", coveredByEmailCode = false): Promise<CaptchaGate> {
    if (bypassed()) return { ok: true, enforced: false };
    const state = await this.loadCaptcha();
    const { config } = state;
    if (config.provider === "none" || !config.scopes[scope]) return { ok: true, enforced: false };
    if (coveredByEmailCode && config.scopes.emailCode) return { ok: true, enforced: true };
    const deny = (status: 400 | 503, error: string, message: string): CaptchaGate => ({ ok: false, response: c.json({ error, message }, status) });
    if (proof?.pass && this.consumePass(scope, subject, proof.pass)) return { ok: true, enforced: true };
    const resolved = resolveProvider(config.provider, config, state.secrets);
    if ("missing" in resolved) {
      console.warn(`[slipgate-bff] captcha ${config.provider} is on but unusable (missing or unreadable: ${resolved.missing.join(", ")})`);
      return deny(503, "captcha_unavailable", "Human verification is misconfigured; contact the administrator");
    }
    if (!proofHasAnswer(resolved.resolved.provider, proof)) return deny(400, "captcha_required", "Complete the human verification first");
    const outcome = await verifyCaptchaProof(this.doFetch, resolved.resolved, proof!, clientAddress(c));
    if (outcome.ok) return { ok: true, enforced: true };
    if (outcome.kind === "rejected") return deny(400, "captcha_invalid", "Human verification failed, please try again");
    console.warn(`[slipgate-bff] captcha ${config.provider} verification unavailable: ${outcome.detail}`);
    return deny(503, "captcha_unavailable", "Human verification is unavailable right now, try again later");
  }

  /** A one-time pass for `scope` (and `subject`, e.g. the sign-in email) in place of a new challenge. */
  issuePass(scope: CaptchaScope, subject = ""): string {
    const pass = b64url(crypto.getRandomValues(new Uint8Array(32)));
    this.passes.set(pass, { scope, subject: subject.trim().toLowerCase(), expiresAt: Date.now() + CAPTCHA_PASS_TTL_MS });
    return pass;
  }

  /** `{ captchaPass }` to add to an answer when the gate enforced a challenge, else nothing. */
  passFor(gate: CaptchaGate, scope: CaptchaScope, subject = ""): { captchaPass?: string } {
    return gate.ok && gate.enforced ? { captchaPass: this.issuePass(scope, subject) } : {};
  }

  private consumePass(scope: CaptchaScope, subject: string, pass: string): boolean {
    const rec = this.passes.take(pass);
    return Boolean(rec && rec.scope === scope && rec.subject === subject.trim().toLowerCase());
  }

  /** GET /auth/oauth/:id/start: true when no challenge is needed or `pass` is a valid OAuth pass. */
  async oauthStartAllowed(pass: string | undefined): Promise<boolean> {
    if (bypassed()) return true;
    const { config } = await this.loadCaptcha();
    if (config.provider === "none" || !config.scopes.oauth) return true;
    return Boolean(pass && pass.length <= 128 && this.consumePass("oauth", "", pass));
  }

  /** POST /api/v1/auth/captcha/pass */
  async passRequest(c: Context): Promise<Response> {
    const req = await jsonBody(c, CaptchaPassRequestSchema);
    if (!this.passLimiter.allow(`pass:${clientIp(c)}`)) {
      return refusalResponse(c, { status: 429, error: "too_many_attempts", message: "Too many attempts, try again later", retryAfterSeconds: 60 });
    }
    const gate = await this.captcha(c, req.scope, { ...req.captcha, pass: undefined });
    if (!gate.ok) return gate.response;
    const body: CaptchaPassResponse = gate.enforced
      ? { required: true, pass: this.issuePass(req.scope), expiresInSeconds: CAPTCHA_PASS_TTL_MS / 1000 }
      : { required: false, pass: null, expiresInSeconds: 0 };
    return c.json(body);
  }

  /* ---------------- Sign-up email policy ---------------- */

  /**
   * Reserved domain and allowlist: the store guard registerUser must apply, or a refusal. With an
   * allowlist, an unlisted domain is refused unless the per-domain quota is on, in which case it is
   * allowed while its registrable domain has no account (checked atomically by the store).
   */
  registrationPolicy(email: string, settings: PortalSettings): { guard: RegistrationGuard } | { refusal: GuardRefusal } {
    if (isReservedEmail(email)) {
      return { refusal: { status: 400, error: "email_reserved", message: "This email domain is reserved and can't be used" } };
    }
    const allowlist = settings.registrationEmailSuffixAllowlist;
    if (isRegistrationEmailSuffixAllowed(email, allowlist)) return { guard: { domainLimit: null } };
    const domain = settings.registrationEmailDomainQuotaEnabled ? registrationEmailDomain(email) : "";
    if (!domain) {
      return {
        refusal: {
          status: 400,
          error: "email_suffix_not_allowed",
          message: `Sign-up is limited to these email domains: ${allowlist.join(", ")}`,
          allowedSuffixes: [...allowlist],
        },
      };
    }
    return { guard: { domainLimit: domain } };
  }

  /** Read-only pre-check of the store guard (the atomic one runs again inside registerUser). */
  async registrationConflict(email: string, guard: RegistrationGuard): Promise<GuardRefusal | null> {
    const conflict = await this.store.registrationEmailConflict(email, guard);
    return conflict ? conflictRefusal(conflict) : null;
  }

  /**
   * Everything POST /api/v1/auth/register checks before it spends an invitation or email code:
   * backend mode, the per-address attempt limit, the captcha (skipped when an email code is sent
   * while verification is live and sending the code required one), the reserved domain, the
   * allowlist and quota, and an existing account of the same inbox.
   */
  async registerPreflight(
    c: Context,
    req: { email: string; emailCode?: string; captcha?: CaptchaProof },
    settings: PortalSettings,
    emailVerificationLive: () => Promise<boolean>,
  ): Promise<{ guard: RegistrationGuard } | { response: Response }> {
    if (settings.backendModeEnabled) return { response: refusalResponse(c, BACKEND_MODE_REFUSAL) };
    // The store refuses too; saying so first spares the visitor a challenge that can't lead anywhere.
    if (!settings.allowRegistration) {
      return { response: refusalResponse(c, { status: 403, error: "forbidden", message: "Public user registration is disabled" }) };
    }
    const ip = clientIp(c);
    // In-process requests (no socket peer, e.g. tests) have no address to count.
    if (ip !== "unknown" && !this.registerLimiter.allow(`register:${ip}`)) {
      return {
        response: refusalResponse(c, { status: 429, error: "too_many_attempts", message: "Too many sign-up attempts, try again in a minute", retryAfterSeconds: 60 }),
      };
    }
    const viaEmailCode = settings.emailVerificationRequired && Boolean(req.emailCode?.trim()) && (await emailVerificationLive());
    const gate = await this.captcha(c, "register", req.captcha, "", viaEmailCode);
    if (!gate.ok) return { response: gate.response };
    const policy = this.registrationPolicy(req.email, settings);
    if ("refusal" in policy) return { response: refusalResponse(c, policy.refusal) };
    const conflict = await this.registrationConflict(req.email, policy.guard);
    if (conflict) return { response: refusalResponse(c, conflict) };
    return { guard: policy.guard };
  }

  /**
   * POST /api/v1/auth/email-code: backend mode, sign-up closed, captcha, then the sign-up policy
   * and existing accounts, so no code is mailed to an address that could not register anyway.
   */
  async emailCodePreflight(c: Context, req: { email: string; captcha?: CaptchaProof }): Promise<Response | null> {
    const settings = await this.store.ops.getSettings();
    if (settings.backendModeEnabled) return refusalResponse(c, BACKEND_MODE_REFUSAL);
    if (!settings.allowRegistration) {
      return refusalResponse(c, { status: 403, error: "forbidden", message: "Public user registration is disabled" });
    }
    const gate = await this.captcha(c, "emailCode", req.captcha);
    if (!gate.ok) return gate.response;
    const policy = this.registrationPolicy(req.email, settings);
    if ("refusal" in policy) return refusalResponse(c, policy.refusal);
    const conflict = await this.registrationConflict(req.email, policy.guard);
    if (!conflict) return null;
    // Its own code here: a plain 409 `conflict` from this route already means "a code was just
    // sent, wait a minute", and the sign-up form must tell the two apart.
    return refusalResponse(c, conflict.error === "conflict" ? { ...conflict, error: "email_registered" } : conflict);
  }

  /**
   * A new account from a third-party sign-in: the oauth_error code to stop with, or null. `email`
   * is the provider-verified address, "" when the account would get a placeholder address (refused
   * while an allowlist is set: it can't be checked against it).
   */
  async oauthSignupRefusal(email: string, settings: PortalSettings): Promise<string | null> {
    if (settings.backendModeEnabled) return "backend_mode";
    if (!email) return settings.registrationEmailSuffixAllowlist.length > 0 ? "email_suffix_not_allowed" : null;
    const policy = this.registrationPolicy(email, settings);
    if ("refusal" in policy) return policy.refusal.error;
    const conflict = await this.store.registrationEmailConflict(email, policy.guard);
    if (!conflict) return null;
    return conflict === "email_exists" ? "email_registered" : conflict;
  }

  /* ---------------- Legal documents ---------------- */

  async legalDocument(documentId: string): Promise<LegalDocumentResponse | null> {
    const settings = await this.settings();
    const doc = settings.loginAgreementDocuments.find((d) => d.id === documentId);
    if (!doc) return null;
    return {
      ...doc,
      updatedAt: settings.loginAgreementUpdatedAt,
      revision: loginAgreementRevision(settings.loginAgreementUpdatedAt, settings.loginAgreementDocuments),
    };
  }
}

/** The refusal for a store-level registration conflict (exact duplicates keep the old `conflict` code). */
export function conflictRefusal(conflict: RegistrationConflict): GuardRefusal {
  return { status: 409, error: conflict === "email_exists" ? "conflict" : conflict, message: registrationConflictMessage(conflict) };
}

/**
 * Routes and middleware of the guards. Mount after the /api/v1/admin/* admin guard and before the
 * ops routes (the backend-mode guards of the public pages and the settings-write hook must run
 * before those handlers).
 */
export function registerAuthGuardRoutes(app: Hono<AuthEnv>, guards: AuthGuards): void {
  // Any admin write may change the portal settings (settings PATCH, backup import …).
  app.use("/api/v1/admin/*", async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") guards.invalidateSettings();
  });

  const publicGuard = guards.backendModePublicGuard();
  app.use("/api/v1/public/models", publicGuard);
  app.use("/api/v1/public/status", publicGuard);
  app.use("/api/v1/public/channel-monitors/status", publicGuard);
  app.use("/api/v1/public/home", publicGuard);
  app.use("/api/v1/public/promo/*", publicGuard);

  app.get("/api/v1/admin/captcha", async (c) => c.json(await guards.captchaConfig()));
  app.patch("/api/v1/admin/captcha", (c) => guards.updateCaptcha(c));
  app.post("/api/v1/admin/captcha/test", (c) => guards.testCaptcha(c));

  app.post("/api/v1/auth/captcha/pass", (c) => guards.passRequest(c));

  app.get("/api/v1/public/legal/:documentId", async (c) => {
    const doc = await guards.legalDocument(c.req.param("documentId"));
    if (!doc) return c.json({ error: "not_found", message: "No such document" }, 404);
    c.header("Cache-Control", "no-cache");
    return c.json(doc);
  });
}
