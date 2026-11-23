import type { Tone } from "../../../lib/format";

/** 0.0123 → "1.23%" (two decimals under 10%, one above). */
export function formatRate(rate: number | null | undefined): string {
  const pct = Math.max(0, (rate ?? 0) * 100);
  if (pct === 0) return "0%";
  if (pct < 0.01) return "<0.01%";
  return `${pct.toFixed(pct < 10 ? 2 : 1)}%`;
}

/** Error-rate tone: ≥5% danger, ≥1% warning; quiet when there was no traffic. */
export function errorRateTone(rate: number, requests = 1): Tone {
  if (requests === 0) return "neutral";
  if (rate >= 0.05) return "danger";
  if (rate >= 0.01) return "warning";
  return "success";
}

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-fg-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  violet: "text-violet",
};

export const TONE_BG: Record<Tone, string> = {
  neutral: "bg-fg-subtle",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  violet: "bg-violet",
};

/** HTTP status → tone: 2xx ok, 3xx info, 4xx warning (429 too), 5xx and transport failures danger. */
export function statusTone(code: number): Tone {
  if (code >= 200 && code < 300) return "success";
  if (code >= 300 && code < 400) return "info";
  if (code >= 400 && code < 500) return "warning";
  return "danger";
}

/** Row stagger delay, capped so long lists do not wait on the tail. */
export function staggerStyle(index: number, stepMs = 30, maxSteps = 10): { animationDelay: string } {
  return { animationDelay: `${Math.min(index, maxSteps) * stepMs}ms` };
}
