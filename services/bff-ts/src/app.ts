import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  AccountBatchDeleteRequestSchema,
  AccountBulkUpdateRequestSchema,
  AccountExportRequestSchema,
  AccountImportRequestSchema,
  AccountStatsRangeSchema,
  AccountTestEventSchema,
  AccountTestRequestSchema,
  canonicalCredentialText,
  DashboardRangeSchema,
  AuthLoginRequestSchema,
  BulkUpdateApiKeysRequestSchema,
  AuthRegisterRequestSchema,
  AuthSessionResponseSchema,
  LogoutResponseSchema,
  RevokeAllSessionsRequestSchema,
  RevokeAllSessionsResponseSchema,
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
  SLIPGATE_ACCOUNT_EXPORT_TYPE,
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
  type AccountBulkResult,
  type AccountExportFile,
  type AccountImportResult,
  type AccountTestResult,
  type AccountUsageSummaryResponse,
  type CreateAccountRequest,
  type ClashExitNode,
  type ClusterNode,
  type CompositeRouteRule,
  type DataPlaneSyncSnapshot,
  type Provider,
  type SlotSeedSnapshot,
  type TlsProfile,
  type VmSlotSummary,
} from "@slipgate/contracts";
import { PluginRegistry } from "@slipgate/plugin-sdk";
import { buildAccountUsageStats, buildDashboardStats, dashboardWindow, DASHBOARD_MAX_ROWS } from "./dashboard.ts";
import { applyEntitlements, cached, detectBuiltinProvider, WindowLimiter } from "./insights.ts";
import { verifyTotp } from "./security/totp.ts";
import { SessionManager, type AuthEnv } from "./middleware/auth.ts";
import { clientIp } from "./security/client_ip.ts";
import { auditMiddleware, registerOpsRoutes } from "./routes/ops.ts";
import { digestEmailCode, registerMailRoutes, type MailService } from "./routes/mail.ts";
import { registerPaymentRoutes } from "./routes/payments.ts";
import { registerPricingRoutes, repriceSettlement, snapshotPriceRules, type PricingService } from "./routes/pricing.ts";
import { CoalescingRunner, KeyedThrottle } from "./settlement_guards.ts";
import { AccountAutoTester, registerAutoTestRoutes } from "./autotest.ts";
import { mountAuditRetention } from "./audit_retention.ts";
import { logRouteError, mountSystemLogging, registerSystemLogRoutes } from "./routes/system_logs.ts";
import { registerAnnouncementRoutes } from "./routes/announcements.ts";
import { paymentWebhookPlugin } from "./plugins/payment_webhook.ts";
import { registerPluginRoutes } from "./routes/plugins.ts";
import { registerBackupRoutes } from "./routes/backup.ts";
import { mountDbBackups, type DbBackupAppOptions } from "./routes/db_backups.ts";
import { registerOAuthRoutes } from "./routes/oauth.ts";
import { AuthGuards, BACKEND_MODE_REFUSAL, conflictRefusal, refusalResponse, registerAuthGuardRoutes } from "./auth_guards.ts";
import { RegistrationGuardError } from "./store/auth_guards_store.ts";
import { registerUserLimitRoutes, repriceForUser, UserRateCache, withApiKeyDefaults, withUserLimits } from "./routes/user_limits.ts";
import {
  credentialFingerprint,
  decryptSecret,
  encryptSecret,
  generateApiKey,
  hashPassword,
  maskSecret,
  verifyPasswordOrDummy,
} from "./security/crypto.ts";
import { MemoryControlStore } from "./store/memory_store.ts";
import { StoreError, type ControlStore, type StoredCredential, type UserCredentialRecord } from "./store/types.ts";

export interface BffAppOptions {
  store?: ControlStore;
  jwtSecret?: string;
  vaultSecret?: string;
  internalToken?: string;
  registry?: PluginRegistry;
  /** Test hook: replaces fetch for OAuth token/userinfo calls. */
  oauthFetch?: typeof fetch;
  /** Test hook: replaces fetch for payment gateway calls (EasyPay, Stripe, Alipay, WeChat Pay, Airwallex). */
  paymentFetch?: typeof fetch;
  /** Test hook: replaces fetch for captcha verification (Turnstile / Tencent / Aliyun). */
  captchaFetch?: typeof fetch;
  /** Run background schedulers (account auto-tests). Only the server entrypoint sets this. */
  startSchedulers?: boolean;
  /** Test hook: replaces SMTP delivery for verification/reset mail. */
  mailDelivery?: (cfg: import("./mail/smtp.ts").SmtpConfig, msg: import("./mail/smtp.ts").MailMessage) => Promise<unknown>;
  /** Test hooks for full database backups (dump runner, object storage, part size, clock). */
  dbBackup?: DbBackupAppOptions;
}

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

/** `Date#getTimezoneOffset()` from a query string, clamped to real-world offsets. */
function parseTzOffset(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(n) ? Math.max(-14 * 60, Math.min(14 * 60, n)) : 0;
}

function describeIssues(issues: z.ZodIssue[]): string {
  return issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
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

/** Push the real balance once an under-valued wallet can pay for fewer than this many such turns. */
const LOW_BALANCE_TURNS = 32n;

export function createBffApp(options: BffAppOptions = {}): Hono<AuthEnv> {
  const store = options.store ?? new MemoryControlStore();
  const jwtSecret = options.jwtSecret ?? process.env.SLIPGATE_JWT_SECRET ?? "slipgate-dev-jwt-secret-change-in-prod";
  const vaultSecret =
    options.vaultSecret ?? process.env.SLIPGATE_VAULT_SECRET ?? "slipgate-dev-vault-secret-change-in-prod";
  const internalToken = options.internalToken ?? process.env.SLIPGATE_INTERNAL_TOKEN ?? "";
  const registry = options.registry ?? new PluginRegistry();

  const app = new Hono<AuthEnv>();
  // First middleware: request ids, the logging context and 5xx / access entries wrap every route.
  const systemLogs = mountSystemLogging(app, store, options.startSchedulers === true);
  const startedAt = Date.now();
  const loginTotpLimiter = new WindowLimiter(8, 5 * 60_000);
  /** Issues, re-validates (per request) and revokes console sessions; owns the password-attempt limits. */
  const sessions = new SessionManager(store, jwtSecret);
  /** Captcha, sign-up email policy, backend (admin-only) mode and legal documents (auth_guards.ts). */
  const guards = new AuthGuards({ store, vaultSecret, sessions, fetchImpl: options.captchaFetch });
  // Assigned when the mail routes register (after the admin guard); read lazily by handlers.
  let mail: MailService = { ready: async () => false };
  let pricing: PricingService = { rules: async () => [], invalidate: () => undefined };

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

  /**
   * The store snapshot with keys of suspended users, ungranted exclusive groups and unusable
   * subscriptions turned off, plus the enabled price rules so slipgate-core holds and settles at
   * the prices the BFF bills.
   */
  async function exportEffectiveSnapshot(): Promise<DataPlaneSyncSnapshot> {
    const [snapshot, access, entitlements, groups, overLimit, rules] = await Promise.all([
      store.exportDataPlaneSnapshot(),
      store.ops.listUserAccess(),
      store.ops.subscriptionEntitlements(),
      store.listGroups(false),
      store.listOverLimitKeyIds(),
      pricing.rules(),
    ]);
    const effective = { ...applyEntitlements(snapshot, access, entitlements, groups, new Set(overLimit)), priceRules: snapshotPriceRules(rules) };
    // Per-user / per-group RPM and concurrency caps (slipgate-net enforces them; key limits clamped).
    return withUserLimits(store, effective);
  }

  /**
   * Shares one in-flight export between concurrent callers (pulls and pushes), so slow exports
   * never pile up. `snapshotGen` moves on every data-plane sync request (i.e. after a write), and an
   * export is only shared within its generation: a caller never gets one that began before its write.
   */
  let snapshotGen = 0;
  let snapshotInflight: { gen: number; promise: Promise<DataPlaneSyncSnapshot> } | null = null;
  function sharedSnapshot(): Promise<DataPlaneSyncSnapshot> {
    const gen = snapshotGen;
    if (snapshotInflight?.gen === gen) return snapshotInflight.promise;
    const promise = exportEffectiveSnapshot().finally(() => {
      if (snapshotInflight?.promise === promise) snapshotInflight = null;
    });
    snapshotInflight = { gen, promise };
    return promise;
  }

  /**
   * Settlement-path caches (one listGroups feeds the multipliers and the capped subscription
   * groups). cached() shares an in-flight load, so a miss costs one query however many settlements
   * hit it; a sync swaps in fresh caches instead of letting every caller reload on its own.
   */
  const loadGroupMeta = async () => {
    const groups = await store.listGroups(false);
    return {
      multipliers: new Map(groups.map((g) => [g.id, g.rateMultiplier])),
      // Every subscription group gets the per-settlement entitlement check: it also catches an
      // expired subscription. Only capped groups sum usage in it (an uncapped group's check never
      // touches usage_logs), so the check stays cheap for them.
      subscriptionGroupIds: new Set(groups.filter((g) => g.subscriptionType === "subscription").map((g) => g.id)),
    };
  };
  const loadLimitedKeyIds = async () => new Set(await store.listLimitedKeyIds());
  let groupMeta = cached(30_000, loadGroupMeta);
  let limitedKeyIds = cached(30_000, loadLimitedKeyIds);
  /** Per-user custom group rates the settlement path bills at (lane U1). */
  const userRates = new UserRateCache(store);
  function refreshSettlementCaches() {
    groupMeta = cached(30_000, loadGroupMeta);
    limitedKeyIds = cached(30_000, loadLimitedKeyIds);
    userRates.invalidate();
  }
  /** Per-key / per-subscription cap checks after a charged settlement: at most one per second each, with a trailing run. */
  const keyCapChecks = new KeyedThrottle(1000);
  const subscriptionCapChecks = new KeyedThrottle(1000);

  /** Debounces sync requests from the settlement path (e.g. settlements crossing a cap) into one push. */
  let syncTimer: ReturnType<typeof setTimeout> | null = null;
  let syncDueAt = 0;
  function scheduleDataPlaneSync(delayMs = 1000) {
    const dueAt = Date.now() + delayMs;
    if (syncTimer && syncDueAt <= dueAt) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncDueAt = dueAt;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      void syncDataPlaneBestEffort();
    }, delayMs);
  }

  /** At most one export+push runs at a time; requests made meanwhile share exactly one more. */
  const dataPlanePush = new CoalescingRunner(async () => {
    const internalUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    if (!internalUrl || !internalToken) return;
    const snapshot = await sharedSnapshot();
    await fetch(`${internalUrl}/internal/net/dataplane/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Slipgate-Internal-Token": internalToken,
      },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(2500),
    });
    // Failures are swallowed by the runner: the DataPlane coordinator also pulls every 15 s.
  });

  async function syncDataPlaneBestEffort(): Promise<void> {
    refreshSettlementCaches();
    snapshotGen++;
    const internalUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    if (!internalUrl || !internalToken) return;
    await dataPlanePush.request();
  }

  async function fingerprintOf(secret: string): Promise<string> {
    return credentialFingerprint(canonicalCredentialText(secret), vaultSecret);
  }

  async function sealCredential(secret: string): Promise<StoredCredential> {
    const trimmed = secret.trim();
    return {
      encrypted: await encryptSecret(trimmed, vaultSecret),
      preview: maskSecret(trimmed),
      fingerprint: await fingerprintOf(trimmed),
    };
  }

  /** Rows created before fingerprints existed get one on first need (once per process). */
  let fingerprintBackfill: Promise<void> | null = null;
  function ensureCredentialFingerprints(): Promise<void> {
    fingerprintBackfill ??= (async () => {
      for (const rec of await store.listAccountSecrets()) {
        if (rec.fingerprint) continue;
        try {
          const plain = await decryptSecret(rec.encrypted, vaultSecret);
          await store.setCredentialFingerprint(rec.accountId, await fingerprintOf(plain));
        } catch {
          // Undecryptable with the current vault key: it cannot be matched either way.
        }
      }
    })().catch((err) => {
      fingerprintBackfill = null;
      throw err;
    });
    return fingerprintBackfill;
  }

  app.onError((err, c) => {
    logRouteError(c, err);
    // A sign-up that lost the race for its inbox / quota domain inside registerUser.
    if (err instanceof RegistrationGuardError) return refusalResponse(c, conflictRefusal(err.reason));
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
    return c.json(AuthSessionResponseSchema.parse(await sessions.issue(admin)), 201);
  });

  app.post("/api/v1/auth/register", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = AuthRegisterRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const settings = await store.ops.getSettings();
    const req = parsed.data;
    // Backend mode, attempt limit, captcha, reserved domain, allowlist / quota, same inbox (auth_guards.ts).
    const preflight = await guards.registerPreflight(c, req, settings, () => mail.ready());
    if ("response" in preflight) return preflight.response;
    if (settings.inviteRequired) {
      if (!req.inviteCode || !(await store.ops.isInvitationCodeUsable(req.inviteCode))) {
        return c.json({ error: "invite_required", message: "A valid invitation code is required to register" }, 400);
      }
    }
    if (settings.emailVerificationRequired && (await mail.ready())) {
      const code = req.emailCode?.trim() ?? "";
      if (!/^\d{6}$/.test(code) || !(await store.ops.consumeEmailCode(req.email, "register", await digestEmailCode(req.email, code)))) {
        return c.json({ error: "email_code_invalid", message: "The email verification code is invalid or expired" }, 400);
      }
    }
    const promoCode = settings.promoCodeEnabled && req.promoCode ? req.promoCode : undefined;
    if (promoCode) {
      const check = await store.ops.checkPromoCode(promoCode);
      if (!check.valid) {
        return c.json({ error: "invalid_promo_code", message: `Promo code is ${check.reason.replace("_", " ")}` }, 400);
      }
    }
    const passwordHash = await hashPassword(req.password);
    // The invitation is claimed atomically before the user exists (one winner per code, handed
    // back if the registration fails), so concurrent sign-ups can't all pass the pre-check above.
    const created = settings.inviteRequired
      ? await store.ops.registerWithInvitation(req.inviteCode ?? "", () => store.registerUser(req.email, passwordHash, preflight.guard))
      : await store.registerUser(req.email, passwordHash, preflight.guard);
    if (!created) {
      return c.json({ error: "invite_required", message: "A valid invitation code is required to register" }, 400);
    }
    await store.ops.applyRegistrationExtras(created.id, {
      username: req.username,
      promoCode,
      affCode: settings.affiliateEnabled ? req.affCode : undefined,
    });
    const defaultBalance = BigInt(settings.defaultBalanceNanoUsd);
    if (defaultBalance > 0n) {
      await store.creditWallet(created.id, defaultBalance, `signup:${created.id}`, "signup_default_balance");
    }
    await store.ops.touchLastLogin(created.id);
    const user = (await store.getUserById(created.id)) ?? created;
    // No data-plane push: a new user has no API keys yet, and creating one pushes the snapshot
    // (wallet included). An unauthenticated signup must not be able to drive snapshot exports.
    return c.json(AuthSessionResponseSchema.parse(await sessions.issue(user)), 201);
  });

  app.post("/api/v1/auth/login", async (c) => {
    const raw = await readJsonBody(c.req.raw);
    const parsed = AuthLoginRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    // Captcha first (the two-factor step presents the one-time pass the first step handed out).
    const captchaGate = await guards.captcha(c, "login", parsed.data.captcha, parsed.data.email);
    if (!captchaGate.ok) return captchaGate.response;
    // Failed passwords are limited per account and client address (trusted-proxy aware, see
    // security/attempts.ts). The attempt is reserved before the store is read or the password
    // hashed, so a burst of concurrent guesses can't outrun the count.
    const start = sessions.attempts.beginSignIn(parsed.data.email, clientIp(c));
    if (!start.ok) {
      c.header("Retry-After", String(start.retryAfterSeconds));
      return c.json({ error: "too_many_attempts", message: "Too many failed sign-in attempts, try again later" }, 429);
    }
    let userRecord: UserCredentialRecord | null;
    let ok: boolean;
    try {
      userRecord = await store.findUserByEmail(parsed.data.email);
      // Unknown accounts pay for one hash as well, so timing doesn't reveal which emails exist.
      ok = await verifyPasswordOrDummy(parsed.data.password, userRecord?.passwordHash);
    } catch (err) {
      start.attempt.release();
      throw err;
    }
    if (!userRecord || !ok) {
      start.attempt.failed();
      return c.json({ error: "invalid_credentials", message: "Invalid email or password" }, 401);
    }
    start.attempt.succeeded();
    if (userRecord.status !== "active") {
      return c.json({ error: "account_suspended", message: "Account is suspended" }, 403);
    }
    // Backend (admin-only) mode, told only after the password checked out (no account probing).
    if (userRecord.role !== "admin" && (await guards.backendMode())) return refusalResponse(c, BACKEND_MODE_REFUSAL);
    if (userRecord.totpEnabled) {
      const code = parsed.data.totpCode?.trim();
      if (!code) {
        return c.json(
          { error: "totp_required", message: "Enter the code from your authenticator app", ...guards.passFor(captchaGate, "login", parsed.data.email) },
          401,
        );
      }
      if (!loginTotpLimiter.allow(userRecord.id)) {
        return c.json({ error: "too_many_attempts", message: "Too many attempts, try again later" }, 429);
      }
      const state = await store.ops.getTotp(userRecord.id);
      let valid = false;
      if (state?.secretEnc) {
        try {
          valid = await verifyTotp(await decryptSecret(state.secretEnc, vaultSecret), code, userRecord.id);
        } catch {
          valid = false;
        }
      }
      if (!valid) {
        return c.json(
          { error: "invalid_totp", message: "The two-factor code is not valid", ...guards.passFor(captchaGate, "login", parsed.data.email) },
          401,
        );
      }
    }
    const { passwordHash: _, tokenVersion, ...profile } = userRecord;
    await store.ops.touchLastLogin(profile.id);
    // Signed at the version read with the hash just checked: if the password was changed or reset
    // meanwhile, this session belongs to the old password and is refused like the others.
    return c.json(AuthSessionResponseSchema.parse(await sessions.issue(profile, tokenVersion)));
  });

  /**
   * Server-side logout of the presented token only: its id is denylisted until it expires, so a
   * copy of it (another tab, a leaked header) stops working too. Other devices stay signed in; use
   * POST /api/v1/user/sessions/revoke-all for those. Idempotent for expired or invalid tokens.
   */
  app.post("/api/v1/auth/logout", async (c) => {
    if (!(await sessions.logout(c.req.header("Authorization")))) {
      return c.json({ error: "unauthorized", message: "Missing bearer token" }, 401);
    }
    return c.json(LogoutResponseSchema.parse({ loggedOut: true }));
  });

  // ---------------------------------------------------------------------------
  // Authenticated User Self-Service Endpoints
  // ---------------------------------------------------------------------------
  app.get("/api/v1/auth/me", sessions.requireAuth(), guards.backendModeUserGuard(), async (c) => {
    const claims = c.get("authUser");
    const user = await store.getUserById(claims.sub);
    if (!user) {
      return c.json({ error: "unauthorized", message: "User no longer exists" }, 401);
    }
    if (user.status !== "active") {
      // 401 makes the console drop the session, the same as an expired token.
      return c.json({ error: "account_suspended", message: "Account is suspended" }, 401);
    }
    const wallet = await store.getWallet(user.id);
    return c.json({ user, wallet });
  });

  app.use("/api/v1/user/*", sessions.requireAuth());
  // Backend (admin-only) mode: other users' sessions stop working at once.
  app.use("/api/v1/user/*", guards.backendModeUserGuard());

  /** Sign out of all devices: bumps the caller's token version, ending every session at once. */
  app.post("/api/v1/user/sessions/revoke-all", async (c) => {
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        throw new StoreError("bad_request", "Malformed JSON request body");
      }
    }
    const parsed = RevokeAllSessionsRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const userId = c.get("authUser").sub;
    const version = await sessions.revokeAll(userId);
    let session = null;
    if (parsed.data.keepCurrent) {
      // This device keeps going on a fresh token at the new version.
      const user = await store.getUserById(userId);
      if (user) session = await sessions.issue(user, version);
    }
    return c.json(RevokeAllSessionsResponseSchema.parse({ revoked: true, session }));
  });

  async function allowedGroupIdsOf(userId: string): Promise<Set<string>> {
    return new Set((await store.ops.getAdminUser(userId))?.allowedGroupIds ?? []);
  }

  /** Moving a key into an exclusive group needs the same grant as creating one there. */
  async function assertGroupUsable(userId: string, role: string, groupId: string | undefined) {
    if (!groupId || role === "admin") return;
    const group = (await store.listGroups()).find((g) => g.id === groupId);
    if (group?.isExclusive && !(await allowedGroupIdsOf(userId)).has(group.id)) {
      throw new StoreError("forbidden", "This group is reserved for administrators");
    }
  }

  app.get("/api/v1/user/groups", async (c) => {
    const claims = c.get("authUser");
    const granted = claims.role === "admin" ? null : await allowedGroupIdsOf(claims.sub);
    const groups = (await store.listGroups(true)).filter((g) => !g.isExclusive || !granted || granted.has(g.id));
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

  /** Custom (bring-your-own) key creations per user and hour. */
  const customKeyLimiter = new WindowLimiter(10, 60 * 60_000);

  app.post("/api/v1/user/api-keys", async (c) => {
    const claims = c.get("authUser");
    const raw = await readJsonBody(c.req.raw);
    // Omitted RPM / concurrency take the portal's new-key defaults (Settings), not the schema's.
    const parsed = CreateApiKeyRequestSchema.safeParse(withApiKeyDefaults(raw, await store.ops.getSettings()));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    if (claims.role !== "admin") {
      // Look across disabled groups too: an enabled-only lookup misses a disabled exclusive
      // group and would skip this guard, leaving only the store's enabled check in the way.
      const group = (await store.listGroups()).find((g) => g.id === parsed.data.groupId);
      if (group?.isExclusive && !(await allowedGroupIdsOf(claims.sub)).has(group.id)) {
        return c.json({ error: "forbidden", message: "This group is reserved for administrators" }, 403);
      }
    }
    let material: { plaintextKey: string; keyPrefix: string; keyHash: Uint8Array };
    if (parsed.data.customKey) {
      // Every custom-key attempt is a probe of "does this key exist?" (the hash is unique), so
      // attempts are budgeted per user whatever their outcome.
      if (!customKeyLimiter.allow(claims.sub)) {
        return c.json({ error: "too_many_attempts", message: "Too many custom keys, try again later" }, 429);
      }
      const plaintextKey = parsed.data.customKey;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintextKey));
      material = {
        plaintextKey,
        // A chosen key can be short (16 characters): store and show only its first four.
        keyPrefix: `${plaintextKey.slice(0, 4)}...`,
        keyHash: new Uint8Array(digest),
      };
    } else {
      material = await generateApiKey();
    }
    const item = await store.createApiKey(claims.sub, parsed.data, material.keyPrefix, material.keyHash).catch((err: unknown) => {
      if (err instanceof StoreError && err.code === "conflict" && parsed.data.customKey) return null;
      throw err;
    });
    if (!item) {
      // Never say whose key collided, or that it is "in use": one generic refusal.
      return c.json({ error: "conflict", message: "This key can't be used. Choose a different one." }, 409);
    }
    await syncDataPlaneBestEffort();
    return c.json(CreatedApiKeyResponseSchema.parse({ item, plaintextKey: material.plaintextKey }), 201);
  });

  app.patch("/api/v1/user/api-keys/:keyId", async (c) => {
    const claims = c.get("authUser");
    const keyId = c.req.param("keyId");
    const raw = await readJsonBody(c.req.raw);
    const parsed = UpdateApiKeyRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    await assertGroupUsable(claims.sub, claims.role, parsed.data.groupId);
    const item = await store.updateUserApiKey(claims.sub, keyId, parsed.data);
    await syncDataPlaneBestEffort();
    return c.json({ item });
  });

  app.post("/api/v1/user/api-keys/bulk", async (c) => {
    const claims = c.get("authUser");
    const raw = await readJsonBody(c.req.raw);
    const parsed = BulkUpdateApiKeysRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    await assertGroupUsable(claims.sub, claims.role, parsed.data.patch.groupId);
    // One UPDATE for every key and one listing of just those keys (not a per-key round trip).
    const result = await store.updateUserApiKeys(claims.sub, parsed.data.keyIds, parsed.data.patch);
    const failed = result.failed.map((f) => ({ keyId: f.keyId, message: f.error.message }));
    await syncDataPlaneBestEffort();
    return c.json({ items: result.items, failed });
  });

  app.delete("/api/v1/user/api-keys/:keyId", async (c) => {
    const claims = c.get("authUser");
    const keyId = c.req.param("keyId");
    await store.deleteUserApiKey(claims.sub, keyId);
    await syncDataPlaneBestEffort();
    return c.json({ deleted: true, keyId });
  });

  // ---------------------------------------------------------------------------
  // Internal DataPlane Synchronization & Post-Turn Settlement Bridge
  // ---------------------------------------------------------------------------
  app.get("/api/v1/internal/dataplane/snapshot", async (c) => {
    if (!verifyInternalHeader(c)) {
      return c.json({ error: "forbidden", message: "Invalid internal supervisor token" }, 403);
    }
    // Overlapping pulls (and pushes) share one export instead of piling up behind a slow one.
    const snapshot = await sharedSnapshot();
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
    // Admin price rules override the core's built-in rates for charged turns, and a turn the core
    // could not settle (coreSettled: false) is priced here rather than recorded as free.
    const reported = parsed.data;
    let event = reported;
    const rules = await pricing.rules();
    // A user's custom group rate replaces the group's: billed here whatever slipgate-core held.
    const userRate = await userRates.rateFor(reported.userId, reported.groupId);
    if (rules.length > 0 || reported.coreSettled === false || userRate !== null) {
      event = repriceForUser(event, rules, (await groupMeta()).multipliers.get(event.groupId) ?? 1, userRate);
    }
    // Idempotent per settlement id: net-go redelivers until it gets a 2xx.
    const { settlementId, duplicate, walletBalanceAfterNanoUsd, ...item } = await store.recordTurnSettlement(event);
    if (!duplicate && BigInt(item.costNanoUsd) > 0n) {
      try {
        // The core held and debited its local wallet at its own valuation. When the bill came out
        // higher (a price rule it has not received yet, or a turn it never settled) its view of the
        // wallet is too generous: push the real balance before it admits turns nobody can pay for.
        if (walletBalanceAfterNanoUsd !== undefined) {
          const balance = BigInt(walletBalanceAfterNanoUsd);
          const underValued = BigInt(event.costNanoUsd) > BigInt(reported.costNanoUsd);
          if (balance <= 0n || (underValued && balance < BigInt(event.costNanoUsd) * LOW_BALANCE_TURNS)) {
            scheduleDataPlaneSync(250);
          }
        }
        if ((await limitedKeyIds()).has(item.apiKeyId)) {
          await keyCapChecks.request(item.apiKeyId, async () => {
            const state = await store.getApiKeyLimitState(item.apiKeyId);
            if (state && state !== "ok") scheduleDataPlaneSync();
          });
        }
        if ((await groupMeta()).subscriptionGroupIds.has(item.groupId)) {
          await subscriptionCapChecks.request(`${item.userId}\u0000${item.groupId}`, async () => {
            if (await store.ops.isSubscriptionOverLimit(item.userId, item.groupId)) scheduleDataPlaneSync();
          });
        }
      } catch {
        // The settlement is recorded; the periodic snapshot pull still converges.
      }
    }
    return c.json({ ok: true, settlementId, duplicate, item });
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
  app.use("/api/v1/admin/*", sessions.requireAdmin());
  app.use("/api/v1/admin/*", auditMiddleware(store));

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

  app.post("/api/v1/admin/groups/:groupId/duplicate", async (c) => {
    const group = await store.duplicateGroup(c.req.param("groupId"));
    await syncDataPlaneBestEffort();
    return c.json({ group }, 201);
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
    const account = await store.createAccount(parsed.data, await sealCredential(parsed.data.credentialSecret));
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
    const credential =
      parsed.data.credentialSecret !== undefined ? await sealCredential(parsed.data.credentialSecret) : undefined;
    const account = await store.updateAccount(accountId, parsed.data, credential);
    await syncDataPlaneBestEffort();
    return c.json({ account });
  });

  app.delete("/api/v1/admin/accounts/:accountId", async (c) => {
    const accountId = c.req.param("accountId");
    await store.deleteAccount(accountId);
    await syncDataPlaneBestEffort();
    return c.json({ deleted: true, accountId });
  });

  async function runAccountBatch(
    accountIds: string[],
    op: (accountId: string) => Promise<unknown>,
  ): Promise<AccountBulkResult> {
    const results: AccountBulkResult["results"] = [];
    for (const id of new Set(accountIds)) {
      try {
        await op(id);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    }
    const success = results.filter((r) => r.ok).length;
    if (success > 0) {
      await syncDataPlaneBestEffort();
    }
    return { success, failed: results.length - success, results };
  }

  app.post("/api/v1/admin/accounts/bulk-update", async (c) => {
    const parsed = AccountBulkUpdateRequestSchema.safeParse(await readJsonBody(c.req.raw));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const { accountIds, patch } = parsed.data;
    return c.json(await runAccountBatch(accountIds, (id) => store.updateAccount(id, patch)));
  });

  app.post("/api/v1/admin/accounts/batch-delete", async (c) => {
    const parsed = AccountBatchDeleteRequestSchema.safeParse(await readJsonBody(c.req.raw));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    return c.json(await runAccountBatch(parsed.data.accountIds, (id) => store.deleteAccount(id)));
  });

  /** Per-account request / token / cost totals since the viewer's local midnight. */
  app.get("/api/v1/admin/accounts/usage-today", async (c) => {
    const nowMs = Date.now();
    const sinceMs = dashboardWindow("24h", nowMs, parseTzOffset(c.req.query("tz"))).todayStartMs;
    const sinceIso = new Date(sinceMs).toISOString();
    const body: AccountUsageSummaryResponse = {
      generatedAtIso: new Date(nowMs).toISOString(),
      sinceIso,
      items: await store.summarizeAccountUsage(sinceIso),
    };
    return c.json(body);
  });

  /** Traffic trend, model mix and error codes of one account. `range` = 24h | 7d | 30d. */
  app.get("/api/v1/admin/accounts/:accountId/stats", async (c) => {
    const accountId = c.req.param("accountId");
    if (!(await store.getAccount(accountId))) {
      return c.json({ error: "not_found", message: `Account ${accountId} not found` }, 404);
    }
    const range = AccountStatsRangeSchema.catch("7d").parse(c.req.query("range") ?? "7d");
    const tzOffsetMinutes = parseTzOffset(c.req.query("tz"));
    const nowMs = Date.now();
    const win = dashboardWindow(range, nowMs, tzOffsetMinutes);
    const logs = await store.listUsageLogs({
      accountId,
      sinceIso: new Date(win.sinceMs).toISOString(),
      limit: DASHBOARD_MAX_ROWS,
    });
    return c.json(
      buildAccountUsageStats({
        accountId,
        range,
        nowMs,
        tzOffsetMinutes,
        logs,
        truncated: logs.length >= DASHBOARD_MAX_ROWS,
      }),
    );
  });

  /**
   * Bulk-create accounts (pasted credentials, Slipgate backups, sub2api / linksyncx exports
   * parsed client-side). Each item is validated and created on its own; duplicates of a
   * stored credential, or of an earlier item, are skipped when `skipExisting` is set.
   */
  app.post("/api/v1/admin/accounts/import", async (c) => {
    const parsed = AccountImportRequestSchema.safeParse(await readJsonBody(c.req.raw));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const { accounts: items, skipExisting } = parsed.data;
    type Prepared =
      | { ok: false; index: number; name: string; error: string }
      | { ok: true; index: number; name: string; req: CreateAccountRequest; fingerprint: string };
    const prepared = await Promise.all(
      items.map(async (raw, index): Promise<Prepared> => {
        const rawName = raw && typeof raw === "object" ? (raw as { name?: unknown }).name : undefined;
        const fallbackName = typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 64) : `#${index + 1}`;
        const req = CreateAccountRequestSchema.safeParse(raw);
        if (!req.success) {
          return { ok: false, index, name: fallbackName, error: describeIssues(req.error.issues) };
        }
        const fingerprint = await fingerprintOf(req.data.credentialSecret);
        return { ok: true, index, name: req.data.name, req: req.data, fingerprint };
      }),
    );

    let existing = new Map<string, string>();
    if (skipExisting) {
      await ensureCredentialFingerprints();
      existing = await store.findAccountsByFingerprint(
        prepared.flatMap((p) => (p.ok ? [p.fingerprint] : [])),
      );
    }

    const results: AccountImportResult["results"] = [];
    const firstInBatch = new Map<string, number>();
    for (const item of prepared) {
      if (!item.ok) {
        results.push({ index: item.index, name: item.name, outcome: "failed", message: item.error });
        continue;
      }
      if (skipExisting) {
        const holder = existing.get(item.fingerprint);
        if (holder) {
          results.push({ index: item.index, name: item.name, outcome: "skipped", duplicateOf: holder });
          continue;
        }
        const earlier = firstInBatch.get(item.fingerprint);
        if (earlier !== undefined) {
          results.push({
            index: item.index,
            name: item.name,
            outcome: "skipped",
            duplicateOfIndex: earlier,
            message: `duplicate of item #${earlier + 1}`,
          });
          continue;
        }
      }
      try {
        const trimmed = item.req.credentialSecret.trim();
        const account = await store.createAccount(item.req, {
          encrypted: await encryptSecret(trimmed, vaultSecret),
          preview: maskSecret(trimmed),
          fingerprint: item.fingerprint,
        });
        firstInBatch.set(item.fingerprint, item.index);
        results.push({ index: item.index, name: item.name, outcome: "created", accountId: account.id });
      } catch (err) {
        results.push({
          index: item.index,
          name: item.name,
          outcome: "failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const created = results.filter((r) => r.outcome === "created").length;
    const skipped = results.filter((r) => r.outcome === "skipped").length;
    if (created > 0) {
      await syncDataPlaneBestEffort();
    }
    const body: AccountImportResult = { created, skipped, failed: results.length - created - skipped, results };
    return c.json(body);
  });

  /**
   * Backup with plaintext credentials. Requires the caller's password even though the
   * session is already an admin one: a stolen token alone must not dump every upstream key.
   */
  app.post("/api/v1/admin/accounts/export", async (c) => {
    const parsed = AccountExportRequestSchema.safeParse(await readJsonBody(c.req.raw));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const claims = c.get("authUser");
    // requireAdmin re-read the caller's role and status from the store for this request. The
    // password goes through the same per-user attempt limit as every other password check made
    // with a session, so a stolen admin token is not an unlimited password oracle here either.
    const check = await sessions.confirmPassword(claims.sub, clientIp(c), parsed.data.password);
    if (!check.ok) {
      if (check.retryAfterSeconds !== null) {
        c.header("Retry-After", String(check.retryAfterSeconds));
        return c.json({ error: "too_many_attempts", message: "Too many wrong passwords, try again later" }, 429);
      }
      return c.json({ error: "invalid_password", message: "Password confirmation failed" }, 403);
    }
    const wanted = parsed.data.accountIds ? new Set(parsed.data.accountIds) : null;
    const accounts = (await store.listAccounts()).filter((a) => !wanted || wanted.has(a.id));
    const secrets = new Map(
      (await store.listAccountSecrets(accounts.map((a) => a.id))).map((s) => [s.accountId, s.encrypted]),
    );
    const file: AccountExportFile = {
      type: SLIPGATE_ACCOUNT_EXPORT_TYPE,
      version: 1,
      exportedAtIso: new Date().toISOString(),
      accounts: [],
      skipped: [],
    };
    for (const acc of accounts) {
      const encrypted = secrets.get(acc.id);
      let credentialSecret: string | null = null;
      if (encrypted) {
        try {
          credentialSecret = await decryptSecret(encrypted, vaultSecret);
        } catch {
          credentialSecret = null;
        }
      }
      if (credentialSecret === null) {
        file.skipped.push({ name: acc.name, reason: "credential_unreadable" });
        continue;
      }
      file.accounts.push({
        name: acc.name,
        notes: acc.notes,
        groupName: acc.groupName,
        platform: acc.platform,
        executionMode: acc.executionMode,
        authKind: acc.authKind,
        subscriptionTier: acc.subscriptionTier,
        maxConcurrency: acc.maxConcurrency,
        priority: acc.priority,
        status: acc.status,
        expiresAtIso: acc.expiresAtIso,
        autoPauseOnExpired: acc.autoPauseOnExpired,
        credentialSecret,
      });
    }
    c.header("Cache-Control", "no-store");
    return c.json(file);
  });

  /**
   * Streams a connectivity test for one non-VM account as text/event-stream.
   * The request leaves through the Go data plane (account persona, uTLS profile and bound exit IP),
   * never from the BFF host. The final done/error event is persisted as the account's lastTest.
   */
  app.post("/api/v1/admin/accounts/:accountId/test", async (c) => {
    const accountId = c.req.param("accountId");
    const bodyText = await c.req.text();
    let raw: unknown = {};
    if (bodyText.trim()) {
      try {
        raw = JSON.parse(bodyText);
      } catch {
        return c.json({ error: "invalid_request", message: "Malformed JSON request body" }, 400);
      }
    }
    const parsed = AccountTestRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }
    const account = await store.getAccount(accountId);
    if (!account) {
      return c.json({ error: "not_found", message: `Account ${accountId} not found` }, 404);
    }
    if (account.executionMode === "vm_slot") {
      return c.json({ error: "vm_slot_unsupported", message: "VM slot accounts are tested from their slot" }, 400);
    }
    const internalUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    if (!internalUrl || !internalToken) {
      return c.json(
        {
          error: "net_supervisor_unconfigured",
          message: "Account tests run through the network service, which is not configured in standalone BFF mode",
        },
        503,
      );
    }

    // Make sure the data plane vault holds the latest credentials before probing.
    await syncDataPlaneBestEffort();

    let upstream: Response;
    try {
      upstream = await fetch(`${internalUrl}/internal/net/accounts/${encodeURIComponent(accountId)}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Slipgate-Internal-Token": internalToken },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (err) {
      return c.json(
        { error: "net_supervisor_unreachable", message: err instanceof Error ? err.message : String(err) },
        502,
      );
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !upstream.body || !contentType.includes("text/event-stream")) {
      const payload = (await upstream.json().catch(() => ({}))) as { error?: string; message?: string };
      return c.json(
        { error: payload.error ?? "net_supervisor_error", message: payload.message ?? `HTTP ${upstream.status}` },
        toForwardStatus(upstream.status),
      );
    }

    const startedAt = Date.now();
    let model = parsed.data.model ?? "";
    let outcome: AccountTestResult | null = null;
    let buffered = "";
    const decoder = new TextDecoder();
    const observe = (text: string) => {
      buffered += text;
      let nl = buffered.indexOf("\n");
      while (nl >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        let json: unknown;
        try {
          json = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        const ev = AccountTestEventSchema.safeParse(json);
        if (!ev.success) continue;
        const e = ev.data;
        if (e.type === "start" && e.model) model = e.model;
        if (e.type === "done" || e.type === "error") {
          const ok = e.type === "done" && e.success === true;
          outcome = {
            ok,
            atIso: new Date().toISOString(),
            model,
            durationMs: Math.max(0, Math.round(e.durationMs ?? Date.now() - startedAt)),
            message: ok ? "" : (e.message ?? e.code ?? (e.status ? `HTTP ${e.status}` : "test failed")).slice(0, 500),
          };
        }
      }
    };

    const relay = upstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          observe(decoder.decode(chunk, { stream: true }));
        },
        async flush() {
          observe(decoder.decode());
          if (outcome) {
            await store.recordAccountTestResult(accountId, outcome).catch(() => undefined);
          }
        },
      }),
    );
    return new Response(relay, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  });

  /**
   * Aggregated console statistics. `range` = 24h (hourly buckets) | 7d | 30d (daily buckets);
   * `tz` = the viewer's Date#getTimezoneOffset() so "today" and day buckets follow local time.
   */
  app.get("/api/v1/admin/dashboard/stats", async (c) => {
    const range = DashboardRangeSchema.catch("7d").parse(c.req.query("range") ?? "7d");
    const tzOffsetMinutes = parseTzOffset(c.req.query("tz"));
    const nowMs = Date.now();
    const win = dashboardWindow(range, nowMs, tzOffsetMinutes);
    const [logs, users, groups, accounts, snapshot] = await Promise.all([
      store.listUsageLogs({ sinceIso: new Date(win.sinceMs).toISOString(), limit: DASHBOARD_MAX_ROWS }),
      store.listUsers(),
      store.listGroups(false),
      store.listAccounts(),
      store.exportDataPlaneSnapshot(),
    ]);
    return c.json(
      buildDashboardStats({
        range,
        nowMs,
        tzOffsetMinutes,
        logs,
        truncated: logs.length >= DASHBOARD_MAX_ROWS,
        users,
        groups,
        accounts,
        apiKeys: snapshot.apiKeys,
      }),
    );
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
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const events = await store.listRiskBanEvents(Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 50);
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

  // Before the ops routes: its public-page guards and settings-write hook wrap their handlers.
  registerAuthGuardRoutes(app, guards);
  registerOpsRoutes(app, {
    store,
    vaultSecret,
    syncDataPlane: syncDataPlaneBestEffort,
    mailReady: () => mail.ready(),
    pricingRules: () => pricing.rules(),
    sessions,
    publicCaptcha: () => guards.publicCaptcha(),
  });
  registerUserLimitRoutes(app, { store, sessions, syncDataPlane: syncDataPlaneBestEffort, internalToken });
  mail = registerMailRoutes(app, { store, vaultSecret, sessions, deliver: options.mailDelivery, guards });
  // Price rules travel in the data-plane snapshot, so an edit is pushed like any other change.
  pricing = registerPricingRoutes(app, store, () => void syncDataPlaneBestEffort());
  const autoTester = new AccountAutoTester(store, () => {
    const url = process.env.SLIPGATE_NET_INTERNAL_URL;
    return url && internalToken ? { url, token: internalToken } : null;
  });
  registerAutoTestRoutes(app, autoTester);
  mountAuditRetention(app, store, options.startSchedulers === true, vaultSecret);
  registerSystemLogRoutes(app, store, systemLogs, { verifyInternal: verifyInternalHeader });
  registerAnnouncementRoutes(app, store);
  if (!registry.list().some((p) => p.name === paymentWebhookPlugin.name)) registry.register(paymentWebhookPlugin);
  const plugins = registerPluginRoutes(app, store, registry, vaultSecret);
  registerOAuthRoutes(app, { store, vaultSecret, jwtSecret, fetchImpl: options.oauthFetch, guards });
  registerBackupRoutes(app, store, async () => {
    pricing.invalidate();
    await plugins.reload();
    await syncDataPlaneBestEffort();
  });
  mountDbBackups(app, {
    store,
    sessions,
    vaultSecret,
    jwtSecret,
    options: options.dbBackup,
    startScheduler: options.startSchedulers === true,
    // A restored dump may predate today's schema: re-apply it, then reload what is cached in memory.
    afterRestore: async () => {
      await store.init();
      pricing.invalidate();
      await plugins.reload();
      await syncDataPlaneBestEffort();
    },
  });
  if (options.startSchedulers) autoTester.start();
  registerPaymentRoutes(app, {
    store,
    vaultSecret,
    fetchImpl: options.paymentFetch,
    startSchedulers: options.startSchedulers === true,
    syncDataPlane: syncDataPlaneBestEffort,
    onOrderPaid: (order) =>
      registry.emitPaymentSettled(
        {
          serviceVersion: "0.1.0",
          logger: (msg, meta) => console.log(`[plugin] ${msg}`, meta ?? {}),
        },
        { orderId: order.id, userId: order.userId, provider: order.provider, amountNanoUsd: order.creditNanoUsd },
      ),
  });

  return app;
}
