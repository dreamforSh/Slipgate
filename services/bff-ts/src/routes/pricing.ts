import type { Hono } from "hono";
import {
  ModelPricingRuleSchema,
  parseUsdToNano,
  UpsertModelPricingRuleSchema,
  type DataPlaneSyncPriceRule,
  type ModelPricingRule,
  type TurnSettlementEvent,
} from "@slipgate/contracts";
import { matchPricingRule } from "@slipgate/contracts";
import { cached } from "../insights.ts";
import type { AuthEnv } from "../middleware/auth.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

const BLOB_KEY = "model_pricing";

export interface PricingService {
  /** Current enabled + disabled rules (cached ~15 s). */
  rules(): Promise<ModelPricingRule[]>;
  invalidate(): void;
}

/**
 * Cost of a settled turn under an admin price rule, times the group multiplier. Token counts
 * follow Anthropic semantics (input excludes cache read/write), so the parts never overlap.
 * Supports >threshold long-context tiered pricing, serviceTier ("fast"/"priority" vs "flex"),
 * reasoningEffort multipliers, and per-request / per-image / per-video-second unit fees.
 */
export function priceTurn(
  rule: ModelPricingRule,
  ev: Pick<
    TurnSettlementEvent,
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "serviceTier"
    | "reasoningEffort"
    | "imageCount"
    | "videoSeconds"
  >,
  rateMultiplier: number,
): bigint {
  let inRate = BigInt(rule.inputNanoPerMTok);
  let outRate = BigInt(rule.outputNanoPerMTok);
  if (rule.longContextThresholdTokens && rule.longContextThresholdTokens > 0 && ev.inputTokens > rule.longContextThresholdTokens) {
    if (rule.longContextInputMultiplier !== undefined) {
      inRate = (inRate * BigInt(Math.max(1, Math.round(rule.longContextInputMultiplier * 1_000_000)))) / 1_000_000n;
    }
    if (rule.longContextOutputMultiplier !== undefined) {
      outRate = (outRate * BigInt(Math.max(1, Math.round(rule.longContextOutputMultiplier * 1_000_000)))) / 1_000_000n;
    }
  }

  let tokenBaseMTok =
    BigInt(ev.inputTokens) * inRate +
    BigInt(ev.outputTokens) * outRate +
    BigInt(ev.cacheReadTokens) * BigInt(rule.cacheReadNanoPerMTok) +
    BigInt(ev.cacheWriteTokens) * BigInt(rule.cacheWriteNanoPerMTok);

  const tier = (ev.serviceTier ?? "").trim().toLowerCase();
  if (tier === "fast" || tier === "priority") {
    const mult = rule.serviceTierFastMultiplier ?? 2;
    tokenBaseMTok = (tokenBaseMTok * BigInt(Math.max(1, Math.round(mult * 1_000_000)))) / 1_000_000n;
  } else if (tier === "flex") {
    const mult = rule.serviceTierFlexMultiplier ?? 0.5;
    tokenBaseMTok = (tokenBaseMTok * BigInt(Math.max(1, Math.round(mult * 1_000_000)))) / 1_000_000n;
  }

  const effort = (ev.reasoningEffort ?? "").trim().toLowerCase();
  if (effort && rule.reasoningEffortMultipliers) {
    const effortMult =
      effort === "low"
        ? rule.reasoningEffortMultipliers.low
        : effort === "medium"
          ? rule.reasoningEffortMultipliers.medium
          : effort === "high"
            ? rule.reasoningEffortMultipliers.high
            : effort === "xhigh"
              ? rule.reasoningEffortMultipliers.xhigh
              : undefined;
    if (effortMult !== undefined) {
      tokenBaseMTok = (tokenBaseMTok * BigInt(Math.max(1, Math.round(effortMult * 1_000_000)))) / 1_000_000n;
    }
  }

  const perReqNano = BigInt(rule.perRequestNanoUsd ?? "0");
  const perImgNano = BigInt(rule.perImageNanoUsd ?? "0") * BigInt(ev.imageCount ?? 0);
  const videoMillis = BigInt(Math.max(0, Math.round((ev.videoSeconds ?? 0) * 1000)));
  const perVideoNano = (BigInt(rule.perVideoSecondNanoUsd ?? "0") * videoMillis) / 1000n;
  const unitBaseMTok = (perReqNano + perImgNano + perVideoNano) * 1_000_000n;

  const micros = BigInt(Math.max(1, Math.round(rateMultiplier * 1_000_000)));
  return ((tokenBaseMTok + unitBaseMTok) * micros) / 1_000_000n / 1_000_000n;
}

/**
 * slipgate-core's built-in rates (gateway.zig lookupModelRate), nano-USD per token. Used only to
 * price a turn the core could not settle when no admin rule matches; keep the two tables equal.
 */
function builtinRate(model: string): { input: bigint; output: bigint } {
  if (model.includes("opus")) return { input: 15_000n, output: 75_000n };
  if (model.startsWith("claude-")) return { input: 3_000n, output: 15_000n };
  if (model.startsWith("gpt-4o-mini") || model.startsWith("text-embedding-3-small")) return { input: 150n, output: 600n };
  if (model.startsWith("text-embedding-") || model.startsWith("embedding-")) return { input: 130n, output: 130n };
  if (model.startsWith("gpt-") || model.startsWith("codex-")) return { input: 2_500n, output: 10_000n };
  if (model.startsWith("gemini-")) return { input: 1_250n, output: 10_000n };
  if (model.startsWith("deepseek-")) return { input: 270n, output: 1_100n };
  return { input: 1_000n, output: 4_000n };
}

/** gateway.zig computeTurnCostNano: cache reads at 10% and cache writes at 125% of the input rate. */
export function builtinTurnCostNano(
  model: string,
  ev: Pick<
    TurnSettlementEvent,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "serviceTier" | "imageCount" | "videoSeconds"
  >,
  rateMultiplier: number,
): bigint {
  const rate = builtinRate(model);
  let base =
    BigInt(ev.inputTokens) * rate.input +
    BigInt(ev.outputTokens) * rate.output +
    (BigInt(ev.cacheReadTokens) * rate.input) / 10n +
    (BigInt(ev.cacheWriteTokens) * rate.input * 5n) / 4n;
  const tier = (ev.serviceTier ?? "").trim().toLowerCase();
  if (tier === "fast" || tier === "priority") base *= 2n;
  else if (tier === "flex") base /= 2n;
  if (base === 0n) {
    if ((ev.imageCount ?? 0) > 0) base += BigInt(ev.imageCount!) * 40_000_000n;
    if ((ev.videoSeconds ?? 0) > 0) base += BigInt(Math.round(ev.videoSeconds! * 1000)) * 100_000n;
  }
  const micros = BigInt(Math.max(1, Math.round(rateMultiplier * 1_000_000)));
  return (base * micros) / 1_000_000n;
}

/** Token counting is free on the data plane (the core takes no hold for it). */
function isFreeTurn(ev: TurnSettlementEvent): boolean {
  return ev.ingressCodec === "anthropic_count_tokens";
}

function hasBillableUsage(ev: TurnSettlementEvent): boolean {
  return (
    ev.inputTokens > 0 ||
    ev.outputTokens > 0 ||
    ev.cacheReadTokens > 0 ||
    ev.cacheWriteTokens > 0 ||
    (ev.imageCount ?? 0) > 0 ||
    (ev.videoSeconds ?? 0) > 0
  );
}

/**
 * Applies a matching price rule to a settlement the core already charged (cost > 0). Free or
 * failed turns (core cost 0) are left alone, so count_tokens and errors stay free.
 *
 * A turn the core could not settle (coreSettled === false: the settle IPC failed, or the core
 * restarted and lost the hold) arrives with cost 0 but real token counts. It is priced here the
 * way the core would have priced it (matching rule, else the built-in rates, times the group
 * multiplier) instead of being recorded as free.
 */
export function repriceSettlement(
  ev: TurnSettlementEvent,
  rules: readonly ModelPricingRule[],
  rateMultiplier: number,
): TurnSettlementEvent {
  const matchRule = () => matchPricingRule(rules, ev.publicModel) ?? matchPricingRule(rules, ev.upstreamModel);
  if (ev.coreSettled === false && BigInt(ev.costNanoUsd) <= 0n) {
    if (isFreeTurn(ev) || !hasBillableUsage(ev)) return ev;
    const rule = matchRule();
    const cost = rule ? priceTurn(rule, ev, rateMultiplier) : builtinTurnCostNano(ev.upstreamModel, ev, rateMultiplier);
    return { ...ev, costNanoUsd: cost.toString() };
  }
  if (ev.statusCode >= 400 || isFreeTurn(ev)) return ev;
  const hasMedia = (ev.imageCount ?? 0) > 0 || (ev.videoSeconds ?? 0) > 0;
  if (BigInt(ev.costNanoUsd) <= 0n && !hasMedia) return ev;
  const rule = matchRule();
  if (!rule) return ev;
  return { ...ev, costNanoUsd: priceTurn(rule, ev, rateMultiplier).toString() };
}

function toMicros(mult: number | undefined): number | undefined {
  return mult !== undefined ? Math.max(1, Math.round(mult * 1_000_000)) : undefined;
}

/** Enabled rules as slipgate-core consumes them from the snapshot (see DataPlaneSyncPriceRule). */
export function snapshotPriceRules(rules: readonly ModelPricingRule[]): DataPlaneSyncPriceRule[] {
  return rules
    .filter((r) => r.enabled)
    .map((r) => ({
      pattern: r.pattern,
      inputNanoPerMTok: r.inputNanoPerMTok,
      outputNanoPerMTok: r.outputNanoPerMTok,
      cacheReadNanoPerMTok: r.cacheReadNanoPerMTok,
      cacheWriteNanoPerMTok: r.cacheWriteNanoPerMTok,
      ...(r.perRequestNanoUsd && r.perRequestNanoUsd !== "0" ? { perRequestNanoUsd: r.perRequestNanoUsd } : {}),
      ...(r.perImageNanoUsd && r.perImageNanoUsd !== "0" ? { perImageNanoUsd: r.perImageNanoUsd } : {}),
      ...(r.perVideoSecondNanoUsd && r.perVideoSecondNanoUsd !== "0" ? { perVideoSecondNanoUsd: r.perVideoSecondNanoUsd } : {}),
      ...(r.longContextThresholdTokens && r.longContextThresholdTokens > 0
        ? {
            longContextThresholdTokens: r.longContextThresholdTokens,
            ...(r.longContextInputMultiplier !== undefined
              ? { longContextInputMultiplierMicros: toMicros(r.longContextInputMultiplier) }
              : {}),
            ...(r.longContextOutputMultiplier !== undefined
              ? { longContextOutputMultiplierMicros: toMicros(r.longContextOutputMultiplier) }
              : {}),
          }
        : {}),
      ...(r.serviceTierFastMultiplier !== undefined
        ? { serviceTierFastMultiplierMicros: toMicros(r.serviceTierFastMultiplier) }
        : {}),
      ...(r.serviceTierFlexMultiplier !== undefined
        ? { serviceTierFlexMultiplierMicros: toMicros(r.serviceTierFlexMultiplier) }
        : {}),
      ...(r.reasoningEffortMultipliers?.low !== undefined
        ? { reasoningEffortLowMultiplierMicros: toMicros(r.reasoningEffortMultipliers.low) }
        : {}),
      ...(r.reasoningEffortMultipliers?.medium !== undefined
        ? { reasoningEffortMediumMultiplierMicros: toMicros(r.reasoningEffortMultipliers.medium) }
        : {}),
      ...(r.reasoningEffortMultipliers?.high !== undefined
        ? { reasoningEffortHighMultiplierMicros: toMicros(r.reasoningEffortMultipliers.high) }
        : {}),
      ...(r.reasoningEffortMultipliers?.xhigh !== undefined
        ? { reasoningEffortXhighMultiplierMicros: toMicros(r.reasoningEffortMultipliers.xhigh) }
        : {}),
    }));
}

function usd(text: string): string {
  try {
    const nano = parseUsdToNano(text);
    return (nano > 0n ? nano : 0n).toString();
  } catch {
    throw new StoreError("bad_request", `Invalid price: ${text}`);
  }
}

/** `onChange` runs after every rule edit: the data plane snapshot carries the enabled rules. */
export function registerPricingRoutes(app: Hono<AuthEnv>, store: ControlStore, onChange?: () => void): PricingService {
  async function load(): Promise<ModelPricingRule[]> {
    const blob = await store.ops.getBlob(BLOB_KEY);
    const list = Array.isArray(blob?.rules) ? blob.rules : [];
    return list.flatMap((r) => {
      const parsed = ModelPricingRuleSchema.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  }
  let cache = cached(15_000, load);
  const service: PricingService = {
    rules: () => cache(),
    invalidate: () => {
      cache = cached(15_000, load);
    },
  };
  async function save(rules: ModelPricingRule[]) {
    await store.ops.setBlob(BLOB_KEY, { rules });
    service.invalidate();
    onChange?.();
  }

  async function parseBody(req: Request) {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new StoreError("bad_request", "Malformed JSON request body");
    }
    const parsed = UpsertModelPricingRuleSchema.safeParse(raw);
    if (!parsed.success) {
      throw new StoreError("bad_request", parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    const v = parsed.data;
    const input = usd(v.inputPerMTokUsd);
    return {
      pattern: v.pattern,
      inputNanoPerMTok: input,
      outputNanoPerMTok: usd(v.outputPerMTokUsd),
      cacheReadNanoPerMTok: v.cacheReadPerMTokUsd !== undefined ? usd(v.cacheReadPerMTokUsd) : (BigInt(input) / 10n).toString(),
      cacheWriteNanoPerMTok: v.cacheWritePerMTokUsd !== undefined ? usd(v.cacheWritePerMTokUsd) : ((BigInt(input) * 5n) / 4n).toString(),
      ...(v.perRequestUsd !== undefined ? { perRequestNanoUsd: usd(v.perRequestUsd) } : {}),
      ...(v.perImageUsd !== undefined ? { perImageNanoUsd: usd(v.perImageUsd) } : {}),
      ...(v.perVideoSecondUsd !== undefined ? { perVideoSecondNanoUsd: usd(v.perVideoSecondUsd) } : {}),
      ...(v.longContextThresholdTokens !== undefined ? { longContextThresholdTokens: v.longContextThresholdTokens } : {}),
      ...(v.longContextInputMultiplier !== undefined ? { longContextInputMultiplier: v.longContextInputMultiplier } : {}),
      ...(v.longContextOutputMultiplier !== undefined ? { longContextOutputMultiplier: v.longContextOutputMultiplier } : {}),
      ...(v.serviceTierFastMultiplier !== undefined ? { serviceTierFastMultiplier: v.serviceTierFastMultiplier } : {}),
      ...(v.serviceTierFlexMultiplier !== undefined ? { serviceTierFlexMultiplier: v.serviceTierFlexMultiplier } : {}),
      ...(v.reasoningEffortMultipliers !== undefined ? { reasoningEffortMultipliers: v.reasoningEffortMultipliers } : {}),
      enabled: v.enabled,
      notes: v.notes,
    };
  }

  const PRESET_PRICING_RULES: ReadonlyArray<Omit<ModelPricingRule, "id" | "updatedAtIso">> = [
    {
      pattern: "claude-opus-4-*",
      inputNanoPerMTok: usd("15"),
      outputNanoPerMTok: usd("75"),
      cacheReadNanoPerMTok: usd("1.5"),
      cacheWriteNanoPerMTok: usd("18.75"),
      longContextThresholdTokens: 200_000,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
      enabled: true,
      notes: "Official preset: Claude Opus 4 family",
    },
    {
      pattern: "claude-sonnet-4-*",
      inputNanoPerMTok: usd("3"),
      outputNanoPerMTok: usd("15"),
      cacheReadNanoPerMTok: usd("0.3"),
      cacheWriteNanoPerMTok: usd("3.75"),
      longContextThresholdTokens: 200_000,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
      enabled: true,
      notes: "Official preset: Claude Sonnet 4 family (200k tiered)",
    },
    {
      pattern: "claude-haiku-4-*",
      inputNanoPerMTok: usd("1"),
      outputNanoPerMTok: usd("5"),
      cacheReadNanoPerMTok: usd("0.1"),
      cacheWriteNanoPerMTok: usd("1.25"),
      enabled: true,
      notes: "Official preset: Claude Haiku 4 family",
    },
    {
      pattern: "gpt-5*",
      inputNanoPerMTok: usd("1.25"),
      outputNanoPerMTok: usd("10"),
      cacheReadNanoPerMTok: usd("0.125"),
      cacheWriteNanoPerMTok: usd("1.25"),
      serviceTierFastMultiplier: 2,
      serviceTierFlexMultiplier: 0.5,
      enabled: true,
      notes: "Official preset: GPT-5 / Codex family (priority 2x / flex 0.5x)",
    },
    {
      pattern: "gpt-4.1",
      inputNanoPerMTok: usd("2"),
      outputNanoPerMTok: usd("8"),
      cacheReadNanoPerMTok: usd("0.5"),
      cacheWriteNanoPerMTok: usd("2"),
      serviceTierFlexMultiplier: 0.5,
      enabled: true,
      notes: "Official preset: GPT-4.1",
    },
    {
      pattern: "gpt-4o",
      inputNanoPerMTok: usd("2.5"),
      outputNanoPerMTok: usd("10"),
      cacheReadNanoPerMTok: usd("1.25"),
      cacheWriteNanoPerMTok: usd("2.5"),
      enabled: true,
      notes: "Official preset: GPT-4o",
    },
    {
      pattern: "gpt-4o-mini*",
      inputNanoPerMTok: usd("0.15"),
      outputNanoPerMTok: usd("0.6"),
      cacheReadNanoPerMTok: usd("0.075"),
      cacheWriteNanoPerMTok: usd("0.15"),
      enabled: true,
      notes: "Official preset: GPT-4o mini",
    },
    {
      pattern: "gpt-image-1*",
      inputNanoPerMTok: usd("5"),
      outputNanoPerMTok: usd("40"),
      cacheReadNanoPerMTok: usd("1.25"),
      cacheWriteNanoPerMTok: usd("5"),
      perImageNanoUsd: usd("0.04"),
      enabled: true,
      notes: "Official preset: GPT Image 1 ($0.04/image)",
    },
    {
      pattern: "dall-e-3",
      inputNanoPerMTok: "0",
      outputNanoPerMTok: "0",
      cacheReadNanoPerMTok: "0",
      cacheWriteNanoPerMTok: "0",
      perImageNanoUsd: usd("0.04"),
      enabled: true,
      notes: "Official preset: DALL-E 3 ($0.04/image)",
    },
    {
      pattern: "sora-*",
      inputNanoPerMTok: "0",
      outputNanoPerMTok: "0",
      cacheReadNanoPerMTok: "0",
      cacheWriteNanoPerMTok: "0",
      perVideoSecondNanoUsd: usd("0.1"),
      enabled: true,
      notes: "Official preset: Sora video generation ($0.10/s)",
    },
    {
      pattern: "text-embedding-3-small",
      inputNanoPerMTok: usd("0.02"),
      outputNanoPerMTok: "0",
      cacheReadNanoPerMTok: "0",
      cacheWriteNanoPerMTok: "0",
      enabled: true,
      notes: "Official preset: OpenAI text-embedding-3-small",
    },
    {
      pattern: "text-embedding-3-large",
      inputNanoPerMTok: usd("0.13"),
      outputNanoPerMTok: "0",
      cacheReadNanoPerMTok: "0",
      cacheWriteNanoPerMTok: "0",
      enabled: true,
      notes: "Official preset: OpenAI text-embedding-3-large",
    },
    {
      pattern: "gemini-2.5-pro*",
      inputNanoPerMTok: usd("1.25"),
      outputNanoPerMTok: usd("10"),
      cacheReadNanoPerMTok: usd("0.3125"),
      cacheWriteNanoPerMTok: usd("1.25"),
      longContextThresholdTokens: 200_000,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5,
      enabled: true,
      notes: "Official preset: Gemini 2.5 Pro (>200k 2x/1.5x)",
    },
    {
      pattern: "gemini-2.5-flash*",
      inputNanoPerMTok: usd("0.3"),
      outputNanoPerMTok: usd("2.5"),
      cacheReadNanoPerMTok: usd("0.075"),
      cacheWriteNanoPerMTok: usd("0.3"),
      enabled: true,
      notes: "Official preset: Gemini 2.5 Flash",
    },
    {
      pattern: "imagen-*",
      inputNanoPerMTok: "0",
      outputNanoPerMTok: "0",
      cacheReadNanoPerMTok: "0",
      cacheWriteNanoPerMTok: "0",
      perImageNanoUsd: usd("0.03"),
      enabled: true,
      notes: "Official preset: Google Imagen ($0.03/image)",
    },
    {
      pattern: "veo-*",
      inputNanoPerMTok: "0",
      outputNanoPerMTok: "0",
      cacheReadNanoPerMTok: "0",
      cacheWriteNanoPerMTok: "0",
      perVideoSecondNanoUsd: usd("0.35"),
      enabled: true,
      notes: "Official preset: Google Veo ($0.35/s)",
    },
    {
      pattern: "deepseek-chat",
      inputNanoPerMTok: usd("0.27"),
      outputNanoPerMTok: usd("1.1"),
      cacheReadNanoPerMTok: usd("0.07"),
      cacheWriteNanoPerMTok: usd("0.27"),
      enabled: true,
      notes: "Official preset: DeepSeek V3",
    },
    {
      pattern: "deepseek-reasoner",
      inputNanoPerMTok: usd("0.55"),
      outputNanoPerMTok: usd("2.19"),
      cacheReadNanoPerMTok: usd("0.14"),
      cacheWriteNanoPerMTok: usd("0.55"),
      enabled: true,
      notes: "Official preset: DeepSeek R1",
    },
  ];

  app.post("/api/v1/admin/pricing/sync-presets", async (c) => {
    let overwrite = false;
    const text = await c.req.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as { overwrite?: unknown };
        overwrite = parsed?.overwrite === true;
      } catch {
        throw new StoreError("bad_request", "Malformed JSON request body");
      }
    }
    const rules = await load();
    const byPattern = new Map(rules.map((r, i) => [r.pattern, i]));
    const nowIso = new Date().toISOString();
    let added = 0;
    let updated = 0;
    for (const preset of PRESET_PRICING_RULES) {
      const idx = byPattern.get(preset.pattern);
      if (idx === undefined) {
        rules.push({ id: `price_${crypto.randomUUID()}`, ...preset, updatedAtIso: nowIso });
        added++;
      } else if (overwrite) {
        const prev = rules[idx]!;
        rules[idx] = { ...preset, id: prev.id, enabled: prev.enabled, updatedAtIso: nowIso };
        updated++;
      }
    }
    if (added > 0 || updated > 0) await save(rules);
    return c.json({
      added,
      updated,
      total: rules.length,
      items: rules.sort((a, b) => a.pattern.localeCompare(b.pattern)),
    });
  });

  app.get("/api/v1/admin/pricing", async (c) => {
    const rules = await load();
    return c.json({ items: rules.sort((a, b) => a.pattern.localeCompare(b.pattern)) });
  });

  app.post("/api/v1/admin/pricing", async (c) => {
    const fields = await parseBody(c.req.raw);
    const rules = await load();
    if (rules.some((r) => r.pattern === fields.pattern)) throw new StoreError("conflict", `A rule for ${fields.pattern} already exists`);
    const item: ModelPricingRule = { id: `price_${crypto.randomUUID()}`, ...fields, updatedAtIso: new Date().toISOString() };
    await save([...rules, item]);
    return c.json({ item }, 201);
  });

  app.put("/api/v1/admin/pricing/:id", async (c) => {
    const id = c.req.param("id");
    const fields = await parseBody(c.req.raw);
    const rules = await load();
    const idx = rules.findIndex((r) => r.id === id);
    if (idx < 0) throw new StoreError("not_found", "Price rule not found");
    if (rules.some((r) => r.id !== id && r.pattern === fields.pattern)) {
      throw new StoreError("conflict", `A rule for ${fields.pattern} already exists`);
    }
    const item: ModelPricingRule = { id, ...fields, updatedAtIso: new Date().toISOString() };
    rules[idx] = item;
    await save(rules);
    return c.json({ item });
  });

  app.delete("/api/v1/admin/pricing/:id", async (c) => {
    const id = c.req.param("id");
    const rules = await load();
    if (!rules.some((r) => r.id === id)) throw new StoreError("not_found", "Price rule not found");
    await save(rules.filter((r) => r.id !== id));
    return c.json({ deleted: true });
  });

  return service;
}
