import type { SubscriptionLimits, SubscriptionUsage, UserSubscriptionItem, UserSubscriptionStatus } from "@slipgate/contracts";
import type { Tone } from "../../../lib/format";

export const DAY_MS = 86_400_000;

export const STATUS_TONE: Record<UserSubscriptionStatus, Tone> = {
  active: "success",
  expired: "warning",
  revoked: "neutral",
};

export type CapWindow = "daily" | "weekly" | "monthly";
export const CAP_WINDOWS: CapWindow[] = ["daily", "weekly", "monthly"];

export interface WindowUsage {
  key: CapWindow;
  usedNano: string;
  limitNano: string;
  /** 0–100+ (can exceed 100 when over the cap). */
  pct: number;
  tone: "success" | "warning" | "danger";
}

const LIMIT_FIELD: Record<CapWindow, keyof SubscriptionLimits> = {
  daily: "dailyLimitNanoUsd",
  weekly: "weeklyLimitNanoUsd",
  monthly: "monthlyLimitNanoUsd",
};
const USAGE_FIELD: Record<CapWindow, keyof SubscriptionUsage> = {
  daily: "dailyNanoUsd",
  weekly: "weeklyNanoUsd",
  monthly: "monthlyNanoUsd",
};

function big(v: string): bigint {
  try {
    return BigInt(v || "0");
  } catch {
    return 0n;
  }
}

/** Success below 70%, warning from 70%, danger from 90%. */
export function usageTone(pct: number): WindowUsage["tone"] {
  if (pct >= 90) return "danger";
  if (pct >= 70) return "warning";
  return "success";
}

/** Only the windows that carry a cap ("0" = unlimited is skipped). */
export function cappedWindows(limits: SubscriptionLimits, usage: SubscriptionUsage): WindowUsage[] {
  const out: WindowUsage[] = [];
  for (const key of CAP_WINDOWS) {
    const limitNano = limits[LIMIT_FIELD[key]];
    const limit = big(limitNano);
    if (limit <= 0n) continue;
    const usedNano = usage[USAGE_FIELD[key]];
    const used = big(usedNano);
    const pct = Number((used * 10_000n) / limit) / 100;
    out.push({ key, usedNano, limitNano, pct, tone: usageTone(pct) });
  }
  return out;
}

export interface ExpiryInfo {
  state: "expired" | "today" | "days";
  days: number;
  tone: Tone;
}

/** Whole days left until expiry (warning ≤ 7, danger ≤ 3). */
export function expiryInfo(sub: Pick<UserSubscriptionItem, "expiresAtIso" | "status">, nowMs: number): ExpiryInfo {
  const left = Date.parse(sub.expiresAtIso) - nowMs;
  if (sub.status === "expired" || !Number.isFinite(left) || left <= 0) return { state: "expired", days: 0, tone: "danger" };
  const days = Math.floor(left / DAY_MS);
  const tone: Tone = days <= 3 ? "danger" : days <= 7 ? "warning" : "neutral";
  return { state: days === 0 ? "today" : "days", days, tone };
}

/** Expiry the server would set for an `extend` of `days` (expired ones restart from now). */
export function previewExpiry(expiresAtIso: string, days: number, nowMs: number): Date {
  const current = Date.parse(expiresAtIso);
  const base = Number.isFinite(current) && current > nowMs ? current : nowMs;
  return new Date(base + days * DAY_MS);
}
