import { createHash } from "node:crypto";
import type {
  ChannelHealth,
  ChannelStatusItem,
  ChannelStatusResponse,
  DashboardRange,
  DataPlaneSyncSnapshot,
  GroupItem,
  ModelPlazaResponse,
  ModelPrice,
  ModelPricingRule,
  OpsOverview,
  OpsRange,
  PlazaModel,
  Provider,
  StoredCompositeRoute,
  UpstreamAccount,
  UsageLogItem,
  UsageRow,
} from "@slipgate/contracts";
import { matchPricingRule } from "@slipgate/contracts";
import type { SubscriptionEntitlement, UserAccessRecord } from "./store/ops_types.ts";
import {
  emptyChannelBucket,
  finalizeScopedUsage,
  OPS_RECENT_ERRORS,
  reduceScopedUsage,
  type ChannelStatusAggregate,
  type ChannelStatusQuery,
  type OpsUsageAggregate,
  type OpsUsageQuery,
  type ScopedUsage,
} from "./store/usage_aggregates.ts";

export type { ScopedUsage } from "./store/usage_aggregates.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/* ------------------------------------------------------------------------------------------ */
/* Provider detection & pricing (mirrors services/core-zig/src/engine/gateway.zig)            */
/* ------------------------------------------------------------------------------------------ */

export function detectBuiltinProvider(model: string): Provider | null {
  if (model.startsWith("antigravity/") || model.startsWith("ag-")) return "antigravity";
  if (
    model.startsWith("codex-") ||
    model.startsWith("codex/") ||
    model.startsWith("gpt-5-codex") ||
    model.startsWith("o3-codex") ||
    model.startsWith("o4-mini-codex")
  ) {
    return "codex";
  }
  if (model.startsWith("claude-") || model.startsWith("anthropic/")) return "anthropic";
  if (
    model.startsWith("gemini-") ||
    model.startsWith("google/") ||
    model.startsWith("imagen-") ||
    model.startsWith("veo-") ||
    model.startsWith("text-embedding-004")
  ) {
    return "gemini";
  }
  if (
    model.startsWith("gpt-") ||
    model.startsWith("chatgpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("text-embedding-") ||
    model.startsWith("dall-e-") ||
    model.startsWith("sora-") ||
    model.startsWith("omni-moderation-") ||
    model.startsWith("openai/")
  ) {
    return "openai";
  }
  if (model.startsWith("grok-") || model.startsWith("xai/")) return "grok";
  if (model.startsWith("deepseek-")) return "deepseek";
  if (
    model.startsWith("glm-") ||
    model.startsWith("cogview-") ||
    model.startsWith("cogvideox-") ||
    model.startsWith("embedding-3")
  ) {
    return "glm";
  }
  if (model.startsWith("kimi-") || model.startsWith("moonshot-")) return "kimi";
  if (model.toLowerCase().startsWith("minimax-") || model.startsWith("abab")) return "minimax";
  if (model.startsWith("qwen-") || model.startsWith("wanx-")) return "qwen";
  if (
    model.startsWith("bedrock/") ||
    model.startsWith("anthropic.claude") ||
    model.startsWith("amazon.nova") ||
    model.startsWith("amazon.titan")
  ) {
    return "bedrock";
  }
  if (model.startsWith("vertex/") || model.startsWith("vertex_ai/")) return "vertex";
  if (model.startsWith("jev-") || model.startsWith("typesafe/")) return "typesafe";
  if (
    model.startsWith("opencode_go/") ||
    model.startsWith("opencode-go/") ||
    model.startsWith("opencode/") ||
    model.startsWith("longcat-") ||
    model.startsWith("mimo-") ||
    model.startsWith("muse-spark-") ||
    model === "hy3" ||
    model.startsWith("hy4-") ||
    model.startsWith("omen-")
  ) {
    return "opencode_go";
  }
  if (model.startsWith("command_code/") || model.startsWith("command-code/")) return "command_code";
  if (model.startsWith("cline/") || model.startsWith("cline-pass/") || model.startsWith("cline-free/")) return "cline";
  return null;
}

/** `builtin_model_candidates` in gateway.zig: what /v1/models lists without an allowlist. */
export const BUILTIN_MODEL_CANDIDATES: readonly string[] = [
  "claude-fable-5-2",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-opus-4-5",
  "claude-haiku-4-5",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-codex",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4o-mini",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "antigravity/claude-sonnet-4-5",
  "grok-4",
  "deepseek-chat",
  "deepseek-reasoner",
  "glm-4.6",
  "kimi-k2",
  "MiniMax-M2",
  "qwen-max",
  "opencode_go/glm-5.3",
  "jev-latest",
  "command_code/deepseek/deepseek-v4-flash",
  "cline-pass/glm-5.3-flash",
];

/**
 * Base rates the core settles with (`lookupModelRate` in gateway.zig), before the group
 * multiplier. Cache reads bill at 1/10 and cache writes at 5/4 of the input rate.
 */
export function modelPrice(model: string, rules: readonly ModelPricingRule[] = []): ModelPrice {
  const rule = matchPricingRule(rules, model);
  if (rule) {
    // Rules are nano-USD per 1M tokens; the plaza reports nano-USD per token.
    return {
      inputNanoPerToken: Number(rule.inputNanoPerMTok) / 1e6,
      outputNanoPerToken: Number(rule.outputNanoPerMTok) / 1e6,
      cacheReadNanoPerToken: Number(rule.cacheReadNanoPerMTok) / 1e6,
      cacheWriteNanoPerToken: Number(rule.cacheWriteNanoPerMTok) / 1e6,
    };
  }
  let input = 1_000;
  let output = 4_000;
  if (model.includes("opus")) [input, output] = [15_000, 75_000];
  else if (model.startsWith("claude-")) [input, output] = [3_000, 15_000];
  else if (model.startsWith("gpt-4o-mini")) [input, output] = [150, 600];
  else if (model.startsWith("gpt-") || model.startsWith("codex-")) [input, output] = [2_500, 10_000];
  else if (model.startsWith("gemini-")) [input, output] = [1_250, 10_000];
  else if (model.startsWith("deepseek-")) [input, output] = [270, 1_100];
  return {
    inputNanoPerToken: input,
    outputNanoPerToken: output,
    cacheReadNanoPerToken: input / 10,
    cacheWriteNanoPerToken: (input * 5) / 4,
  };
}

function providerServes(provider: string, groupPlatform: string, activeProviders: Set<string>): boolean {
  if (groupPlatform !== "composite") {
    return provider === groupPlatform || (groupPlatform === "codex" && provider === "openai");
  }
  return activeProviders.has(provider) || (provider === "openai" && activeProviders.has("codex"));
}

/** Public model catalogue: enabled, non-exclusive groups with the models each one answers. */
export function buildModelPlaza(
  groups: GroupItem[],
  routes: StoredCompositeRoute[],
  accounts: UpstreamAccount[],
  nowMs = Date.now(),
  rules: readonly ModelPricingRule[] = [],
  /** Exclusive groups the viewer may use (all for admins); public plaza passes none. */
  visibleExclusive: ReadonlySet<string> | "all" = new Set(),
  /** SWR-discovered upstream model IDs per provider from slipgate-net. */
  discoveredModels: Record<string, readonly string[]> = {},
): ModelPlazaResponse {
  const out: ModelPlazaResponse["groups"] = [];
  for (const g of groups) {
    if (!g.enabled) continue;
    if (g.isExclusive && visibleExclusive !== "all" && !visibleExclusive.has(g.id)) continue;
    const groupAccounts = accounts.filter((a) => a.groupId === g.id);
    const active = groupAccounts.filter((a) => a.effectiveStatus === "active");
    const activeProviders = new Set(active.map((a) => a.platform as string));
    const models = new Map<string, PlazaModel>();
    const add = (id: string, provider: string, source: PlazaModel["source"]) => {
      if (!models.has(id)) models.set(id, { id, provider, source, price: modelPrice(id, rules) });
    };
    if (g.modelAllowlist.length > 0) {
      for (const m of g.modelAllowlist) add(m, detectBuiltinProvider(m) ?? g.platform, "allowlist");
    } else {
      for (const r of routes) {
        if (r.groupId === g.id && r.enabled && r.matchType === "exact") add(r.publicModel, r.targetPlatform, "route");
      }
      for (const m of BUILTIN_MODEL_CANDIDATES) {
        const provider = detectBuiltinProvider(m);
        if (provider && providerServes(provider, g.platform, activeProviders)) add(m, provider, "builtin");
      }
      for (const [provider, ids] of Object.entries(discoveredModels)) {
        if (!providerServes(provider, g.platform, activeProviders)) continue;
        for (const id of ids) {
          if (id) add(id, provider, "discovered");
        }
      }
    }
    out.push({
      id: g.id,
      name: g.name,
      description: g.description,
      platform: g.platform,
      billing: g.subscriptionType,
      rateMultiplier: g.rateMultiplier,
      activeAccounts: active.length,
      models: [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)),
    });
  }
  return { generatedAtIso: new Date(nowMs).toISOString(), groups: out };
}

/* ------------------------------------------------------------------------------------------ */
/* Data-plane entitlements                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Turns off API keys that must not serve: suspended or deleted owners, exclusive groups the
 * owner was not granted, subscription groups without a usable (active, under-cap)
 * subscription, and keys at their own quota or rolling-window spend cap. The data plane is fail-closed on `enabled`, so this is the enforcement point.
 */
export function applyEntitlements(
  snapshot: DataPlaneSyncSnapshot,
  access: UserAccessRecord[],
  entitlements: SubscriptionEntitlement[],
  groups: Pick<GroupItem, "id" | "isExclusive" | "subscriptionType">[],
  overLimitKeyIds: ReadonlySet<string> = new Set(),
): DataPlaneSyncSnapshot {
  const users = new Map(access.map((u) => [u.id, u]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const usable = new Set(entitlements.filter((e) => e.usable).map((e) => `${e.userId}\u0000${e.groupId}`));
  return {
    ...snapshot,
    apiKeys: snapshot.apiKeys.map((k) => {
      if (!k.enabled) return k;
      const owner = users.get(k.userId);
      const group = groupById.get(k.groupId);
      let allowed = Boolean(owner && owner.status === "active") && !overLimitKeyIds.has(k.id);
      if (allowed && group?.isExclusive && owner!.role !== "admin") {
        allowed = owner!.allowedGroupIds.includes(k.groupId);
      }
      if (allowed && group?.subscriptionType === "subscription") {
        allowed = usable.has(`${k.userId}\u0000${k.groupId}`);
      }
      return allowed ? k : { ...k, enabled: false };
    }),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Scoped usage (user dashboard, key lookup)                                                  */
/* ------------------------------------------------------------------------------------------ */

/**
 * Totals, series and breakdowns of already-fetched rows. The routes ask the store instead
 * (`ops.scopedUsage` + `finalizeScopedUsage`), which aggregates in SQL; this is the same
 * computation over an in-memory list.
 */
export function buildScopedUsage(range: DashboardRange, nowMs: number, tzOffsetMinutes: number, logs: UsageLogItem[]): ScopedUsage {
  const q = { range, nowMs, tzOffsetMinutes };
  return finalizeScopedUsage(q, reduceScopedUsage(q, logs));
}

/* ------------------------------------------------------------------------------------------ */
/* Channel status page                                                                        */
/* ------------------------------------------------------------------------------------------ */

export const STATUS_BUCKET_MINUTES = 30;
export const STATUS_WINDOW_MS = DAY_MS;
/** Below this many requests a bucket or window is too thin to call degraded/outage. */
const MIN_SAMPLE = 5;

function healthOf(requests: number, errors: number, activeAccounts: number): ChannelHealth {
  if (activeAccounts === 0) return "no_capacity";
  if (requests === 0) return "idle";
  const rate = 1 - errors / requests;
  if (requests >= MIN_SAMPLE && rate < 0.5) return "outage";
  if (requests >= MIN_SAMPLE && rate < 0.95) return "degraded";
  return "operational";
}

/** Groups the public status page lists. */
export function statusPageGroups(groups: GroupItem[]): GroupItem[] {
  return groups.filter((g) => g.enabled && !g.isExclusive);
}

/** The 24h window (whole 30-minute buckets ending after `nowMs`) the status page aggregates. */
export function channelStatusQuery(groups: GroupItem[], nowMs = Date.now()): ChannelStatusQuery {
  const bucketMs = STATUS_BUCKET_MINUTES * MINUTE_MS;
  const count = STATUS_WINDOW_MS / bucketMs;
  const endMs = Math.floor(nowMs / bucketMs) * bucketMs + bucketMs;
  return { groupIds: statusPageGroups(groups).map((g) => g.id), startMs: endMs - count * bucketMs, endMs, bucketMs };
}

/** Passive health from real traffic over the last 24h, bucketed every 30 minutes. */
export function buildChannelStatus(
  groups: GroupItem[],
  accounts: UpstreamAccount[],
  usage: ChannelStatusAggregate,
  nowMs = Date.now(),
): ChannelStatusResponse {
  const { startMs: start, bucketMs } = channelStatusQuery(groups, nowMs);
  const count = STATUS_WINDOW_MS / bucketMs;
  const visible = statusPageGroups(groups);
  const channels: ChannelStatusItem[] = visible.map((g) => {
    const byBucket = usage.get(g.id);
    const slot = {
      buckets: Array.from({ length: count }, (_, bi) => byBucket?.get(bi) ?? emptyChannelBucket()),
      durSum: 0,
      durN: 0,
      last: 0,
    };
    for (const b of slot.buckets) {
      slot.durSum += b.durationSum;
      slot.durN += b.durationCount;
      if (b.lastMs > slot.last) slot.last = b.lastMs;
    }
    const groupAccounts = accounts.filter((a) => a.groupId === g.id);
    const activeAccounts = groupAccounts.filter((a) => a.effectiveStatus === "active").length;
    let requests = 0;
    let errors = 0;
    let ttftSum = 0;
    let ttftN = 0;
    for (const b of slot.buckets) {
      requests += b.requests;
      errors += b.errors;
      ttftSum += b.ttftSum;
      ttftN += b.ttftCount;
    }
    // Recent health weighs the last two hours; the 24h rate is reported alongside.
    const recent = slot.buckets.slice(-4);
    const recentReq = recent.reduce((s, b) => s + b.requests, 0);
    const recentErr = recent.reduce((s, b) => s + b.errors, 0);
    return {
      groupId: g.id,
      name: g.name,
      platform: g.platform,
      health: healthOf(recentReq || requests, recentReq ? recentErr : errors, activeAccounts),
      activeAccounts,
      totalAccounts: groupAccounts.length,
      requests24h: requests,
      successRate24h: requests ? 1 - errors / requests : null,
      avgTtftMs24h: ttftN ? Math.round(ttftSum / ttftN) : 0,
      avgDurationMs24h: slot.durN ? Math.round(slot.durSum / slot.durN) : 0,
      lastRequestAtIso: slot.last ? new Date(slot.last).toISOString() : null,
      buckets: slot.buckets.map((b, bi) => ({
        startIso: new Date(start + bi * bucketMs).toISOString(),
        requests: b.requests,
        errors: b.errors,
        successRate: b.requests ? 1 - b.errors / b.requests : null,
        avgTtftMs: b.ttftCount ? Math.round(b.ttftSum / b.ttftCount) : 0,
      })),
    };
  });
  const rank: Record<ChannelHealth, number> = { outage: 4, degraded: 3, no_capacity: 2, operational: 1, idle: 0 };
  const worst = channels.reduce<ChannelHealth>((w, c) => (rank[c.health] > rank[w] ? c.health : w), "idle");
  return {
    generatedAtIso: new Date(nowMs).toISOString(),
    bucketMinutes: STATUS_BUCKET_MINUTES,
    overall: worst,
    channels,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* CSV and audit helpers                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** RFC 4180 field, with spreadsheet formula injection neutralised. */
export function csvField(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvField).join(",")];
  for (const row of rows) lines.push(row.map(csvField).join(","));
  // BOM so Excel reads UTF-8.
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function nanoToUsdString(nano: string | bigint): string {
  const n = typeof nano === "bigint" ? nano : BigInt(nano);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function usageCsv(rows: UsageRow[]): string {
  return toCsv(
    [
      "time",
      "request_id",
      "user",
      "api_key",
      "group",
      "account",
      "model",
      "upstream_model",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cost_usd",
      "ttft_ms",
      "duration_ms",
      "status",
    ],
    rows.map((r) => [
      r.createdAtIso,
      r.requestId,
      r.userEmail || r.userId,
      r.apiKeyName || r.apiKeyId,
      r.groupName || r.groupId,
      r.accountName || r.accountId,
      r.publicModel,
      r.upstreamModel,
      r.inputTokens,
      r.outputTokens,
      r.cacheReadTokens,
      r.cacheWriteTokens,
      nanoToUsdString(r.costNanoUsd),
      r.ttftMs,
      r.durationMs,
      r.statusCode,
    ]),
  );
}

/**
 * Field names whose values never reach the audit log, tested on the lower-cased name with
 * separators removed (apiKey, api_key, API-Key and x-api-key all read "apikey"): passwords,
 * secrets, tokens, credentials, private keys, cookies and seeds, plus every name ending in
 * "key"/"keys" (the EasyPay merchant `key`, customKey, sshKey…), "pem" (sshKeyPem), signatures,
 * one-time codes and mnemonics.
 */
const SECRET_NAME = /pass|secret|token|credential|apikey|private|auth|cookie|seed|signature|mnemonic|totp|^otp|otp(?:code)?$|codeinput|verifier|pem$|keys?$/;

/**
 * Credentials recognisable by their shape wherever they appear, e.g. in free-text or URL fields.
 * No pattern can rescan a long run of text from many start positions (repetitions that could are
 * bounded, the JWT one only starts at the beginning of a token run), so each runs in linear time
 * on any input: an unbounded `[a-z0-9+.-]*` scheme or `[^=&#;\s]*` parameter name took seconds on
 * a few dozen KB of "a.a.a…" or "?a?a…".
 */
const SECRET_VALUE_PATTERNS: readonly [RegExp, string][] = [
  // PEM private keys (SSH, TLS): everything from the header on.
  [/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*/g, "[redacted]"],
  // user:password@ (or token@) in URLs: proxies, DSNs, subscription links.
  [/(\b[a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#@]+@/gi, "$1[redacted]@"],
  // ?token=… / &key=… / &sig=… query parameters.
  [/([?&#;][^=&#;?\s]{0,64}(?:token|key|secret|pass|auth|sig|credential)[^=&#;?\s]{0,64}=)[^&#;\s]+/gi, "$1[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  // JWTs and well-known API key shapes (sk-/sk_/rk_/whsec_, GitHub, GitLab, Slack, AWS, Google).
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted]"],
  [/\b(?:sk|rk|whsec|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{12,}/g, "[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[redacted]"],
];
const AUDIT_BODY_LIMIT = 4096;

function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

function scrubSecretValues(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_VALUE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Secret-named fields replaced at any depth and `scrub` applied to every other string. With `cut`,
 * nesting past 6 levels and arrays past 20 items are elided too (stored bodies are walked again
 * without it, so a second pass changes nothing but what the current rules hide).
 */
function redactTree(value: unknown, depth: number, cut: boolean, scrub: (s: string) => string): unknown {
  if (cut && depth > 6) return "[…]";
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) {
    if (!cut) return value.map((v) => redactTree(v, depth + 1, cut, scrub));
    const head = value.slice(0, 20).map((v) => redactTree(v, depth + 1, cut, scrub));
    return value.length > 20 ? [...head, `[+${value.length - 20} more]`] : head;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretName(k) && v !== null && v !== "" && typeof v !== "boolean" ? "[redacted]" : redactTree(v, depth + 1, cut, scrub);
    }
    return out;
  }
  return value;
}

/**
 * JSON body for the audit log: secret fields replaced at any depth, credential-shaped text
 * scrubbed from every other string, long strings cut and the size capped.
 */
export function redactAuditBody(text: string): string {
  if (!text.trim()) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `[non-JSON body, ${text.length} bytes]`;
  }
  // The JSON text is at least as long as the string values written before any point in it, so
  // once those pass the stored prefix, later strings can never show: they are not scrubbed at all
  // (bounds the work on a large body to what is kept).
  let remaining = AUDIT_BODY_LIMIT;
  const json = JSON.stringify(
    redactTree(parsed, 0, true, (value) => {
      if (remaining < 0) return "…";
      const clean = scrubSecretValues(value);
      const shown = clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
      remaining -= shown.length;
      return shown;
    }),
  );
  return json.length > AUDIT_BODY_LIMIT ? `${json.slice(0, AUDIT_BODY_LIMIT)}…` : json;
}

/**
 * `password=…`, `token: …`, `api_key="…"` in free log text (the audit body is JSON, so its fields
 * are matched by name instead). Bounded name parts keep it linear on any input.
 */
const SECRET_ASSIGNMENT =
  /\b([A-Za-z_-]{0,32}(?:pass(?:word|wd|phrase)|secret|token(?!s)|api[_-]?key|credential|authorization|cookie)[A-Za-z_-]{0,32}\s{0,4}[=:]\s{0,4})(["']?)[^\s"',;&]{1,4096}/gi;

/** System-log message text with credential-shaped values scrubbed (the audit-log rules plus `name=value` secrets). */
export function redactLogText(text: string): string {
  return scrubSecretValues(text).replace(SECRET_ASSIGNMENT, "$1$2[redacted]");
}

/**
 * System-log structured context with the audit-log redaction: secret-named fields replaced at any
 * depth, credential-shaped text scrubbed from every other string (cut at 4 KB, enough for a stack
 * trace), nesting past 6 levels and arrays past 20 items elided.
 */
export function redactLogContext(context: Record<string, unknown>): Record<string, unknown> {
  const out = redactTree(context, 0, true, (value) => {
    const clean = scrubSecretValues(value);
    return clean.length > 4096 ? `${clean.slice(0, 4096)}…` : clean;
  });
  return out && typeof out === "object" && !Array.isArray(out) ? (out as Record<string, unknown>) : {};
}

/** Index just past the JSON number, object or array starting at `start` (the text end if cut). */
function skipJsonValue(text: string, start: number): number {
  let i = start;
  if (text[i] !== "{" && text[i] !== "[") {
    while (i < text.length && /[-+.0-9eE]/.test(text[i]!)) i++;
    return i;
  }
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/**
 * Redaction over JSON text that the size cap cut mid-way (it no longer parses): every string token
 * is scrubbed and the value of a secret-named key replaced, however far the text got. The rest of
 * the text is kept byte for byte.
 */
function redactJsonPrefix(text: string): string {
  let out = "";
  const objects: boolean[] = []; // open containers, true for an object
  let expectKey = false;
  let secretValue = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const closed = j < text.length;
      const inner = text.slice(i + 1, Math.min(j, text.length));
      const quote = closed ? '"' : "";
      i = closed ? j + 1 : text.length;
      if (expectKey) {
        let name = inner;
        try {
          name = JSON.parse(`"${inner}"`) as string;
        } catch {
          // a key cut by the cap: match on its raw text
        }
        secretValue = isSecretName(name);
        expectKey = false;
        out += `"${inner}${quote}`;
      } else if (secretValue && inner !== "") {
        out += closed ? '"[redacted]"' : '"[redacted]…';
        secretValue = false;
      } else {
        out += `"${scrubSecretValues(inner)}${quote}`;
        secretValue = false;
      }
      continue;
    }
    if (secretValue && (ch === "{" || ch === "[" || ch === "-" || (ch >= "0" && ch <= "9"))) {
      i = skipJsonValue(text, i);
      out += '"[redacted]"';
      secretValue = false;
      continue;
    }
    if (ch === "{" || ch === "[") {
      objects.push(ch === "{");
      expectKey = ch === "{";
    } else if (ch === "}" || ch === "]") {
      objects.pop();
      expectKey = false;
    } else if (ch === ",") {
      expectKey = objects[objects.length - 1] === true;
    } else if (ch !== ":" && !/\s/.test(ch)) {
      secretValue = false; // true / false / null stay, as in redactAuditBody
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * The current redaction applied again to an audit body an older build stored: already redacted
 * by older rules, strings and arrays already cut, possibly truncated mid-JSON by the size cap.
 * Returns the text unchanged when nothing in it needs hiding, and is idempotent.
 */
export function reRedactStoredAuditBody(stored: string): string {
  if (!stored.trim() || stored.startsWith("[non-JSON body")) return stored;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return redactJsonPrefix(stored);
  }
  return JSON.stringify(redactTree(parsed, 0, false, scrubSecretValues));
}

/**
 * Small fixed-window limiter for unauthenticated endpoints (per key, in-process). Keys can carry
 * client-chosen text (addresses, emails), so the map is bounded: every window has the same length, so
 * keeping each key at the tail of the Map from the start of its current window orders entries by
 * expiry. Expired entries are dropped from the head (amortised O(1) per call, never a full walk)
 * and, at `maxKeys` live entries, the one closest to expiring is evicted. A key longer than
 * MAX_KEY_CHARS is stored as its SHA-256, so an entry costs a bounded amount of memory however
 * long the client-supplied text in it (a header can carry ~16 KB).
 */
export class WindowLimiter {
  static readonly MAX_KEY_CHARS = 128;
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /**
   * The map key for `key`: itself when short, else a NUL-prefixed digest (keys built from
   * addresses, ids and emails never contain NUL, so a digest cannot collide with one of them).
   */
  private static slot(key: string): string {
    if (key.length <= WindowLimiter.MAX_KEY_CHARS) return key;
    return `\u0000${createHash("sha256").update(key).digest("base64url")}`;
  }

  allow(rawKey: string, nowMs = Date.now()): boolean {
    const key = WindowLimiter.slot(rawKey);
    for (const [k, v] of this.hits) {
      if (v.resetAt > nowMs) break;
      this.hits.delete(k);
    }
    const entry = this.hits.get(key);
    if (entry && entry.resetAt > nowMs) {
      entry.count += 1;
      return entry.count <= this.limit;
    }
    if (entry) this.hits.delete(key);
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (oldest.done) break;
      this.hits.delete(oldest.value);
    }
    this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
    return true;
  }

  /** Keys currently tracked. */
  get size(): number {
    return this.hits.size;
  }
}

/** Memoises an async producer for `ttlMs`, sharing one in-flight promise between callers. */
export function cached<T>(ttlMs: number, produce: () => Promise<T>): () => Promise<T> {
  let value: { at: number; data: T } | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    const now = Date.now();
    if (value && now - value.at < ttlMs) return Promise.resolve(value.data);
    inflight ??= produce()
      .then((data) => {
        value = { at: Date.now(), data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/**
 * `cached()` per key: a value is reused for `ttlMs`, concurrent misses of one key share a single
 * load, and a failed load is not kept. At most `maxKeys` values are held: every value lives
 * equally long, so the Map's insertion order is expiry order; expired values are dropped from
 * the head and, when full, the one closest to expiring goes first.
 */
export class KeyedCache<T> {
  private readonly values = new Map<string, { at: number; data: T }>();
  private readonly inflight = new Map<string, Promise<T>>();
  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** The fresh value, or the load already running, for `key`; undefined on a miss. */
  peek(key: string, nowMs = Date.now()): Promise<T> | undefined {
    for (const [k, v] of this.values) {
      if (nowMs - v.at < this.ttlMs) break;
      this.values.delete(k);
    }
    const hit = this.values.get(key);
    if (hit) return Promise.resolve(hit.data);
    return this.inflight.get(key);
  }

  /** `peek()`, else runs `produce` for `key` (callers arriving meanwhile share it). */
  get(key: string, produce: () => Promise<T>, nowMs = Date.now()): Promise<T> {
    const known = this.peek(key, nowMs);
    if (known) return known;
    const load = produce()
      .then((data) => {
        this.values.delete(key);
        while (this.values.size >= this.maxKeys) {
          const oldest = this.values.keys().next();
          if (oldest.done) break;
          this.values.delete(oldest.value);
        }
        this.values.set(key, { at: Date.now(), data });
        return data;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, load);
    return load;
  }

  /** Values currently held (expired ones may linger until the next lookup). */
  get size(): number {
    return this.values.size;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Ops monitoring                                                                             */
/* ------------------------------------------------------------------------------------------ */

export const OPS_RANGE_MS: Record<OpsRange, number> = { "1h": HOUR_MS, "6h": 6 * HOUR_MS, "24h": DAY_MS };
const OPS_BUCKET_MINUTES: Record<OpsRange, number> = { "1h": 1, "6h": 5, "24h": 30 };

/** The window and series buckets `ops.opsUsage` aggregates for one overview range. */
export function opsUsageQuery(range: OpsRange, nowMs: number): OpsUsageQuery {
  const span = OPS_RANGE_MS[range];
  const bucketMs = OPS_BUCKET_MINUTES[range] * MINUTE_MS;
  const bucketCount = Math.round(span / bucketMs);
  const end = Math.floor(nowMs / bucketMs) * bucketMs + bucketMs;
  return { sinceMs: nowMs - span, nowMs, bucketStartMs: end - bucketCount * bucketMs, bucketMs, bucketCount };
}

export interface OpsInputs {
  range: OpsRange;
  nowMs: number;
  /** Exact aggregates of every row in the window (`ops.opsUsage(opsUsageQuery(range, nowMs))`). */
  usage: OpsUsageAggregate;
  accounts: UpstreamAccount[];
}

const byKey = <T>(key: (row: T) => string | number) => (a: T, b: T) => {
  const x = key(a);
  const y = key(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Latency, error and throughput picture of the last hour(s), from settled turns. */
export function buildOpsOverview(input: OpsInputs): OpsOverview {
  const q = opsUsageQuery(input.range, input.nowMs);
  const { usage } = input;
  const t = usage.totals;
  const accountById = new Map(input.accounts.map((a) => [a.id, a]));
  const minutes = OPS_RANGE_MS[input.range] / MINUTE_MS;
  const status = (s: string) => input.accounts.filter((a) => a.effectiveStatus === s).length;
  const tieAccount = byKey<{ accountId: string }>((r) => r.accountId);
  const tieModel = byKey<{ model: string }>((r) => r.model);
  const tieCode = byKey<{ code: number }>((r) => r.code);
  return {
    generatedAtIso: new Date(input.nowMs).toISOString(),
    range: input.range,
    bucketMinutes: OPS_BUCKET_MINUTES[input.range],
    // Every row of the window is aggregated (in SQL on Postgres); nothing is sampled any more.
    truncated: false,
    totals: {
      requests: t.requests,
      errors: t.errors,
      errorRate: t.requests ? t.errors / t.requests : 0,
      rpm: t.lastMinuteRequests || Math.round((t.requests / minutes) * 10) / 10,
      tpm: t.lastMinuteTokens || Math.round((t.inputTokens + t.outputTokens) / minutes),
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      costNanoUsd: t.costNano.toString(),
      ttftP50: t.ttftP50,
      ttftP95: t.ttftP95,
      durationP50: t.durationP50,
      durationP95: t.durationP95,
      durationP99: t.durationP99,
    },
    series: Array.from({ length: q.bucketCount }, (_, i) => {
      const b = usage.buckets.get(i);
      return {
        startIso: new Date(q.bucketStartMs + i * q.bucketMs).toISOString(),
        requests: b?.requests ?? 0,
        errors: b?.errors ?? 0,
        tokens: b ? b.inputTokens + b.outputTokens : 0,
        ttftP50: b?.ttftP50 ?? 0,
        durationP95: b?.durationP95 ?? 0,
      };
    }),
    statusCodes: [...usage.statusCodes]
      .filter(([code]) => code >= 400)
      .map(([code, n]) => ({ code, count: n }))
      .sort((a, b) => b.count - a.count || tieCode(a, b)),
    accounts: [...usage.accounts]
      .map(([accountId, v]) => ({
        accountId,
        name: accountById.get(accountId)?.name || accountId,
        platform: accountById.get(accountId)?.platform ?? "",
        requests: v.requests,
        errors: v.errors,
        errorRate: v.requests ? v.errors / v.requests : 0,
        ttftP50: v.ttftP50,
      }))
      .sort((a, b) => b.errors - a.errors || b.requests - a.requests || tieAccount(a, b))
      .slice(0, 12),
    models: [...usage.models]
      .map(([model, v]) => ({
        model,
        requests: v.requests,
        errors: v.errors,
        errorRate: v.requests ? v.errors / v.requests : 0,
        ttftP50: v.ttftP50,
        durationP95: v.durationP95,
        tokens: v.inputTokens + v.outputTokens,
      }))
      .sort((a, b) => b.requests - a.requests || tieModel(a, b))
      .slice(0, 12),
    recentErrors: usage.recentErrors.slice(0, OPS_RECENT_ERRORS).map((l) => ({
      createdAtIso: l.createdAtIso,
      requestId: l.requestId,
      userEmail: l.userEmail || l.userId,
      model: l.model,
      accountName: accountById.get(l.accountId)?.name || l.accountId,
      groupName: l.groupName || l.groupId,
      statusCode: l.statusCode,
      durationMs: l.durationMs,
    })),
    fleet: {
      accounts: input.accounts.length,
      active: status("active"),
      cooldown: status("cooldown"),
      paused: status("paused"),
      failedTests: input.accounts.filter((a) => a.lastTest && !a.lastTest.ok).length,
    },
  };
}
