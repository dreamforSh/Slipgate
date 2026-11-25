import type { Provider } from "@slipgate/contracts";
import { enumLabel, i18n } from "../i18n";

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "violet";

/** Basis points (0–10000) → "37.5%". */
export function bpsToPercent(bps: number | undefined | null, digits = 1): string {
  return `${((bps ?? 0) / 100).toFixed(digits)}%`;
}

export function shortHash(value: string | null | undefined, len = 12): string {
  if (!value) return "-";
  return value.length > len ? value.slice(0, len) : value;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatUnixMs(ms: number | null | undefined): string {
  if (!ms) return "-";
  return formatDateTime(new Date(ms).toISOString());
}

export function formatNumber(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString("en-US");
}

export function healthTone(status: string | undefined): Tone {
  switch (status) {
    case "healthy":
    case "up":
    case "ok":
    case "ready":
    case "active":
    case "success":
    case "online":
      return "success";
    case "degraded":
    case "cooldown":
    case "cooldown_5h":
    case "cooldown_7d":
    case "draining":
    case "paused":
    case "provisioning":
    case "migrating":
      return "warning";
    case "circuit_open":
    case "down":
    case "error":
    case "failed":
    case "expired":
    case "auth_expired":
      return "danger";
    case "stopped":
    case "unknown":
    default:
      return "neutral";
  }
}

/* Backend enum → localized label (falls back to the raw value for unknown states). */
export const slotStateLabel = (state: string | null | undefined) => enumLabel("slotState", state);
export const accountStatusLabel = (status: string | null | undefined) => enumLabel("accountStatus", status);
export const healthLabel = (status: string | null | undefined) => enumLabel("health", status);
export const hostStatusLabel = (status: string | null | undefined) => enumLabel("hostStatus", status);
export const planeLabel = (status: string | null | undefined) => enumLabel("plane", status);
export const executionModeLabel = (mode: string | null | undefined) => enumLabel("executionMode", mode);

export const RUNTIME_PROFILE_TONE: Record<string, Tone> = {
  claude_code: "warning",
  codex_cli: "success",
  antigravity: "violet",
};

/** Upstream providers in display order (values must match ProviderSchema). Brand names are not translated. */
export const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: "anthropic", label: "Anthropic Claude" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "antigravity", label: "Google Antigravity" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "grok", label: "XPass" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "glm", label: "GLM" },
  { value: "kimi", label: "Kimi" },
  { value: "minimax", label: "MiniMax" },
  { value: "qwen", label: "Qwen" },
  { value: "bedrock", label: "AWS Bedrock" },
  { value: "vertex", label: "Vertex AI" },
  { value: "opencode_go", label: "OpenCode" },
  { value: "command_code", label: "Command Code" },
  { value: "cline", label: "Cline" },
  { value: "typesafe", label: "TypeSafe" },
];

/* ---------------- Dashboard number formatting ---------------- */

function activeLocale(): string {
  return i18n.global.locale.value;
}

/** 1,284 / 12.9K / 3.4M (zh: 1.3万) — for standalone figures and axis ticks. */
export function formatCompact(n: number | null | undefined): string {
  const v = n ?? 0;
  if (Math.abs(v) < 10_000) return v.toLocaleString(activeLocale(), { maximumFractionDigits: 1 });
  return new Intl.NumberFormat(activeLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

/**
 * Token counts in K / M / B whatever the UI language (12.3K, 4.5M): 万 / 亿 read oddly for token
 * volumes, and every model vendor quotes tokens this way. Exact digits below 1,000.
 */
export function formatTokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (Math.abs(v) < 1000) return Math.round(v).toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

/** nano-USD integer string → dollars as a float (display only, never for accounting). */
export function nanoToUsd(nano: string | null | undefined): number {
  if (!nano) return 0;
  return Number(BigInt(nano)) / 1e9;
}

/** $1,234.56 for larger amounts, more precision for sub-dollar values. */
export function formatUsd(nano: string | null | undefined): string {
  const usd = nanoToUsd(nano);
  const digits = usd === 0 ? 2 : usd < 0.01 ? 6 : usd < 1 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  }).format(usd);
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "3 分钟前" / "in 5 hours" — past or future, in the active locale. */
export function formatRelative(iso: string | null | undefined, nowMs: number = Date.now()): string {
  if (!iso) return "-";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "-";
  const diff = at - nowMs;
  const fmt = new Intl.RelativeTimeFormat(activeLocale(), { numeric: "auto" });
  for (const [unit, size] of RELATIVE_UNITS) {
    // Round, not truncate: a cooldown set for 5h a moment ago should still read "in 5 hours".
    if (Math.abs(diff) >= size) return fmt.format(Math.round(diff / size), unit);
  }
  return fmt.format(0, "second");
}

/** 2026-12-01 in local time. */
export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 1.2 MB / 842 KB — concise byte size formatting for release archives and download progress. */
export function formatBytes(bytes: number | null | undefined): string {
  const v = bytes ?? 0;
  if (!Number.isFinite(v) || v <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let idx = 0;
  let val = v;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return `${val >= 10 || idx === 0 ? val.toFixed(0) : val.toFixed(1)} ${units[idx]}`;
}

/** 850ms / 1.2s / 2m 05s */
export function formatDurationMs(ms: number | null | undefined): string {
  const v = Math.max(0, Math.round(ms ?? 0));
  if (v < 1000) return `${v}ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)}s`;
  const m = Math.floor(v / 60_000);
  const s = Math.round((v % 60_000) / 1000);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}
