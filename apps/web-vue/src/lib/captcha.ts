import type { CaptchaProof, CaptchaScope, PublicCaptcha } from "@slipgate/contracts";

/**
 * Human-verification widgets (Cloudflare Turnstile, Tencent Captcha, Aliyun Captcha 2.0): the
 * provider scripts, loaded on demand only when the site switched a provider on for the flow being
 * shown. Nothing here runs (or touches the network) while the captcha is off.
 */

export const CAPTCHA_SCRIPT_TIMEOUT_MS = 15_000;

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
/** cn = cloud.tencent.com (TJCaptcha.js); intl = tencentcloud.com (Robot checkbox, needs a container). */
const TENCENT_SRC = {
  cn: "https://turing.captcha.qcloud.com/TJCaptcha.js",
  intl: "https://ca.turing.captcha.qcloud.com/TJNCaptcha-global.js",
} as const;
const ALIYUN_SRC = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";

/* ---------------- Provider globals ---------------- */

export interface TurnstileRenderOptions {
  sitekey: string;
  callback: (token: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
  "error-callback"?: (code?: string) => boolean | void;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "compact" | "flexible";
  language?: string;
  appearance?: "always" | "execute" | "interaction-only";
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

export interface TencentCaptchaResult {
  /** 0 = solved, 2 = closed by the user. */
  ret: number;
  ticket?: string | null;
  randstr?: string | null;
  errorCode?: number;
}

export interface TencentCaptchaInstance {
  show(): void;
  destroy(): void;
}

type TencentCallback = (result: TencentCaptchaResult) => void;

/** cn: (appId, callback, options); intl: (container, appId, callback, options). */
export interface TencentCaptchaConstructor {
  new (appId: string, callback: TencentCallback, options?: Record<string, unknown>): TencentCaptchaInstance;
  new (element: HTMLElement, appId: string, callback: TencentCallback, options?: Record<string, unknown>): TencentCaptchaInstance;
}

export interface AliyunCaptchaInitOptions {
  SceneId: string;
  prefix: string;
  mode: "popup" | "embed";
  element: string;
  button: string;
  captchaVerifyCallback: (captchaVerifyParam: string) => { captchaResult: boolean; bizResult?: boolean };
  onBizResultCallback: (bizResult: boolean) => void;
  getInstance: (instance: unknown) => void;
  slideStyle?: { width: number; height: number };
  language?: string;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
    TencentCaptcha?: TencentCaptchaConstructor;
    /** Set by the international Tencent script only. */
    TCaptchaGlobal?: boolean;
    initAliyunCaptcha?: (options: AliyunCaptchaInitOptions) => void;
    AliyunCaptchaConfig?: { region: string; prefix: string };
  }
}

/* ---------------- Script loading ---------------- */

const scripts = new Map<string, Promise<void>>();

/**
 * Adds `src` once (shared by every caller) and resolves when it has run. A failure or timeout
 * removes the tag, so a later call (the "retry" button) starts over.
 */
function loadScript(src: string, timeoutMs = CAPTCHA_SCRIPT_TIMEOUT_MS): Promise<void> {
  const cached = scripts.get(src);
  if (cached) return cached;
  const promise = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.referrerPolicy = "origin";
    const timer = window.setTimeout(() => fail(new Error("captcha_script_timeout")), timeoutMs);
    function fail(err: Error) {
      window.clearTimeout(timer);
      el.remove();
      scripts.delete(src);
      reject(err);
    }
    el.onload = () => {
      window.clearTimeout(timer);
      resolve();
    };
    el.onerror = () => fail(new Error("captcha_script_failed"));
    document.head.appendChild(el);
  });
  scripts.set(src, promise);
  return promise;
}

export async function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return window.turnstile;
  await loadScript(TURNSTILE_SRC);
  if (!window.turnstile) throw new Error("captcha_script_failed");
  return window.turnstile;
}

/**
 * Both Tencent scripts register the same `TencentCaptcha` global with incompatible constructors,
 * so a page can only ever hold one of them (switching region needs a reload).
 */
export async function loadTencent(region: "cn" | "intl"): Promise<TencentCaptchaConstructor> {
  const loadedRegion = window.TencentCaptcha ? (window.TCaptchaGlobal === true ? "intl" : "cn") : null;
  if (loadedRegion === region && window.TencentCaptcha) return window.TencentCaptcha;
  if (loadedRegion && loadedRegion !== region) throw new Error("captcha_region_changed");
  await loadScript(TENCENT_SRC[region]);
  if (!window.TencentCaptcha) throw new Error("captcha_script_failed");
  return window.TencentCaptcha;
}

/** The Aliyun script reads its region / prefix from a global that must exist before it loads. */
export async function loadAliyun(region: "cn" | "sgp", prefix: string): Promise<void> {
  window.AliyunCaptchaConfig = { region, prefix };
  if (window.initAliyunCaptcha) return;
  await loadScript(ALIYUN_SRC);
  if (!window.initAliyunCaptcha) throw new Error("captcha_script_failed");
}

/* ---------------- Helpers ---------------- */

/** Widget parameters as public settings carry them (the admin "try it" box builds the same shape). */
export type CaptchaWidgetConfig = Pick<
  PublicCaptcha,
  "provider" | "turnstileSiteKey" | "tencentAppId" | "tencentRegion" | "aliyunSceneId" | "aliyunPrefix" | "aliyunRegion"
>;

/** Whether the widget has what it needs to render for its provider. */
export function captchaRenderable(c: CaptchaWidgetConfig | null | undefined): boolean {
  if (!c) return false;
  switch (c.provider) {
    case "turnstile":
      return Boolean(c.turnstileSiteKey);
    case "tencent":
      return Boolean(c.tencentAppId);
    case "aliyun":
      return Boolean(c.aliyunSceneId && c.aliyunPrefix);
    default:
      return false;
  }
}

/** Whether a flow needs a challenge under these public settings. */
export function captchaRequired(c: PublicCaptcha | null | undefined, scope: CaptchaScope): boolean {
  return Boolean(c && c.provider !== "none" && c.scopes[scope]);
}

/** Error codes a guarded request answers with when the challenge failed. */
export const CAPTCHA_ERROR_CODES = new Set(["captcha_required", "captcha_invalid", "captcha_unavailable"]);

export function isCaptchaError(code: string | null | undefined): boolean {
  return Boolean(code && CAPTCHA_ERROR_CODES.has(code));
}

/** True when the proof carries a fresh answer (not just a server-issued pass). */
export function proofHasAnswer(proof: CaptchaProof | null | undefined): boolean {
  return Boolean(proof && (proof.turnstileToken || proof.tencentTicket || proof.aliyunVerifyParam));
}
