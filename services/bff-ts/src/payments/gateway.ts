import {
  AirwallexInstanceConfigSchema,
  AlipayInstanceConfigSchema,
  EasypayInstanceConfigSchema,
  WxpayInstanceConfigSchema,
  type PaymentChannelLimit,
  type PaymentCheckout,
  type PaymentDevice,
  type PaymentInstanceProvider,
  type PaymentOrderItem,
} from "@slipgate/contracts";
import type { z } from "zod";
import {
  airwallexCancelIntent,
  airwallexCreateIntent,
  airwallexQueryIntent,
  airwallexRefund,
  airwallexRefundQuery,
  type AirwallexCredentials,
} from "./airwallex.ts";
import {
  alipayAppLink,
  alipayCashierUrl,
  alipayClose,
  alipayPrecreate,
  alipayQuery,
  alipayRefund,
  alipayRefundQuery,
  type AlipayCredentials,
} from "./alipay.ts";
import { GatewayError } from "./http.ts";
import {
  easypayCreateApiPayment,
  easypayPayUrl,
  easypayQueryOrder,
  easypayRefund,
  stripeCreateCheckout,
  stripeExpireSession,
  stripeQuery,
  stripeRefund,
  stripeRefundQuery,
  type EasypayCredentials,
  type ProviderPaymentQuery,
  type ProviderRefundResult,
} from "./providers.ts";
import {
  wxpayClose,
  wxpayH5Prepay,
  wxpayJsapiPrepay,
  wxpayNativePrepay,
  wxpayQuery,
  wxpayRefund,
  wxpayRefundQuery,
  type WxpayCredentials,
} from "./wxpay.ts";

/**
 * One merchant account able to take an order: a provider instance, or the built-in EasyPay /
 * Stripe block of the payment config (`id` null). Secrets are decrypted, so a Merchant never
 * leaves the BFF.
 */
export interface Merchant {
  id: string | null;
  provider: PaymentInstanceProvider;
  name: string;
  enabled: boolean;
  /** Configuration and the secrets it needs are complete. */
  ready: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  supportedTypes: string[];
  paymentMode: string;
  refundEnabled: boolean;
  allowUserRefund: boolean;
  limits: Record<string, PaymentChannelLimit>;
  sortOrder: number;
}

/** Key of a merchant in instance usage maps (PaymentsStore.instanceUsage). */
export const merchantKey = (m: Pick<Merchant, "id" | "provider">) => m.id ?? `builtin:${m.provider}`;

/** The channel type an order of `provider` / `method` counts against. */
export const channelType = (provider: string, method: string | null) => (provider === "easypay" ? (method ?? "alipay") : provider);

export interface GatewayOrder {
  id: string;
  amountMinor: number;
  currency: string;
  subject: string;
  email: string;
  method: string | null;
  providerTradeNo: string | null;
  expiresAtIso: string;
}

export interface CheckoutContext {
  notifyUrl: string;
  returnUrl: string;
  device: PaymentDevice;
  clientIp: string;
  /** WeChat JSAPI: the payer's openid (from the payment OAuth). */
  openid: string | null;
  fetch: typeof fetch;
}

export interface CheckoutResult {
  checkout: PaymentCheckout;
  /** The gateway's id for the trade when it issues one at creation (Stripe session, Airwallex intent, EasyPay trade_no). */
  tradeNo: string | null;
}

function parsed<T extends z.ZodTypeAny>(schema: T, m: Merchant): z.infer<T> {
  const r = schema.safeParse(m.config);
  if (!r.success) throw new GatewayError(`${m.name} is not fully configured`, true);
  return r.data;
}

export function easypayCreds(m: Merchant): EasypayCredentials {
  const c = parsed(EasypayInstanceConfigSchema, m);
  return { apiUrl: c.apiUrl, pid: c.pid, key: m.secrets.key ?? "" };
}

export function alipayCreds(m: Merchant): AlipayCredentials & { modes: string[] } {
  const c = parsed(AlipayInstanceConfigSchema, m);
  return { appId: c.appId, alipayPublicKey: c.alipayPublicKey, sandbox: c.sandbox, privateKey: m.secrets.privateKey ?? "", modes: c.modes };
}

export function wxpayCreds(m: Merchant): WxpayCredentials & { modes: string[]; mpAppSecret: string } {
  const c = parsed(WxpayInstanceConfigSchema, m);
  return {
    appId: c.appId,
    mpAppId: c.mpAppId,
    mchId: c.mchId,
    certSerial: c.certSerial,
    publicKeyId: c.publicKeyId,
    publicKey: c.publicKey,
    privateKey: m.secrets.privateKey ?? "",
    apiV3Key: m.secrets.apiV3Key ?? "",
    mpAppSecret: m.secrets.mpAppSecret ?? "",
    h5AppName: c.h5AppName,
    h5AppUrl: c.h5AppUrl,
    modes: c.modes,
  };
}

export function airwallexCreds(m: Merchant): AirwallexCredentials & { currency: string; countryCode: string } {
  const c = parsed(AirwallexInstanceConfigSchema, m);
  return {
    clientId: c.clientId,
    accountId: c.accountId,
    env: c.env,
    apiKey: m.secrets.apiKey ?? "",
    webhookSecret: m.secrets.webhookSecret ?? "",
    currency: c.currency,
    countryCode: c.countryCode,
  };
}

/** WeChat JSAPI is possible for this merchant (mode enabled and the OAuth secret set). */
export function wxpayJsapiReady(m: Merchant): boolean {
  if (m.provider !== "wxpay") return false;
  const c = WxpayInstanceConfigSchema.safeParse(m.config);
  return c.success && c.data.modes.includes("jsapi") && Boolean(m.secrets.mpAppSecret);
}

const emptyCheckout = (flow: PaymentCheckout["flow"]): PaymentCheckout => ({ flow, payUrl: null, qrCode: null, appLink: null, jsapi: null, airwallex: null });

/** Starts the payment at the gateway and says how the browser completes it. */
export async function createCheckout(m: Merchant, order: GatewayOrder, ctx: CheckoutContext): Promise<CheckoutResult> {
  const mobile = ctx.device !== "pc";
  switch (m.provider) {
    case "easypay": {
      const creds = easypayCreds(m);
      const eo = { orderId: order.id, amountMinor: order.amountMinor, name: order.subject, method: order.method ?? "alipay" };
      const urls = { notifyUrl: ctx.notifyUrl, returnUrl: ctx.returnUrl };
      if (m.paymentMode === "qrcode") {
        const r = await easypayCreateApiPayment(creds, eo, urls, ctx.clientIp, mobile, ctx.fetch);
        // A QR payload is shown in-page on desktops; phones (and gateways without one) open the pay URL.
        if (r.qrCode && (!mobile || !r.payUrl)) return { checkout: { ...emptyCheckout("qrcode"), qrCode: r.qrCode, payUrl: r.payUrl }, tradeNo: r.tradeNo };
        return { checkout: { ...emptyCheckout("redirect"), payUrl: r.payUrl, qrCode: r.qrCode }, tradeNo: r.tradeNo };
      }
      return { checkout: { ...emptyCheckout("redirect"), payUrl: easypayPayUrl(creds, eo, urls, mobile) }, tradeNo: null };
    }
    case "stripe": {
      const session = await stripeCreateCheckout(
        m.secrets.secretKey ?? "",
        {
          orderId: order.id,
          amountMinor: order.amountMinor,
          currency: order.currency as "CNY" | "USD",
          name: order.subject,
          email: order.email,
          expiresAtSec: Math.floor(Date.parse(order.expiresAtIso) / 1000),
        },
        { successUrl: ctx.returnUrl, cancelUrl: `${ctx.returnUrl}&cancelled=1` },
        ctx.fetch,
      );
      return { checkout: { ...emptyCheckout("redirect"), payUrl: session.url }, tradeNo: session.id };
    }
    case "alipay": {
      const creds = alipayCreds(m);
      const ao = { orderId: order.id, amountMinor: order.amountMinor, subject: order.subject };
      const has = (mode: string) => creds.modes.includes(mode);
      if (mobile && has("wap")) {
        return { checkout: { ...emptyCheckout("redirect"), payUrl: alipayCashierUrl(creds, "wap", ao, ctx.notifyUrl, ctx.returnUrl) }, tradeNo: null };
      }
      if (has("precreate")) {
        try {
          const qr = await alipayPrecreate(creds, ao, ctx.notifyUrl, ctx.fetch);
          return { checkout: { ...emptyCheckout("qrcode"), qrCode: qr, appLink: mobile ? alipayAppLink(qr) : null }, tradeNo: null };
        } catch (err) {
          // Merchants without face-to-face payment fall back to the cashier page.
          if (!has("page")) throw err;
        }
      }
      if (has("page")) {
        return { checkout: { ...emptyCheckout("redirect"), payUrl: alipayCashierUrl(creds, "page", ao, ctx.notifyUrl, ctx.returnUrl) }, tradeNo: null };
      }
      return { checkout: { ...emptyCheckout("redirect"), payUrl: alipayCashierUrl(creds, "wap", ao, ctx.notifyUrl, ctx.returnUrl) }, tradeNo: null };
    }
    case "wxpay": {
      const creds = wxpayCreds(m);
      const wo = { orderId: order.id, amountMinor: order.amountMinor, description: order.subject };
      if (ctx.openid) {
        const jsapi = await wxpayJsapiPrepay(creds, wo, ctx.notifyUrl, ctx.openid, ctx.clientIp, ctx.fetch);
        return { checkout: { ...emptyCheckout("jsapi"), jsapi }, tradeNo: null };
      }
      const h5 = creds.modes.includes("h5");
      const native = creds.modes.includes("native");
      // Phone browsers use H5; WeChat's own browser blocks H5 pages, so without JSAPI it gets the QR
      // (long-press to recognise), as do desktops.
      if ((ctx.device === "mobile" && h5) || (!native && h5)) {
        const url = await wxpayH5Prepay(creds, wo, ctx.notifyUrl, ctx.clientIp, ctx.returnUrl, ctx.fetch);
        return { checkout: { ...emptyCheckout("redirect"), payUrl: url }, tradeNo: null };
      }
      if (!native) throw new GatewayError("WeChat Pay QR payments are not enabled for this merchant", true);
      const qr = await wxpayNativePrepay(creds, wo, ctx.notifyUrl, ctx.fetch);
      return { checkout: { ...emptyCheckout("qrcode"), qrCode: qr }, tradeNo: null };
    }
    case "airwallex": {
      const creds = airwallexCreds(m);
      const intent = await airwallexCreateIntent(creds, { orderId: order.id, amountMinor: order.amountMinor, currency: order.currency }, ctx.returnUrl, ctx.fetch);
      return {
        checkout: {
          ...emptyCheckout("airwallex"),
          airwallex: { intentId: intent.intentId, clientSecret: intent.clientSecret, currency: order.currency, countryCode: creds.countryCode, env: creds.env },
        },
        tradeNo: intent.intentId,
      };
    }
  }
}

/** Asks the gateway whether the order was paid. */
export async function queryPayment(m: Merchant, order: Pick<PaymentOrderItem, "id" | "providerTradeNo">, fetchImpl: typeof fetch): Promise<ProviderPaymentQuery> {
  switch (m.provider) {
    case "easypay":
      return easypayQueryOrder(easypayCreds(m), order.id, fetchImpl);
    case "stripe":
      if (!order.providerTradeNo) return { status: "pending", amountMinor: null, currency: null, tradeNo: null };
      return stripeQuery(m.secrets.secretKey ?? "", order.providerTradeNo, fetchImpl);
    case "alipay":
      return alipayQuery(alipayCreds(m), order.id, fetchImpl);
    case "wxpay":
      return wxpayQuery(wxpayCreds(m), order.id, fetchImpl);
    case "airwallex":
      if (!order.providerTradeNo) return { status: "pending", amountMinor: null, currency: null, tradeNo: null };
      return airwallexQueryIntent(airwallexCreds(m), order.providerTradeNo, fetchImpl);
  }
}

/** Closes the upstream trade of an unpaid order (EasyPay has no such API). Best effort. */
export async function cancelPayment(m: Merchant, order: Pick<PaymentOrderItem, "id" | "providerTradeNo">, fetchImpl: typeof fetch): Promise<void> {
  switch (m.provider) {
    case "easypay":
      return;
    case "stripe":
      if (order.providerTradeNo) await stripeExpireSession(m.secrets.secretKey ?? "", order.providerTradeNo, fetchImpl);
      return;
    case "alipay":
      return alipayClose(alipayCreds(m), order.id, fetchImpl);
    case "wxpay":
      return wxpayClose(wxpayCreds(m), order.id, fetchImpl);
    case "airwallex":
      if (order.providerTradeNo) await airwallexCancelIntent(airwallexCreds(m), order.providerTradeNo, fetchImpl);
      return;
  }
}

/** Gateway refund id: stable per order and amount, so a retried call cannot refund twice. */
export const refundRequestNo = (orderId: string, amountMinor: number) => `${orderId}R${amountMinor}`;

/** Sends a refund of `amountMinor` through the gateway. */
export async function refundPayment(
  m: Merchant,
  order: Pick<PaymentOrderItem, "id" | "providerTradeNo" | "amountMinor">,
  amountMinor: number,
  reason: string,
  fetchImpl: typeof fetch,
): Promise<ProviderRefundResult> {
  switch (m.provider) {
    case "easypay":
      return easypayRefund(easypayCreds(m), order.id, order.providerTradeNo, amountMinor, fetchImpl);
    case "stripe":
      if (!order.providerTradeNo) throw new GatewayError("The order has no Stripe payment to refund", true);
      return stripeRefund(m.secrets.secretKey ?? "", order.id, order.providerTradeNo, amountMinor, fetchImpl);
    case "alipay":
      return alipayRefund(alipayCreds(m), order.id, refundRequestNo(order.id, amountMinor), amountMinor, reason, fetchImpl);
    case "wxpay":
      return wxpayRefund(wxpayCreds(m), order.id, refundRequestNo(order.id, amountMinor), amountMinor, order.amountMinor, reason, fetchImpl);
    case "airwallex":
      if (!order.providerTradeNo) throw new GatewayError("The order has no Airwallex payment intent to refund", true);
      return airwallexRefund(airwallexCreds(m), order.id, order.providerTradeNo, amountMinor, reason, fetchImpl);
  }
}

/** Whether the gateway can report a refund's progress (EasyPay refunds are synchronous only). */
export const supportsRefundQuery = (provider: string) => provider !== "easypay";

/** Asks the gateway how a refund sent earlier is doing. */
export async function queryRefund(
  m: Merchant,
  order: Pick<PaymentOrderItem, "id" | "providerRefundId" | "refundAmountMinor">,
  fetchImpl: typeof fetch,
): Promise<ProviderRefundResult> {
  const requestNo = order.providerRefundId ?? refundRequestNo(order.id, order.refundAmountMinor);
  switch (m.provider) {
    case "easypay":
      throw new GatewayError("EasyPay cannot report a refund's status; check the merchant console", true);
    case "stripe":
      if (!order.providerRefundId) throw new GatewayError("Stripe never acknowledged this refund; send it again", true);
      return stripeRefundQuery(m.secrets.secretKey ?? "", order.providerRefundId, fetchImpl);
    case "alipay":
      return alipayRefundQuery(alipayCreds(m), order.id, requestNo, fetchImpl);
    case "wxpay":
      return wxpayRefundQuery(wxpayCreds(m), requestNo, fetchImpl);
    case "airwallex":
      if (!order.providerRefundId) throw new GatewayError("Airwallex never acknowledged this refund; send it again", true);
      return airwallexRefundQuery(airwallexCreds(m), order.providerRefundId, fetchImpl);
  }
}
