import type { Provider } from "@slipgate/contracts";
import { enumLabel } from "../i18n";

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
  { value: "grok", label: "Grok" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "glm", label: "GLM" },
  { value: "kimi", label: "Kimi" },
  { value: "minimax", label: "MiniMax" },
  { value: "qwen", label: "Qwen" },
];
