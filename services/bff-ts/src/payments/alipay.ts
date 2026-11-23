import { createPrivateKey, createPublicKey, createSign, createVerify, type KeyObject } from "node:crypto";
import { minorToFiat } from "@slipgate/contracts";
import { decimalToMinor, GatewayError, gatewayFetch, isDefinitiveStatus, str, summarize } from "./http.ts";
import type { ProviderPaymentQuery, ProviderRefundResult } from "./providers.ts";

/**
 * The official Alipay open platform (RSA2): page / WAP cashier redirects, face-to-face precreate
 * (QR), trade query, refund (+ refund query) and close, and async-notification verification.
 * Requests are signed with the app private key; responses and notifications are verified with
 * Alipay's public key, so a forged gateway answer cannot mark an order paid.
 */

export interface AlipayCredentials {
  appId: string;
  /** App private key (PKCS#1 or PKCS#8, PEM or bare base64). */
  privateKey: string;
  /** Alipay public key (PEM or bare base64 SPKI). */
  alipayPublicKey: string;
  sandbox: boolean;
}

export interface AlipayOrder {
  orderId: string;
  amountMinor: number;
  subject: string;
}

const GATEWAY = "https://openapi.alipay.com/gateway.do";
const SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";

export const alipayGateway = (creds: Pick<AlipayCredentials, "sandbox">) => (creds.sandbox ? SANDBOX_GATEWAY : GATEWAY);

function wrapPem(body: string, label: string): string {
  const clean = body.replace(/\s+/g, "");
  return `-----BEGIN ${label}-----\n${clean.replace(/(.{64})/g, "$1\n").replace(/\n$/, "")}\n-----END ${label}-----\n`;
}

const keyCache = new Map<string, KeyObject>();

function cached(kind: "private" | "public", text: string, load: () => KeyObject): KeyObject {
  const id = `${kind}:${text}`;
  const hit = keyCache.get(id);
  if (hit) return hit;
  const key = load();
  if (keyCache.size > 64) keyCache.clear();
  keyCache.set(id, key);
  return key;
}

/** An RSA private key from PEM (PKCS#1 / PKCS#8) or the bare base64 Alipay's key tool prints. */
export function loadRsaPrivateKey(text: string): KeyObject {
  return cached("private", text, () => {
    const t = text.trim();
    if (t.startsWith("-----BEGIN")) return createPrivateKey(t);
    const der = Buffer.from(t.replace(/\s+/g, ""), "base64");
    try {
      return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    } catch {
      return createPrivateKey({ key: der, format: "der", type: "pkcs1" });
    }
  });
}

/** An RSA public key from PEM (SPKI / PKCS#1) or bare base64 SPKI. */
export function loadRsaPublicKey(text: string): KeyObject {
  return cached("public", text, () => {
    const t = text.trim();
    if (t.startsWith("-----BEGIN")) return createPublicKey(t);
    try {
      return createPublicKey(wrapPem(t, "PUBLIC KEY"));
    } catch {
      return createPublicKey(wrapPem(t, "RSA PUBLIC KEY"));
    }
  });
}

/** k=v pairs sorted by key, empty values and the excluded keys skipped (values not encoded). */
export function alipaySignContent(params: Record<string, string>, exclude: readonly string[] = ["sign"]): string {
  return Object.keys(params)
    .filter((k) => !exclude.includes(k) && params[k] !== undefined && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
}

export function rsaSha256Sign(content: string, privateKey: string): string {
  return createSign("RSA-SHA256").update(content, "utf8").sign(loadRsaPrivateKey(privateKey), "base64");
}

export function rsaSha256Verify(content: string, signature: string, publicKey: string): boolean {
  try {
    return createVerify("RSA-SHA256").update(content, "utf8").verify(loadRsaPublicKey(publicKey), signature, "base64");
  } catch {
    return false;
  }
}

/** Async notification: every field but sign and sign_type, sorted, verified with Alipay's key. */
export function alipayVerifyNotification(params: Record<string, string>, alipayPublicKey: string): boolean {
  const sign = params.sign ?? "";
  if (!sign || (params.sign_type && params.sign_type !== "RSA2")) return false;
  return rsaSha256Verify(alipaySignContent(params, ["sign", "sign_type"]), sign, alipayPublicKey);
}

/** "yyyy-MM-dd HH:mm:ss" in China time, as the gateway expects. */
function chinaTimestamp(now = Date.now()): string {
  const d = new Date(now + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function signedParams(creds: AlipayCredentials, method: string, biz: Record<string, unknown>, extra: Record<string, string> = {}): Record<string, string> {
  const params: Record<string, string> = {
    app_id: creds.appId,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: chinaTimestamp(),
    version: "1.0",
    biz_content: JSON.stringify(biz),
    ...extra,
  };
  params.sign = rsaSha256Sign(alipaySignContent(params), creds.privateKey);
  return params;
}

/**
 * The raw JSON text of `key`'s object value in `text` (Alipay signs the response node exactly as
 * sent, so it must not be re-serialised). Null when absent.
 */
export function rawJsonValue(text: string, key: string): string | null {
  const marker = `"${key}"`;
  let at = text.indexOf(marker);
  while (at >= 0) {
    let i = at + marker.length;
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text[i] === ":") {
      i++;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text[i] !== "{") return null;
      let depth = 0;
      let inString = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j]!;
        if (inString) {
          if (ch === "\\") j++;
          else if (ch === '"') inString = false;
        } else if (ch === '"') inString = true;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) return text.slice(i, j + 1);
      }
      return null;
    }
    at = text.indexOf(marker, at + 1);
  }
  return null;
}

/** Page (desktop) or WAP (phone) cashier: a signed GET URL on the gateway. */
export function alipayCashierUrl(creds: AlipayCredentials, kind: "page" | "wap", order: AlipayOrder, notifyUrl: string, returnUrl: string): string {
  const biz = {
    out_trade_no: order.orderId,
    total_amount: minorToFiat(order.amountMinor),
    subject: order.subject.slice(0, 128),
    product_code: kind === "page" ? "FAST_INSTANT_TRADE_PAY" : "QUICK_WAP_WAY",
  };
  const params = signedParams(creds, kind === "page" ? "alipay.trade.page.pay" : "alipay.trade.wap.pay", biz, {
    notify_url: notifyUrl,
    return_url: returnUrl,
  });
  return `${alipayGateway(creds)}?${new URLSearchParams(params).toString()}`;
}

interface AlipayAnswer {
  ok: boolean;
  code: string;
  subCode: string;
  message: string;
  body: Record<string, unknown>;
}

/** Signed POST of an API method; a successful answer must carry a valid Alipay signature. */
async function alipayCall(
  creds: AlipayCredentials,
  method: string,
  biz: Record<string, unknown>,
  fetchImpl: typeof fetch,
  extra: Record<string, string> = {},
): Promise<AlipayAnswer> {
  const params = signedParams(creds, method, biz, extra);
  const res = await gatewayFetch(fetchImpl, `${alipayGateway(creds)}?charset=utf-8`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(params).toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new GatewayError(`Alipay returned HTTP ${res.status}: ${summarize(res.text)}`, isDefinitiveStatus(res.status));
  }
  const node = `${method.replace(/\./g, "_")}_response`;
  // Gateway-level failures (bad app id, bad signature) come back as error_response instead.
  const raw = rawJsonValue(res.text, node) ?? rawJsonValue(res.text, "error_response");
  if (!raw) throw new GatewayError(`Alipay returned an unreadable answer: ${summarize(res.text)}`, false);
  let body: Record<string, unknown>;
  let sign = "";
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
    sign = str((JSON.parse(res.text) as Record<string, unknown>).sign);
  } catch {
    throw new GatewayError(`Alipay returned an unreadable answer: ${summarize(res.text)}`, false);
  }
  const code = str(body.code);
  const ok = code === "10000";
  // Errors may come unsigned (e.g. a bad app id); only success answers move money, so those must verify.
  if (ok && (!sign || !rsaSha256Verify(raw, sign, creds.alipayPublicKey))) {
    throw new GatewayError("Alipay's answer failed signature verification (check the Alipay public key)", false);
  }
  const subCode = str(body.sub_code);
  return { ok, code, subCode, message: [str(body.sub_msg) || str(body.msg), subCode].filter(Boolean).join(" "), body };
}

/** Face-to-face precreate: the QR payload (https://qr.alipay.com/…). */
export async function alipayPrecreate(creds: AlipayCredentials, order: AlipayOrder, notifyUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const a = await alipayCall(
    creds,
    "alipay.trade.precreate",
    { out_trade_no: order.orderId, total_amount: minorToFiat(order.amountMinor), subject: order.subject.slice(0, 128) },
    fetchImpl,
    { notify_url: notifyUrl },
  );
  if (!a.ok) throw new GatewayError(`Alipay precreate failed: ${a.message}`, true);
  const qr = str(a.body.qr_code);
  if (!qr) throw new GatewayError("Alipay precreate returned no QR code", true);
  return qr;
}

/** Opens a precreate QR in the Alipay app on phones. */
export const alipayAppLink = (qrCode: string) => `alipays://platformapi/startapp?saId=10000007&qrcode=${encodeURIComponent(qrCode)}`;

export async function alipayQuery(creds: AlipayCredentials, orderId: string, fetchImpl: typeof fetch): Promise<ProviderPaymentQuery> {
  const a = await alipayCall(creds, "alipay.trade.query", { out_trade_no: orderId }, fetchImpl);
  if (!a.ok) {
    if (a.subCode === "ACQ.TRADE_NOT_EXIST") return { status: "pending", amountMinor: null, currency: null, tradeNo: null };
    throw new GatewayError(`Alipay query failed: ${a.message}`, true);
  }
  const ts = str(a.body.trade_status);
  return {
    status: ts === "TRADE_SUCCESS" || ts === "TRADE_FINISHED" ? "paid" : ts === "TRADE_CLOSED" ? "failed" : "pending",
    amountMinor: decimalToMinor(a.body.total_amount),
    currency: "CNY",
    tradeNo: str(a.body.trade_no) || null,
  };
}

/** Refund of `amountMinor`; `requestNo` makes retries idempotent. fund_change Y = done. */
export async function alipayRefund(
  creds: AlipayCredentials,
  orderId: string,
  requestNo: string,
  amountMinor: number,
  reason: string,
  fetchImpl: typeof fetch,
): Promise<ProviderRefundResult> {
  const a = await alipayCall(
    creds,
    "alipay.trade.refund",
    { out_trade_no: orderId, refund_amount: minorToFiat(amountMinor), refund_reason: reason.slice(0, 256) || "refund", out_request_no: requestNo },
    fetchImpl,
  );
  if (!a.ok) throw new GatewayError(`Alipay refund failed: ${a.message}`, true);
  return { status: str(a.body.fund_change) === "Y" ? "success" : "pending", refundId: requestNo, message: null };
}

export async function alipayRefundQuery(creds: AlipayCredentials, orderId: string, requestNo: string, fetchImpl: typeof fetch): Promise<ProviderRefundResult> {
  const a = await alipayCall(creds, "alipay.trade.fastpay.refund.query", { out_trade_no: orderId, out_request_no: requestNo }, fetchImpl);
  if (!a.ok) throw new GatewayError(`Alipay refund query failed: ${a.message}`, true);
  // REFUND_SUCCESS (or, on older merchants, an echoed refund_amount) = refunded; nothing yet = still processing.
  const status = str(a.body.refund_status);
  const done = status === "REFUND_SUCCESS" || (!status && decimalToMinor(a.body.refund_amount) !== null && str(a.body.out_request_no) === requestNo);
  return { status: done ? "success" : "pending", refundId: requestNo, message: null };
}

/** Closes an unpaid trade (one that never existed is fine). */
export async function alipayClose(creds: AlipayCredentials, orderId: string, fetchImpl: typeof fetch): Promise<void> {
  const a = await alipayCall(creds, "alipay.trade.close", { out_trade_no: orderId }, fetchImpl);
  if (!a.ok && a.subCode !== "ACQ.TRADE_NOT_EXIST") throw new GatewayError(`Alipay close failed: ${a.message}`, true);
}
