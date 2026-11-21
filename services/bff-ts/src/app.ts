import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  AuthLoginRequestSchema,
  AuthRegisterRequestSchema,
  AuthSessionResponseSchema,
  BindAccountExitRequestSchema,
  ClashExitNodeSchema,
  ClashOutboundTestRequestSchema,
  ClashProbeRequestSchema,
  CreateAccountRequestSchema,
  CreateApiKeyRequestSchema,
  CreateClashSubscriptionRequestSchema,
  CreateClusterNodeRequestSchema,
  CreateCompositeRouteRequestSchema,
  CreateGroupRequestSchema,
  CreatedApiKeyResponseSchema,
  CreateTlsProfileRequestSchema,
  formatNanoUsd,
  MigrateVmSlotRequestSchema,
  parseUsdToNano,
  PlaneHealthSchema,
  ProvisionVmSlotRequestSchema,
  RecordRiskBanInputSchema,
  RoutePreviewRequestSchema,
  RoutePreviewResponseSchema,
  SetupInitializeRequestSchema,
  SlotSeedSnapshotSchema,
  SystemUpdateStatusSchema,
  TriggerUpdateSyncRequestSchema,
  TurnSettlementEventSchema,
  UpdateAccountRequestSchema,
  UpdateApiKeyRequestSchema,
  UpdateGroupRequestSchema,
  UpdateTlsProfileRequestSchema,
  UpdateVmSeedRequestSchema,
  UpdateVmTelemetryRequestSchema,
  VmSlotSummarySchema,
  type ClashExitNode,
  type ClusterNode,
  type CompositeRouteRule,
  type Provider,
  type SlotSeedSnapshot,
  type TlsProfile,
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
  internalToken?: string;
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
    runtimeProfile: "claude_code",
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

function detectBuiltinProvider(model: string): Provider | null {
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
  if (model.startsWith("gemini-") || model.startsWith("google/")) return "gemini";
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("openai/")
  ) {
    return "openai";
  }
  if (model.startsWith("grok-") || model.startsWith("xai/")) return "grok";
  if (model.startsWith("deepseek-")) return "deepseek";
  if (model.startsWith("glm-")) return "glm";
  if (model.startsWith("kimi-") || model.startsWith("moonshot-")) return "kimi";
  if (model.startsWith("minimax-") || model.startsWith("abab")) return "minimax";
  if (model.startsWith("qwen-")) return "qwen";
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

const STANDALONE_CLUSTER_NODES: ClusterNode[] = [
  {
    id: "local-node",
    name: "Local Control Node",
    driverKind: "local",
    sshAddr: "127.0.0.1:22",
    sshUser: "slipgate",
    hasSSHKey: false,
    arch: "amd64",
    kvmCapable: false,
    dockerCapable: true,
    status: "online",
    maxSlots: 32,
    createdAtIso: "2026-11-20T00:00:00Z",
    updatedAtIso: "2026-11-20T00:00:00Z",
  },
];

const STANDALONE_TLS_PROFILES: TlsProfile[] = [
  {
    id: "auto",
    name: "Auto Sticky (Rendezvous OS-Aware)",
    description: "Deterministic Rendezvous sticky profile selection per account ID",
    clientHelloPreset: "auto",
    ja3Fingerprint: "",
    ja4Fingerprint: "",
    alpnProtocols: ["h2", "http/1.1"],
    userAgentTemplate: "",
    enableGrease: false,
    cipherSuites: [],
    curves: [],
    pointFormats: [],
    signatureAlgorithms: [],
    supportedVersions: [],
    keyShareGroups: [],
    pskModes: [],
    extensions: [],
    osHint: "",
    builtIn: true,
  },
  {
    id: "claude-bun-21",
    name: "Claude Code 2.1.280 (Bun uTLS + PQ X25519MLKEM768)",
    description: "Wire-exact BoringSSL/Bun ClientHello with X25519MLKEM768 hybrid key share",
    clientHelloPreset: "custom_wire",
    ja3Fingerprint: "",
    ja4Fingerprint: "",
    alpnProtocols: ["h2", "http/1.1"],
    userAgentTemplate: "claude-cli/2.1.280 (external, cli)",
    enableGrease: false,
    cipherSuites: [4865, 4866, 4867, 49195, 49199, 49196, 49200, 52393, 52392],
    curves: [4588, 29, 23, 24],
    pointFormats: [0],
    signatureAlgorithms: [1027, 2052, 1025, 1283, 2053, 1281, 2054, 1537, 513],
    supportedVersions: [772, 771],
    keyShareGroups: [4588, 29],
    pskModes: [1],
    extensions: [0, 23, 65281, 10, 11, 35, 16, 5, 13, 18, 51, 45, 43],
    osHint: "linux",
    builtIn: true,
  },
  {
    id: "codex-rustls-01",
    name: "OpenAI Codex CLI (Rust reqwest/rustls)",
    description: "GREASE-free Rustls TLS 1.3/1.2 ClientHello with AES-256-GCM preference and X25519 key share",
    clientHelloPreset: "codex_rustls",
    ja3Fingerprint: "",
    ja4Fingerprint: "",
    alpnProtocols: ["h2", "http/1.1"],
    userAgentTemplate: "codex_cli_rs/0.38.0 (Linux 6.8.0; x86_64)",
    enableGrease: false,
    cipherSuites: [4866, 4865, 4867, 49196, 49195, 52393, 49200, 49199, 52392],
    curves: [29, 23, 24],
    pointFormats: [0],
    signatureAlgorithms: [1027, 2052, 1025, 1283, 2053, 1281, 2054, 1537, 513],
    supportedVersions: [772, 771],
    keyShareGroups: [29],
    pskModes: [1],
    extensions: [0, 23, 65281, 10, 11, 35, 16, 5, 13, 51, 45, 43],
    osHint: "linux",
    builtIn: true,
  },
  {
    id: "antigravity-electron-15",
    name: "Antigravity IDE 1.15 (Electron BoringSSL + PQ)",
    description: "Electron/Chromium GREASE + X25519MLKEM768 + Brotli cert compression + ALPS h2 ClientHello",
    clientHelloPreset: "antigravity_ide",
    ja3Fingerprint: "",
    ja4Fingerprint: "",
    alpnProtocols: ["h2", "http/1.1"],
    userAgentTemplate: "antigravity/1.15.8 linux/amd64",
    enableGrease: true,
    cipherSuites: [4865, 4866, 4867, 49195, 49199, 49196, 49200, 52393, 52392],
    curves: [4588, 29, 23, 24],
    pointFormats: [0],
    signatureAlgorithms: [1027, 2052, 1025, 1283, 2053, 1281, 2054, 1537, 513],
    supportedVersions: [772, 771],
    keyShareGroups: [4588, 29],
    pskModes: [1],
    extensions: [0, 23, 65281, 10, 11, 35, 16, 5, 13, 18, 51, 45, 43, 27, 17513],
    osHint: "linux",
    builtIn: true,
  },
  {
    id: "chrome-131",
    name: "Chrome 131 (Windows Desktop)",
    description: "Google Chrome desktop TLS + HTTP/2 ClientHello",
    clientHelloPreset: "chrome_auto",
    ja3Fingerprint: "",
    ja4Fingerprint: "",
    alpnProtocols: ["h2", "http/1.1"],
    userAgentTemplate:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    enableGrease: false,
    cipherSuites: [],
    curves: [],
    pointFormats: [],
    signatureAlgorithms: [],
    supportedVersions: [],
    keyShareGroups: [],
    pskModes: [],
    extensions: [],
    osHint: "windows",
    builtIn: true,
  },
  {
    id: "firefox-133",
    name: "Firefox 133 (Desktop)",
    description: "Mozilla Firefox desktop TLS + HTTP/2 ClientHello",
    clientHelloPreset: "firefox_auto",
    ja3Fingerprint: "",
    ja4Fingerprint: "",
    alpnProtocols: ["h2", "http/1.1"],
    userAgentTemplate:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    enableGrease: false,
    cipherSuites: [],
    curves: [],
    pointFormats: [],
    signatureAlgorithms: [],
    supportedVersions: [],
    keyShareGroups: [],
    pskModes: [],
    extensions: [],
    osHint: "windows",
    builtIn: true,
  },
  {
    id: "claude-cli-mac",
    name: "Official CLI Runtime (Bun/macOS)",
    description: "HTTP/1.1 pinned CLI profile for macOS hosts",
    clientHelloPreset: "chrome_auto",
    ja3Fingerprint: "",
    ja4Fingerprint: "",
    alpnProtocols: ["http/1.1"],
    userAgentTemplate: "claude-cli/2.1.280 (external, cli)",
    enableGrease: false,
    cipherSuites: [],
    curves: [],
    pointFormats: [],
    signatureAlgorithms: [],
    supportedVersions: [],
    keyShareGroups: [],
    pskModes: [],
    extensions: [],
    osHint: "darwin",
    builtIn: true,
  },
];

type ForwardStatus = 200 | 201 | 202 | 400 | 403 | 404 | 409 | 502 | 503;

function toForwardStatus(code: number): ForwardStatus {
  if (
    code === 200 ||
    code === 201 ||
    code === 202 ||
    code === 400 ||
    code === 403 ||
    code === 404 ||
    code === 409 ||
    code === 503
  ) {
    return code;
  }
  return 502;
}

async function forwardNetInternal(
  path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<{ configured: false } | { configured: true; status: ForwardStatus; payload: Record<string, unknown> }> {
  const internalUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
  const internalToken = process.env.SLIPGATE_INTERNAL_TOKEN;
  if (!internalUrl || !internalToken) {
    return { configured: false };
  }

  const headers: Record<string, string> = {
    "X-Slipgate-Internal-Token": internalToken,
  };
  let bodyStr: string | undefined;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyStr = JSON.stringify(options.body);
  }

  const res = await fetch(`${internalUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  const payload = (await res.json()) as Record<string, unknown>;
  return {
    configured: true,
    status: toForwardStatus(res.status),
    payload,
  };
}

export function createBffApp(options: BffAppOptions = {}): Hono<AuthEnv> {
  const store = options.store ?? new MemoryControlStore();
  const jwtSecret = options.jwtSecret ?? process.env.SLIPGATE_JWT_SECRET ?? "slipgate-dev-jwt-secret-change-in-prod";
  const vaultSecret =
    options.vaultSecret ?? process.env.SLIPGATE_VAULT_SECRET ?? "slipgate-dev-vault-secret-change-in-prod";
  const internalToken = options.internalToken ?? process.env.SLIPGATE_INTERNAL_TOKEN ?? "";
  const registry = options.registry ?? new PluginRegistry();

  const app = new Hono<AuthEnv>();
  const startedAt = Date.now();

  function verifyInternalHeader(c: Context): boolean {
    if (!internalToken) return false;
    const provided = c.req.header("X-Slipgate-Internal-Token") ?? "";
    if (provided.length !== internalToken.length) return false;
    let diff = 0;
    for (let i = 0; i < internalToken.length; i++) {
      diff |= provided.charCodeAt(i) ^ internalToken.charCodeAt(i);
    }
    return diff === 0;
  }

  async function syncDataPlaneBestEffort(): Promise<void> {
    const internalUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    if (!internalUrl || !internalToken) return;
    try {
      const snapshot = await store.exportDataPlaneSnapshot();
      await fetch(`${internalUrl}/internal/net/dataplane/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slipgate-Internal-Token": internalToken,
        },
        body: JSON.stringify(snapshot),
        signal: AbortSignal.timeout(2500),
      });
    } catch {
      // DataPlane coordinator also reconciles periodically via background pull.
    }
  }

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
    await syncDataPlaneBestEffort();
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
    await syncDataPlaneBestEffort();
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

  app.get("/api/v1/user/wallet", async (c) => {
    const claims = c.get("authUser");
    const wallet = await store.getWallet(claims.sub);
    return c.json({ wallet });
  });

  app.get("/api/v1/user/usage", async (c) => {
    const claims = c.get("authUser");
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
    const items = await store.listUsageLogs({ userId: claims.sub, limit });
    return c.json({ items });
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
    await syncDataPlaneBestEffort();
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
    await syncDataPlaneBestEffort();
    return c.json({ item });
  });

  app.delete("/api/v1/user/api-keys/:keyId", async (c) => {
    const claims = c.get("authUser");
    const keyId = c.req.param("keyId");
    await store.deleteUserApiKey(claims.sub, keyId);
    await syncDataPlaneBestEffort();
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
  // Internal DataPlane Synchronization & Post-Turn Settlement Bridge
  // ---------------------------------------------------------------------------
  app.get("/api/v1/internal/dataplane/snapshot", async (c) => {
    if (!verifyInternalHeader(c)) {
      return c.json({ error: "forbidden", message: "Invalid internal supervisor token" }, 403);
    }
    const snapshot = await store.exportDataPlaneSnapshot();
    return c.json(snapshot);
  });

  app.post("/api/v1/internal/dataplane/settlement", async (c) => {
    if (!verifyInternalHeader(c)) {
      return c.json({ error: "forbidden", message: "Invalid internal supervisor token" }, 403);
    }
    const raw = await readJsonBody(c.req.raw);
    const parsed = TurnSettlementEventSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const item = await store.recordTurnSettlement(parsed.data);
    return c.json({ ok: true, item });
  });

  app.post("/api/v1/internal/dataplane/risk-events", async (c) => {
    if (!verifyInternalHeader(c)) {
      return c.json({ error: "forbidden", message: "Invalid internal supervisor token" }, 403);
    }
    const raw = await readJsonBody(c.req.raw);
    const parsed = RecordRiskBanInputSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const event = await store.recordRiskBanEvent(parsed.data);
    return c.json({ ok: true, event });
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
    await syncDataPlaneBestEffort();
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
    await syncDataPlaneBestEffort();
    return c.json({ group });
  });

  app.delete("/api/v1/admin/groups/:groupId", async (c) => {
    const groupId = c.req.param("groupId");
    await store.deleteGroup(groupId);
    await syncDataPlaneBestEffort();
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
    await syncDataPlaneBestEffort();
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
    await syncDataPlaneBestEffort();
    return c.json({ account });
  });

  app.delete("/api/v1/admin/accounts/:accountId", async (c) => {
    const accountId = c.req.param("accountId");
    await store.deleteAccount(accountId);
    await syncDataPlaneBestEffort();
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
    await syncDataPlaneBestEffort();
    return c.json({ wallet });
  });

  app.get("/api/v1/admin/usage", async (c) => {
    const userId = c.req.query("userId");
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "100", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 100;
    const items = await store.listUsageLogs({
      userId: userId || undefined,
      limit,
    });
    return c.json({ items });
  });

  app.get("/api/v1/admin/routes", async (c) => {
    const groupId = c.req.query("groupId");
    const routes = await store.listCompositeRoutes(groupId || undefined);
    return c.json({ routes });
  });

  app.post("/api/v1/admin/routes", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = CreateCompositeRouteRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const route = await store.createCompositeRoute(parsed.data);
    await syncDataPlaneBestEffort();
    return c.json({ route }, 201);
  });

  app.delete("/api/v1/admin/routes/:routeId", async (c) => {
    const routeId = c.req.param("routeId");
    await store.deleteCompositeRoute(routeId);
    await syncDataPlaneBestEffort();
    return c.json({ deleted: true, routeId });
  });

  app.get("/api/v1/admin/clash/nodes", async (c) => {
    try {
      const forwarded = await forwardNetInternal("/internal/net/clash/nodes");
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({
        nodes: SAMPLE_CLASH_NODES,
        policy: {
          maxAccountsPerExitIp: 1,
          failClosed: true,
          dropGuardThreshold: 0.5,
        },
      });
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

  app.get("/api/v1/admin/clash/overview", async (c) => {
    try {
      const forwarded = await forwardNetInternal("/internal/net/clash/overview");
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({
        runtime: {
          mode: "standalone",
          ready: false,
          version: "standalone",
          configHash: "",
          activeListeners: 0,
          activeProxies: 0,
          lastReconciledAtIso: null,
        },
        subscriptions: [],
        nodes: SAMPLE_CLASH_NODES,
        bindings: [],
        profiles: STANDALONE_TLS_PROFILES,
        policy: {
          maxAccountsPerExitIp: 1,
          failClosed: true,
          dropGuardThreshold: 0.5,
        },
      });
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

  app.post("/api/v1/admin/clash/subscriptions", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = CreateClashSubscriptionRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    try {
      const forwarded = await forwardNetInternal("/internal/net/clash/subscriptions", {
        method: "POST",
        body: parsed.data,
        timeoutMs: 30_000,
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json(
        {
          subscription: {
            id: parsed.data.id ?? `sub-${crypto.randomUUID().slice(0, 8)}`,
            name: parsed.data.name,
            sourceKind: parsed.data.sourceKind,
            sourceUrl: parsed.data.sourceUrl,
            userAgent: parsed.data.userAgent,
            excludeRegex: parsed.data.excludeRegex,
            enabled: true,
            lastSyncAt: null,
            lastSyncStatus: "standalone",
            lastNodeCount: 0,
            createdAt: new Date().toISOString(),
          },
          sync: null,
        },
        201,
      );
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

  app.post("/api/v1/admin/clash/subscriptions/:id/sync", async (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    let body: { force?: boolean } = {};
    const text = await c.req.text();
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text) as { force?: boolean };
      } catch {
        return c.json({ error: "invalid_request", message: "Malformed JSON request body" }, 400);
      }
    }
    try {
      const forwarded = await forwardNetInternal(`/internal/net/clash/subscriptions/${id}/sync`, {
        method: "POST",
        body: { force: Boolean(body.force) },
        timeoutMs: 45_000,
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ error: "net_supervisor_unconfigured", message: "Standalone BFF mode" }, 503);
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

  app.delete("/api/v1/admin/clash/subscriptions/:id", async (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    try {
      const forwarded = await forwardNetInternal(`/internal/net/clash/subscriptions/${id}`, {
        method: "DELETE",
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ deleted: true, subscriptionId: c.req.param("id") });
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

  app.post("/api/v1/admin/clash/nodes/probe", async (c) => {
    let rawBody: unknown = {};
    const text = await c.req.text();
    if (text.trim().length > 0) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        return c.json({ error: "invalid_request", message: "Malformed JSON request body" }, 400);
      }
    }
    const parsed = ClashProbeRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    try {
      const forwarded = await forwardNetInternal("/internal/net/clash/nodes/probe", {
        method: "POST",
        body: parsed.data,
        timeoutMs: 60_000,
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ results: [] });
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

  app.post("/api/v1/admin/clash/nodes/:id/confirm-drift", async (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    try {
      const forwarded = await forwardNetInternal(`/internal/net/clash/nodes/${id}/confirm-drift`, {
        method: "POST",
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ nodeId: c.req.param("id"), driftUnconfirmed: false });
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

  app.patch("/api/v1/admin/clash/nodes/:id", async (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    const raw = await readJsonBody(c.req.raw);
    const bodySchema = z.object({ enabled: z.boolean() });
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    try {
      const forwarded = await forwardNetInternal(`/internal/net/clash/nodes/${id}`, {
        method: "PATCH",
        body: parsed.data,
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ nodeId: c.req.param("id"), enabled: parsed.data.enabled });
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

  app.post("/api/v1/admin/clash/bindings", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = BindAccountExitRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    try {
      const forwarded = await forwardNetInternal("/internal/net/clash/bindings", {
        method: "POST",
        body: parsed.data,
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ binding: parsed.data });
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

  app.delete("/api/v1/admin/clash/bindings/:accountId", async (c) => {
    const accountId = encodeURIComponent(c.req.param("accountId"));
    try {
      const forwarded = await forwardNetInternal(`/internal/net/clash/bindings/${accountId}`, {
        method: "DELETE",
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ deleted: true, accountId: c.req.param("accountId") });
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

  app.post("/api/v1/admin/clash/test-outbound", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = ClashOutboundTestRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    try {
      const forwarded = await forwardNetInternal("/internal/net/clash/test-outbound", {
        method: "POST",
        body: parsed.data,
        timeoutMs: 30_000,
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ error: "net_supervisor_unconfigured", message: "Standalone BFF mode" }, 503);
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

  app.get("/api/v1/admin/tls-profiles", async (c) => {
    try {
      const forwarded = await forwardNetInternal("/internal/net/tls-profiles");
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ profiles: STANDALONE_TLS_PROFILES });
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

  app.post("/api/v1/admin/tls-profiles", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = CreateTlsProfileRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    try {
      const forwarded = await forwardNetInternal("/internal/net/tls-profiles", {
        method: "POST",
        body: parsed.data,
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json(
        {
          profile: {
            id: parsed.data.id ?? `tls-${crypto.randomUUID().slice(0, 8)}`,
            ...parsed.data,
            builtIn: false,
          },
        },
        201,
      );
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

  app.put("/api/v1/admin/tls-profiles/:id", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = UpdateTlsProfileRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const id = encodeURIComponent(c.req.param("id"));
    try {
      const forwarded = await forwardNetInternal(`/internal/net/tls-profiles/${id}`, {
        method: "PUT",
        body: parsed.data,
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      if (STANDALONE_TLS_PROFILES.some((p) => p.id === c.req.param("id") && p.builtIn)) {
        return c.json({ error: "clash_operation_failed", message: "built-in TLS profile is immutable" }, 403);
      }
      return c.json({
        profile: {
          id: c.req.param("id"),
          ...parsed.data,
          builtIn: false,
        },
      });
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

  app.delete("/api/v1/admin/tls-profiles/:id", async (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    try {
      const forwarded = await forwardNetInternal(`/internal/net/tls-profiles/${id}`, {
        method: "DELETE",
      });
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      return c.json({ deleted: true, id: c.req.param("id") });
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

  async function forwardVmAdmin(
    c: Context<AuthEnv>,
    internalPath: string,
    opts: { method?: string; body?: unknown; timeoutMs?: number } = {},
    standaloneFallback?: () => Response,
  ) {
    try {
      const forwarded = await forwardNetInternal(internalPath, opts);
      if (forwarded.configured) {
        return c.json(forwarded.payload, forwarded.status);
      }
      if (standaloneFallback) {
        return standaloneFallback();
      }
      return c.json(
        { error: "net_supervisor_unconfigured", message: "VM coordinator requires live net supervisor" },
        503,
      );
    } catch (err) {
      return c.json(
        {
          error: "net_supervisor_unreachable",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  }

  app.get("/api/v1/admin/vms/overview", (c) =>
    forwardVmAdmin(c, "/internal/net/vms/overview", {}, () =>
      c.json({
        nodes: STANDALONE_CLUSTER_NODES,
        slots: SAMPLE_VM_SLOTS,
        migrations: [],
        invariants: {
          oneSlotOneEgress: true,
          maxSubagentsDefault: 20,
          zeroPromptInjection: true,
        },
        runtime: {
          vmDataDir: "/var/run/slipgate/vms",
          guestdBin: "/usr/local/share/slipgate/guest/slipgate-guestd",
          guestdAvailable: false,
          localNodeId: "local-node",
        },
      }),
    ),
  );

  app.get("/api/v1/admin/vms/nodes", (c) =>
    forwardVmAdmin(c, "/internal/net/vms/nodes", {}, () => c.json({ nodes: STANDALONE_CLUSTER_NODES })),
  );

  app.post("/api/v1/admin/vms/nodes", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = CreateClusterNodeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    return forwardVmAdmin(c, "/internal/net/vms/nodes", { method: "POST", body: parsed.data });
  });

  app.delete("/api/v1/admin/vms/nodes/:id", (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    return forwardVmAdmin(c, `/internal/net/vms/nodes/${id}`, { method: "DELETE" });
  });

  app.get("/api/v1/admin/vms/slots", (c) =>
    forwardVmAdmin(c, "/internal/net/vms/slots", {}, () =>
      c.json({
        slots: SAMPLE_VM_SLOTS,
        invariants: {
          oneSlotOneEgress: true,
          maxSubagentsDefault: 20,
          zeroPromptInjection: true,
        },
      }),
    ),
  );

  app.post("/api/v1/admin/vms/slots", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = ProvisionVmSlotRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    return forwardVmAdmin(c, "/internal/net/vms/slots", { method: "POST", body: parsed.data });
  });

  app.delete("/api/v1/admin/vms/slots/:id", (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    return forwardVmAdmin(c, `/internal/net/vms/slots/${id}`, { method: "DELETE" });
  });

  app.post("/api/v1/admin/vms/slots/:id/start", (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    return forwardVmAdmin(c, `/internal/net/vms/slots/${id}/start`, { method: "POST" });
  });

  app.post("/api/v1/admin/vms/slots/:id/stop", (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    return forwardVmAdmin(c, `/internal/net/vms/slots/${id}/stop`, { method: "POST" });
  });

  app.get("/api/v1/admin/vms/:slotId/seed", (c) => {
    const slotId = c.req.param("slotId");
    return forwardVmAdmin(c, `/internal/net/vms/slots/${encodeURIComponent(slotId)}/seed`, {}, () => {
      const snapshot: SlotSeedSnapshot = SlotSeedSnapshotSchema.parse({
        slotId,
        runtimeProfile: "claude_code",
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
        authJsonRaw: "",
        rejectClientSettings: true,
        rejectClientIdentity: true,
        telemetryMode: "isolated",
        telemetryDaemonRunning: true,
        syncedAtUnixMs: Date.now(),
      });
      return c.json(snapshot);
    });
  });

  app.put("/api/v1/admin/vms/:slotId/seed", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = UpdateVmSeedRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const id = encodeURIComponent(c.req.param("slotId"));
    return forwardVmAdmin(c, `/internal/net/vms/slots/${id}/seed`, { method: "PUT", body: parsed.data });
  });

  app.get("/api/v1/admin/vms/slots/:slotId/seed", (c) => {
    const id = encodeURIComponent(c.req.param("slotId"));
    return forwardVmAdmin(c, `/internal/net/vms/slots/${id}/seed`);
  });

  app.put("/api/v1/admin/vms/slots/:slotId/seed", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = UpdateVmSeedRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const id = encodeURIComponent(c.req.param("slotId"));
    return forwardVmAdmin(c, `/internal/net/vms/slots/${id}/seed`, { method: "PUT", body: parsed.data });
  });

  app.patch("/api/v1/admin/vms/slots/:id/telemetry", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = UpdateVmTelemetryRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const id = encodeURIComponent(c.req.param("id"));
    return forwardVmAdmin(c, `/internal/net/vms/slots/${id}/telemetry`, { method: "PATCH", body: parsed.data });
  });

  app.post("/api/v1/admin/vms/slots/:id/migrate", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = MigrateVmSlotRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const id = encodeURIComponent(c.req.param("id"));
    return forwardVmAdmin(c, `/internal/net/vms/slots/${id}/migrate`, { method: "POST", body: parsed.data });
  });

  app.post("/api/v1/admin/vms/slots/:id/terminal-ticket", (c) => {
    const id = encodeURIComponent(c.req.param("id"));
    return forwardVmAdmin(c, `/internal/net/vms/slots/${id}/terminal-ticket`, { method: "POST" });
  });

  app.get("/api/v1/admin/risk/events", async (c) => {
    const events = await store.listRiskBanEvents(50);
    return c.json({
      events,
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

    const { endpoint, groupId, publicModel } = parsed.data;
    let rules = parsed.data.rules;
    if (rules.length === 0) {
      const persisted = await store.listCompositeRoutes(groupId);
      rules = persisted.map((r) => ({
        routeId: r.id,
        groupId: r.groupId,
        publicModel: r.publicModel,
        matchType: r.matchType,
        targetPlatform: r.targetPlatform,
        upstreamModel: r.upstreamModel,
        endpoint: r.endpoint,
        priority: r.priority,
        enabled: r.enabled,
      }));
    }
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
      const groups = await store.listGroups(false);
      const grp = groups.find((g) => g.id === groupId);
      const targetPlatform: Provider =
        grp && grp.platform !== "composite" ? grp.platform : builtin;
      return c.json(
        RoutePreviewResponseSchema.parse({
          matched: true,
          targetPlatform,
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
