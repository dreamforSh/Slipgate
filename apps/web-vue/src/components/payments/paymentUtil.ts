import {
  fiatToMinor,
  MAX_FIAT_MINOR,
  minorToFiat,
  type PaymentChannel,
  type PaymentCurrency,
  type PaymentOrderStatus,
  type PaymentPlan,
  type UpsertPaymentPlanRequest,
  type WalletSummary,
} from "@slipgate/contracts";
import { apiJson } from "../../lib/api";
import type { Tone } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import { nanoToUsdInput } from "../admin/users/money";
import type { IconName } from "../ui/UiIcon.vue";

export { STAGGER_CLASS, stagger, useDebounced } from "../admin/ops/opsUtil";

/* ---------------- Money ---------------- */

const CURRENCY_SYMBOL: Record<PaymentCurrency, string> = { CNY: "¥", USD: "$" };

export function currencySymbol(currency: PaymentCurrency | string): string {
  return CURRENCY_SYMBOL[currency as PaymentCurrency] ?? "";
}

/** 123456 → "1,234.56" (integer minor units in, never floats). */
export function groupedFiat(minor: number): string {
  const text = minorToFiat(minor);
  const negative = text.startsWith("-");
  const [whole = "0", frac = "00"] = text.replace(/^-/, "").split(".");
  return `${negative ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${frac}`;
}

/** 123456, "CNY" → "¥1,234.56". */
export function formatFiat(minor: number, currency: PaymentCurrency | string): string {
  const negative = minor < 0;
  return `${negative ? "-" : ""}${currencySymbol(currency)}${groupedFiat(Math.abs(minor))}`;
}

/** formatFiat without a trailing ".00" ("¥100", "¥9.90") for chips and plan cards. */
export function formatFiatCompact(minor: number, currency: PaymentCurrency | string): string {
  return formatFiat(minor, currency).replace(/\.00$/, "");
}

/** Same pattern as the contracts' FiatAmountSchema. */
export const FIAT_INPUT_RE = /^\d{1,9}(?:\.\d{1,2})?$/;
export const FIAT_INPUT_PATTERN = "[0-9]{1,9}(\\.[0-9]{1,2})?";

/** "12.5" → 1250; null when the text is not a fiat amount the API accepts (pattern and MAX_FIAT_MINOR). */
export function parseFiatInput(text: string): number | null {
  const value = text.trim();
  if (!FIAT_INPUT_RE.test(value)) return null;
  const minor = fiatToMinor(value);
  return minor <= MAX_FIAT_MINOR ? minor : null;
}

/** Fiat minor units → nano-USD credited at `minorPerUsd` (identical integer math to the BFF). */
export function creditNanoForMinor(minor: number, minorPerUsd: number): string {
  if (!Number.isFinite(minor) || minor <= 0 || !Number.isFinite(minorPerUsd) || minorPerUsd <= 0) return "0";
  return ((BigInt(Math.trunc(minor)) * 1_000_000_000n) / BigInt(Math.trunc(minorPerUsd))).toString();
}

/** Sum of nano-USD strings (exact). */
export function sumNano(values: string[]): string {
  let total = 0n;
  for (const v of values) {
    try {
      total += BigInt(v || "0");
    } catch {
      // Malformed amounts are skipped rather than poisoning the total.
    }
  }
  return total.toString();
}

/**
 * Bonus a recharge plan gives over the configured base rate, as a whole percent (≥ 1), or null.
 * Only comparable when the plan is priced in the configured currency.
 */
export function planBonusPct(plan: Pick<PaymentPlan, "kind" | "currency" | "priceMinor" | "creditNanoUsd">, minorPerUsd: number, currency: PaymentCurrency): number | null {
  if (plan.kind !== "recharge" || plan.currency !== currency) return null;
  let base: bigint;
  let credit: bigint;
  try {
    base = BigInt(creditNanoForMinor(plan.priceMinor, minorPerUsd));
    credit = BigInt(plan.creditNanoUsd);
  } catch {
    return null;
  }
  if (base <= 0n || credit <= base) return null;
  const pct = Math.round(Number(((credit - base) * 1000n) / base) / 10);
  return pct >= 1 ? pct : null;
}

/** Price per day of a subscription plan, in minor units (rounded). */
export function perDayMinor(priceMinor: number, days: number | null): number | null {
  if (!days || days <= 1) return null;
  return Math.max(1, Math.round(priceMinor / days));
}

/* ---------------- Orders ---------------- */

export const ORDER_STATUSES: PaymentOrderStatus[] = [
  "pending",
  "paid",
  "refund_requested",
  "refund_pending",
  "refund_failed",
  "partially_refunded",
  "refunded",
  "expired",
  "cancelled",
  "failed",
];

export const ORDER_STATUS_TONE: Record<PaymentOrderStatus, Tone> = {
  pending: "warning",
  paid: "success",
  expired: "neutral",
  cancelled: "neutral",
  refunded: "violet",
  failed: "danger",
  refund_requested: "info",
  refund_pending: "accent",
  refund_failed: "danger",
  partially_refunded: "violet",
};

/** Statuses whose badge breathes: something is still in motion. */
export const ORDER_STATUS_PULSE: ReadonlySet<PaymentOrderStatus> = new Set(["pending", "refund_requested", "refund_pending"]);

/** The refund flow has started for this order (requested, sent, failed or done). */
export const REFUND_STATUSES: ReadonlySet<PaymentOrderStatus> = new Set([
  "refund_requested",
  "refund_pending",
  "refund_failed",
  "partially_refunded",
  "refunded",
]);

/** "mm:ss" (or "h:mm:ss") until `iso`; "0:00" once past. */
export function countdownText(iso: string | null | undefined, nowMs: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return "-";
  const left = Math.max(0, Math.floor((at - nowMs) / 1000));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/* ---------------- Channels ---------------- */

/** Stable identity of a payment channel: the EasyPay method, or the provider itself. */
export function channelKey(provider: string, method: string | null | undefined): string {
  if (provider === "easypay") return method || "alipay";
  return provider;
}

export function channelId(ch: PaymentChannel): string {
  return `${ch.provider}:${ch.method ?? ""}`;
}

export interface ChannelVisual {
  /** Brand monogram (decorative), or an icon when there is no brand mark. */
  glyph?: string;
  icon?: IconName;
  tone: Tone;
}

const CHANNEL_VISUALS: Record<string, ChannelVisual> = {
  alipay: { glyph: "支", tone: "info" },
  wxpay: { glyph: "微", tone: "success" },
  qqpay: { glyph: "Q", tone: "accent" },
  stripe: { icon: "credit-card", tone: "violet" },
  airwallex: { glyph: "A", tone: "danger" },
  manual: { icon: "file", tone: "warning" },
};

export function channelVisual(provider: string, method: string | null | undefined): ChannelVisual {
  return CHANNEL_VISUALS[channelKey(provider, method)] ?? { icon: "credit-card", tone: "neutral" };
}

/** Display order of channels on the purchase page. */
const CHANNEL_ORDER = ["alipay", "wxpay", "qqpay", "stripe", "airwallex", "manual"];

/** Providers that only settle CNY orders (the BFF refuses others with 400). */
export const CNY_ONLY_PROVIDERS: ReadonlySet<string> = new Set(["easypay", "alipay", "wxpay"]);

/** Why a channel cannot take the current item (null = it can). */
export type ChannelBlock =
  | { kind: "currency" }
  | { kind: "soldOut" }
  | { kind: "unavailable" }
  | { kind: "range"; min: number; max: number }
  | { kind: "remaining"; remaining: number };

/**
 * Checks a channel against the item being bought: CNY-only gateways, today's availability, the
 * aggregated single-order range and what is left of the daily limit (all fiat minor units).
 */
export function channelBlock(ch: PaymentChannel, currency: PaymentCurrency | null, amountMinor: number | null): ChannelBlock | null {
  if (currency !== null && currency !== "CNY" && CNY_ONLY_PROVIDERS.has(ch.provider)) return { kind: "currency" };
  if (!ch.available) return ch.dailyLimitMinor > 0 ? { kind: "soldOut" } : { kind: "unavailable" };
  if (amountMinor === null || amountMinor <= 0) return null;
  const tooLow = ch.singleMinMinor > 0 && amountMinor < ch.singleMinMinor;
  const tooHigh = ch.singleMaxMinor > 0 && amountMinor > ch.singleMaxMinor;
  if (tooLow || tooHigh) return { kind: "range", min: ch.singleMinMinor, max: ch.singleMaxMinor };
  if (ch.dailyRemainingMinor !== null && amountMinor > ch.dailyRemainingMinor) return { kind: "remaining", remaining: ch.dailyRemainingMinor };
  return null;
}

export function sortChannels(list: PaymentChannel[]): PaymentChannel[] {
  const rank = (ch: PaymentChannel) => {
    const i = CHANNEL_ORDER.indexOf(channelKey(ch.provider, ch.method));
    return i === -1 ? CHANNEL_ORDER.length : i;
  };
  return [...list].sort((a, b) => rank(a) - rank(b));
}

export const ICON_CHIP_TONE: Record<Tone, string> = {
  neutral: "",
  accent: "icon-chip-accent",
  success: "icon-chip-success",
  warning: "icon-chip-warning",
  danger: "icon-chip-danger",
  info: "icon-chip-info",
  violet: "icon-chip-violet",
};

/* ---------------- Plans ---------------- */

/** Full PUT body for an existing plan, optionally with a few fields replaced. */
export function planToRequest(plan: PaymentPlan, patch: Partial<UpsertPaymentPlanRequest> = {}): UpsertPaymentPlanRequest {
  const base: UpsertPaymentPlanRequest = {
    name: plan.name,
    description: plan.description,
    kind: plan.kind,
    price: minorToFiat(plan.priceMinor),
    currency: plan.currency,
    badge: plan.badge,
    enabled: plan.enabled,
    sortOrder: plan.sortOrder,
  };
  if (plan.kind === "recharge") base.creditUsd = nanoToUsdInput(plan.creditNanoUsd);
  else {
    if (plan.groupId) base.groupId = plan.groupId;
    if (plan.validityDays) base.validityDays = plan.validityDays;
  }
  return { ...base, ...patch };
}

/* ---------------- Wallet ---------------- */

/** Re-reads the signed-in user's wallet into the auth store (silent on failure). */
export async function refreshWallet(): Promise<void> {
  const auth = useAuthStore();
  try {
    const { wallet } = await apiJson<{ wallet: WalletSummary }>("/api/v1/user/wallet");
    auth.wallet = wallet;
  } catch {
    // The shell already shows a balance; a failed refresh is not worth a toast.
  }
}

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
