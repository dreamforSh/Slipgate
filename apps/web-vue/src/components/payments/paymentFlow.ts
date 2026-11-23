import type {
  AirwallexCheckout,
  CreateOrderRequest,
  PaymentDevice,
  PaymentOrderItem,
  PublicOrderStatus,
  WechatJsapiParams,
} from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { ApiError } from "../../lib/api";
import { useAuthStore } from "../../stores/auth";

/* ------------------------------------------------------------------------------------------ */
/* Device                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Where the purchase page runs: WeChat's in-app browser, another phone browser, or a desktop. */
export function detectDevice(): PaymentDevice {
  if (typeof navigator === "undefined") return "pc";
  const ua = navigator.userAgent || "";
  if (/MicroMessenger/i.test(ua)) return "wechat";
  if (/Android|iPhone|iPad|iPod|HarmonyOS|Mobile/i.test(ua)) return "mobile";
  return "pc";
}

/* ------------------------------------------------------------------------------------------ */
/* API calls whose error bodies carry more than { error, message }                            */
/* ------------------------------------------------------------------------------------------ */

/** ApiError plus the parsed error body (authorizeUrl, balanceNanoUsd …). */
export class PayApiError extends ApiError {
  constructor(
    message: string,
    status: number,
    code: string | null,
    requestId: string | null,
    readonly body: Record<string, unknown>,
  ) {
    super(message, status, code, requestId);
    this.name = "PayApiError";
  }
}

/** Authenticated JSON call like apiJson, but a failure keeps the whole error body. */
export async function payApi<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const auth = useAuthStore();
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(init.body);
  }
  const res = await auth.apiFetch(path, { method: init.method ?? "GET", headers, body: payload, signal: init.signal });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    const body = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
    const code = typeof body.error === "string" ? body.error : null;
    const message = typeof body.message === "string" && body.message ? body.message : (code ?? `HTTP ${res.status}`);
    throw new PayApiError(message, res.status, code, res.headers.get("x-request-id"), body);
  }
  return data as T;
}

/** POST /payments/public/orders/resolve: what a signed resume token says about its order (no session). */
export async function resolvePublicOrder(token: string, signal?: AbortSignal): Promise<PublicOrderStatus> {
  const res = await fetch("/api/v1/payments/public/orders/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    signal,
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : null;
    throw new PayApiError(typeof data.message === "string" ? data.message : `HTTP ${res.status}`, res.status, code, null, data);
  }
  return data as unknown as PublicOrderStatus;
}

/**
 * Error text for a failed payment call: known BFF error codes become friendly copy, network
 * failures say so, anything else keeps the server's message (validation details) or `fallback`.
 * `overrides` maps a code (e.g. "conflict") to copy that fits the call site.
 */
export function usePayErrors() {
  const { t, te } = useI18n();
  return (err: unknown, fallback: string, overrides: Record<string, string> = {}): string => {
    if (err instanceof ApiError) {
      const code = err.code ?? "";
      if (code && overrides[code]) return overrides[code];
      if (code && /^[a-z_]+$/.test(code) && te(`payFlow.errors.${code}`)) return t(`payFlow.errors.${code}`);
      if (err.status === 429) return t("payFlow.errors.rate_limited");
      return err.message || fallback;
    }
    if (err instanceof TypeError) return t("payFlow.errors.network");
    if (err instanceof Error && err.message) return err.message;
    return fallback;
  };
}

/* ------------------------------------------------------------------------------------------ */
/* WeChat (JSAPI inside WeChat, after the payment OAuth round-trip)                           */
/* ------------------------------------------------------------------------------------------ */

const WECHAT_PENDING_KEY = "slipgate_wechat_pending_purchase";
const WECHAT_PENDING_TTL_MS = 15 * 60_000;

/** What was being bought when the browser left for WeChat's OAuth page. */
export type PendingPurchase = Pick<CreateOrderRequest, "planId" | "amount" | "provider" | "method">;

export function savePendingPurchase(p: PendingPurchase): void {
  try {
    sessionStorage.setItem(WECHAT_PENDING_KEY, JSON.stringify({ ...p, savedAt: Date.now() }));
  } catch {
    // Storage blocked: the callback page reports the lost purchase and sends the payer back.
  }
}

/** Reads and forgets the saved purchase (null when missing, stale or malformed). */
export function takePendingPurchase(): PendingPurchase | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(WECHAT_PENDING_KEY);
    sessionStorage.removeItem(WECHAT_PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PendingPurchase> & { savedAt?: number };
    if (typeof v.savedAt !== "number" || Date.now() - v.savedAt > WECHAT_PENDING_TTL_MS) return null;
    if (typeof v.provider !== "string") return null;
    const planId = typeof v.planId === "string" && v.planId ? v.planId : undefined;
    const amount = typeof v.amount === "string" && v.amount ? v.amount : undefined;
    if (Boolean(planId) === Boolean(amount)) return null;
    return { provider: v.provider, method: v.method, planId, amount };
  } catch {
    return null;
  }
}

interface WeixinJSBridgeLike {
  invoke(api: string, params: Record<string, string>, cb: (res: { err_msg?: string }) => void): void;
}

export type WechatPayOutcome = "ok" | "cancel" | "fail" | "unavailable";

/** Opens WeChat Pay inside WeChat (getBrandWCPayRequest); resolves with how it ended. */
export function invokeWechatPay(params: WechatJsapiParams, readyTimeoutMs = 5000): Promise<WechatPayOutcome> {
  return new Promise((resolve) => {
    const w = window as unknown as { WeixinJSBridge?: WeixinJSBridgeLike };
    let settled = false;
    const finish = (v: WechatPayOutcome) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const run = () => {
      const bridge = w.WeixinJSBridge;
      if (!bridge) return finish("unavailable");
      bridge.invoke("getBrandWCPayRequest", { ...params }, (res) => {
        const msg = res?.err_msg ?? "";
        if (msg === "get_brand_wcpay_request:ok") finish("ok");
        else if (msg.endsWith(":cancel")) finish("cancel");
        else finish("fail");
      });
    };
    if (w.WeixinJSBridge) {
      run();
      return;
    }
    document.addEventListener("WeixinJSBridgeReady", run, { once: true });
    window.setTimeout(() => {
      if (!w.WeixinJSBridge) finish("unavailable");
    }, readyTimeoutMs);
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Airwallex Components SDK (loaded from Airwallex's CDN on demand)                           */
/* ------------------------------------------------------------------------------------------ */

const AIRWALLEX_SDK_URL = "https://static.airwallex.com/components/sdk/v1/index.js";

export interface AirwallexElement {
  mount(target: string | HTMLElement): unknown;
  unmount?(): void;
  destroy?(): void;
  on(event: string, handler: (ev: unknown) => void): void;
}

interface AirwallexSdk {
  init(options: Record<string, unknown>): Promise<{ payments?: { redirectToCheckout(options: Record<string, unknown>): unknown } }>;
  createElement?(type: string, options: Record<string, unknown>): Promise<AirwallexElement> | AirwallexElement;
}

let sdkPromise: Promise<AirwallexSdk> | null = null;

function loadAirwallexSdk(): Promise<AirwallexSdk> {
  const w = window as unknown as { AirwallexComponentsSDK?: AirwallexSdk };
  if (w.AirwallexComponentsSDK) return Promise.resolve(w.AirwallexComponentsSDK);
  sdkPromise ??= new Promise<AirwallexSdk>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = AIRWALLEX_SDK_URL;
    script.async = true;
    script.onload = () => (w.AirwallexComponentsSDK ? resolve(w.AirwallexComponentsSDK) : reject(new Error("Airwallex SDK missing")));
    script.onerror = () => reject(new Error("Airwallex SDK failed to load"));
    document.head.appendChild(script);
  }).catch((err: unknown) => {
    sdkPromise = null;
    throw err;
  });
  return sdkPromise;
}

const sdkInits = new Map<string, Promise<Awaited<ReturnType<AirwallexSdk["init"]>>>>();

async function airwallexInit(env: AirwallexCheckout["env"], locale: string) {
  const sdk = await loadAirwallexSdk();
  const key = `${env}|${locale}`;
  let ready = sdkInits.get(key);
  if (!ready) {
    ready = sdk.init({ env, enabledElements: ["payments"], locale });
    sdkInits.set(key, ready);
    ready.catch(() => sdkInits.delete(key));
  }
  return { sdk, payments: (await ready).payments };
}

const intentOptions = (c: AirwallexCheckout) => ({
  intent_id: c.intentId,
  client_secret: c.clientSecret,
  currency: c.currency,
  country_code: c.countryCode,
});

/** Mounts Airwallex's embedded drop-in, or null when this SDK build cannot embed it. */
export async function mountAirwallexDropIn(c: AirwallexCheckout, target: HTMLElement, locale: string): Promise<AirwallexElement | null> {
  const { sdk } = await airwallexInit(c.env, locale);
  if (typeof sdk.createElement !== "function") return null;
  const element = await sdk.createElement("dropIn", { ...intentOptions(c), autoCapture: true });
  element.mount(target);
  return element;
}

/** Sends the browser to Airwallex's hosted checkout page; it returns to `successUrl`. */
export async function openAirwallexHosted(c: AirwallexCheckout, successUrl: string, locale: string): Promise<void> {
  const { payments } = await airwallexInit(c.env, locale);
  if (!payments) throw new Error("Airwallex payments are unavailable");
  const out = payments.redirectToCheckout({ ...intentOptions(c), successUrl });
  const safeOut = typeof out === "string" ? safeHttpUrl(out) : null;
  if (safeOut) window.location.assign(safeOut);
}

/* ------------------------------------------------------------------------------------------ */
/* Links                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Accepts only absolute http(s) URLs for browser redirects / cashier links (blocks javascript:/data:). */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
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

/** Accepts http(s) or mobile wallet deep links (Alipay / WeChat) for explicit app-launch buttons. */
export function safePaymentAppLink(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol === "https:" ||
      parsed.protocol === "http:" ||
      parsed.protocol === "alipays:" ||
      parsed.protocol === "alipay:" ||
      parsed.protocol === "weixin:"
    ) {
      return trimmed;
    }
    return null;
  } catch {
    return null;
  }
}

export function resultLink(orderId: string, extra: Record<string, string> = {}) {
  return { path: "/payment/result", query: { order: orderId, ...extra } };
}

/** Whether an unpaid order can still be paid from the browser (QR, redirect, WeChat, Airwallex). */
export function canResume(order: Pick<PaymentOrderItem, "status" | "provider" | "payUrl" | "checkout">): boolean {
  if (order.status !== "pending") return false;
  const c = order.checkout;
  if (!c) return Boolean(safeHttpUrl(order.payUrl));
  switch (c.flow) {
    case "redirect":
      return Boolean(safeHttpUrl(c.payUrl ?? order.payUrl));
    case "qrcode":
      return Boolean(c.qrCode);
    case "jsapi":
      return Boolean(c.jsapi);
    case "airwallex":
      return Boolean(c.airwallex);
    default:
      return false;
  }
}
