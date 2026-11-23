import { z } from "zod";
import { MAX_FIAT_MINOR, PaymentCurrencySchema } from "./payments.ts";

/**
 * Payment provider instances: any number of merchant accounts per gateway (EasyPay, Stripe, the
 * official Alipay and WeChat Pay APIs, Airwallex), each with its own credentials, the channels it
 * serves, per-channel limits and refund flags. Orders are spread over the enabled instances of a
 * channel by PaymentConfig.loadBalanceStrategy and remember the instance that took them, so
 * callbacks, queries and refunds use that merchant's credentials. Secrets are write-only: the
 * admin API reports them as set/unset (`secretsSet`) and the BFF keeps them encrypted at rest.
 */

export const PaymentInstanceProviderSchema = z.enum(["easypay", "stripe", "alipay", "wxpay", "airwallex"]);
export type PaymentInstanceProvider = z.infer<typeof PaymentInstanceProviderSchema>;

/** Per-channel limits in fiat minor units; 0 = no limit. dailyLimit counts today's (UTC) paid and unexpired pending orders. */
export const PaymentChannelLimitSchema = z.object({
  dailyLimitMinor: z.number().int().min(0).max(MAX_FIAT_MINOR).default(0),
  singleMinMinor: z.number().int().min(0).max(MAX_FIAT_MINOR).default(0),
  singleMaxMinor: z.number().int().min(0).max(MAX_FIAT_MINOR).default(0),
});
export type PaymentChannelLimit = z.infer<typeof PaymentChannelLimitSchema>;

/** Alipay checkout kinds: page = desktop cashier, wap = mobile cashier, precreate = QR (face-to-face). */
export const AlipayModeSchema = z.enum(["page", "wap", "precreate"]);
export type AlipayMode = z.infer<typeof AlipayModeSchema>;

/** WeChat Pay v3 kinds: native = QR (code_url), h5 = mobile browser page, jsapi = inside WeChat (needs the payer's openid). */
export const WxpayModeSchema = z.enum(["native", "h5", "jsapi"]);
export type WxpayMode = z.infer<typeof WxpayModeSchema>;

const HttpsOrHttpUrl = z
  .string()
  .trim()
  .max(512)
  .refine((v) => /^https?:\/\/[^\s/]+/i.test(v), "Must be an http(s) URL");
const Ident = (max = 64) => z.string().trim().max(max);
const PemText = z.string().trim().max(8192);

/* Public (non-secret) configuration per provider. ---------------------------------------------- */

export const EasypayInstanceConfigSchema = z.object({
  apiUrl: HttpsOrHttpUrl,
  pid: Ident().min(1),
});

export const StripeInstanceConfigSchema = z.object({});

export const AlipayInstanceConfigSchema = z.object({
  appId: Ident().min(1),
  /** Alipay's public key (PEM or bare base64) that signs its responses and notifications. */
  alipayPublicKey: PemText.min(1),
  /** Use the Alipay sandbox gateway (openapi-sandbox.dl.alipaydev.com). */
  sandbox: z.boolean().default(false),
  /** Desktop tries precreate (QR) first and falls back to page; phones use wap, else precreate + app link. */
  modes: z.array(AlipayModeSchema).min(1).default(["precreate", "page", "wap"]),
});

export const WxpayInstanceConfigSchema = z.object({
  /** AppID bound to the merchant (Native / H5). */
  appId: Ident().min(1),
  /** Official-account AppID for JSAPI and the payment OAuth (empty = appId). */
  mpAppId: Ident().default(""),
  mchId: Ident().min(1),
  /** Serial number of the merchant API certificate (signs requests). */
  certSerial: Ident(128).min(1),
  /** WeChat Pay public key ID (Wechatpay-Serial of its responses and notifications) and the key itself. */
  publicKeyId: Ident(128).min(1),
  publicKey: PemText.min(1),
  modes: z.array(WxpayModeSchema).min(1).default(["native", "h5"]),
  h5AppName: Ident().default(""),
  h5AppUrl: z.string().trim().max(512).default(""),
});

export const AirwallexInstanceConfigSchema = z.object({
  clientId: Ident(128).min(1),
  /** Connected-account id for platform keys (x-on-behalf-of); empty for single-account keys. */
  accountId: Ident(128).default(""),
  env: z.enum(["demo", "prod"]).default("demo"),
  /** Only orders in this currency use the instance; empty = any. */
  currency: z.union([z.literal(""), PaymentCurrencySchema]).default(""),
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/, "Two-letter ISO country code")
    .default("CN"),
});

export const PAYMENT_INSTANCE_CONFIG_SCHEMAS = {
  easypay: EasypayInstanceConfigSchema,
  stripe: StripeInstanceConfigSchema,
  alipay: AlipayInstanceConfigSchema,
  wxpay: WxpayInstanceConfigSchema,
  airwallex: AirwallexInstanceConfigSchema,
} as const;

/**
 * Write-only fields per provider. easypay.key = merchant key; stripe = API secret key and webhook
 * signing secret; alipay.privateKey = app private key (RSA2); wxpay = merchant API private key,
 * APIv3 key (32 characters) and the official account's AppSecret (JSAPI openid OAuth);
 * airwallex = API key and webhook secret.
 */
export const PAYMENT_INSTANCE_SECRET_FIELDS = {
  easypay: ["key"],
  stripe: ["secretKey", "webhookSecret"],
  alipay: ["privateKey"],
  wxpay: ["privateKey", "apiV3Key", "mpAppSecret"],
  airwallex: ["apiKey", "webhookSecret"],
} as const satisfies Record<PaymentInstanceProvider, readonly string[]>;

/** Secrets an instance needs before it takes orders (wxpay.mpAppSecret only gates JSAPI). */
export const PAYMENT_INSTANCE_REQUIRED_SECRETS = {
  easypay: ["key"],
  stripe: ["secretKey"],
  alipay: ["privateKey"],
  wxpay: ["privateKey", "apiV3Key"],
  airwallex: ["apiKey", "webhookSecret"],
} as const satisfies Record<PaymentInstanceProvider, readonly string[]>;

/** Channel types an instance can serve: EasyPay picks among these, every other provider serves its own key. */
export const PAYMENT_INSTANCE_TYPES: Record<PaymentInstanceProvider, readonly string[]> = {
  easypay: ["alipay", "wxpay", "qqpay"],
  stripe: ["stripe"],
  alipay: ["alipay"],
  wxpay: ["wxpay"],
  airwallex: ["airwallex"],
};

export const PaymentProviderInstanceSchema = z.object({
  id: z.string(),
  provider: PaymentInstanceProviderSchema,
  name: z.string(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  /** Channel types served (see PAYMENT_INSTANCE_TYPES). */
  supportedTypes: z.array(z.string()),
  /** EasyPay only: popup (submit.php) or qrcode (mapi.php); empty elsewhere. */
  paymentMode: z.string(),
  /** Admin refunds go through this merchant's refund API. */
  refundEnabled: z.boolean(),
  /** Payers may request refunds of top-ups paid through this instance. */
  allowUserRefund: z.boolean(),
  /** Keyed by channel type (alipay / wxpay / qqpay for EasyPay, the provider key otherwise). */
  limits: z.record(z.string(), PaymentChannelLimitSchema),
  /** Public configuration (the provider's *InstanceConfigSchema). */
  config: z.record(z.string(), z.unknown()),
  secretsSet: z.record(z.string(), z.boolean()),
  /** Configuration and required secrets are complete, so it can take orders when enabled. */
  ready: z.boolean(),
  /** Today's (UTC) paid and unexpired pending order volume, fiat minor units. */
  todayUsageMinor: z.number().int(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type PaymentProviderInstance = z.infer<typeof PaymentProviderInstanceSchema>;

const InstanceFields = {
  name: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  sortOrder: z.number().int().min(-100_000).max(100_000),
  supportedTypes: z.array(z.string().trim().min(1).max(32)).max(16),
  paymentMode: z.string().trim().max(32),
  refundEnabled: z.boolean(),
  allowUserRefund: z.boolean(),
  limits: z.record(z.string().trim().min(1).max(32), PaymentChannelLimitSchema),
  /** Public configuration; validated against the provider's schema by the BFF. */
  config: z.record(z.string(), z.unknown()),
  /** Omitted field = keep, "" = clear, otherwise replace. */
  secrets: z.record(z.string(), z.string().max(8192)),
};

export const CreatePaymentInstanceRequestSchema = z.object({
  provider: PaymentInstanceProviderSchema,
  name: InstanceFields.name,
  enabled: InstanceFields.enabled.default(true),
  sortOrder: InstanceFields.sortOrder.default(0),
  supportedTypes: InstanceFields.supportedTypes.default([]),
  paymentMode: InstanceFields.paymentMode.default(""),
  refundEnabled: InstanceFields.refundEnabled.default(true),
  allowUserRefund: InstanceFields.allowUserRefund.default(false),
  limits: InstanceFields.limits.default({}),
  config: InstanceFields.config.default({}),
  secrets: InstanceFields.secrets.default({}),
});
export type CreatePaymentInstanceRequest = z.infer<typeof CreatePaymentInstanceRequestSchema>;

/** PUT: every field optional; `config` replaces the public configuration as a whole when given. */
export const UpdatePaymentInstanceRequestSchema = z.object({
  name: InstanceFields.name.optional(),
  enabled: InstanceFields.enabled.optional(),
  sortOrder: InstanceFields.sortOrder.optional(),
  supportedTypes: InstanceFields.supportedTypes.optional(),
  paymentMode: InstanceFields.paymentMode.optional(),
  refundEnabled: InstanceFields.refundEnabled.optional(),
  allowUserRefund: InstanceFields.allowUserRefund.optional(),
  limits: InstanceFields.limits.optional(),
  config: InstanceFields.config.optional(),
  secrets: InstanceFields.secrets.optional(),
});
export type UpdatePaymentInstanceRequest = z.infer<typeof UpdatePaymentInstanceRequestSchema>;

/** POST /admin/payments/providers/reorder: ids in display order (sortOrder becomes 10, 20, …). */
export const ReorderPaymentInstancesRequestSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(200),
});
export type ReorderPaymentInstancesRequest = z.infer<typeof ReorderPaymentInstancesRequestSchema>;

/** The supported types an instance of `provider` may keep (defaults when none are given). */
export function normalizeInstanceTypes(provider: PaymentInstanceProvider, types: readonly string[]): string[] {
  const allowed = PAYMENT_INSTANCE_TYPES[provider];
  if (provider !== "easypay") return [...allowed];
  const picked = allowed.filter((t) => types.includes(t));
  return picked.length > 0 ? picked : ["alipay", "wxpay"];
}

/**
 * POST /user/payments/wechat/oauth: the console's /payment/wechat/callback page sends the `code`
 * and `state` WeChat appended (snsapi_base OAuth started by a `wechat_oauth_required` 409) and gets
 * a short-lived token proving the payer's openid; it then repeats POST /user/orders with
 * `wechatResumeToken` (and the same plan / amount it kept before leaving).
 */
export const WechatOAuthExchangeRequestSchema = z.object({
  code: z.string().trim().min(1).max(256),
  state: z.string().trim().min(1).max(128),
});
export type WechatOAuthExchangeRequest = z.infer<typeof WechatOAuthExchangeRequestSchema>;

export const WechatOAuthExchangeResponseSchema = z.object({
  wechatResumeToken: z.string(),
  /** Seconds the token stays valid. */
  expiresInSec: z.number().int(),
});
export type WechatOAuthExchangeResponse = z.infer<typeof WechatOAuthExchangeResponseSchema>;

/** POST /admin/payments/orders/sweep (also run every minute by the BFF scheduler). */
export const PaymentSweepResultSchema = z.object({
  /** Pending orders past their deadline that the provider reported paid and were fulfilled. */
  recovered: z.number().int(),
  /** Pending orders past their deadline now persisted as expired (upstream trade closed when possible). */
  expired: z.number().int(),
  /** refund_pending orders the gateway confirmed (refunded) or refused (refund_failed). */
  refundsSettled: z.number().int(),
});
export type PaymentSweepResult = z.infer<typeof PaymentSweepResultSchema>;
