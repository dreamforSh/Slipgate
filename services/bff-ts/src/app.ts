import { Hono } from "hono";
import { z } from "zod";
import {
  AuthLoginRequestSchema,
  AuthRegisterRequestSchema,
  AuthSessionResponseSchema,
  ClashExitNodeSchema,
  CreateAccountRequestSchema,
  CreateApiKeyRequestSchema,
  CreateGroupRequestSchema,
  CreatedApiKeyResponseSchema,
  formatNanoUsd,
  parseUsdToNano,
  PlaneHealthSchema,
  RiskBanEventSchema,
  RoutePreviewRequestSchema,
  RoutePreviewResponseSchema,
  SetupInitializeRequestSchema,
  SlotSeedSnapshotSchema,
  SystemUpdateStatusSchema,
  TriggerUpdateSyncRequestSchema,
  UpdateAccountRequestSchema,
  UpdateApiKeyRequestSchema,
  UpdateGroupRequestSchema,
  VmSlotSummarySchema,
  type ClashExitNode,
  type CompositeRouteRule,
  type Provider,
  type RiskBanEvent,
  type SlotSeedSnapshot,
  type VmSlotSummary,
} from "@slipgate/contracts";
import { PluginRegistry } from "@slipgate/plugin-sdk";
import { requireAdmin, requireAuth, type AuthEnv } from "./middleware/auth.ts";
import {
  encryptSecret,
  generateApiKey,
  hashPassword,
  maskSecret,
  signJwt,
  verifyPassword,
} from "./security/crypto.ts";
import { MemoryControlStore } from "./store/memory_store.ts";
import { StoreError, type ControlStore } from "./store/types.ts";

export interface BffAppOptions {
  store?: ControlStore;
  jwtSecret?: string;
  vaultSecret?: string;
  registry?: PluginRegistry;
}

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

const AdminCreditUserSchema = z.object({
  amountUsd: z.string().min(1),
  reason: z.string().trim().min(1).max(120).default("admin_manual_credit"),
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

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
}

function buildStandaloneSystemUpdateStatus() {
  const mode = process.env.SLIPGATE_MODE === "dev" ? "dev" : "release";
  const strategyRaw = process.env.SLIPGATE_DEV_SYNC_MODE;
  const strategy =
    strategyRaw === "git" || strategyRaw === "release" || strategyRaw === "auto"
      ? strategyRaw
      : "auto";
  const intervalRaw = Number(process.env.SLIPGATE_DEV_SYNC_INTERVAL_SEC ?? "60");
  const intervalSeconds =
    Number.isFinite(intervalRaw) && intervalRaw >= 0 ? Math.floor(intervalRaw) : 60;

  return SystemUpdateStatusSchema.parse({
    mode,
    strategy,
    resolvedStrategy: strategy === "git" ? "git" : "release",
    repo: process.env.SLIPGATE_UPDATE_REPO || "dreamforSh/Slipgate",
    branch: process.env.SLIPGATE_UPDATE_BRANCH || "main",
    version: process.env.SLIPGATE_BUILD_VERSION || "0.1.0",
    activeCommit: process.env.SLIPGATE_BUILD_COMMIT || "dev",
    remoteCommit: null,
    updateAvailable: false,
    autoSyncEnabled: mode === "dev" && intervalSeconds > 0,
    intervalSeconds,
    state: "idle",
    reloadCount: 0,
    webUiOverridden: false,
    edgeBinaryStaged: false,
    lastCheckedAtIso: null,
    lastUpdatedAtIso: null,
    lastError: null,
  });
}

export function createBffApp(options: BffAppOptions = {}): Hono<AuthEnv> {
  const store = options.store ?? new MemoryControlStore();
  const jwtSecret = options.jwtSecret ?? process.env.SLIPGATE_JWT_SECRET ?? "slipgate-dev-jwt-secret-change-in-prod";
  const vaultSecret =
    options.vaultSecret ?? process.env.SLIPGATE_VAULT_SECRET ?? "slipgate-dev-vault-secret-change-in-prod";
  const registry = options.registry ?? new PluginRegistry();

  const app = new Hono<AuthEnv>();
  const startedAt = Date.now();

  app.onError((err, c) => {
    if (err instanceof StoreError) {
      return c.json({ error: err.code, message: err.message }, err.status);
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return c.json({ error: "internal_error", message }, 500);
  });

  // ---------------------------------------------------------------------------
  // Public Health, Setup Wizard & Authentication Endpoints
  // ---------------------------------------------------------------------------
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
          stack: "Bun + TypeScript + Hono + Zod + Postgres",
          schema: "commerce",
          role: "ControlPlane API aggregation, IAM/Setup/RBAC, account vault & API key lifecycle, payment outbox & TS plugins",
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

  app.get("/api/v1/setup/status", async (c) => {
    const status = await store.getSetupStatus();
    return c.json(status);
  });

  app.post("/api/v1/setup/initialize", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = SetupInitializeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const passwordHash = await hashPassword(parsed.data.adminPassword);
    const admin = await store.initializeSetup(parsed.data, passwordHash);
    const { token, expiresAtIso } = await signJwt(
      { sub: admin.id, email: admin.email, role: admin.role },
      jwtSecret,
    );
    return c.json(
      AuthSessionResponseSchema.parse({
        accessToken: token,
        expiresAtIso,
        user: admin,
      }),
      201,
    );
  });

  app.post("/api/v1/auth/register", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = AuthRegisterRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const passwordHash = await hashPassword(parsed.data.password);
    const user = await store.registerUser(parsed.data.email, passwordHash);
    const { token, expiresAtIso } = await signJwt(
      { sub: user.id, email: user.email, role: user.role },
      jwtSecret,
    );
    return c.json(
      AuthSessionResponseSchema.parse({
        accessToken: token,
        expiresAtIso,
        user,
      }),
      201,
    );
  });

  app.post("/api/v1/auth/login", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = AuthLoginRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const userRecord = await store.findUserByEmail(parsed.data.email);
    if (!userRecord || !userRecord.passwordHash) {
      return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401);
    }
    const ok = await verifyPassword(parsed.data.password, userRecord.passwordHash);
    if (!ok) {
      return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401);
    }
    if (userRecord.status !== "active") {
      return c.json({ error: "account_suspended", message: "Account is suspended" }, 403);
    }
    const { passwordHash: _, ...profile } = userRecord;
    const { token, expiresAtIso } = await signJwt(
      { sub: profile.id, email: profile.email, role: profile.role },
      jwtSecret,
    );
    return c.json(
      AuthSessionResponseSchema.parse({
        accessToken: token,
        expiresAtIso,
        user: profile,
      }),
    );
  });

  // ---------------------------------------------------------------------------
  // Authenticated User Self-Service Endpoints
  // ---------------------------------------------------------------------------
  app.get("/api/v1/auth/me", requireAuth(jwtSecret), async (c) => {
    const claims = c.get("authUser");
    const user = await store.getUserById(claims.sub);
    if (!user) {
      return c.json({ error: "unauthorized", message: "User no longer exists" }, 401);
    }
    const wallet = await store.getWallet(user.id);
    return c.json({ user, wallet });
  });

  app.use("/api/v1/user/*", requireAuth(jwtSecret));

  app.get("/api/v1/user/groups", async (c) => {
    const groups = await store.listGroups(true);
    return c.json({ groups });
  });

  app.get("/api/v1/user/api-keys", async (c) => {
    const claims = c.get("authUser");
    const items = await store.listUserApiKeys(claims.sub);
    return c.json({ items });
  });

  app.post("/api/v1/user/api-keys", async (c) => {
    const claims = c.get("authUser");
    const raw = await readJsonBody(c.req.raw);
    const parsed = CreateApiKeyRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const { plaintextKey, keyPrefix, keyHash } = await generateApiKey();
    const item = await store.createApiKey(claims.sub, parsed.data, keyPrefix, keyHash);
    return c.json(CreatedApiKeyResponseSchema.parse({ item, plaintextKey }), 201);
  });

  app.patch("/api/v1/user/api-keys/:keyId", async (c) => {
    const claims = c.get("authUser");
    const keyId = c.req.param("keyId");
    const raw = await readJsonBody(c.req.raw);
    const parsed = UpdateApiKeyRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const item = await store.updateUserApiKey(claims.sub, keyId, parsed.data);
    return c.json({ item });
  });

  app.delete("/api/v1/user/api-keys/:keyId", async (c) => {
    const claims = c.get("authUser");
    const keyId = c.req.param("keyId");
    await store.deleteUserApiKey(claims.sub, keyId);
    return c.json({ deleted: true, keyId });
  });

  app.post("/api/v1/commerce/orders", requireAuth(jwtSecret), async (c) => {
    const raw = await readJsonBody(c.req.raw);
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
    const raw = await readJsonBody(c.req.raw);
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

  // ---------------------------------------------------------------------------
  // Admin Console Endpoints (RBAC: admin required)
  // ---------------------------------------------------------------------------
  app.use("/api/v1/admin/*", requireAdmin(jwtSecret));

  app.get("/api/v1/admin/system/update", async (c) => {
    const internalUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    const internalToken = process.env.SLIPGATE_INTERNAL_TOKEN;
    if (!internalUrl || !internalToken) {
      return c.json(buildStandaloneSystemUpdateStatus());
    }
    try {
      const res = await fetch(`${internalUrl}/internal/supervisor/update`, {
        headers: { "X-Slipgate-Internal-Token": internalToken },
        signal: AbortSignal.timeout(5000),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return c.json(payload, 502);
      }
      return c.json(SystemUpdateStatusSchema.parse(payload));
    } catch (err) {
      return c.json(
        {
          error: "net_supervisor_unreachable",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  app.post("/api/v1/admin/system/update/sync", async (c) => {
    let rawBody: unknown = {};
    const rawText = await c.req.text();
    if (rawText.trim().length > 0) {
      try {
        rawBody = JSON.parse(rawText);
      } catch {
        return c.json({ error: "invalid_request", message: "Malformed JSON request body" }, 400);
      }
    }
    const parsed = TriggerUpdateSyncRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }

    const internalUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    const internalToken = process.env.SLIPGATE_INTERNAL_TOKEN;
    if (!internalUrl || !internalToken) {
      return c.json({
        ...buildStandaloneSystemUpdateStatus(),
        lastCheckedAtIso: new Date().toISOString(),
      });
    }

    try {
      const res = await fetch(`${internalUrl}/internal/supervisor/update/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slipgate-Internal-Token": internalToken,
        },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(120_000),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return c.json(payload, 502);
      }
      return c.json(SystemUpdateStatusSchema.parse(payload));
    } catch (err) {
      return c.json(
        {
          error: "net_supervisor_unreachable",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  app.get("/api/v1/admin/groups", async (c) => {
    const groups = await store.listGroups(false);
    return c.json({ groups });
  });

  app.post("/api/v1/admin/groups", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = CreateGroupRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const group = await store.createGroup(parsed.data);
    return c.json({ group }, 201);
  });

  app.patch("/api/v1/admin/groups/:groupId", async (c) => {
    const groupId = c.req.param("groupId");
    const raw = await readJsonBody(c.req.raw);
    const parsed = UpdateGroupRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const group = await store.updateGroup(groupId, parsed.data);
    return c.json({ group });
  });

  app.delete("/api/v1/admin/groups/:groupId", async (c) => {
    const groupId = c.req.param("groupId");
    await store.deleteGroup(groupId);
    return c.json({ deleted: true, groupId });
  });

  app.get("/api/v1/admin/accounts", async (c) => {
    const groupId = c.req.query("groupId");
    const executionMode = c.req.query("executionMode");
    const accounts = await store.listAccounts({
      groupId: groupId || undefined,
      executionMode: executionMode || undefined,
    });
    return c.json({ accounts });
  });

  app.post("/api/v1/admin/accounts", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = CreateAccountRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const encrypted = await encryptSecret(parsed.data.credentialSecret, vaultSecret);
    const preview = maskSecret(parsed.data.credentialSecret);
    const account = await store.createAccount(parsed.data, encrypted, preview);
    return c.json({ account }, 201);
  });

  app.patch("/api/v1/admin/accounts/:accountId", async (c) => {
    const accountId = c.req.param("accountId");
    const raw = await readJsonBody(c.req.raw);
    const parsed = UpdateAccountRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    let encrypted: Uint8Array | undefined;
    let preview: string | undefined;
    if (parsed.data.credentialSecret !== undefined) {
      encrypted = await encryptSecret(parsed.data.credentialSecret, vaultSecret);
      preview = maskSecret(parsed.data.credentialSecret);
    }
    const account = await store.updateAccount(accountId, parsed.data, encrypted, preview);
    return c.json({ account });
  });

  app.delete("/api/v1/admin/accounts/:accountId", async (c) => {
    const accountId = c.req.param("accountId");
    await store.deleteAccount(accountId);
    return c.json({ deleted: true, accountId });
  });

  app.get("/api/v1/admin/users", async (c) => {
    const users = await store.listUsers();
    return c.json({ users });
  });

  app.post("/api/v1/admin/users/:userId/credit", async (c) => {
    const userId = c.req.param("userId");
    const raw = await readJsonBody(c.req.raw);
    const parsed = AdminCreditUserSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const amountNano = parseUsdToNano(parsed.data.amountUsd);
    const wallet = await store.creditWallet(
      userId,
      amountNano,
      `admin:${crypto.randomUUID()}`,
      parsed.data.reason,
    );
    return c.json({ wallet });
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
    const raw = await readJsonBody(c.req.raw);
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

  return app;
}
