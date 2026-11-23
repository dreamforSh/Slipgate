import type { ChannelHealth } from "@slipgate/contracts";
import type { Tone } from "../../lib/format";
import type { IconName } from "../ui/icons";

/** Badge tone and icon per channel health state. */
export const HEALTH_META: Record<ChannelHealth, { tone: Tone; icon: IconName }> = {
  operational: { tone: "success", icon: "check-circle" },
  degraded: { tone: "warning", icon: "alert" },
  outage: { tone: "danger", icon: "x-circle" },
  idle: { tone: "neutral", icon: "clock" },
  no_capacity: { tone: "warning", icon: "shield-alert" },
};

/** Severity order for summaries (worst first). */
export const HEALTH_ORDER: ChannelHealth[] = ["outage", "degraded", "no_capacity", "operational", "idle"];

/** Success-rate thresholds shared by the bars, the 24h figure and the legend. */
export function rateTone(rate: number | null): "good" | "warn" | "bad" | "none" {
  if (rate === null) return "none";
  if (rate >= 0.95) return "good";
  if (rate >= 0.5) return "warn";
  return "bad";
}

export const RATE_TEXT: Record<ReturnType<typeof rateTone>, string> = {
  good: "text-success",
  warn: "text-warning",
  bad: "text-danger",
  none: "text-fg-subtle",
};

export const RATE_BAR: Record<ReturnType<typeof rateTone>, string> = {
  good: "bg-success/75",
  warn: "bg-warning/80",
  bad: "bg-danger/80",
  none: "bg-surface-3 dark:bg-surface-3/70",
};

/** 99.4% / 100% / — */
export function formatRate(rate: number | null): string {
  if (rate === null) return "—";
  if (rate >= 1) return "100%";
  return `${(Math.floor(rate * 1000) / 10).toFixed(1)}%`;
}
