import { createHash } from "node:crypto";
import { minorToFiat, type PaymentCurrency } from "@slipgate/contracts";
import { decimalToMinor, GatewayError, gatewayFetch, isDefinitiveStatus, parseJsonObject, str, summarize, timingSafeEqualText } from "./http.ts";

/** What a gateway said about a payment: paid, still open, or closed / failed. */
export type ProviderPaymentStatus = "paid" | "pending" | "failed";

export interface ProviderPaymentQuery {
  status: ProviderPaymentStatus;
  /** Amount the gateway reports, fiat minor units (null when it did not say). */
  amountMinor: number | null;
  /** Upper-case ISO currency when the gateway reports one. */
  currency: string | null;
  /** The gateway's own trade / transaction id, when known. */
  tradeNo: string | null;
}

/** What a gateway said about a refund. */
export interface ProviderRefundResult {
  status: "success" | "pending" | "failed";
  refundId: string | null;
  message: string | null;
}

/* ------------------------------------------------------------------------------------------ */
/* EasyPay (易支付 / 彩虹易支付 compatible)                                                    */
/* ------------------------------------------------------------------------------------------ */

/** md5(k1=v1&k2=v2… sorted by key, empty values and sign/sign_type skipped, then the merchant key). */
export function easypaySign(params: Record<string, string>, key: string): string {
  const text = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("md5").update(`${text}${key}`, "utf8").digest("hex");
}

export function easypayVerify(params: Record<string, string>, key: string): boolean {
  const sign = (params.sign ?? "").toLowerCase();
  return sign.length === 32 && timingSafeEqualText(sign, easypaySign(params, key));
}

export interface EasypayCredentials {
  apiUrl: string;
  pid: string;
  key: string;
}

export interface EasypayOrder {
  orderId: string;
  amountMinor: number;
  name: string;
  method: string;
}

export interface EasypayUrls {
  notifyUrl: string;
  returnUrl: string;
}

/** The gateway base: trailing slashes and a pasted /submit.php, /mapi.php or /api.php removed. */
export function easypayBase(apiUrl: string): string {
  return apiUrl
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\/(?:submit|mapi|api)\.php$/i, "")
    .replace(/\/+$/, "");
}

function easypayOrderParams(creds: EasypayCredentials, order: EasypayOrder, urls: EasypayUrls, mobile: boolean): Record<string, string> {
  const params: Record<string, string> = {
    pid: creds.pid,
    type: order.method,
    out_trade_no: order.orderId,
    notify_url: urls.notifyUrl,
    return_url: urls.returnUrl,
    name: order.name.slice(0, 64),
    money: minorToFiat(order.amountMinor),
  };
  if (mobile) params.device = "mobile";
  return params;
}

/** Popup mode: browser redirect to the gateway's submit.php with a signed query string. */
export function easypayPayUrl(creds: EasypayCredentials, order: EasypayOrder, urls: EasypayUrls, mobile = false): string {
  const params = easypayOrderParams(creds, order, urls, mobile);
  const query = new URLSearchParams({ ...params, sign: easypaySign(params, creds.key), sign_type: "MD5" });
  return `${easypayBase(creds.apiUrl)}/submit.php?${query.toString()}`;
}

/**
 * Resolves a site-root-relative payurl / qrcode ("/pay/qr/123") against the gateway. Anything with
 * a scheme (https://, weixin://, alipays://) or an opaque token is returned unchanged.
 */
export function resolveEasypayRef(apiUrl: string, ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return ref;
  try {
    return new URL(trimmed, `${easypayBase(apiUrl)}/`).toString();
  } catch {
    return ref;
  }
}

function sanitizeGatewayPayUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

export interface EasypayApiPayment {
  tradeNo: string | null;
  payUrl: string | null;
  qrCode: string | null;
}

async function easypayPost(fetchImpl: typeof fetch, url: string, params: Record<string, string>) {
  return gatewayFetch(fetchImpl, url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

const easypayCodeOk = (code: unknown) => Number(str(code).trim()) === 1;

/**
 * API (QR) mode: signed POST to mapi.php. Returns the gateway's trade number and the QR payload
 * and/or pay URL (payurl2 on phones when given), relative references resolved.
 */
export async function easypayCreateApiPayment(
  creds: EasypayCredentials,
  order: EasypayOrder,
  urls: EasypayUrls,
  clientIp: string,
  mobile: boolean,
  fetchImpl: typeof fetch,
): Promise<EasypayApiPayment> {
  const params: Record<string, string> = { ...easypayOrderParams(creds, order, urls, mobile), clientip: clientIp || "127.0.0.1" };
  const res = await easypayPost(fetchImpl, `${easypayBase(creds.apiUrl)}/mapi.php`, {
    ...params,
    sign: easypaySign(params, creds.key),
    sign_type: "MD5",
  });
  const data = parseJsonObject(res.text);
  if (!data) throw new GatewayError(`EasyPay returned HTTP ${res.status}: ${summarize(res.text)}`, isDefinitiveStatus(res.status));
  if (!easypayCodeOk(data.code)) throw new GatewayError(`EasyPay: ${str(data.msg) || summarize(res.text)}`, true);
  const payUrl = (mobile && str(data.payurl2)) || str(data.payurl);
  const qrCode = str(data.qrcode);
  if (!payUrl && !qrCode) throw new GatewayError("EasyPay returned neither a pay URL nor a QR code", true);
  const resolvedPayUrl = payUrl ? sanitizeGatewayPayUrl(resolveEasypayRef(creds.apiUrl, payUrl)) : null;
  const resolvedQrCode = qrCode ? resolveEasypayRef(creds.apiUrl, qrCode) : null;
  if (!resolvedPayUrl && !resolvedQrCode) {
    throw new GatewayError("EasyPay returned an invalid or unsafe payment URL", true);
  }
  return {
    tradeNo: str(data.trade_no) || null,
    payUrl: resolvedPayUrl,
    qrCode: resolvedQrCode,
  };
}

/** api.php?act=order: status 1 (or trade_status TRADE_SUCCESS) = paid. */
export async function easypayQueryOrder(creds: EasypayCredentials, orderId: string, fetchImpl: typeof fetch): Promise<ProviderPaymentQuery> {
  const res = await easypayPost(fetchImpl, `${easypayBase(creds.apiUrl)}/api.php`, {
    act: "order",
    pid: creds.pid,
    key: creds.key,
    out_trade_no: orderId,
  });
  const top = parseJsonObject(res.text);
  if (!top) throw new GatewayError(`EasyPay query returned HTTP ${res.status}: ${summarize(res.text)}`, isDefinitiveStatus(res.status));
  const data = { ...((top.data && typeof top.data === "object" ? top.data : {}) as Record<string, unknown>), ...top };
  const tradeStatus = str(data.trade_status);
  const paid = tradeStatus ? tradeStatus === "TRADE_SUCCESS" : Number(str(data.status)) === 1;
  if (!paid && !easypayCodeOk(top.code) && top.code !== undefined) {
    // Most gateways answer code -1 / "订单不存在" for an order that was never opened: still unpaid.
    return { status: "pending", amountMinor: null, currency: null, tradeNo: null };
  }
  return {
    status: paid ? "paid" : "pending",
    amountMinor: decimalToMinor(data.money),
    currency: "CNY",
    tradeNo: str(data.trade_no) || null,
  };
}

/**
 * api.php?act=refund (synchronous): code 1 = refunded. Tries out_trade_no, then the gateway's
 * trade_no when the gateway does not know the first.
 */
export async function easypayRefund(
  creds: EasypayCredentials,
  orderId: string,
  tradeNo: string | null,
  amountMinor: number,
  fetchImpl: typeof fetch,
): Promise<ProviderRefundResult> {
  const base = { pid: creds.pid, key: creds.key, money: minorToFiat(amountMinor) };
  const attempts: Record<string, string>[] = [{ ...base, out_trade_no: orderId }];
  if (tradeNo) attempts.push({ ...base, trade_no: tradeNo });
  let last: GatewayError | null = null;
  for (const [i, params] of attempts.entries()) {
    const res = await easypayPost(fetchImpl, `${easypayBase(creds.apiUrl)}/api.php?act=refund`, params);
    const data = parseJsonObject(res.text);
    if (res.status >= 500) throw new GatewayError(`EasyPay refund HTTP ${res.status}: ${summarize(res.text)}`, false);
    if (!data) throw new GatewayError(`EasyPay refund returned a non-JSON answer (HTTP ${res.status}): ${summarize(res.text)}`, false);
    if (easypayCodeOk(data.code)) return { status: "success", refundId: params.trade_no ?? orderId, message: null };
    const msg = str(data.msg) || summarize(res.text);
    last = new GatewayError(`EasyPay refund failed: ${msg}`, true);
    const notFound = /订单编号不存在|订单不存在|order not found|not exist/i.test(msg);
    if (!(notFound && i + 1 < attempts.length)) break;
  }
  throw last ?? new GatewayError("EasyPay refund failed", true);
}

/* ------------------------------------------------------------------------------------------ */
/* Stripe Checkout                                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface StripeOrder {
  orderId: string;
  amountMinor: number;
  currency: PaymentCurrency;
  name: string;
  email: string;
  /** Unix seconds; Stripe accepts 30 minutes to 24 hours ahead (clamped). */
  expiresAtSec?: number;
}

export interface StripeSession {
  id: string;
  url: string;
}

export interface StripeUrls {
  successUrl: string;
  cancelUrl: string;
}

const STRIPE_API = "https://api.stripe.com/v1";

async function stripeCall(
  secretKey: string,
  method: "GET" | "POST",
  path: string,
  form: URLSearchParams | null,
  fetchImpl: typeof fetch,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
  if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await gatewayFetch(fetchImpl, `${STRIPE_API}${path}`, { method, headers, body: form ? form.toString() : undefined });
  const data = parseJsonObject(res.text) ?? {};
  if (res.status < 200 || res.status >= 300) {
    const err = (data.error ?? {}) as { message?: string };
    throw new GatewayError(err.message ?? `Stripe returned HTTP ${res.status}`, isDefinitiveStatus(res.status));
  }
  return data;
}

/** POST /v1/checkout/sessions (form-encoded). Throws with Stripe's message on failure. */
export async function stripeCreateCheckout(
  secretKey: string,
  order: StripeOrder,
  urls: StripeUrls | string,
  fetchImpl: typeof fetch = fetch,
): Promise<StripeSession> {
  const u: StripeUrls =
    typeof urls === "string"
      ? {
          successUrl: `${urls}/payment/result?order=${encodeURIComponent(order.orderId)}`,
          cancelUrl: `${urls}/payment/result?order=${encodeURIComponent(order.orderId)}&cancelled=1`,
        }
      : urls;
  const form = new URLSearchParams({
    mode: "payment",
    success_url: u.successUrl,
    cancel_url: u.cancelUrl,
    client_reference_id: order.orderId,
    "metadata[order_id]": order.orderId,
    "payment_intent_data[metadata][order_id]": order.orderId,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": order.currency.toLowerCase(),
    "line_items[0][price_data][unit_amount]": String(order.amountMinor),
    "line_items[0][price_data][product_data][name]": order.name.slice(0, 120),
  });
  if (order.email) form.set("customer_email", order.email);
  if (order.expiresAtSec) {
    const now = Math.floor(Date.now() / 1000);
    const at = Math.min(now + 24 * 3600 - 60, Math.max(now + 30 * 60 + 60, order.expiresAtSec));
    form.set("expires_at", String(at));
  }
  const data = await stripeCall(secretKey, "POST", "/checkout/sessions", form, fetchImpl, `checkout-${order.orderId}`);
  if (typeof data.url !== "string" || typeof data.id !== "string") throw new GatewayError("Stripe returned no checkout URL", true);
  return { id: data.id, url: data.url };
}

/**
 * The payment of a Checkout Session (cs_…) or PaymentIntent (pi_…). A session is paid when
 * payment_status = paid; expired sessions and cancelled intents count as failed.
 */
export async function stripeQuery(secretKey: string, ref: string, fetchImpl: typeof fetch): Promise<ProviderPaymentQuery> {
  if (ref.startsWith("pi_")) {
    const pi = await stripeCall(secretKey, "GET", `/payment_intents/${encodeURIComponent(ref)}`, null, fetchImpl);
    const status = str(pi.status);
    return {
      status: status === "succeeded" ? "paid" : status === "canceled" ? "failed" : "pending",
      amountMinor: typeof pi.amount_received === "number" && pi.amount_received > 0 ? pi.amount_received : typeof pi.amount === "number" ? pi.amount : null,
      currency: str(pi.currency).toUpperCase() || null,
      tradeNo: str(pi.id) || ref,
    };
  }
  const s = await stripeCall(secretKey, "GET", `/checkout/sessions/${encodeURIComponent(ref)}`, null, fetchImpl);
  const paid = str(s.payment_status) === "paid";
  return {
    status: paid ? "paid" : str(s.status) === "expired" ? "failed" : "pending",
    amountMinor: typeof s.amount_total === "number" ? s.amount_total : null,
    currency: str(s.currency).toUpperCase() || null,
    tradeNo: str(s.payment_intent) || null,
  };
}

/** POST /v1/checkout/sessions/:id/expire (an already expired or completed session is fine). */
export async function stripeExpireSession(secretKey: string, sessionId: string, fetchImpl: typeof fetch): Promise<void> {
  if (!sessionId.startsWith("cs_")) return;
  try {
    await stripeCall(secretKey, "POST", `/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, new URLSearchParams(), fetchImpl);
  } catch (err) {
    if (err instanceof GatewayError && err.definitive) return;
    throw err;
  }
}

function stripeRefundResult(r: Record<string, unknown>): ProviderRefundResult {
  const status = str(r.status);
  return {
    status: status === "succeeded" ? "success" : status === "failed" || status === "canceled" ? "failed" : "pending",
    refundId: str(r.id) || null,
    message: str(r.failure_reason) || null,
  };
}

/** POST /v1/refunds against the order's PaymentIntent (a session id is resolved first). */
export async function stripeRefund(
  secretKey: string,
  orderId: string,
  ref: string,
  amountMinor: number,
  fetchImpl: typeof fetch,
): Promise<ProviderRefundResult> {
  let intent = ref;
  if (!intent.startsWith("pi_")) {
    const q = await stripeQuery(secretKey, ref, fetchImpl);
    if (!q.tradeNo?.startsWith("pi_")) throw new GatewayError("The Stripe checkout has no payment to refund", true);
    intent = q.tradeNo;
  }
  const form = new URLSearchParams({ payment_intent: intent, amount: String(amountMinor), reason: "requested_by_customer" });
  form.set("metadata[order_id]", orderId);
  return stripeRefundResult(await stripeCall(secretKey, "POST", "/refunds", form, fetchImpl, `refund-${orderId}-${amountMinor}`));
}

export async function stripeRefundQuery(secretKey: string, refundId: string, fetchImpl: typeof fetch): Promise<ProviderRefundResult> {
  return stripeRefundResult(await stripeCall(secretKey, "GET", `/refunds/${encodeURIComponent(refundId)}`, null, fetchImpl));
}

/**
 * Verifies a `Stripe-Signature` header (t=…,v1=…) over the raw body: HMAC-SHA256 of
 * `${t}.${body}` with the endpoint secret, within `toleranceSec` of now.
 */
export async function stripeVerifySignature(
  rawBody: string,
  header: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000),
  toleranceSec = 300,
): Promise<boolean> {
  const parts = header.split(",").map((p) => p.trim());
  const t = parts.find((p) => p.startsWith("t="))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || signatures.length === 0) return false;
  const ts = Number.parseInt(t, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((sig) => timingSafeEqualText(sig, expected));
}

/** Test helper and documentation of the header format. */
export async function stripeSignatureHeader(rawBody: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${nowSec}.${rawBody}`)));
  return `t=${nowSec},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
