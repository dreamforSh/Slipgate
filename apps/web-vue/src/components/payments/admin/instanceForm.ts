import {
  minorToFiat,
  PAYMENT_INSTANCE_REQUIRED_SECRETS,
  PAYMENT_INSTANCE_SECRET_FIELDS,
  PAYMENT_INSTANCE_TYPES,
  type PaymentChannelLimit,
  type PaymentInstanceProvider,
  type PaymentProviderInstance,
} from "@slipgate/contracts";
import { parseFiatInput } from "../paymentUtil";

/**
 * The provider-instance editor's form model: which public fields each gateway has (mirroring
 * PAYMENT_INSTANCE_CONFIG_SCHEMAS), their defaults, and conversions between the typed draft and
 * the admin API's create / update bodies. Limits are typed as fiat text ("100.00"; "" = none).
 */

export const INSTANCE_PROVIDERS: PaymentInstanceProvider[] = ["easypay", "stripe", "alipay", "wxpay", "airwallex"];

export type FieldKind = "text" | "url" | "pem" | "switch" | "modes" | "select" | "country";

export interface ConfigField {
  key: string;
  kind: FieldKind;
  required?: boolean;
  /** Choices of `modes` / `select` fields (labels come from i18n). */
  options?: readonly string[];
  max?: number;
  /** i18n key of the help line, if any. */
  hint?: string;
  /** Spans both columns of the form grid. */
  wide?: boolean;
}

export const CONFIG_FIELDS: Record<PaymentInstanceProvider, ConfigField[]> = {
  easypay: [
    { key: "apiUrl", kind: "url", required: true, max: 512, wide: true },
    { key: "pid", kind: "text", required: true, max: 64 },
  ],
  stripe: [],
  alipay: [
    { key: "appId", kind: "text", required: true, max: 64 },
    { key: "sandbox", kind: "switch", hint: "sandboxHint" },
    { key: "alipayPublicKey", kind: "pem", required: true, max: 8192, hint: "alipayPublicKeyHint", wide: true },
    { key: "modes", kind: "modes", options: ["precreate", "page", "wap"], hint: "alipayModesHint", wide: true },
  ],
  wxpay: [
    { key: "mchId", kind: "text", required: true, max: 64 },
    { key: "appId", kind: "text", required: true, max: 64 },
    { key: "mpAppId", kind: "text", max: 64, hint: "mpAppIdHint" },
    { key: "certSerial", kind: "text", required: true, max: 128 },
    { key: "publicKeyId", kind: "text", required: true, max: 128, wide: true },
    { key: "publicKey", kind: "pem", required: true, max: 8192, hint: "publicKeyHint", wide: true },
    { key: "modes", kind: "modes", options: ["native", "h5", "jsapi"], hint: "wxpayModesHint", wide: true },
    { key: "h5AppName", kind: "text", max: 64 },
    { key: "h5AppUrl", kind: "url", max: 512 },
  ],
  airwallex: [
    { key: "clientId", kind: "text", required: true, max: 128 },
    { key: "accountId", kind: "text", max: 128, hint: "accountIdHint" },
    { key: "env", kind: "select", options: ["demo", "prod"] },
    { key: "currency", kind: "select", options: ["", "CNY", "USD"], hint: "currencyHint" },
    { key: "countryCode", kind: "country" },
  ],
};

export const DEFAULT_CONFIG: Record<PaymentInstanceProvider, Record<string, unknown>> = {
  easypay: { apiUrl: "", pid: "" },
  stripe: {},
  alipay: { appId: "", alipayPublicKey: "", sandbox: false, modes: ["precreate", "page", "wap"] },
  wxpay: {
    appId: "",
    mpAppId: "",
    mchId: "",
    certSerial: "",
    publicKeyId: "",
    publicKey: "",
    modes: ["native", "h5"],
    h5AppName: "",
    h5AppUrl: "",
  },
  airwallex: { clientId: "", accountId: "", env: "demo", currency: "", countryCode: "CN" },
};

/** Secrets pasted as multi-line PEM (a single-line input would drop the line breaks). */
export const PEM_SECRETS: ReadonlySet<string> = new Set(["privateKey"]);

export function secretFields(provider: PaymentInstanceProvider): readonly string[] {
  return PAYMENT_INSTANCE_SECRET_FIELDS[provider];
}

export function isRequiredSecret(provider: PaymentInstanceProvider, field: string): boolean {
  return (PAYMENT_INSTANCE_REQUIRED_SECRETS[provider] as readonly string[]).includes(field);
}

export interface LimitDraft {
  daily: string;
  min: string;
  max: string;
}

export interface InstanceDraft {
  provider: PaymentInstanceProvider;
  name: string;
  enabled: boolean;
  supportedTypes: string[];
  paymentMode: "popup" | "qrcode";
  refundEnabled: boolean;
  allowUserRefund: boolean;
  config: Record<string, unknown>;
  /** undefined = keep, "" = clear, otherwise replace (same contract as SecretInput). */
  secrets: Record<string, string | undefined>;
  limits: Record<string, LimitDraft>;
}

const limitText = (minor: number | undefined) => (minor && minor > 0 ? minorToFiat(minor) : "");

/** Deep copy of plain JSON data (works on Vue proxies, unlike structuredClone). */
const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function emptyDraft(provider: PaymentInstanceProvider): InstanceDraft {
  const types = provider === "easypay" ? ["alipay", "wxpay"] : [...PAYMENT_INSTANCE_TYPES[provider]];
  return {
    provider,
    name: "",
    enabled: true,
    supportedTypes: types,
    paymentMode: "popup",
    refundEnabled: true,
    allowUserRefund: false,
    config: cloneJson(DEFAULT_CONFIG[provider]),
    secrets: {},
    limits: Object.fromEntries(PAYMENT_INSTANCE_TYPES[provider].map((t) => [t, { daily: "", min: "", max: "" }])),
  };
}

export function draftFromInstance(item: PaymentProviderInstance): InstanceDraft {
  const base = emptyDraft(item.provider);
  const limits: Record<string, LimitDraft> = { ...base.limits };
  for (const [type, l] of Object.entries(item.limits)) {
    limits[type] = { daily: limitText(l.dailyLimitMinor), min: limitText(l.singleMinMinor), max: limitText(l.singleMaxMinor) };
  }
  return {
    provider: item.provider,
    name: item.name,
    enabled: item.enabled,
    supportedTypes: [...item.supportedTypes],
    paymentMode: item.paymentMode === "qrcode" ? "qrcode" : "popup",
    refundEnabled: item.refundEnabled,
    allowUserRefund: item.allowUserRefund,
    config: { ...cloneJson(DEFAULT_CONFIG[item.provider]), ...cloneJson(item.config) },
    secrets: {},
    limits,
  };
}

/** Fiat text → minor units; "" = 0 (no limit); null when not a valid amount. */
export function limitMinor(text: string): number | null {
  const v = text.trim();
  if (v === "") return 0;
  return parseFiatInput(v);
}

export function limitsBody(draft: InstanceDraft): Record<string, PaymentChannelLimit> {
  const out: Record<string, PaymentChannelLimit> = {};
  for (const type of draft.supportedTypes) {
    const l = draft.limits[type];
    if (!l) continue;
    const daily = limitMinor(l.daily) ?? 0;
    const min = limitMinor(l.min) ?? 0;
    const max = limitMinor(l.max) ?? 0;
    if (daily || min || max) out[type] = { dailyLimitMinor: daily, singleMinMinor: min, singleMaxMinor: max };
  }
  return out;
}

/** Trimmed public config in the shape the provider's schema expects. */
export function configBody(draft: InstanceDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of CONFIG_FIELDS[draft.provider]) {
    const v = draft.config[f.key];
    if (f.kind === "switch") out[f.key] = Boolean(v);
    else if (f.kind === "modes") out[f.key] = Array.isArray(v) ? [...v] : [];
    else if (f.kind === "country") out[f.key] = String(v ?? "").trim().toUpperCase();
    else out[f.key] = String(v ?? "").trim();
  }
  return out;
}

/** Only the secrets being replaced or cleared ("" on a stored secret). */
export function secretsBody(draft: InstanceDraft, secretsSet: Record<string, boolean>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, value] of Object.entries(draft.secrets)) {
    if (value === undefined) continue;
    if (value === "" && !secretsSet[field]) continue;
    out[field] = value;
  }
  return out;
}
