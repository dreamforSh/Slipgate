import { matchPricingRule, type ModelPricingRule, type UpsertModelPricingRule } from "@slipgate/contracts";

/**
 * Display and preview helpers for the model pricing page. Rule prices travel as nano-USD per
 * 1M tokens (integer strings); admins type USD per 1M tokens with up to 6 decimals.
 */

const NANO_PER_USD = 1_000_000_000n;
const MICROS = 1_000_000n;

/** Price per 1M tokens, nano-USD. */
export interface PriceSet {
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
}

/* ---------------- Patterns ---------------- */

/** Same shape UpsertModelPricingRuleSchema accepts. */
export const PATTERN_RE = /^[A-Za-z0-9._:/@-]+\*?$/;
export const PATTERN_MAX = 128;

export function isPrefixPattern(pattern: string): boolean {
  return pattern.endsWith("*");
}

/** "claude-opus-*" → "claude-opus-"; exact ids are returned unchanged. */
export function patternStem(pattern: string): string {
  return isPrefixPattern(pattern) ? pattern.slice(0, -1) : pattern;
}

export function sortRules(rules: ModelPricingRule[]): ModelPricingRule[] {
  return [...rules].sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** The rule that would win if every rule were enabled (drives "a disabled rule would win" hints). */
export function matchIgnoringEnabled(rules: readonly ModelPricingRule[], model: string): ModelPricingRule | null {
  return matchPricingRule(
    rules.map((r) => (r.enabled ? r : { ...r, enabled: true })),
    model,
  );
}

export { matchPricingRule };

/* ---------------- Money ---------------- */

/** Mirrors PerMillionUsdSchema: up to 9 integer and 6 fractional digits. */
const PRICE_RE = /^\d{1,9}(?:\.\d{1,6})?$/;
/** Mirrors PerUnitUsdSchema: up to 9 integer and 9 fractional digits. */
const UNIT_PRICE_RE = /^\d{1,9}(?:\.\d{1,9})?$/;

/** "$3" / " 0.25 " → "3" / "0.25"; null when the API would reject it. */
export function normalizePriceInput(text: string): string | null {
  const v = text.trim().replace(/^\$/, "");
  return PRICE_RE.test(v) ? v : null;
}

export function normalizeUnitPriceInput(text: string): string | null {
  const v = text.trim().replace(/^\$/, "");
  return UNIT_PRICE_RE.test(v) ? v : null;
}

/** Typed USD per 1M → nano-USD per 1M; null when invalid. */
export function parsePriceInput(text: string): bigint | null {
  const v = normalizePriceInput(text);
  if (v === null) return null;
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole) * NANO_PER_USD + BigInt(frac.padEnd(9, "0"));
}

/** Exact plain decimal for an input box ("15", "0.0375"). */
export function nanoToUsdText(nano: bigint): string {
  const whole = nano / NANO_PER_USD;
  const frac = (nano % NANO_PER_USD).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Same, rounded to the 6 decimals the API accepts. */
export function nanoToApiPrice(nano: bigint): string {
  return nanoToUsdText(((nano + 500n) / 1000n) * 1000n);
}

/** "$15.00" / "$0.075" / "$0.3375": exact, never fewer than 2 decimals. */
export function formatPerM(nano: bigint | string): string {
  const n = typeof nano === "bigint" ? nano : BigInt(nano || "0");
  const whole = (n / NANO_PER_USD).toLocaleString("en-US");
  let frac = (n % NANO_PER_USD).toString().padStart(9, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `$${whole}.${frac}`;
}

export const defaultCacheRead = (input: bigint): bigint => input / 10n;
export const defaultCacheWrite = (input: bigint): bigint => (input * 5n) / 4n;

export function rulePrices(rule: ModelPricingRule): PriceSet {
  return {
    input: BigInt(rule.inputNanoPerMTok),
    output: BigInt(rule.outputNanoPerMTok),
    cacheRead: BigInt(rule.cacheReadNanoPerMTok),
    cacheWrite: BigInt(rule.cacheWriteNanoPerMTok),
  };
}

/** Whether a rule's cache prices are the server-derived defaults (10% / 125% of input). */
export function cacheIsDefault(prices: PriceSet): { read: boolean; write: boolean } {
  return {
    read: prices.cacheRead === defaultCacheRead(prices.input),
    write: prices.cacheWrite === defaultCacheWrite(prices.input),
  };
}

/**
 * Full PUT body for an existing rule. Default-derived cache prices are left out so the server
 * keeps deriving them exactly from the input price; advanced multimodal & tiered fields are preserved.
 */
export function ruleToBody(rule: ModelPricingRule, patch: Partial<Pick<UpsertModelPricingRule, "enabled">> = {}): UpsertModelPricingRule {
  const p = rulePrices(rule);
  const d = cacheIsDefault(p);
  return {
    pattern: rule.pattern,
    inputPerMTokUsd: nanoToApiPrice(p.input),
    outputPerMTokUsd: nanoToApiPrice(p.output),
    ...(d.read ? {} : { cacheReadPerMTokUsd: nanoToApiPrice(p.cacheRead) }),
    ...(d.write ? {} : { cacheWritePerMTokUsd: nanoToApiPrice(p.cacheWrite) }),
    ...(rule.perRequestNanoUsd && rule.perRequestNanoUsd !== "0" ? { perRequestUsd: nanoToUsdText(BigInt(rule.perRequestNanoUsd)) } : {}),
    ...(rule.perImageNanoUsd && rule.perImageNanoUsd !== "0" ? { perImageUsd: nanoToUsdText(BigInt(rule.perImageNanoUsd)) } : {}),
    ...(rule.perVideoSecondNanoUsd && rule.perVideoSecondNanoUsd !== "0"
      ? { perVideoSecondUsd: nanoToUsdText(BigInt(rule.perVideoSecondNanoUsd)) }
      : {}),
    ...(rule.longContextThresholdTokens !== undefined ? { longContextThresholdTokens: rule.longContextThresholdTokens } : {}),
    ...(rule.longContextInputMultiplier !== undefined ? { longContextInputMultiplier: rule.longContextInputMultiplier } : {}),
    ...(rule.longContextOutputMultiplier !== undefined ? { longContextOutputMultiplier: rule.longContextOutputMultiplier } : {}),
    ...(rule.serviceTierFastMultiplier !== undefined ? { serviceTierFastMultiplier: rule.serviceTierFastMultiplier } : {}),
    ...(rule.serviceTierFlexMultiplier !== undefined ? { serviceTierFlexMultiplier: rule.serviceTierFlexMultiplier } : {}),
    ...(rule.reasoningEffortMultipliers !== undefined ? { reasoningEffortMultipliers: rule.reasoningEffortMultipliers } : {}),
    enabled: patch.enabled ?? rule.enabled,
    notes: rule.notes,
  };
}

/** Values a create dialog opens with (from the tester or the built-in reference). */
export interface RulePreset {
  pattern: string;
  input: string;
  output: string;
}

export function presetFromPrices(pattern: string, prices: PriceSet): RulePreset {
  return { pattern, input: nanoToUsdText(prices.input), output: nanoToUsdText(prices.output) };
}

/* ---------------- Group multiplier & cost ---------------- */

function multiplierMicros(multiplier: number): bigint {
  return BigInt(Math.max(1, Math.round((Number.isFinite(multiplier) ? multiplier : 1) * 1_000_000)));
}

/** Price per 1M after a group multiplier (truncated to whole nano-USD like the server). */
export function applyMultiplier(nanoPerM: bigint, multiplier: number): bigint {
  return (nanoPerM * multiplierMicros(multiplier)) / MICROS;
}

/** Mirrors the BFF's priceTurn for an input/output-only request: nano-USD charged. */
export function sampleCost(prices: Pick<PriceSet, "input" | "output">, inputTokens: number, outputTokens: number, multiplier: number): bigint {
  const base = BigInt(clampTokens(inputTokens)) * prices.input + BigInt(clampTokens(outputTokens)) * prices.output;
  return (base * multiplierMicros(multiplier)) / MICROS / MICROS;
}

/** Cost of one token class without the multiplier, nano-USD. */
export function partCost(nanoPerM: bigint, tokens: number): bigint {
  return (BigInt(clampTokens(tokens)) * nanoPerM) / MICROS;
}

export const TOKENS_MAX = 100_000_000;

export function clampTokens(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(TOKENS_MAX, Math.floor(n));
}

export function multiplierText(multiplier: number): string {
  return `${Number(multiplier.toFixed(4))}×`;
}

/* ---------------- Built-in fallback rates ---------------- */

export type BuiltinTierKey = "opus" | "claude" | "gpt4oMini" | "gpt" | "gemini" | "deepseek" | "other";

export interface BuiltinTier {
  key: BuiltinTierKey;
  /** Patterns shown in the reference table; `contains` tiers match anywhere in the id. */
  matchers: string[];
  contains: boolean;
  prices: PriceSet;
  /** Pattern suggested when an admin overrides this tier (null: no single pattern covers it). */
  suggestPattern: string | null;
}

function tier(key: BuiltinTierKey, matchers: string[], inUsd: number, outUsd: number, suggestPattern: string | null, contains = false): BuiltinTier {
  // Whole cents per 1M → nano: every built-in price is an exact multiple of $0.01.
  const input = BigInt(Math.round(inUsd * 100)) * 10_000_000n;
  const output = BigInt(Math.round(outUsd * 100)) * 10_000_000n;
  return {
    key,
    matchers,
    contains,
    prices: { input, output, cacheRead: defaultCacheRead(input), cacheWrite: defaultCacheWrite(input) },
    suggestPattern,
  };
}

/** Evaluated top to bottom; the first tier that matches wins (same order as the core). */
export const BUILTIN_TIERS: BuiltinTier[] = [
  tier("opus", ["opus"], 15, 75, "claude-opus-*", true),
  tier("claude", ["claude-*"], 3, 15, "claude-*"),
  tier("gpt4oMini", ["gpt-4o-mini*"], 0.15, 0.6, "gpt-4o-mini*"),
  tier("gpt", ["gpt-*", "codex-*"], 2.5, 10, "gpt-*"),
  tier("gemini", ["gemini-*"], 1.25, 10, "gemini-*"),
  tier("deepseek", ["deepseek-*"], 0.27, 1.1, "deepseek-*"),
  tier("other", [], 1, 4, null),
];

export function builtinTierFor(model: string): BuiltinTier {
  const m = model.trim();
  const pick = (key: BuiltinTierKey) => BUILTIN_TIERS.find((t) => t.key === key)!;
  if (m.includes("opus")) return pick("opus");
  if (m.startsWith("claude-")) return pick("claude");
  if (m.startsWith("gpt-4o-mini")) return pick("gpt4oMini");
  if (m.startsWith("gpt-") || m.startsWith("codex-")) return pick("gpt");
  if (m.startsWith("gemini-")) return pick("gemini");
  if (m.startsWith("deepseek-")) return pick("deepseek");
  return pick("other");
}

/** Models offered as one-click samples in the price tester. */
export const SAMPLE_MODELS = [
  "claude-opus-4-1",
  "claude-sonnet-4-5",
  "gpt-5",
  "gpt-4o-mini",
  "gemini-2.5-pro",
  "deepseek-chat",
];

/* ---------------- Motion ---------------- */

/** Rows/cards that rise in one after another (off under reduced motion). */
export const STAGGER_CLASS = "animate-slide-up [animation-fill-mode:both] motion-reduce:animate-none";

export function stagger(index: number, stepMs = 24, cap = 12): { animationDelay: string } {
  return { animationDelay: `${Math.min(index, cap) * stepMs}ms` };
}
