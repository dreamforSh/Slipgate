import type { AccountAuthKind, GroupPlatform, SubscriptionTier } from "@slipgate/contracts";
import type { IconName } from "../components/ui/icons";

/**
 * Per-platform color classes for account cards and platform badges. Every value is a full,
 * literal class string so Tailwind's scanner keeps it (never build these by concatenation).
 * `violet-*` shades are unavailable: the theme maps `violet` to a single token color.
 */
export interface PlatformStyle {
  /** Platform segment of the platform/type badge. */
  badge: string;
  /** Auth-type segment next to it (same hue, slightly lighter text). */
  type: string;
  /** Card border tint, plus a stronger tint on hover. */
  border: string;
  /** 4px accent bar across the top of a card. */
  bar: string;
  /** Text color of the selected platform in the add-account platform picker. */
  text: string;
}

const STYLES: Record<GroupPlatform, PlatformStyle> = {
  anthropic: {
    badge: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
    type: "bg-orange-50 text-orange-600 dark:bg-orange-900/20 dark:text-orange-400",
    border: "border-orange-500/20 hover:border-orange-500/40",
    bar: "bg-gradient-to-r from-orange-400 to-orange-500",
    text: "text-orange-600 dark:text-orange-400",
  },
  openai: {
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    type: "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400",
    border: "border-emerald-500/20 hover:border-emerald-500/40",
    bar: "bg-gradient-to-r from-emerald-400 to-emerald-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  codex: {
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    type: "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400",
    border: "border-emerald-500/20 hover:border-emerald-500/40",
    bar: "bg-gradient-to-r from-emerald-500 to-teal-500",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  gemini: {
    badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    type: "bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400",
    border: "border-blue-500/20 hover:border-blue-500/40",
    bar: "bg-gradient-to-r from-blue-400 to-blue-500",
    text: "text-blue-600 dark:text-blue-400",
  },
  antigravity: {
    badge: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
    type: "bg-purple-50 text-purple-600 dark:bg-purple-900/20 dark:text-purple-400",
    border: "border-purple-500/20 hover:border-purple-500/40",
    bar: "bg-gradient-to-r from-purple-400 to-purple-500",
    text: "text-purple-600 dark:text-purple-400",
  },
  grok: {
    badge: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    type: "bg-zinc-50 text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300",
    border: "border-zinc-800/20 hover:border-zinc-800/40 dark:border-zinc-500/20 dark:hover:border-zinc-500/40",
    bar: "bg-gradient-to-r from-zinc-700 to-zinc-900",
    text: "text-zinc-900 dark:text-zinc-100",
  },
  deepseek: {
    badge: "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400",
    type: "bg-teal-50 text-teal-600 dark:bg-teal-900/20 dark:text-teal-400",
    border: "border-teal-500/20 hover:border-teal-500/40",
    bar: "bg-gradient-to-r from-teal-400 to-teal-500",
    text: "text-teal-600 dark:text-teal-400",
  },
  glm: {
    badge: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
    type: "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400",
    border: "border-indigo-500/20 hover:border-indigo-500/40",
    bar: "bg-gradient-to-r from-indigo-400 to-indigo-500",
    text: "text-indigo-600 dark:text-indigo-400",
  },
  kimi: {
    badge: "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400",
    type: "bg-pink-50 text-pink-600 dark:bg-pink-900/20 dark:text-pink-400",
    border: "border-pink-500/20 hover:border-pink-500/40",
    bar: "bg-gradient-to-r from-pink-400 to-pink-500",
    text: "text-pink-600 dark:text-pink-400",
  },
  minimax: {
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
    type: "bg-rose-50 text-rose-600 dark:bg-rose-900/20 dark:text-rose-400",
    border: "border-rose-500/20 hover:border-rose-500/40",
    bar: "bg-gradient-to-r from-rose-400 to-rose-500",
    text: "text-rose-600 dark:text-rose-400",
  },
  qwen: {
    badge: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-400",
    type: "bg-sky-50 text-sky-600 dark:bg-sky-900/20 dark:text-sky-400",
    border: "border-sky-500/20 hover:border-sky-500/40",
    bar: "bg-gradient-to-r from-sky-400 to-indigo-500",
    text: "text-sky-600 dark:text-sky-400",
  },
  bedrock: {
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
    type: "bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-400",
    border: "border-amber-500/20 hover:border-amber-500/40",
    bar: "bg-gradient-to-r from-amber-400 to-amber-500",
    text: "text-amber-600 dark:text-amber-400",
  },
  vertex: {
    badge: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
    type: "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/20 dark:text-indigo-400",
    border: "border-indigo-500/20 hover:border-indigo-500/40",
    bar: "bg-gradient-to-r from-indigo-400 to-indigo-500",
    text: "text-indigo-600 dark:text-indigo-400",
  },
  opencode_go: {
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    type: "bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300",
    border: "border-amber-500/20 hover:border-amber-500/40",
    bar: "bg-gradient-to-r from-amber-400 to-amber-500",
    text: "text-amber-700 dark:text-amber-300",
  },
  command_code: {
    badge: "bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200",
    type: "bg-zinc-50 text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
    border: "border-zinc-500/20 hover:border-zinc-500/40",
    bar: "bg-gradient-to-r from-zinc-500 to-zinc-700",
    text: "text-zinc-700 dark:text-zinc-300",
  },
  cline: {
    badge: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
    type: "bg-purple-50 text-purple-600 dark:bg-purple-900/20 dark:text-purple-300",
    border: "border-purple-500/20 hover:border-purple-500/40",
    bar: "bg-gradient-to-r from-purple-400 to-fuchsia-500",
    text: "text-purple-600 dark:text-purple-300",
  },
  typesafe: {
    badge: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
    type: "bg-sky-50 text-sky-700 dark:bg-sky-900/20 dark:text-sky-300",
    border: "border-sky-500/20 hover:border-sky-500/40",
    bar: "bg-gradient-to-r from-sky-400 to-cyan-500",
    text: "text-sky-700 dark:text-sky-300",
  },
  composite: {
    badge: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
    type: "bg-cyan-50 text-cyan-600 dark:bg-cyan-900/20 dark:text-cyan-400",
    border: "border-cyan-500/20 hover:border-cyan-500/40",
    bar: "bg-gradient-to-r from-slate-500 to-cyan-500",
    text: "text-cyan-600 dark:text-cyan-400",
  },
};

const FALLBACK: PlatformStyle = {
  badge: "bg-surface-2 text-fg-muted",
  type: "bg-surface-2/60 text-fg-subtle",
  border: "",
  bar: "bg-gradient-to-r from-accent/70 to-accent",
  text: "text-accent",
};

export function platformStyle(platform: string): PlatformStyle {
  return Object.prototype.hasOwnProperty.call(STYLES, platform) ? STYLES[platform as GroupPlatform] : FALLBACK;
}

/** Compact badge names (the mark carries the brand); the full PROVIDER_OPTIONS label goes in the title. */
const SHORT_LABELS: Record<GroupPlatform, string> = {
  anthropic: "Claude",
  openai: "OpenAI",
  codex: "Codex",
  gemini: "Gemini",
  antigravity: "Antigravity",
  grok: "Grok",
  deepseek: "DeepSeek",
  glm: "GLM",
  kimi: "Kimi",
  minimax: "MiniMax",
  qwen: "Qwen",
  bedrock: "Bedrock",
  vertex: "Vertex AI",
  opencode_go: "OpenCode",
  command_code: "Command Code",
  cline: "Cline",
  typesafe: "TypeSafe",
  composite: "Composite",
};

export function platformShortLabel(platform: string): string {
  return Object.prototype.hasOwnProperty.call(SHORT_LABELS, platform) ? SHORT_LABELS[platform as GroupPlatform] : platform;
}

/** Short auth-type label and icon for the second badge segment. */
export const AUTH_KIND_BADGE: Record<AccountAuthKind, { label: string; icon: IconName }> = {
  oauth: { label: "OAuth", icon: "key" },
  setup_token: { label: "Token", icon: "shield" },
  api_key: { label: "Key", icon: "key" },
  vm_cli_seed: { label: "CLI", icon: "terminal" },
};

/**
 * Plan badge for subscription tiers; `null` for `standard` (API keys and accounts whose plan
 * is unknown show no plan row). The multiplier is spelled out wherever the name hides it.
 */
export function planBadge(tier: SubscriptionTier, multiplier: number, platform: string): { label: string; class: string } | null {
  switch (tier) {
    case "plus":
      return { label: "Plus", class: "bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300" };
    case "pro":
      return {
        label: multiplier > 1 ? `Pro ${multiplier}x` : "Pro",
        class: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300",
      };
    case "pro_5x":
      return { label: "Pro 5x", class: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300" };
    case "pro_10x":
      return { label: "Pro 10x", class: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300" };
    case "pro_25x":
      return { label: "Pro 25x", class: "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300" };
    case "max":
      return { label: `Max ${multiplier}x`, class: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" };
    case "ultra":
      return {
        label: `Ultra ${multiplier}x`,
        class:
          platform === "anthropic"
            ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300"
            : "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-900/30 dark:text-fuchsia-300",
      };
    default:
      return null;
  }
}
