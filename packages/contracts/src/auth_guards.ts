import { z } from "zod";

/**
 * Sign-in and sign-up guards: human verification (captcha), the registration email policy
 * (suffix allowlist, one account per unlisted domain, alias de-duplication, the reserved
 * placeholder domain), login agreement documents (terms / privacy, served at /legal/:id) and
 * backend (admin-only) mode.
 *
 * Pure ESM/Zod leaf module (no Node/Bun APIs, no imports from other contract files), shared by
 * the BFF (enforcement) and the console (rendering). The portal settings fields that use these
 * schemas live in commerce.ts (PortalSettingsSchema / toPublicSettings).
 */

/* ------------------------------------------------------------------------------------------ */
/* Email parsing, reserved domain, alias identity                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * Placeholder address domain of accounts whose sign-in provider gave no verified email (see
 * routes/oauth.ts placeholderEmail). Never delivered; nobody may register or be given one.
 */
export const RESERVED_EMAIL_DOMAIN = "users.noreply.slipgate";

/** ASCII whitespace only, exactly like the SQL twin (commerce.email_alias_identity uses btrim). */
function trimAscii(text: string): string {
  return text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
}

/**
 * The lower-cased local part and domain of an address, the domain without a trailing FQDN dot;
 * null when malformed (no "@", an empty side, or a second "@" in the domain).
 */
export function splitEmailForPolicy(raw: string): { local: string; domain: string } | null {
  const email = trimAscii(raw).toLowerCase();
  const at = email.indexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const rawDomain = email.slice(at + 1);
  if (!rawDomain || rawDomain.includes("@")) return null;
  const domain = rawDomain.replace(/\.+$/, "");
  return domain ? { local, domain } : null;
}

/** True for the reserved placeholder domain and its subdomains (any case, trailing dot or not). */
export function isReservedEmail(email: string): boolean {
  const domain = splitEmailForPolicy(email)?.domain;
  return domain !== undefined && (domain === RESERVED_EMAIL_DOMAIN || domain.endsWith(`.${RESERVED_EMAIL_DOMAIN}`));
}

const GMAIL_FAMILY = new Set(["gmail.com", "googlemail.com"]);

/**
 * The "inbox identity" of an address for registration de-duplication: lower-cased and trimmed,
 * the trailing FQDN dot dropped and a "+tag" stripped from the local part (only when something
 * precedes the "+"); for gmail.com / googlemail.com the local part also loses its dots (unless
 * nothing would be left) and the domain folds to gmail.com. Malformed input comes back lower-cased
 * and trimmed. Stored addresses, sign-in and delivery keep the address as typed.
 *
 * Mirrored exactly by the SQL function commerce.email_alias_identity (migration 0008), which the
 * Postgres store indexes and compares against: change both together (and REINDEX).
 */
export function normalizeEmailForAliasDedup(email: string): string {
  const parts = splitEmailForPolicy(email);
  if (!parts) return trimAscii(email).toLowerCase();
  let local = parts.local;
  const plus = local.indexOf("+");
  if (plus > 0) local = local.slice(0, plus);
  let domain = parts.domain;
  if (GMAIL_FAMILY.has(domain)) {
    const stripped = local.replaceAll(".", "");
    if (stripped) local = stripped;
    domain = "gmail.com";
  }
  return `${local}@${domain}`;
}

/**
 * Two-label public suffixes under which registrations are counted one level deeper (a.edu.cn and
 * b.edu.cn are different organisations). A compact stand-in for the public suffix list, covering
 * the suffixes mail domains commonly sit under; anything else counts at its last two labels.
 */
const MULTI_LABEL_PUBLIC_SUFFIXES = new Set(
  (
    "com.cn net.cn org.cn gov.cn edu.cn ac.cn mil.cn " +
    "com.hk net.hk org.hk edu.hk gov.hk idv.hk com.mo edu.mo com.tw net.tw org.tw edu.tw gov.tw idv.tw " +
    "co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk nhs.uk " +
    "co.jp ne.jp or.jp ac.jp go.jp ed.jp ad.jp gr.jp lg.jp " +
    "co.kr ne.kr or.kr ac.kr go.kr re.kr " +
    "com.au net.au org.au edu.au gov.au asn.au id.au co.nz net.nz org.nz ac.nz govt.nz school.nz " +
    "com.sg net.sg org.sg edu.sg gov.sg com.my net.my org.my edu.my gov.my " +
    "co.id or.id ac.id go.id web.id co.th or.th ac.th go.th in.th com.vn net.vn edu.vn gov.vn " +
    "com.ph net.ph org.ph edu.ph gov.ph co.in net.in org.in ac.in edu.in gov.in firm.in gen.in ind.in " +
    "com.pk edu.pk com.bd edu.bd com.np edu.np com.lk edu.lk " +
    "com.br net.br org.br edu.br gov.br com.ar edu.ar gob.ar com.mx edu.mx gob.mx org.mx com.co edu.co " +
    "com.pe edu.pe com.ve com.uy com.py com.bo com.ec com.gt " +
    "co.za org.za ac.za gov.za edu.za com.ng edu.ng com.eg edu.eg co.ke ac.ke " +
    "com.tr edu.tr gov.tr org.tr net.tr co.il ac.il org.il gov.il com.sa edu.sa com.ae ac.ae " +
    "com.ru org.ru net.ru com.ua org.ua edu.ua com.pl net.pl org.pl edu.pl " +
    "co.at or.at ac.at gv.at com.es org.es edu.es com.pt com.gr com.cy co.hu"
  ).split(" "),
);

/**
 * The registrable domain of a mail domain (mail.dept.example.com -> example.com, x.edu.cn ->
 * x.edu.cn): what the one-account-per-domain quota counts, so subdomains can't each claim a slot.
 */
export function registrableEmailDomain(domain: string): string {
  const d = trimAscii(domain).toLowerCase().replace(/^@/, "").replace(/\.+$/, "");
  const labels = d.split(".");
  if (labels.length <= 2) return d;
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) ? -3 : -2).join(".");
}

/** registrableEmailDomain of an address's domain; "" when the address is malformed. */
export function registrationEmailDomain(email: string): string {
  const parts = splitEmailForPolicy(email);
  return parts ? registrableEmailDomain(parts.domain) : "";
}

/* ------------------------------------------------------------------------------------------ */
/* Registration email suffix allowlist                                                        */
/* ------------------------------------------------------------------------------------------ */

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export const REGISTRATION_EMAIL_SUFFIX_MAX = 100;

/**
 * One allowlist entry in stored form: "@example.com" (that exact domain) or "*.edu.cn" (edu.cn and
 * every subdomain). Accepts "example.com", "@example.com" and "*.edu.cn" in any case. "" for a
 * blank entry, null when invalid.
 */
export function normalizeRegistrationEmailSuffix(raw: string): string | null {
  const value = trimAscii(raw).toLowerCase();
  if (!value) return "";
  if (value.startsWith("*.")) {
    const base = value.slice(2);
    return DOMAIN_RE.test(base) ? `*.${base}` : null;
  }
  let domain = value;
  if (value.includes("@")) {
    if (!value.startsWith("@") || value.indexOf("@", 1) !== -1) return null;
    domain = value.slice(1);
  }
  domain = domain.replace(/\.$/, "");
  return DOMAIN_RE.test(domain) ? `@${domain}` : null;
}

/** Normalised, de-duplicated, blanks dropped; an invalid entry is a validation error. */
export const RegistrationEmailSuffixListSchema = z
  .array(z.string().max(255))
  .max(REGISTRATION_EMAIL_SUFFIX_MAX)
  .superRefine((items, ctx) => {
    items.forEach((item, index) => {
      if (normalizeRegistrationEmailSuffix(item) === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: `Invalid email suffix: ${item.slice(0, 80)}` });
      }
    });
  })
  .transform((items) => {
    const out: string[] = [];
    for (const item of items) {
      const normalized = normalizeRegistrationEmailSuffix(item);
      if (normalized && !out.includes(normalized)) out.push(normalized);
    }
    return out;
  });

/** Empty allowlist: everything is allowed. Otherwise the address's domain must match an entry. */
export function isRegistrationEmailSuffixAllowed(email: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const domain = splitEmailForPolicy(email)?.domain;
  if (!domain) return false;
  for (const entry of allowlist) {
    if (entry.startsWith("@") && domain === entry.slice(1)) return true;
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      if (domain === base || domain.endsWith(`.${base}`)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------------------------------ */
/* Login agreement documents (terms, privacy …) and the public legal pages                    */
/* ------------------------------------------------------------------------------------------ */

export const LoginAgreementModeSchema = z.enum(["modal", "checkbox"]);
export type LoginAgreementMode = z.infer<typeof LoginAgreementModeSchema>;

export const LOGIN_AGREEMENT_MAX_DOCUMENTS = 10;
export const LOGIN_AGREEMENT_MAX_TITLE = 80;
export const LOGIN_AGREEMENT_MAX_CONTENT = 100_000;
const DOCUMENT_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

/**
 * 64-bit non-cryptographic hash (two 32-bit multiply-xorshift lanes) as 16 hex digits: change
 * detection for the agreement revision and generated document ids. Not for anything secret.
 */
export function contentHash64(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * A document id as used in /legal/:id: lower-case letters and digits, runs of "-", " ", ".", "/"
 * become one "-", "_" is kept, other characters are dropped, separators trimmed, 64 chars at most.
 */
export function normalizeLoginAgreementDocumentId(raw: string): string {
  let out = "";
  let lastSeparator = false;
  for (const ch of trimAscii(raw).toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      lastSeparator = false;
    } else if (ch === "-" || ch === "_" || ch === " " || ch === "." || ch === "/") {
      if (!lastSeparator && out.length > 0) {
        out += ch === "_" ? "_" : "-";
        lastSeparator = true;
      }
    }
  }
  return out.slice(0, 64).replace(/^[-_]+|[-_]+$/g, "");
}

/**
 * Preprocess for the stored / submitted document list: blank documents (no title and no content)
 * dropped, title and content trimmed, ids normalised (from the title, else a content hash, when
 * missing) and made unique with -2, -3 … Anything that is not an array passes through to fail.
 */
export function normalizeLoginAgreementDocuments(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const out: { id: string; title: string; contentMd: string }[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") {
      out.push(item as never);
      return;
    }
    const doc = item as Record<string, unknown>;
    const title = typeof doc.title === "string" ? trimAscii(doc.title) : "";
    const contentMd = typeof doc.contentMd === "string" ? trimAscii(doc.contentMd) : "";
    if (!title && !contentMd) return;
    let id = normalizeLoginAgreementDocumentId(typeof doc.id === "string" ? doc.id : "");
    if (!id) id = normalizeLoginAgreementDocumentId(title);
    if (!id) id = `doc-${contentHash64(`${index}:${title}:${contentMd}`).slice(0, 10)}`;
    const base = id.slice(0, 58);
    for (let suffix = 2; seen.has(id); suffix++) id = `${base}-${suffix}`;
    seen.add(id);
    out.push({ id, title, contentMd });
  });
  return out;
}

export const LoginAgreementDocumentSchema = z.object({
  id: z.string().regex(DOCUMENT_ID_RE, "Document id: lower-case letters, digits, - and _"),
  title: z.string().trim().min(1, "Document title is required").max(LOGIN_AGREEMENT_MAX_TITLE),
  contentMd: z.string().max(LOGIN_AGREEMENT_MAX_CONTENT, `Document content is limited to ${LOGIN_AGREEMENT_MAX_CONTENT} characters`),
});
export type LoginAgreementDocument = z.infer<typeof LoginAgreementDocumentSchema>;

export const LoginAgreementDocumentsSchema = z.preprocess(
  normalizeLoginAgreementDocuments,
  z.array(LoginAgreementDocumentSchema).max(LOGIN_AGREEMENT_MAX_DOCUMENTS),
);

/** "" (not shown) or a calendar date such as 2026-03-31. */
export const LoginAgreementUpdatedAtSchema = z
  .string()
  .trim()
  .regex(/^(?:\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))?$/, "Expected a date such as 2026-03-31");

/**
 * Changes whenever the updated-at date or any document (id, title or text) changes: consent given
 * to an older revision is asked for again.
 */
export function loginAgreementRevision(updatedAt: string, documents: readonly LoginAgreementDocument[]): string {
  return contentHash64(JSON.stringify({ updatedAt: updatedAt.trim(), documents: documents.map((d) => [d.id, d.title, d.contentMd]) }));
}

/** In public settings: the documents to link (their text comes from GET /api/v1/public/legal/:id). */
export const PublicLoginAgreementDocumentSchema = LoginAgreementDocumentSchema.pick({ id: true, title: true });
export type PublicLoginAgreementDocument = z.infer<typeof PublicLoginAgreementDocumentSchema>;

/** GET /api/v1/public/legal/:documentId */
export const LegalDocumentResponseSchema = LoginAgreementDocumentSchema.extend({
  updatedAt: z.string(),
  revision: z.string(),
});
export type LegalDocumentResponse = z.infer<typeof LegalDocumentResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Captcha (Cloudflare Turnstile, Tencent Captcha, Aliyun Captcha 2.0)                        */
/* ------------------------------------------------------------------------------------------ */

export const CaptchaProviderSchema = z.enum(["none", "turnstile", "tencent", "aliyun"]);
export type CaptchaProvider = z.infer<typeof CaptchaProviderSchema>;

/** Where a challenge is required while a provider is on. */
export const CaptchaScopesSchema = z.object({
  login: z.boolean(),
  register: z.boolean(),
  /** Sending a sign-up email code. */
  emailCode: z.boolean(),
  forgotPassword: z.boolean(),
  /** Starting a third-party sign-in (the console asks POST /api/v1/auth/captcha/pass first). */
  oauth: z.boolean(),
});
export type CaptchaScopes = z.infer<typeof CaptchaScopesSchema>;
export type CaptchaScope = keyof CaptchaScopes;

export const DEFAULT_CAPTCHA_SCOPES: CaptchaScopes = {
  login: true,
  register: true,
  emailCode: true,
  forgotPassword: true,
  oauth: false,
};

/** Tencent site: cn = cloud.tencent.com (TJCaptcha.js), intl = tencentcloud.com (TJCaptcha-global.js). */
export const TencentCaptchaRegionSchema = z.enum(["cn", "intl"]);
/** Aliyun region: cn = cn-shanghai, sgp = ap-southeast-1 (the widget's `region` option). */
export const AliyunCaptchaRegionSchema = z.enum(["cn", "sgp"]);

/** Admin view (GET /api/v1/admin/captcha). Secrets are only reported as set / unset. */
export const CaptchaConfigSchema = z.object({
  provider: CaptchaProviderSchema,
  scopes: CaptchaScopesSchema,
  turnstileSiteKey: z.string().trim().max(256),
  turnstileSecretKeySet: z.boolean(),
  /** Tencent CaptchaAppId (a positive integer). */
  tencentAppId: z.string().trim().regex(/^\d{0,20}$/, "CaptchaAppId is a number"),
  tencentRegion: TencentCaptchaRegionSchema,
  tencentAppSecretKeySet: z.boolean(),
  /** Tencent Cloud API SecretId / SecretKey (DescribeCaptchaResult is a signed cloud API call). */
  tencentSecretIdSet: z.boolean(),
  tencentSecretKeySet: z.boolean(),
  aliyunAccessKeyId: z.string().trim().max(128),
  aliyunAccessKeySecretSet: z.boolean(),
  aliyunSceneId: z.string().trim().max(128),
  /** Identity prefix shown in the Aliyun console (the widget's `prefix` option). */
  aliyunPrefix: z.string().trim().max(128),
  aliyunRegion: AliyunCaptchaRegionSchema,
});
export type CaptchaConfig = z.infer<typeof CaptchaConfigSchema>;

export const DEFAULT_CAPTCHA_CONFIG: CaptchaConfig = {
  provider: "none",
  scopes: { ...DEFAULT_CAPTCHA_SCOPES },
  turnstileSiteKey: "",
  turnstileSecretKeySet: false,
  tencentAppId: "",
  tencentRegion: "cn",
  tencentAppSecretKeySet: false,
  tencentSecretIdSet: false,
  tencentSecretKeySet: false,
  aliyunAccessKeyId: "",
  aliyunAccessKeySecretSet: false,
  aliyunSceneId: "",
  aliyunPrefix: "",
  aliyunRegion: "cn",
};

/**
 * PATCH /api/v1/admin/captcha: any subset. Secret fields: omitted = keep, "" = clear, otherwise
 * replace. Turning a provider on (or changing its keys) needs every credential of it and a
 * successful credential check against the provider, or nothing is saved.
 */
export const UpdateCaptchaConfigRequestSchema = CaptchaConfigSchema.omit({
  scopes: true,
  turnstileSecretKeySet: true,
  tencentAppSecretKeySet: true,
  tencentSecretIdSet: true,
  tencentSecretKeySet: true,
  aliyunAccessKeySecretSet: true,
})
  .extend({
    scopes: CaptchaScopesSchema.partial(),
    turnstileSecretKey: z.string().trim().max(512),
    tencentAppSecretKey: z.string().trim().max(512),
    tencentSecretId: z.string().trim().max(512),
    tencentSecretKey: z.string().trim().max(512),
    aliyunAccessKeySecret: z.string().trim().max(512),
  })
  .partial();
export type UpdateCaptchaConfigRequest = z.infer<typeof UpdateCaptchaConfigRequestSchema>;

/**
 * The widget's answer, sent with a guarded request as `captcha`. Turnstile: `turnstileToken`;
 * Tencent: `tencentTicket` + `tencentRandstr`; Aliyun: `aliyunVerifyParam` (captchaVerifyParam).
 * `pass` is a one-time pass the server handed out earlier (the second, two-factor step of a
 * sign-in; an OAuth start) in place of a fresh challenge.
 */
export const CaptchaProofSchema = z.object({
  turnstileToken: z.string().trim().max(4096).optional(),
  tencentTicket: z.string().trim().max(8192).optional(),
  tencentRandstr: z.string().trim().max(256).optional(),
  aliyunVerifyParam: z.string().trim().max(16384).optional(),
  pass: z.string().trim().max(128).optional(),
});
export type CaptchaProof = z.infer<typeof CaptchaProofSchema>;

/** In public settings: what the login page needs to render the active provider's widget. */
export const PublicCaptchaSchema = z.object({
  /** The provider switched on ("none": no widget; the admin API only turns on fully configured ones). */
  provider: CaptchaProviderSchema,
  scopes: CaptchaScopesSchema,
  turnstileSiteKey: z.string(),
  tencentAppId: z.string(),
  tencentRegion: TencentCaptchaRegionSchema,
  aliyunSceneId: z.string(),
  aliyunPrefix: z.string(),
  aliyunRegion: AliyunCaptchaRegionSchema,
});
export type PublicCaptcha = z.infer<typeof PublicCaptchaSchema>;

export const DISABLED_PUBLIC_CAPTCHA: PublicCaptcha = {
  provider: "none",
  scopes: { ...DEFAULT_CAPTCHA_SCOPES },
  turnstileSiteKey: "",
  tencentAppId: "",
  tencentRegion: "cn",
  aliyunSceneId: "",
  aliyunPrefix: "",
  aliyunRegion: "cn",
};

/**
 * POST /api/v1/admin/captcha/test. Without `captcha`: checks the saved credentials with the
 * provider. With `captcha` (a widget answer from the settings page): verifies it end to end.
 * `provider` tests saved credentials of a provider that is not switched on yet (default: the
 * active one).
 */
export const CaptchaTestRequestSchema = z.object({
  provider: CaptchaProviderSchema.exclude(["none"]).optional(),
  captcha: CaptchaProofSchema.optional(),
});
export type CaptchaTestRequest = z.infer<typeof CaptchaTestRequestSchema>;

export const CaptchaTestResultSchema = z.object({
  ok: z.boolean(),
  provider: CaptchaProviderSchema,
  mode: z.enum(["credentials", "token"]),
  /** Error code when not ok (captcha_not_configured, captcha_invalid_credentials, captcha_invalid, captcha_unavailable). */
  error: z.string().nullable(),
  detail: z.string(),
});
export type CaptchaTestResult = z.infer<typeof CaptchaTestResultSchema>;

/** POST /api/v1/auth/captcha/pass: trade a solved challenge for a one-time pass (OAuth start). */
export const CaptchaPassRequestSchema = z.object({
  scope: z.literal("oauth"),
  captcha: CaptchaProofSchema.default({}),
});
export type CaptchaPassRequest = z.infer<typeof CaptchaPassRequestSchema>;

export const CaptchaPassResponseSchema = z.object({
  /** false: the scope needs no challenge right now (pass is null, start the flow directly). */
  required: z.boolean(),
  pass: z.string().nullable(),
  expiresInSeconds: z.number().int().nonnegative(),
});
export type CaptchaPassResponse = z.infer<typeof CaptchaPassResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Error codes                                                                                */
/* ------------------------------------------------------------------------------------------ */

/** `error` values the auth guards answer with (besides the existing invalid_request / conflict …). */
export const AUTH_GUARD_ERROR_CODES = [
  /** 400: the scope needs a challenge and none (or an expired pass) was sent. */
  "captcha_required",
  /** 400: the provider rejected the answer (solve the challenge again). */
  "captcha_invalid",
  /** 503: the provider could not be asked, or the saved captcha configuration is unusable (fail-closed). */
  "captcha_unavailable",
  /** Admin save / test only: the provider refused the credentials. */
  "captcha_invalid_credentials",
  /** Admin save only: a credential of the chosen provider is missing. */
  "captcha_not_configured",
  /** 400: the placeholder domain users.noreply.slipgate. */
  "email_reserved",
  /** 400: the domain is not on the registration allowlist (and the per-domain quota is off). */
  "email_suffix_not_allowed",
  /** 409: unlisted domain under the per-domain quota, which already has an account. */
  "email_domain_limit",
  /** 409: another account uses the same inbox (+tag / Gmail dot / googlemail variants). */
  "email_alias_exists",
  /** 409, POST /api/v1/auth/email-code only: the address already has an account (a plain `conflict` there is the resend cooldown). */
  "email_registered",
  /** 403: backend (admin-only) mode is on. */
  "backend_mode",
  /** 429: too many sign-up attempts from this address. */
  "too_many_attempts",
] as const;
export type AuthGuardErrorCode = (typeof AUTH_GUARD_ERROR_CODES)[number];
