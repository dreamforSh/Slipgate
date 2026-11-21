import { Hono } from "hono";
import { z } from "zod";
import {
  ClashExitNodeSchema,
  formatNanoUsd,
  parseUsdToNano,
  PlaneHealthSchema,
  RiskBanEventSchema,
  RoutePreviewRequestSchema,
  RoutePreviewResponseSchema,
  SlotSeedSnapshotSchema,
  VmSlotSummarySchema,
  type ClashExitNode,
  type CompositeRouteRule,
  type Provider,
  type RiskBanEvent,
  type SlotSeedSnapshot,
  type VmSlotSummary,
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

const SAMPLE_VM_SLOTS: VmSlotSummary[] = [
  VmSlotSummarySchema.parse({
    slotId: "vm-tokyo-01",
    clusterNodeId: "vps-tokyo-01",
    accountId: "acc-claude-max-01",
    clashNodeId: "node-tokyo-01",
    exitIp: "203.0.113.11",
    hypervisorKind: "kvm_qemu",
    state: "ready",
    activeSubagents: 3,
    maxSubagents: 20,
    window5hUsedBps: 1850,
    window7dUsedBps: 3120,
    telemetryMode: "isolated",
    cleanseMode: "zero",
    memoryMiB: 2048,
    persona: {
      guestMachineId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      macAddress: "02:42:ac:11:00:02",
      smbiosUuid: "11111111-2222-3333-4444-555555555555",
      smbiosSerial: "SG-KVM-01",
      cpuModel: "AMD EPYC 9354",
      cpuCores: 4,
      timezone: "Asia/Tokyo",
      dohUrl: "https://dns.quad9.net/dns-query",
    },
  }),
];

const SAMPLE_RISK_EVENTS: RiskBanEvent[] = [
  RiskBanEventSchema.parse({
    eventId: "risk-001",
    subjectKind: "session",
    strikeLevel: 1,
    banDuration: "10m",
    reason: "prompt_distillation_signature",
    ordinaryUpstream400Count: 0,
    downgradedCount: 1,
    createdAtIso: "2026-11-20T12:00:00Z",
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
      executionModes: ["stealth_http", "vm_slot", "direct_api"],
      guestDaemon: "slipgate-guestd (Zig 0.14)",
      layers: [
        {
          id: "L1",
          name: "slipgate-net",
          stack: "Go 1.27 + mihomo + uTLS + SSH/KVM",
          schema: "net",
          role: "Unified edge ingress, single-service supervisor, Clash 1-slot-1-exit pool & VM hardware persona orchestration",
        },
        {
          id: "L2",
          name: "slipgate-core",
          stack: "Zig 0.14 + slipgate-guestd + i128 Ledger",
          schema: "core",
          role: "Zero-GC DataPlane scheduling, pre-hop risk gate, 5h/7d window alignment, native tool handoff & in-VM guest daemon",
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

  app.get("/api/v1/admin/vms/slots", (c) => {
    return c.json({
      slots: SAMPLE_VM_SLOTS,
      invariants: {
        oneSlotOneEgress: true,
        maxSubagentsDefault: 20,
        zeroPromptInjection: true,
      },
    });
  });

  app.get("/api/v1/admin/vms/:slotId/seed", (c) => {
    const slotId = c.req.param("slotId");
    const snapshot: SlotSeedSnapshot = SlotSeedSnapshotSchema.parse({
      slotId,
      settingsJsonRaw: JSON.stringify(
        {
          cleanupPeriodDays: 30,
          includeCoAuthoredBy: false,
          permissions: { allow: [], deny: [] },
        },
        null,
        2,
      ),
      customSettingRaw: "cleanse_mode=zero\ntelemetry=isolated\n",
      rejectClientSettings: true,
      rejectClientIdentity: true,
      telemetryMode: "isolated",
      telemetryDaemonRunning: true,
      syncedAtUnixMs: Date.now(),
    });
    return c.json(snapshot);
  });

  app.get("/api/v1/admin/risk/events", (c) => {
    return c.json({
      events: SAMPLE_RISK_EVENTS,
      banLadder: ["10m", "24h", "permanent"],
      exemptOrdinaryUpstream400: true,
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
