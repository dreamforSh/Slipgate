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
 */
export function priceTurn(
  rule: ModelPricingRule,
  ev: Pick<TurnSettlementEvent, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  rateMultiplier: number,
): bigint {
  const base =
    BigInt(ev.inputTokens) * BigInt(rule.inputNanoPerMTok) +
    BigInt(ev.outputTokens) * BigInt(rule.outputNanoPerMTok) +
    BigInt(ev.cacheReadTokens) * BigInt(rule.cacheReadNanoPerMTok) +
    BigInt(ev.cacheWriteTokens) * BigInt(rule.cacheWriteNanoPerMTok);
  const micros = BigInt(Math.max(1, Math.round(rateMultiplier * 1_000_000)));
  return (base * micros) / 1_000_000n / 1_000_000n;
}

/**
 * slipgate-core's built-in rates (gateway.zig lookupModelRate), nano-USD per token. Used only to
 * price a turn the core could not settle when no admin rule matches; keep the two tables equal.
 */
function builtinRate(model: string): { input: bigint; output: bigint } {
  if (model.includes("opus")) return { input: 15_000n, output: 75_000n };
  if (model.startsWith("claude-")) return { input: 3_000n, output: 15_000n };
  if (model.startsWith("gpt-4o-mini")) return { input: 150n, output: 600n };
  if (model.startsWith("gpt-") || model.startsWith("codex-")) return { input: 2_500n, output: 10_000n };
  if (model.startsWith("gemini-")) return { input: 1_250n, output: 10_000n };
  if (model.startsWith("deepseek-")) return { input: 270n, output: 1_100n };
  return { input: 1_000n, output: 4_000n };
}

/** gateway.zig computeTurnCostNano: cache reads at 10% and cache writes at 125% of the input rate. */
export function builtinTurnCostNano(
  model: string,
  ev: Pick<TurnSettlementEvent, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">,
  rateMultiplier: number,
): bigint {
  const rate = builtinRate(model);
  const base =
    BigInt(ev.inputTokens) * rate.input +
    BigInt(ev.outputTokens) * rate.output +
    (BigInt(ev.cacheReadTokens) * rate.input) / 10n +
    (BigInt(ev.cacheWriteTokens) * rate.input * 5n) / 4n;
  const micros = BigInt(Math.max(1, Math.round(rateMultiplier * 1_000_000)));
  return (base * micros) / 1_000_000n;
}

/** Token counting is free on the data plane (the core takes no hold for it). */
function isFreeTurn(ev: TurnSettlementEvent): boolean {
  return ev.ingressCodec === "anthropic_count_tokens";
}

function hasTokens(ev: TurnSettlementEvent): boolean {
  return ev.inputTokens > 0 || ev.outputTokens > 0 || ev.cacheReadTokens > 0 || ev.cacheWriteTokens > 0;
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
    if (isFreeTurn(ev) || !hasTokens(ev)) return ev;
    const rule = matchRule();
    const cost = rule ? priceTurn(rule, ev, rateMultiplier) : builtinTurnCostNano(ev.upstreamModel, ev, rateMultiplier);
    return { ...ev, costNanoUsd: cost.toString() };
  }
  if (BigInt(ev.costNanoUsd) <= 0n || ev.statusCode >= 400) return ev;
  const rule = matchRule();
  if (!rule) return ev;
  return { ...ev, costNanoUsd: priceTurn(rule, ev, rateMultiplier).toString() };
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
      enabled: v.enabled,
      notes: v.notes,
    };
  }

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
