import { createHash, createHmac } from "node:crypto";
import { minorToFiat } from "@slipgate/contracts";
import { decimalToMinor, deterministicUuid, GatewayError, gatewayFetch, isDefinitiveStatus, parseJsonObject, str, summarize, timingSafeEqualText } from "./http.ts";
import type { ProviderPaymentQuery, ProviderRefundResult } from "./providers.ts";

/**
 * Airwallex payment intents: bearer token login (cached until shortly before it expires), intent
 * create / query / cancel with deterministic request ids, refunds and refund query, and the
 * webhook HMAC (x-timestamp + raw body) with a freshness window.
 */

export interface AirwallexCredentials {
  clientId: string;
  apiKey: string;
  webhookSecret: string;
  accountId: string;
  env: "demo" | "prod";
}

export const airwallexApiBase = (env: "demo" | "prod") => (env === "prod" ? "https://api.airwallex.com/api/v1" : "https://api-demo.airwallex.com/api/v1");

const TOKEN_SKEW_MS = 2 * 60_000;
const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
const tokens = new Map<string, { token: string; expiresAtMs: number }>();

function tokenKey(c: AirwallexCredentials): string {
  return [c.env, c.clientId, c.accountId, createHash("sha256").update(c.apiKey).digest("hex").slice(0, 16)].join("|");
}

/** Test hook: forget cached tokens. */
export function clearAirwallexTokens(): void {
  tokens.clear();
}

async function accessToken(c: AirwallexCredentials, fetchImpl: typeof fetch): Promise<string> {
  const key = tokenKey(c);
  const hit = tokens.get(key);
  if (hit && hit.expiresAtMs - TOKEN_SKEW_MS > Date.now()) return hit.token;
  const headers: Record<string, string> = { "Content-Type": "application/json", "x-client-id": c.clientId, "x-api-key": c.apiKey };
  if (c.accountId) headers["x-login-as"] = c.accountId;
  const res = await gatewayFetch(fetchImpl, `${airwallexApiBase(c.env)}/authentication/login`, { method: "POST", headers });
  const data = parseJsonObject(res.text) ?? {};
  const token = str(data.token);
  if (res.status < 200 || res.status >= 300 || !token) {
    throw new GatewayError(
      `Airwallex login failed (HTTP ${res.status}): ${summarize(res.text)}${res.status === 401 || res.status === 403 ? " — check the client ID, API key, environment and account ID" : ""}`,
      isDefinitiveStatus(res.status),
    );
  }
  const exp = Date.parse(str(data.expires_at));
  if (tokens.size > 64) tokens.clear();
  tokens.set(key, { token, expiresAtMs: Number.isFinite(exp) ? exp : Date.now() + 25 * 60_000 });
  return token;
}

async function call(c: AirwallexCredentials, method: "GET" | "POST", path: string, payload: Record<string, unknown> | null, fetchImpl: typeof fetch) {
  const token = await accessToken(c, fetchImpl);
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  if (c.accountId) headers["x-on-behalf-of"] = c.accountId;
  const res = await gatewayFetch(fetchImpl, `${airwallexApiBase(c.env)}${path}`, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(payload ?? {}) : undefined,
  });
  const data = parseJsonObject(res.text) ?? {};
  if (res.status < 200 || res.status >= 300) {
    throw new GatewayError(`Airwallex HTTP ${res.status}: ${str(data.message) || summarize(res.text)}`, isDefinitiveStatus(res.status));
  }
  return data;
}

export interface AirwallexIntent {
  intentId: string;
  clientSecret: string;
}

export async function airwallexCreateIntent(
  c: AirwallexCredentials,
  order: { orderId: string; amountMinor: number; currency: string },
  returnUrl: string,
  fetchImpl: typeof fetch,
): Promise<AirwallexIntent> {
  const amount = minorToFiat(order.amountMinor);
  const data = await call(
    c,
    "POST",
    "/pa/payment_intents/create",
    {
      request_id: deterministicUuid("payment-intent", order.orderId, amount, order.currency),
      amount: Number(amount),
      currency: order.currency,
      merchant_order_id: order.orderId,
      return_url: returnUrl,
      metadata: { order_id: order.orderId },
    },
    fetchImpl,
  );
  const intentId = str(data.id);
  const clientSecret = str(data.client_secret);
  if (!intentId || !clientSecret) throw new GatewayError("Airwallex returned no payment intent id or client secret", true);
  return { intentId, clientSecret };
}

const intentStatus = (s: string): ProviderPaymentQuery["status"] => (s === "SUCCEEDED" ? "paid" : s === "CANCELLED" ? "failed" : "pending");

export async function airwallexQueryIntent(c: AirwallexCredentials, intentId: string, fetchImpl: typeof fetch): Promise<ProviderPaymentQuery> {
  const data = await call(c, "GET", `/pa/payment_intents/${encodeURIComponent(intentId)}`, null, fetchImpl);
  return {
    status: intentStatus(str(data.status).toUpperCase()),
    amountMinor: decimalToMinor(data.amount),
    currency: str(data.currency).toUpperCase() || null,
    tradeNo: str(data.id) || intentId,
  };
}

export async function airwallexCancelIntent(c: AirwallexCredentials, intentId: string, fetchImpl: typeof fetch): Promise<void> {
  await call(c, "POST", `/pa/payment_intents/${encodeURIComponent(intentId)}/cancel`, {}, fetchImpl);
}

const refundStatus = (s: string): ProviderRefundResult["status"] => (s === "SETTLED" ? "success" : s === "FAILED" ? "failed" : "pending");

export async function airwallexRefund(
  c: AirwallexCredentials,
  intentId: string,
  amountMinor: number,
  reason: string,
  fetchImpl: typeof fetch,
): Promise<ProviderRefundResult> {
  const amount = minorToFiat(amountMinor);
  const data = await call(
    c,
    "POST",
    "/pa/refunds/create",
    { request_id: deterministicUuid("refund", intentId, amount), payment_intent_id: intentId, amount: Number(amount), reason: reason.slice(0, 120) || "refund" },
    fetchImpl,
  );
  const id = str(data.id);
  if (!id) throw new GatewayError("Airwallex returned no refund id", true);
  return { status: refundStatus(str(data.status).toUpperCase()), refundId: id, message: null };
}

export async function airwallexRefundQuery(c: AirwallexCredentials, refundId: string, fetchImpl: typeof fetch): Promise<ProviderRefundResult> {
  const data = await call(c, "GET", `/pa/refunds/${encodeURIComponent(refundId)}`, null, fetchImpl);
  return { status: refundStatus(str(data.status).toUpperCase()), refundId: str(data.id) || refundId, message: null };
}

/** HMAC-SHA256(secret, x-timestamp + raw body), hex, with x-timestamp (ms) within 5 minutes. */
export function airwallexVerifyWebhook(rawBody: string, timestamp: string, signature: string, secret: string, nowMs = Date.now()): boolean {
  if (!secret || !timestamp || !signature) return false;
  const expected = createHmac("sha256", secret).update(timestamp).update(rawBody).digest("hex");
  if (!timingSafeEqualText(signature.trim().toLowerCase(), expected)) return false;
  const ts = Number(timestamp.trim());
  return Number.isFinite(ts) && ts > 0 && Math.abs(nowMs - ts) <= WEBHOOK_TOLERANCE_MS;
}

/** Test helper: the signature Airwallex would send. */
export function airwallexWebhookSignature(rawBody: string, timestamp: string, secret: string): string {
  return createHmac("sha256", secret).update(timestamp).update(rawBody).digest("hex");
}
