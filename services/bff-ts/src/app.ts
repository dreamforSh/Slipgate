import { Hono } from "hono";
import { z } from "zod";
import {
  ClashExitNodeSchema,
  formatNanoUsd,
  parseUsdToNano,
  PlaneHealthSchema,
  RoutePreviewRequestSchema,
  RoutePreviewResponseSchema,
  type ClashExitNode,
  type CompositeRouteRule,
  type Provider,
} from "@slipgate/contracts";
import { PluginRegistry } from "@slipgate/plugin-sdk";

const CreateOrderSchema = z.object({
  userId: z.string().min(1),
  provider: z.enum(["stripe", "airwallex", "alipay", "wechat", "easypay"]),
  amountUsd: z.string().min(1),
});

const PaymentWebhookSchema = z.object({
  orderId: z.string().min(1),
  userId: z.string().min(1),
  providerTradeNo: z.string().min(1),
  amountNanoUsd: z.string().regex(/^\d+$/),
});

const SAMPLE_CLASH_NODES: ClashExitNode[] = [
  ClashExitNodeSchema.parse({
    nodeId: "node-tokyo-01",
    subscriptionId: "sub-primary",
    name: "Tokyo-Residential-01",
    proxySlotId: "slot-20001",
    listenerPort: 20001,
    exitIp: "203.0.113.11",
    latencyMs: 34,
    healthStatus: "healthy",
    driftUnconfirmed: false,
    boundAccounts: 1,
    maxAccounts: 1,
  }),
  ClashExitNodeSchema.parse({
    nodeId: "node-sg-02",
    subscriptionId: "sub-primary",
    name: "Singapore-ISP-02",
    proxySlotId: "slot-20002",
    listenerPort: 20002,
    exitIp: "198.51.100.24",
    latencyMs: 49,
    healthStatus: "healthy",
    driftUnconfirmed: false,
    boundAccounts: 0,
    maxAccounts: 1,
  }),
];

function detectBuiltinProvider(model: string): Provider | null {
  if (model.startsWith("claude-") || model.startsWith("anthropic/")) return "anthropic";
  if (model.startsWith("gemini-") || model.startsWith("google/")) return "gemini";
  if (model.startsWith("gpt-") || model.startsWith("codex-") || model.startsWith("openai/")) return "openai";
  if (model.startsWith("grok-") || model.startsWith("xai/")) return "grok";
  if (model.startsWith("deepseek-")) return "deepseek";
  if (model.startsWith("glm-")) return "glm";
  if (model.startsWith("kimi-") || model.startsWith("moonshot-")) return "kimi";
  if (model.startsWith("minimax-") || model.startsWith("abab")) return "minimax";
  return null;
}

function ruleBeats(candidate: CompositeRouteRule, incumbent: CompositeRouteRule): boolean {
  const cExact = candidate.matchType === "exact";
  const iExact = incumbent.matchType === "exact";
  if (cExact !== iExact) return cExact;

  const cEp = candidate.endpoint !== "any";
  const iEp = incumbent.endpoint !== "any";
  if (cEp !== iEp) return cEp;

  if (candidate.publicModel.length !== incumbent.publicModel.length) {
    return candidate.publicModel.length > incumbent.publicModel.length;
  }
  return candidate.priority < incumbent.priority;
}

export function createBffApp(registry = new PluginRegistry()): Hono {
  const app = new Hono();
  const startedAt = Date.now();

  app.get("/api/v1/health", (c) => {
    const payload = PlaneHealthSchema.parse({
      status: "ok",
      service: "slipgate-bff",
      version: "0.1.0",
      runtime: typeof Bun !== "undefined" ? `bun-${Bun.version}` : "node",
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
      planes: {
        net: "unknown",
        core: "unknown",
        bff: "up",
      },
    });
    return c.json(payload);
  });

  app.get("/api/v1/system/architecture", (c) => {
    return c.json({
      project: "Slipgate",
      version: "0.1.0",
      startupModel: "single-service-supervisor",
      layers: [
        {
          id: "L1",
          name: "slipgate-net",
          stack: "Go 1.27 + mihomo + uTLS",
          schema: "net",
          role: "Unified edge ingress, single-service supervisor, Clash 1-account-1-exit pool & fail-closed circuit breaker",
        },
        {
          id: "L2",
          name: "slipgate-core",
          stack: "Zig 0.14 + Arena + i128 Ledger",
          schema: "core",
          role: "Zero-GC DataPlane scheduling, Composite Trie routing, SlipIR streaming codec, nano-USD two-phase billing",
        },
        {
          id: "L3",
          name: "slipgate-bff",
          stack: "Bun + TypeScript + Hono + Zod",
          schema: "commerce",
          role: "ControlPlane API aggregation, IAM/Passkey/OAuth2, payment gateways, transactional outbox & TS plugins",
        },
        {
          id: "L4",
          name: "slipgate-web",
          stack: "Vue 3.5 + Vite 6 + TailwindCSS + Pinia",
          schema: "-",
          role: "Embedded User Workbench and Admin Control Console",
        },
      ],
    });
  });

  app.get("/api/v1/admin/clash/nodes", (c) => {
    return c.json({
      nodes: SAMPLE_CLASH_NODES,
      policy: {
        maxAccountsPerExitIp: 1,
        failClosed: true,
        dropGuardThreshold: 0.5,
      },
    });
  });

  app.post("/api/v1/admin/routes/preview", async (c) => {
    const raw = await c.req.json();
    const parsed = RoutePreviewRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }

    const { endpoint, publicModel, rules } = parsed.data;
    let best: CompositeRouteRule | null = null;
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.endpoint !== "any" && rule.endpoint !== endpoint) continue;
      const matched =
        rule.matchType === "exact"
          ? rule.publicModel === publicModel
          : publicModel.startsWith(rule.publicModel);
      if (!matched) continue;
      if (best === null || ruleBeats(rule, best)) {
        best = rule;
      }
    }

    if (best) {
      return c.json(
        RoutePreviewResponseSchema.parse({
          matched: true,
          targetPlatform: best.targetPlatform,
          upstreamModel: best.upstreamModel || publicModel,
          matchedRuleId: best.routeId,
          resolutionSource: "explicit_rule",
        }),
      );
    }

    const builtin = detectBuiltinProvider(publicModel);
    if (builtin) {
      return c.json(
        RoutePreviewResponseSchema.parse({
          matched: true,
          targetPlatform: builtin,
          upstreamModel: publicModel,
          matchedRuleId: null,
          resolutionSource: "builtin_detector",
        }),
      );
    }

    return c.json(
      RoutePreviewResponseSchema.parse({
        matched: false,
        targetPlatform: null,
        upstreamModel: null,
        matchedRuleId: null,
        resolutionSource: "none",
      }),
      400,
    );
  });

  app.post("/api/v1/commerce/orders", async (c) => {
    const raw = await c.req.json();
    const parsed = CreateOrderSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_order", issues: parsed.error.issues }, 400);
    }
    const amountNano = parseUsdToNano(parsed.data.amountUsd);
    const orderId = `ord_${crypto.randomUUID()}`;
    return c.json(
      {
        orderId,
        userId: parsed.data.userId,
        provider: parsed.data.provider,
        amountNanoUsd: amountNano.toString(),
        formattedAmountUsd: formatNanoUsd(amountNano),
        status: "pending",
        idempotencyKey: `credit:${orderId}`,
      },
      201,
    );
  });

  app.post("/webhooks/payment/:provider", async (c) => {
    const provider = c.req.param("provider");
    const raw = await c.req.json();
    const parsed = PaymentWebhookSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_webhook", issues: parsed.error.issues }, 400);
    }

    await registry.emitPaymentSettled(
      {
        serviceVersion: "0.1.0",
        logger: (msg, meta) => console.log(`[plugin] ${msg}`, meta ?? {}),
      },
      {
        orderId: parsed.data.orderId,
        userId: parsed.data.userId,
        provider,
        amountNanoUsd: parsed.data.amountNanoUsd,
      },
    );

    return c.json({
      accepted: true,
      outboxEvent: "core.v1.CreditWallet",
      idempotencyKey: `credit:${provider}:${parsed.data.orderId}`,
    });
  });

  return app;
}
