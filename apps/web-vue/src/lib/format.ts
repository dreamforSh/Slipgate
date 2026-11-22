import type { Provider } from "@slipgate/contracts";

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

export const SLOT_STATE_LABEL: Record<string, string> = {
  provisioning: "部署中",
  ready: "就绪",
  cooldown_5h: "5h 冷却",
  cooldown_7d: "7d 冷却",
  draining: "排空中",
  stopped: "已停止",
  auth_expired: "凭据过期",
  migrating: "迁移中",
};

export const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  active: "活跃",
  paused: "已暂停",
  cooldown: "冷却中",
  expired: "已过期",
};

export const HEALTH_LABEL: Record<string, string> = {
  healthy: "健康",
  degraded: "降级",
  circuit_open: "熔断",
  unknown: "未探测",
};

export const PLANE_LABEL: Record<string, string> = {
  up: "运行中",
  down: "离线",
  unknown: "未知",
};

export const EXECUTION_MODE_LABEL: Record<string, string> = {
  stealth_http: "Stealth HTTP",
  vm_slot: "VM Slot",
  direct_api: "Direct API",
};

export const RUNTIME_PROFILE_TONE: Record<string, Tone> = {
  claude_code: "warning",
  codex_cli: "success",
  antigravity: "violet",
};

/** Upstream providers in display order (values must match ProviderSchema). */
export const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: "anthropic", label: "Anthropic · Claude Code" },
  { value: "codex", label: "Codex · Codex CLI Responses" },
  { value: "antigravity", label: "Antigravity · v1internal" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "grok", label: "Grok" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "glm", label: "GLM" },
  { value: "kimi", label: "Kimi" },
  { value: "minimax", label: "MiniMax" },
  { value: "qwen", label: "Qwen" },
];
