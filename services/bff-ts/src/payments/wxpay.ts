import { createDecipheriv, randomBytes } from "node:crypto";
import type { WechatJsapiParams } from "@slipgate/contracts";
import { loadRsaPrivateKey, rsaSha256Sign, rsaSha256Verify } from "./alipay.ts";
import { GatewayError, gatewayFetch, isDefinitiveStatus, parseJsonObject, str, summarize } from "./http.ts";
import type { ProviderPaymentQuery, ProviderRefundResult } from "./providers.ts";

/**
 * WeChat Pay API v3 (public-key verifier mode): Native (QR code_url), H5 and JSAPI prepay with
 * the JSAPI paySign, order query / close, refunds and refund query, notification signature
 * verification and AES-256-GCM resource decryption, plus the snsapi_base OAuth that yields the
 * payer's openid for JSAPI. Requests are signed with the merchant API private key; responses and
 * notifications must carry a valid signature by the WeChat Pay public key `publicKeyId`.
 */

export interface WxpayCredentials {
  appId: string;
  mpAppId: string;
  mchId: string;
  certSerial: string;
  publicKeyId: string;
  publicKey: string;
  privateKey: string;
  apiV3Key: string;
  h5AppName: string;
  h5AppUrl: string;
}

export interface WxpayOrder {
  orderId: string;
  amountMinor: number;
  description: string;
}

const API = "https://api.mch.weixin.qq.com";
const SIGNATURE_SKEW_SEC = 300;

const nonce = () => randomBytes(16).toString("hex");

/** The JSAPI AppID: the official account's when set, else the merchant's. */
export const wxpayJsapiAppId = (creds: Pick<WxpayCredentials, "appId" | "mpAppId">) => creds.mpAppId.trim() || creds.appId.trim();

/** Authorization header of a v3 request (WECHATPAY2-SHA256-RSA2048). */
export function wxpayAuthorization(
  creds: Pick<WxpayCredentials, "mchId" | "certSerial" | "privateKey">,
  method: string,
  pathWithQuery: string,
  body: string,
  ts = Math.floor(Date.now() / 1000),
  nonceStr = nonce(),
): string {
  const message = `${method}\n${pathWithQuery}\n${ts}\n${nonceStr}\n${body}\n`;
  const signature = rsaSha256Sign(message, creds.privateKey);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${creds.mchId}",nonce_str="${nonceStr}",signature="${signature}",timestamp="${ts}",serial_no="${creds.certSerial}"`;
}

/** Verifies a response or notification signature (`${ts}\n${nonce}\n${body}\n`). */
export function wxpayVerifySignature(
  creds: Pick<WxpayCredentials, "publicKeyId" | "publicKey">,
  headers: { timestamp: string; nonce: string; signature: string; serial: string },
  body: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (!headers.signature || !headers.timestamp || !headers.nonce) return false;
  if (headers.serial !== creds.publicKeyId) return false;
  const ts = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > SIGNATURE_SKEW_SEC) return false;
  return rsaSha256Verify(`${headers.timestamp}\n${headers.nonce}\n${body}\n`, headers.signature, creds.publicKey);
}

export function wxpaySignatureHeaders(h: Headers) {
  return {
    timestamp: h.get("wechatpay-timestamp") ?? "",
    nonce: h.get("wechatpay-nonce") ?? "",
    signature: h.get("wechatpay-signature") ?? "",
    serial: h.get("wechatpay-serial") ?? "",
  };
}

/** AEAD_AES_256_GCM resource of a notification, decrypted with the APIv3 key. */
export function wxpayDecryptResource(apiV3Key: string, resource: { ciphertext: string; nonce: string; associated_data?: string }): string {
  const data = Buffer.from(resource.ciphertext, "base64");
  if (data.byteLength <= 16) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(apiV3Key, "utf8"), Buffer.from(resource.nonce, "utf8"));
  decipher.setAAD(Buffer.from(resource.associated_data ?? "", "utf8"));
  decipher.setAuthTag(data.subarray(data.byteLength - 16));
  return Buffer.concat([decipher.update(data.subarray(0, data.byteLength - 16)), decipher.final()]).toString("utf8");
}

/** A signed v3 call; 2xx answers with a body must carry a valid WeChat Pay signature. */
async function wxpayCall(
  creds: WxpayCredentials,
  method: "GET" | "POST",
  path: string,
  payload: Record<string, unknown> | null,
  fetchImpl: typeof fetch,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = payload ? JSON.stringify(payload) : "";
  const res = await gatewayFetch(fetchImpl, `${API}${path}`, {
    method,
    headers: {
      Authorization: wxpayAuthorization(creds, method, path, body),
      Accept: "application/json",
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    body: payload ? body : undefined,
  });
  const json = parseJsonObject(res.text) ?? {};
  if (res.status < 200 || res.status >= 300) {
    const message = str(json.message) || summarize(res.text);
    throw new GatewayError(`WeChat Pay ${str(json.code) || `HTTP ${res.status}`}: ${message}`, isDefinitiveStatus(res.status));
  }
  if (res.text.trim() && !wxpayVerifySignature(creds, wxpaySignatureHeaders(res.headers), res.text)) {
    throw new GatewayError("WeChat Pay's answer failed signature verification (check the public key and its ID)", false);
  }
  return { status: res.status, body: json };
}

function prepayBody(creds: WxpayCredentials, appId: string, order: WxpayOrder, notifyUrl: string): Record<string, unknown> {
  return {
    appid: appId,
    mchid: creds.mchId,
    description: order.description.slice(0, 127) || order.orderId,
    out_trade_no: order.orderId,
    notify_url: notifyUrl,
    amount: { total: order.amountMinor, currency: "CNY" },
  };
}

/** Native: the code_url to show as a QR code. */
export async function wxpayNativePrepay(creds: WxpayCredentials, order: WxpayOrder, notifyUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const r = await wxpayCall(creds, "POST", "/v3/pay/transactions/native", prepayBody(creds, creds.appId, order, notifyUrl), fetchImpl);
  const url = str(r.body.code_url);
  if (!url) throw new GatewayError("WeChat Pay returned no code_url", true);
  return url;
}

/** H5 (mobile browsers): the h5_url, with redirect_url back to the result page. */
export async function wxpayH5Prepay(
  creds: WxpayCredentials,
  order: WxpayOrder,
  notifyUrl: string,
  clientIp: string,
  returnUrl: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const h5Info: Record<string, string> = { type: "Wap" };
  if (creds.h5AppName) h5Info.app_name = creds.h5AppName;
  if (creds.h5AppUrl) h5Info.app_url = creds.h5AppUrl;
  const r = await wxpayCall(
    creds,
    "POST",
    "/v3/pay/transactions/h5",
    { ...prepayBody(creds, creds.appId, order, notifyUrl), scene_info: { payer_client_ip: clientIp || "127.0.0.1", h5_info: h5Info } },
    fetchImpl,
  );
  const url = str(r.body.h5_url);
  if (!url) throw new GatewayError("WeChat Pay returned no h5_url", true);
  return returnUrl ? `${url}${url.includes("?") ? "&" : "?"}redirect_url=${encodeURIComponent(returnUrl)}` : url;
}

/** JSAPI (inside WeChat): prepay for the payer's openid, then the signed getBrandWCPayRequest parameters. */
export async function wxpayJsapiPrepay(
  creds: WxpayCredentials,
  order: WxpayOrder,
  notifyUrl: string,
  openid: string,
  clientIp: string,
  fetchImpl: typeof fetch,
): Promise<WechatJsapiParams> {
  const appId = wxpayJsapiAppId(creds);
  const body: Record<string, unknown> = { ...prepayBody(creds, appId, order, notifyUrl), payer: { openid } };
  if (clientIp) body.scene_info = { payer_client_ip: clientIp };
  const r = await wxpayCall(creds, "POST", "/v3/pay/transactions/jsapi", body, fetchImpl);
  const prepayId = str(r.body.prepay_id);
  if (!prepayId) throw new GatewayError("WeChat Pay returned no prepay_id", true);
  return wxpayJsapiParams(creds, appId, prepayId);
}

export function wxpayJsapiParams(creds: Pick<WxpayCredentials, "privateKey">, appId: string, prepayId: string, ts = Math.floor(Date.now() / 1000)): WechatJsapiParams {
  const timeStamp = String(ts);
  const nonceStr = nonce();
  const pkg = `prepay_id=${prepayId}`;
  return {
    appId,
    timeStamp,
    nonceStr,
    package: pkg,
    signType: "RSA",
    paySign: rsaSha256Sign(`${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`, creds.privateKey),
  };
}

const tradeStatus = (state: string): ProviderPaymentQuery["status"] =>
  state === "SUCCESS" || state === "REFUND" ? "paid" : state === "CLOSED" || state === "PAYERROR" || state === "REVOKED" ? "failed" : "pending";

export async function wxpayQuery(creds: WxpayCredentials, orderId: string, fetchImpl: typeof fetch): Promise<ProviderPaymentQuery> {
  try {
    const r = await wxpayCall(
      creds,
      "GET",
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(creds.mchId)}`,
      null,
      fetchImpl,
    );
    const amount = (r.body.amount ?? {}) as Record<string, unknown>;
    return {
      status: tradeStatus(str(r.body.trade_state)),
      amountMinor: typeof amount.total === "number" ? amount.total : null,
      currency: str(amount.currency).toUpperCase() || null,
      tradeNo: str(r.body.transaction_id) || null,
    };
  } catch (err) {
    if (err instanceof GatewayError && /ORDER_NOT_EXIST|ORDERNOTEXIST/.test(err.message)) {
      return { status: "pending", amountMinor: null, currency: null, tradeNo: null };
    }
    throw err;
  }
}

export async function wxpayClose(creds: WxpayCredentials, orderId: string, fetchImpl: typeof fetch): Promise<void> {
  await wxpayCall(creds, "POST", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}/close`, { mchid: creds.mchId }, fetchImpl);
}

const refundStatus = (r: Record<string, unknown>, refundNo: string): ProviderRefundResult => {
  const s = str(r.status);
  return {
    status: s === "SUCCESS" ? "success" : s === "CLOSED" || s === "ABNORMAL" ? "failed" : "pending",
    refundId: str(r.out_refund_no) || refundNo,
    message: s === "ABNORMAL" ? "WeChat Pay could not return the money to the payer's account (ABNORMAL)" : s === "CLOSED" ? "WeChat Pay closed the refund" : null,
  };
};

/** Domestic refund; `refundNo` (out_refund_no) makes retries idempotent. */
export async function wxpayRefund(
  creds: WxpayCredentials,
  orderId: string,
  refundNo: string,
  refundMinor: number,
  totalMinor: number,
  reason: string,
  fetchImpl: typeof fetch,
): Promise<ProviderRefundResult> {
  const body: Record<string, unknown> = {
    out_trade_no: orderId,
    out_refund_no: refundNo,
    amount: { refund: refundMinor, total: totalMinor, currency: "CNY" },
  };
  if (reason) body.reason = reason.slice(0, 80);
  const r = await wxpayCall(creds, "POST", "/v3/refund/domestic/refunds", body, fetchImpl);
  return refundStatus(r.body, refundNo);
}

export async function wxpayRefundQuery(creds: WxpayCredentials, refundNo: string, fetchImpl: typeof fetch): Promise<ProviderRefundResult> {
  const r = await wxpayCall(creds, "GET", `/v3/refund/domestic/refunds/${encodeURIComponent(refundNo)}`, null, fetchImpl);
  return refundStatus(r.body, refundNo);
}

/** True when the private key parses (checked when an admin saves it). */
export function wxpayKeyUsable(privateKey: string): boolean {
  try {
    loadRsaPrivateKey(privateKey);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- snsapi_base OAuth (JSAPI openid) ---------------- */

export function wechatOAuthAuthorizeUrl(appId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({ appid: appId, redirect_uri: redirectUri, response_type: "code", scope: "snsapi_base", state });
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${q.toString()}#wechat_redirect`;
}

/** Exchanges an OAuth code for the payer's openid. */
export async function wechatOAuthOpenid(appId: string, appSecret: string, code: string, fetchImpl: typeof fetch): Promise<string> {
  const q = new URLSearchParams({ appid: appId, secret: appSecret, code, grant_type: "authorization_code" });
  const res = await gatewayFetch(fetchImpl, `https://api.weixin.qq.com/sns/oauth2/access_token?${q.toString()}`, { method: "GET" });
  const data = parseJsonObject(res.text) ?? {};
  const openid = str(data.openid);
  if (!openid) throw new GatewayError(`WeChat OAuth failed: ${str(data.errmsg) || str(data.errcode) || summarize(res.text)}`, true);
  return openid;
}
