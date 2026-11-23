import type {
  CaptchaConfig,
  CaptchaProvider,
  CaptchaScope,
  CaptchaScopes,
  UpdateCaptchaConfigRequest,
} from "@slipgate/contracts";
import type { CaptchaWidgetConfig } from "../../lib/captcha";
import type { FieldIssue } from "./emailForm";

/**
 * Editable captcha settings (PATCH /api/v1/admin/captcha). Secrets follow SecretInput's contract:
 * undefined keeps the stored value, "" clears it, anything else replaces it.
 */
export interface CaptchaForm {
  provider: CaptchaProvider;
  scopes: CaptchaScopes;
  turnstileSiteKey: string;
  turnstileSecretKey: string | undefined;
  tencentAppId: string;
  tencentRegion: "cn" | "intl";
  tencentAppSecretKey: string | undefined;
  tencentSecretId: string | undefined;
  tencentSecretKey: string | undefined;
  aliyunAccessKeyId: string;
  aliyunAccessKeySecret: string | undefined;
  aliyunSceneId: string;
  aliyunPrefix: string;
  aliyunRegion: "cn" | "sgp";
}

export const CAPTCHA_SCOPE_KEYS: CaptchaScope[] = ["login", "register", "emailCode", "forgotPassword", "oauth"];
export const CAPTCHA_PROVIDERS: Exclude<CaptchaProvider, "none">[] = ["turnstile", "tencent", "aliyun"];

export const CAPTCHA_SECRET_FIELDS = [
  "turnstileSecretKey",
  "tencentAppSecretKey",
  "tencentSecretId",
  "tencentSecretKey",
  "aliyunAccessKeySecret",
] as const;
export type CaptchaSecretField = (typeof CAPTCHA_SECRET_FIELDS)[number];

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
type PlainField = (typeof PLAIN_FIELDS)[number];

/** Dirty / validation keys: plain fields, secrets and `scopes.<scope>`. */
export type CaptchaFieldKey = PlainField | CaptchaSecretField | `scopes.${CaptchaScope}`;

export const CAPTCHA_FIELDS: CaptchaFieldKey[] = [
  ...PLAIN_FIELDS,
  ...CAPTCHA_SECRET_FIELDS,
  ...CAPTCHA_SCOPE_KEYS.map((s) => `scopes.${s}` as const),
];

/** Fields each provider needs before it can be switched on (mirrors the BFF). */
export const PROVIDER_FIELDS: Record<Exclude<CaptchaProvider, "none">, (PlainField | CaptchaSecretField)[]> = {
  turnstile: ["turnstileSiteKey", "turnstileSecretKey"],
  tencent: ["tencentAppId", "tencentAppSecretKey", "tencentSecretId", "tencentSecretKey"],
  aliyun: ["aliyunPrefix", "aliyunSceneId", "aliyunAccessKeyId", "aliyunAccessKeySecret"],
};

/** `<secret>Set` flag of each secret field. */
const SET_FLAG: Record<CaptchaSecretField, keyof CaptchaConfig> = {
  turnstileSecretKey: "turnstileSecretKeySet",
  tencentAppSecretKey: "tencentAppSecretKeySet",
  tencentSecretId: "tencentSecretIdSet",
  tencentSecretKey: "tencentSecretKeySet",
  aliyunAccessKeySecret: "aliyunAccessKeySecretSet",
};

export function secretIsSet(saved: CaptchaConfig, field: CaptchaSecretField): boolean {
  return saved[SET_FLAG[field]] === true;
}

export function toCaptchaForm(c: CaptchaConfig): CaptchaForm {
  return {
    provider: c.provider,
    scopes: { ...c.scopes },
    turnstileSiteKey: c.turnstileSiteKey,
    turnstileSecretKey: undefined,
    tencentAppId: c.tencentAppId,
    tencentRegion: c.tencentRegion,
    tencentAppSecretKey: undefined,
    tencentSecretId: undefined,
    tencentSecretKey: undefined,
    aliyunAccessKeyId: c.aliyunAccessKeyId,
    aliyunAccessKeySecret: undefined,
    aliyunSceneId: c.aliyunSceneId,
    aliyunPrefix: c.aliyunPrefix,
    aliyunRegion: c.aliyunRegion,
  };
}

export function cloneCaptchaForm(f: CaptchaForm): CaptchaForm {
  return { ...f, scopes: { ...f.scopes } };
}

function value(f: CaptchaForm, key: CaptchaFieldKey): string {
  if (key.startsWith("scopes.")) return String(f.scopes[key.slice(7) as CaptchaScope]);
  const v = f[key as PlainField | CaptchaSecretField];
  if (v === undefined) return "\u0000keep";
  return typeof v === "string" ? v.trim() : String(v);
}

export function captchaDirtyKeys(form: CaptchaForm, base: CaptchaForm): CaptchaFieldKey[] {
  return CAPTCHA_FIELDS.filter((k) => value(form, k) !== value(base, k));
}

const issue = (key: string, params?: Record<string, unknown>): FieldIssue => ({ key, params });

/** Whether the field will hold a value after saving (secrets: typed, or stored and not cleared). */
function willHave(f: CaptchaForm, saved: CaptchaConfig, key: PlainField | CaptchaSecretField): boolean {
  if ((CAPTCHA_SECRET_FIELDS as readonly string[]).includes(key)) {
    const v = f[key as CaptchaSecretField];
    return v === undefined ? secretIsSet(saved, key as CaptchaSecretField) : v.trim() !== "";
  }
  return String(f[key as PlainField]).trim() !== "";
}

export function validateCaptchaForm(f: CaptchaForm, saved: CaptchaConfig): Partial<Record<CaptchaFieldKey, FieldIssue>> {
  const e: Partial<Record<CaptchaFieldKey, FieldIssue>> = {};
  if (f.provider !== "none") {
    for (const key of PROVIDER_FIELDS[f.provider]) {
      if (!willHave(f, saved, key)) e[key] = issue("settings.errors.required");
    }
  }
  const appId = f.tencentAppId.trim();
  if (appId && !/^[1-9]\d{0,19}$/.test(appId)) e.tencentAppId = issue("authGuards.settings.captcha.errors.appId");
  const maxLen: [PlainField, number][] = [
    ["turnstileSiteKey", 256],
    ["aliyunAccessKeyId", 128],
    ["aliyunSceneId", 128],
    ["aliyunPrefix", 128],
  ];
  for (const [k, n] of maxLen) if (String(f[k]).trim().length > n) e[k] = issue("settings.errors.maxLength", { n });
  for (const k of CAPTCHA_SECRET_FIELDS) {
    if ((f[k]?.trim().length ?? 0) > 512) e[k] = issue("settings.errors.maxLength", { n: 512 });
  }
  return e;
}

/** PATCH body with the changed fields only. */
export function buildCaptchaPatch(f: CaptchaForm, dirty: CaptchaFieldKey[]): UpdateCaptchaConfigRequest {
  const patch: UpdateCaptchaConfigRequest = {};
  const scopes: Partial<CaptchaScopes> = {};
  for (const k of dirty) {
    if (k.startsWith("scopes.")) {
      const scope = k.slice(7) as CaptchaScope;
      scopes[scope] = f.scopes[scope];
    } else if ((CAPTCHA_SECRET_FIELDS as readonly string[]).includes(k)) {
      const v = f[k as CaptchaSecretField];
      if (v !== undefined) patch[k as CaptchaSecretField] = v.trim();
    } else {
      const v = f[k as PlainField];
      Object.assign(patch, { [k]: typeof v === "string" ? v.trim() : v });
    }
  }
  if (Object.keys(scopes).length) patch.scopes = scopes;
  return patch;
}

/** Field names listed by a captcha_not_configured message ("… switching x on: a, b"). */
export function parseMissingFields(message: string): CaptchaFieldKey[] {
  const tail = /:\s*([A-Za-z, ]+)$/.exec(message)?.[1] ?? "";
  return tail
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is CaptchaFieldKey => (CAPTCHA_FIELDS as string[]).includes(s));
}

/** Field errors from a Zod message such as `tencentAppId: CaptchaAppId is a number`. */
export function parseCaptchaServerErrors(message: string): Partial<Record<CaptchaFieldKey, string>> {
  const out: Partial<Record<CaptchaFieldKey, string>> = {};
  for (const part of message.split("; ")) {
    const m = /^([A-Za-z]+(?:\.[A-Za-z]+)?):\s*(.+)$/.exec(part.trim());
    if (m && (CAPTCHA_FIELDS as string[]).includes(m[1]!)) out[m[1] as CaptchaFieldKey] = m[2]!;
  }
  return out;
}

/** What the "try the challenge" box renders: the saved configuration's public half. */
export function widgetConfigOf(c: CaptchaConfig): CaptchaWidgetConfig {
  return {
    provider: c.provider,
    turnstileSiteKey: c.turnstileSiteKey,
    tencentAppId: c.tencentAppId,
    tencentRegion: c.tencentRegion,
    aliyunSceneId: c.aliyunSceneId,
    aliyunPrefix: c.aliyunPrefix,
    aliyunRegion: c.aliyunRegion,
  };
}
