import {
  ACCOUNT_TEST_HISTORY_LIMIT,
  ACCOUNT_TEST_PLANS_PER_ACCOUNT,
  ACCOUNT_TEST_PLAN_RESULTS_MAX,
  ACCOUNT_QUOTA_DAY_MS,
  ACCOUNT_QUOTA_WEEK_MS,
  accountQuotaLimited,
  accountQuotaState,
  effectiveAccountStatus,
  formatNanoUsd,
  parseUsdToNano,
  isSubscriptionTierAllowedForProvider,
  effectiveSubscriptionTier,
  subscriptionTierMultiplier,
  type AccountPrivacyMode,
  type AccountQuota,
  type AccountQuotaState,
  type AccountTestResult,
  type AccountTestRun,
  type UpdateAccountTestPlanRequest,
  type CreateAccountTestPlanRequest,
  type AccountTestPlan,
  type AccountUsageSummaryItem,
  type ApiKeyItem,
  type CreateAccountRequest,
  type CreateApiKeyRequest,
  type CreateCompositeRouteRequest,
  type CreateGroupRequest,
  type DataPlaneSyncSnapshot,
  type GroupItem,
  ModelPricingRuleSchema,
  type ModelPricingRule,
  type RecordRiskBanInput,
  type RiskBanEvent,
  type SetupInitializeRequest,
  type SetupStatus,
  type StoredCompositeRoute,
  type TurnSettlementEvent,
  type UpdateAccountRequest,
  type UpdateApiKeyRequest,
  type UpdateGroupRequest,
  type TempUnschedRule,
  type UpstreamAccount,
  type UsageLogItem,
  type UserProfile,
  type WalletSummary,
} from "@slipgate/contracts";
import { normalizeIso, resolveCooldownChange } from "./account_patch.ts";
import {
  memoryRegistrationConflict,
  RegistrationGuardError,
  type RegistrationConflict,
  type RegistrationGuard,
} from "./auth_guards_store.ts";
import { applyMemoryWalletDelta, MemoryOpsStore, type MemoryLedgerEntry, type MemoryWallet } from "./memory_ops.ts";
import { MemoryPaymentsStore } from "./memory_payments.ts";
import { MemorySystemLogStore } from "./memory_system_logs.ts";
import { MemoryDbBackupStore } from "./db_backups_memory.ts";
import { MemoryUserLimitsStore } from "./memory_user_limits.ts";
import { MemoryRequestErrorStore } from "./memory_request_errors.ts";
import { MemoryAlertStore } from "./memory_alerts.ts";
import { MemoryChannelMonitorStore } from "./memory_channel_monitors.ts";
import { MemoryPlatformQuotasStore } from "./memory_platform_quotas.ts";
import { MemoryUsageRollupsStore } from "./memory_usage_rollups.ts";
import { MemoryModerationStore } from "./memory_moderation.ts";
import { MemoryPasskeyStore } from "./memory_passkeys.ts";
import { MemorySitePagesStore } from "./memory_site_pages.ts";
import { MemoryUserAttributesStore } from "./memory_user_attributes.ts";
import type { OpsStore } from "./ops_types.ts";
import type { PaymentsStore } from "./payments_types.ts";
import {
  SETTLEMENT_ID_RETENTION_DAYS,
  settlementIdOf,
  StoreError,
  type AccountSecretRecord,
  type ApiKeyBulkResult,
  type ControlStore,
  type PersistedMediaTaskRecord,
  type StoredCredential,
  type StoredUserRecord,
  type UserCredentialRecord,
  type TurnSettlementResult,
  type UsageLogFilter,
} from "./types.ts";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

type InternalGroup = Omit<GroupItem, "accountCount" | "activeAccountCount" | "apiKeyCount">;

function cloneRules(rules: readonly TempUnschedRule[]): TempUnschedRule[] {
  return rules.map((r) => ({ ...r, keywords: [...r.keywords] }));
}

interface InternalAccount extends Omit<UpstreamAccount, "groupName" | "effectiveStatus" | "quota"> {
  /** Spend quota limits, nano-USD ("0" = none), and the reset floor. */
  quotaDailyLimitNanoUsd: string;
  quotaWeeklyLimitNanoUsd: string;
  quotaTotalLimitNanoUsd: string;
  quotaResetAtIso: string | null;
  credentialsEnc: Uint8Array;
  credentialFingerprint: string | null;
  window5hResetAtMs: number | null;
  window7dResetAtMs: number | null;
}

type ComputedKeyFields =
  | "groupName"
  | "usage5hNanoUsd"
  | "usage1dNanoUsd"
  | "usage7dNanoUsd"
  | "limitState";

interface InternalApiKey extends Omit<ApiKeyItem, ComputedKeyFields> {
  keyHash: Uint8Array;
  /** Rolling-window spend before this instant is ignored (key "reset windows"). */
  usageResetAtIso: string | null;
}

const HOUR_MS = 3_600_000;

type InternalWallet = MemoryWallet;

/** USD cap typed by an admin ("0" = unlimited) → nano-USD digits. */
function limitNano(usd: string | undefined, fallback = "0"): string {
  if (usd === undefined) return fallback;
  const nano = parseUsdToNano(usd);
  return (nano > 0n ? nano : 0n).toString();
}

export class MemoryControlStore implements ControlStore {
  private setup: SetupStatus = {
    initialized: false,
    siteName: "Slipgate Gateway",
    allowRegistration: true,
  };

  private readonly users = new Map<string, StoredUserRecord>();
  private readonly wallets = new Map<string, InternalWallet>();
  private readonly idempotencyKeys = new Set<string>();
  private readonly groups = new Map<string, InternalGroup>();
  private readonly accounts = new Map<string, InternalAccount>();
  /** Test history per account, newest first (plan runs pruned per plan, others to ACCOUNT_TEST_HISTORY_LIMIT). */
  private readonly accountTestRuns = new Map<string, AccountTestRun[]>();
  /** Scheduled test plans by id. */
  private readonly accountTestPlans = new Map<string, AccountTestPlan>();
  private readonly apiKeys = new Map<string, InternalApiKey>();
  private readonly routes = new Map<string, StoredCompositeRoute>();
  /** Settlement id -> the usage row it recorded (billing idempotency, see recordTurnSettlement). */
  private readonly settlements = new Map<string, { usageId: string; createdAtIso: string }>();
  private readonly usageLogs: UsageLogItem[] = [];
  private pricingRules: ModelPricingRule[] | null = null;
  private readonly mediaTasks = new Map<string, PersistedMediaTaskRecord>();
  private readonly riskEvents: {
    event: RiskBanEvent;
    expiresAtMs: number | null;
    unbannedAtMs: number | null;
  }[] = [];
  private readonly activeRiskBans = new Map<
    string,
    { subjectKind: RiskBanEvent["subjectKind"]; subjectHash: string; strikeLevel: number; bannedUntilUnixMs: number }
  >();
  private readonly ledger: MemoryLedgerEntry[] = [];

  private readonly walletState = { wallets: this.wallets, idempotencyKeys: this.idempotencyKeys, ledger: this.ledger };

  readonly ops: OpsStore & Pick<MemoryOpsStore, "tokenVersionOf"> = new MemoryOpsStore({
    getSetup: () => ({ ...this.setup }),
    patchSetup: (patch) => {
      this.setup = { ...this.setup, ...patch };
    },
    users: this.users,
    wallets: this.wallets,
    idempotencyKeys: this.idempotencyKeys,
    ledger: this.ledger,
    groups: this.groups,
    apiKeys: this.apiKeys,
    accounts: this.accounts,
    usageLogs: this.usageLogs,
  });

  readonly systemLogs = new MemorySystemLogStore();
  readonly dbBackups = new MemoryDbBackupStore();

  readonly userLimits = new MemoryUserLimitsStore({
    users: this.users,
    groups: this.groups,
    apiKeys: this.apiKeys,
    usageLogs: this.usageLogs,
    ops: () => this.ops,
  });

  readonly requestErrors = new MemoryRequestErrorStore({
    users: this.users,
    accounts: this.accounts,
    groups: this.groups,
  });

  readonly alerts = new MemoryAlertStore();

  readonly channelMonitors = new MemoryChannelMonitorStore({
    accounts: this.accounts,
    groups: this.groups,
  });

  readonly platformQuotas = new MemoryPlatformQuotasStore({
    users: this.users,
    usageLogs: this.usageLogs,
  });

  readonly usageRollups = new MemoryUsageRollupsStore({
    usageLogs: this.usageLogs,
  });

  readonly moderation = new MemoryModerationStore();
  readonly passkeys = new MemoryPasskeyStore();
  readonly userAttributes = new MemoryUserAttributesStore({ hasUser: (id) => this.users.has(id) });
  readonly sitePages = new MemorySitePagesStore();

  readonly payments: PaymentsStore = new MemoryPaymentsStore(
    {
      users: this.users,
      wallets: this.wallets,
      idempotencyKeys: this.idempotencyKeys,
      ledger: this.ledger,
      groups: this.groups,
    },
    this.ops,
  );

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async getSetupStatus(): Promise<SetupStatus> {
    return { ...this.setup };
  }

  async initializeSetup(
    req: SetupInitializeRequest,
    adminPasswordHash: string,
  ): Promise<UserProfile> {
    if (this.setup.initialized) {
      throw new StoreError("conflict", "Slipgate is already initialized");
    }
    const normalizedEmail = req.adminEmail.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === normalizedEmail) {
        throw new StoreError("conflict", "Admin email already exists");
      }
    }

    const now = new Date().toISOString();
    const adminId = `usr_${crypto.randomUUID()}`;
    const admin: StoredUserRecord = {
      id: adminId,
      email: normalizedEmail,
      username: "",
      avatarUrl: "",
      emailVerified: false,
      passwordHash: adminPasswordHash,
      role: "admin",
      status: "active",
      totpEnabled: false,
      createdAtIso: now,
    };
    this.users.set(adminId, admin);
    this.wallets.set(adminId, { balanceNano: 0n, heldNano: 0n, spentNano: 0n });

    // Seed a default composite routing group so newly initialized users can immediately issue keys.
    const defaultGroupId = "grp_default";
    if (!this.groups.has(defaultGroupId)) {
      this.groups.set(defaultGroupId, {
        id: defaultGroupId,
        name: "default-composite",
        description: "",
        platform: "composite",
        subscriptionType: "balance",
        rateMultiplier: 1,
        modelAllowlist: [],
        isExclusive: false,
        sortOrder: 0,
        enabled: true,
        dailyLimitNanoUsd: "0",
        weeklyLimitNanoUsd: "0",
        monthlyLimitNanoUsd: "0",
        defaultValidityDays: 30,
        rpmLimit: 0,
        concurrencyLimit: 0,
        createdAtIso: now,
      });
    }

    this.setup = {
      initialized: true,
      siteName: req.siteName,
      allowRegistration: req.allowRegistration,
    };

    const { passwordHash: _, ...profile } = admin;
    return profile;
  }

  async registerUser(email: string, passwordHash: string, guard?: RegistrationGuard): Promise<UserProfile> {
    if (!this.setup.initialized) {
      throw new StoreError("conflict", "System setup has not completed yet");
    }
    if (!this.setup.allowRegistration) {
      throw new StoreError("forbidden", "Public user registration is disabled");
    }
    // Checked and inserted with no await in between (one winner among concurrent variants).
    const conflict = guard ? memoryRegistrationConflict(this.users.values(), email, guard) : null;
    if (conflict) throw new RegistrationGuardError(conflict);
    const normalizedEmail = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === normalizedEmail) {
        throw new StoreError("conflict", "Email is already registered");
      }
    }

    const userId = `usr_${crypto.randomUUID()}`;
    const user: StoredUserRecord = {
      id: userId,
      email: normalizedEmail,
      username: "",
      avatarUrl: "",
      emailVerified: false,
      passwordHash,
      role: "user",
      status: "active",
      totpEnabled: false,
      createdAtIso: new Date().toISOString(),
    };
    this.users.set(userId, user);
    this.wallets.set(userId, { balanceNano: 0n, heldNano: 0n, spentNano: 0n });
    const { passwordHash: _, ...profile } = user;
    return profile;
  }

  async findUserByEmail(email: string): Promise<UserCredentialRecord | null> {
    const normalized = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === normalized) {
        // Hash and token version in the same synchronous step (one consistent read).
        return { ...u, tokenVersion: this.ops.tokenVersionOf(u.id) };
      }
    }
    return null;
  }

  async registrationEmailConflict(email: string, guard: RegistrationGuard): Promise<RegistrationConflict | null> {
    return memoryRegistrationConflict(this.users.values(), email, guard);
  }

  async getUserById(userId: string): Promise<UserProfile | null> {
    const u = this.users.get(userId);
    if (!u) return null;
    const { passwordHash: _, ...profile } = u;
    return profile;
  }

  async listUsers(): Promise<UserProfile[]> {
    return Array.from(this.users.values()).map(({ passwordHash: _, ...profile }) => profile);
  }

  async getWallet(userId: string): Promise<WalletSummary> {
    if (!this.users.has(userId)) {
      throw new StoreError("not_found", `User ${userId} not found`);
    }
    const w = this.wallets.get(userId) ?? { balanceNano: 0n, heldNano: 0n, spentNano: 0n };
    const available = w.balanceNano - w.heldNano;
    return {
      userId,
      balanceNanoUsd: w.balanceNano.toString(),
      heldNanoUsd: w.heldNano.toString(),
      availableNanoUsd: available.toString(),
      formattedAvailableUsd: formatNanoUsd(available),
    };
  }

  async creditWallet(
    userId: string,
    amountNanoUsd: bigint,
    idempotencyKey: string,
    _reason: string,
  ): Promise<WalletSummary> {
    if (amountNanoUsd <= 0n) {
      throw new StoreError("bad_request", "Credit amount must be positive");
    }
    if (!this.users.has(userId)) {
      throw new StoreError("not_found", `User ${userId} not found`);
    }
    applyMemoryWalletDelta(this.walletState, userId, amountNanoUsd, idempotencyKey, "credit", _reason);
    return this.getWallet(userId);
  }

  private withGroupCounts(g: InternalGroup): GroupItem {
    let accountCount = 0;
    let activeAccountCount = 0;
    for (const acc of this.accounts.values()) {
      if (acc.groupId !== g.id) continue;
      accountCount += 1;
      if (effectiveAccountStatus(acc) === "active") activeAccountCount += 1;
    }
    let apiKeyCount = 0;
    for (const key of this.apiKeys.values()) {
      if (key.groupId === g.id) apiKeyCount += 1;
    }
    return { ...g, modelAllowlist: [...g.modelAllowlist], accountCount, activeAccountCount, apiKeyCount };
  }

  private assertGroupNameFree(name: string, exceptId?: string) {
    for (const [id, g] of this.groups.entries()) {
      if (id !== exceptId && g.name.toLowerCase() === name.toLowerCase()) {
        throw new StoreError("conflict", `Group "${name}" already exists`);
      }
    }
  }

  async listGroups(enabledOnly = false): Promise<GroupItem[]> {
    return Array.from(this.groups.values())
      .filter((g) => !enabledOnly || g.enabled)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAtIso.localeCompare(b.createdAtIso))
      .map((g) => this.withGroupCounts(g));
  }

  async createGroup(req: CreateGroupRequest): Promise<GroupItem> {
    this.assertGroupNameFree(req.name);
    const id = `grp_${crypto.randomUUID()}`;
    const item: InternalGroup = {
      id,
      name: req.name,
      description: req.description,
      platform: req.platform,
      subscriptionType: req.subscriptionType,
      rateMultiplier: req.rateMultiplier,
      modelAllowlist: [...req.modelAllowlist],
      isExclusive: req.isExclusive,
      sortOrder: req.sortOrder,
      enabled: req.enabled,
      dailyLimitNanoUsd: limitNano(req.dailyLimitUsd),
      weeklyLimitNanoUsd: limitNano(req.weeklyLimitUsd),
      monthlyLimitNanoUsd: limitNano(req.monthlyLimitUsd),
      defaultValidityDays: req.defaultValidityDays,
      rpmLimit: req.rpmLimit,
      concurrencyLimit: req.concurrencyLimit,
      createdAtIso: new Date().toISOString(),
    };
    this.groups.set(id, item);
    return this.withGroupCounts(item);
  }

  async updateGroup(groupId: string, req: UpdateGroupRequest): Promise<GroupItem> {
    const existing = this.groups.get(groupId);
    if (!existing) {
      throw new StoreError("not_found", `Group ${groupId} not found`);
    }
    if (req.name !== undefined) {
      this.assertGroupNameFree(req.name, groupId);
      existing.name = req.name;
    }
    if (req.description !== undefined) existing.description = req.description;
    if (req.subscriptionType !== undefined) existing.subscriptionType = req.subscriptionType;
    if (req.rateMultiplier !== undefined) existing.rateMultiplier = req.rateMultiplier;
    if (req.modelAllowlist !== undefined) existing.modelAllowlist = [...req.modelAllowlist];
    if (req.isExclusive !== undefined) existing.isExclusive = req.isExclusive;
    if (req.sortOrder !== undefined) existing.sortOrder = req.sortOrder;
    if (req.enabled !== undefined) existing.enabled = req.enabled;
    existing.dailyLimitNanoUsd = limitNano(req.dailyLimitUsd, existing.dailyLimitNanoUsd);
    existing.weeklyLimitNanoUsd = limitNano(req.weeklyLimitUsd, existing.weeklyLimitNanoUsd);
    existing.monthlyLimitNanoUsd = limitNano(req.monthlyLimitUsd, existing.monthlyLimitNanoUsd);
    if (req.defaultValidityDays !== undefined) existing.defaultValidityDays = req.defaultValidityDays;
    if (req.rpmLimit !== undefined) existing.rpmLimit = req.rpmLimit;
    if (req.concurrencyLimit !== undefined) existing.concurrencyLimit = req.concurrencyLimit;
    return this.withGroupCounts(existing);
  }

  async deleteGroup(groupId: string): Promise<{ ungroupedAccounts: number }> {
    if (!this.groups.has(groupId)) {
      throw new StoreError("not_found", `Group ${groupId} not found`);
    }
    for (const key of this.apiKeys.values()) {
      if (key.groupId === groupId) {
        throw new StoreError("conflict", "Cannot delete group referenced by active API keys");
      }
    }
    // Accounts outlive their group: they stay in the pool, ungrouped.
    let ungroupedAccounts = 0;
    for (const acc of this.accounts.values()) {
      if (acc.groupId === groupId) {
        acc.groupId = "";
        ungroupedAccounts += 1;
      }
    }
    for (const [routeId, route] of this.routes.entries()) {
      if (route.groupId === groupId) {
        this.routes.delete(routeId);
      }
    }
    this.groups.delete(groupId);
    return { ungroupedAccounts };
  }

  async duplicateGroup(groupId: string): Promise<GroupItem> {
    const source = this.groups.get(groupId);
    if (!source) {
      throw new StoreError("not_found", `Group ${groupId} not found`);
    }
    let name = `${source.name}-copy`.slice(0, 64);
    for (let n = 2; Array.from(this.groups.values()).some((g) => g.name.toLowerCase() === name.toLowerCase()); n++) {
      name = `${source.name.slice(0, 56)}-copy-${n}`;
    }
    return this.createGroup({
      name,
      description: source.description,
      platform: source.platform,
      subscriptionType: source.subscriptionType,
      rateMultiplier: source.rateMultiplier,
      modelAllowlist: [...source.modelAllowlist],
      isExclusive: source.isExclusive,
      sortOrder: source.sortOrder,
      enabled: false,
      dailyLimitUsd: formatNanoUsd(BigInt(source.dailyLimitNanoUsd)),
      weeklyLimitUsd: formatNanoUsd(BigInt(source.weeklyLimitNanoUsd)),
      monthlyLimitUsd: formatNanoUsd(BigInt(source.monthlyLimitNanoUsd)),
      defaultValidityDays: source.defaultValidityDays,
      rpmLimit: source.rpmLimit,
      concurrencyLimit: source.concurrencyLimit,
    });
  }

  private effectiveWindowQuotas(acc: InternalAccount, nowMs: number) {
    const r5 = acc.window5hResetAtMs;
    const r7 = acc.window7dResetAtMs;
    return {
      window5hUsedBps: r5 !== null && r5 <= nowMs ? 0 : acc.window5hUsedBps,
      window7dUsedBps: r7 !== null && r7 <= nowMs ? 0 : acc.window7dUsedBps,
      window5hResetAtUnixMs: r5 !== null && r5 > nowMs ? r5 : undefined,
      window7dResetAtUnixMs: r7 !== null && r7 > nowMs ? r7 : undefined,
    };
  }

  private toPublicAccount(acc: InternalAccount, nowMs = Date.now()): UpstreamAccount {
    const {
      credentialsEnc: _enc,
      credentialFingerprint: _fp,
      window5hResetAtMs: _r5,
      window7dResetAtMs: _r7,
      quotaDailyLimitNanoUsd: _qd,
      quotaWeeklyLimitNanoUsd: _qw,
      quotaTotalLimitNanoUsd: _qt,
      quotaResetAtIso: _qr,
      ...rest
    } = acc;
    const win = this.effectiveWindowQuotas(acc, nowMs);
    return {
      ...rest,
      quota: this.accountQuota(acc, nowMs),
      window5hUsedBps: win.window5hUsedBps,
      window7dUsedBps: win.window7dUsedBps,
      lastTest: acc.lastTest ? { ...acc.lastTest } : null,
      tempUnschedRules: cloneRules(acc.tempUnschedRules),
      groupName: acc.groupId ? (this.groups.get(acc.groupId)?.name ?? acc.groupId) : "",
      effectiveStatus: effectiveAccountStatus(acc, nowMs),
    };
  }

  async listAccounts(filter?: { groupId?: string; executionMode?: string }): Promise<UpstreamAccount[]> {
    const nowMs = Date.now();
    const out: UpstreamAccount[] = [];
    for (const acc of this.accounts.values()) {
      if (filter?.groupId && acc.groupId !== filter.groupId) continue;
      if (filter?.executionMode && acc.executionMode !== filter.executionMode) continue;
      out.push(this.toPublicAccount(acc, nowMs));
    }
    return out.sort((a, b) => a.priority - b.priority || b.createdAtIso.localeCompare(a.createdAtIso));
  }

  async getAccount(accountId: string): Promise<UpstreamAccount | null> {
    const acc = this.accounts.get(accountId);
    return acc ? this.toPublicAccount(acc) : null;
  }

  async createAccount(req: CreateAccountRequest, credential: StoredCredential): Promise<UpstreamAccount> {
    // An empty group id creates an ungrouped account.
    if (req.groupId && !this.groups.has(req.groupId)) {
      throw new StoreError("not_found", `Group ${req.groupId} not found`);
    }
    if (!isSubscriptionTierAllowedForProvider(req.platform, req.subscriptionTier)) {
      throw new StoreError(
        "bad_request",
        `Subscription tier ${req.subscriptionTier} is not valid for provider ${req.platform}`,
      );
    }
    const subscriptionTier = effectiveSubscriptionTier(req.authKind, req.subscriptionTier);
    const id = `acc_${crypto.randomUUID()}`;
    const record: InternalAccount = {
      id,
      name: req.name,
      notes: req.notes,
      groupId: req.groupId,
      platform: req.platform,
      executionMode: req.executionMode,
      authKind: req.authKind,
      subscriptionTier,
      tierMultiplier: subscriptionTierMultiplier(req.platform, subscriptionTier),
      credentialPreview: credential.preview,
      credentialsEnc: credential.encrypted,
      credentialFingerprint: credential.fingerprint,
      maxConcurrency: req.maxConcurrency,
      priority: req.priority,
      status: req.status,
      expiresAtIso: normalizeIso(req.expiresAtIso) ?? null,
      autoPauseOnExpired: req.autoPauseOnExpired,
      cooldownUntilIso: null,
      cooldownReason: "",
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      window5hResetAtMs: null,
      window7dResetAtMs: null,
      lastTest: null,
      lastUsedAtIso: null,
      tempUnschedRules: cloneRules(req.tempUnschedRules),
      privacyMode: null,
      privacyCheckedAtIso: null,
      quotaDailyLimitNanoUsd: quotaNano(req.quotaDailyLimitUsd) ?? "0",
      quotaWeeklyLimitNanoUsd: quotaNano(req.quotaWeeklyLimitUsd) ?? "0",
      quotaTotalLimitNanoUsd: quotaNano(req.quotaTotalLimitUsd) ?? "0",
      quotaResetAtIso: null,
      createdAtIso: new Date().toISOString(),
    };
    this.accounts.set(id, record);
    return this.toPublicAccount(record);
  }

  async updateAccount(
    accountId: string,
    req: UpdateAccountRequest,
    credential?: StoredCredential,
  ): Promise<UpstreamAccount> {
    const acc = this.accounts.get(accountId);
    if (!acc) {
      throw new StoreError("not_found", `Account ${accountId} not found`);
    }
    // Validate everything before mutating so a rejected patch leaves the record untouched.
    if (req.groupId && !this.groups.has(req.groupId)) {
      throw new StoreError("not_found", `Group ${req.groupId} not found`);
    }
    if (req.subscriptionTier !== undefined && !isSubscriptionTierAllowedForProvider(acc.platform, req.subscriptionTier)) {
      throw new StoreError(
        "bad_request",
        `Subscription tier ${req.subscriptionTier} is not valid for provider ${acc.platform}`,
      );
    }
    if (req.groupId !== undefined) acc.groupId = req.groupId;
    if (req.name !== undefined) acc.name = req.name;
    if (req.notes !== undefined) acc.notes = req.notes;
    if (req.executionMode !== undefined) acc.executionMode = req.executionMode;
    if (req.authKind !== undefined) acc.authKind = req.authKind;
    // Re-derived on every patch: switching to an API key drops the plan even without a tier.
    const nextTier = effectiveSubscriptionTier(acc.authKind, req.subscriptionTier ?? acc.subscriptionTier);
    if (nextTier !== acc.subscriptionTier) {
      acc.subscriptionTier = nextTier;
      acc.tierMultiplier = subscriptionTierMultiplier(acc.platform, nextTier);
    }
    if (req.maxConcurrency !== undefined) acc.maxConcurrency = req.maxConcurrency;
    if (req.priority !== undefined) acc.priority = req.priority;
    if (req.status !== undefined) acc.status = req.status;
    if (req.expiresAtIso !== undefined) acc.expiresAtIso = normalizeIso(req.expiresAtIso) ?? null;
    if (req.autoPauseOnExpired !== undefined) acc.autoPauseOnExpired = req.autoPauseOnExpired;
    if (req.tempUnschedRules !== undefined) acc.tempUnschedRules = cloneRules(req.tempUnschedRules);
    acc.quotaDailyLimitNanoUsd = quotaNano(req.quotaDailyLimitUsd) ?? acc.quotaDailyLimitNanoUsd;
    acc.quotaWeeklyLimitNanoUsd = quotaNano(req.quotaWeeklyLimitUsd) ?? acc.quotaWeeklyLimitNanoUsd;
    acc.quotaTotalLimitNanoUsd = quotaNano(req.quotaTotalLimitUsd) ?? acc.quotaTotalLimitNanoUsd;
    if (req.resetQuota) acc.quotaResetAtIso = new Date().toISOString();
    const cooldown = resolveCooldownChange(req);
    if (cooldown.untilIso !== undefined) acc.cooldownUntilIso = cooldown.untilIso;
    if (cooldown.reason !== undefined) acc.cooldownReason = cooldown.reason;
    if (credential) {
      acc.credentialsEnc = credential.encrypted;
      acc.credentialPreview = credential.preview;
      acc.credentialFingerprint = credential.fingerprint;
    }
    return this.toPublicAccount(acc);
  }

  async deleteAccount(accountId: string): Promise<void> {
    if (!this.accounts.delete(accountId)) {
      throw new StoreError("not_found", `Account ${accountId} not found`);
    }
    this.accountTestRuns.delete(accountId);
    for (const [id, plan] of this.accountTestPlans) if (plan.accountId === accountId) this.accountTestPlans.delete(id);
  }

  async recordAccountTestResult(accountId: string, result: AccountTestResult): Promise<void> {
    const acc = this.accounts.get(accountId);
    if (acc) acc.lastTest = { ...result };
  }

  async recordAccountTestRun(run: Omit<AccountTestRun, "id">): Promise<AccountTestRun> {
    if (!this.accounts.has(run.accountId)) {
      throw new StoreError("not_found", `Account ${run.accountId} not found`);
    }
    const plan = run.planId ? this.accountTestPlans.get(run.planId) : undefined;
    if (run.planId && !plan) {
      throw new StoreError("not_found", `Test plan ${run.planId} not found`);
    }
    const saved: AccountTestRun = { id: `atr_${crypto.randomUUID()}`, ...run };
    const list = [saved, ...(this.accountTestRuns.get(run.accountId) ?? [])];
    // Prune the scope the run belongs to: its plan (to maxResults), or the account's other runs.
    const keep = plan ? plan.maxResults : ACCOUNT_TEST_HISTORY_LIMIT;
    let seen = 0;
    this.accountTestRuns.set(
      run.accountId,
      list.filter((r) => r.planId !== run.planId || ++seen <= keep),
    );
    return { ...saved };
  }

  async listAccountTestPlanRuns(planId: string, limit = ACCOUNT_TEST_PLAN_RESULTS_MAX): Promise<AccountTestRun[]> {
    const plan = this.accountTestPlans.get(planId);
    if (!plan) return [];
    const n = Math.max(1, Math.min(ACCOUNT_TEST_PLAN_RESULTS_MAX, Math.floor(limit)));
    return (this.accountTestRuns.get(plan.accountId) ?? [])
      .filter((r) => r.planId === planId)
      .slice(0, n)
      .map((r) => ({ ...r }));
  }

  async listAccountTestPlans(accountId?: string): Promise<AccountTestPlan[]> {
    return [...this.accountTestPlans.values()]
      .filter((p) => accountId === undefined || p.accountId === accountId)
      // Map order is creation order; the stable sort only matters for plans loaded out of order.
      .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso))
      .map((p) => ({ ...p }));
  }

  async getAccountTestPlan(planId: string): Promise<AccountTestPlan | null> {
    const plan = this.accountTestPlans.get(planId);
    return plan ? { ...plan } : null;
  }

  async createAccountTestPlan(accountId: string, req: CreateAccountTestPlanRequest, nextRunAtIso: string | null): Promise<AccountTestPlan> {
    if (!this.accounts.has(accountId)) {
      throw new StoreError("not_found", `Account ${accountId} not found`);
    }
    const count = [...this.accountTestPlans.values()].filter((p) => p.accountId === accountId).length;
    if (count >= ACCOUNT_TEST_PLANS_PER_ACCOUNT) {
      throw new StoreError("conflict", `An account can have at most ${ACCOUNT_TEST_PLANS_PER_ACCOUNT} test plans`);
    }
    const now = new Date().toISOString();
    const plan: AccountTestPlan = {
      id: `atp_${crypto.randomUUID()}`,
      accountId,
      ...req,
      lastRunAtIso: null,
      lastOk: null,
      lastMessage: "",
      nextRunAtIso,
      createdAtIso: now,
      updatedAtIso: now,
    };
    this.accountTestPlans.set(plan.id, plan);
    return { ...plan };
  }

  async updateAccountTestPlan(planId: string, req: UpdateAccountTestPlanRequest, nextRunAtIso: string | null): Promise<AccountTestPlan> {
    const plan = this.accountTestPlans.get(planId);
    if (!plan) throw new StoreError("not_found", `Test plan ${planId} not found`);
    const defined = Object.fromEntries(Object.entries(req).filter(([, v]) => v !== undefined));
    const next: AccountTestPlan = { ...plan, ...defined, nextRunAtIso, updatedAtIso: new Date().toISOString() };
    this.accountTestPlans.set(planId, next);
    return { ...next };
  }

  async deleteAccountTestPlan(planId: string): Promise<boolean> {
    const plan = this.accountTestPlans.get(planId);
    if (!plan) return false;
    this.accountTestPlans.delete(planId);
    const runs = this.accountTestRuns.get(plan.accountId);
    if (runs) this.accountTestRuns.set(plan.accountId, runs.filter((r) => r.planId !== planId));
    return true;
  }

  async listDueAccountTestPlans(nowIso: string, limit: number): Promise<AccountTestPlan[]> {
    const now = Date.parse(nowIso);
    return [...this.accountTestPlans.values()]
      .filter((p) => p.enabled && p.nextRunAtIso !== null && Date.parse(p.nextRunAtIso) <= now)
      .sort((a, b) => Date.parse(a.nextRunAtIso!) - Date.parse(b.nextRunAtIso!))
      .slice(0, Math.max(0, limit))
      .map((p) => ({ ...p }));
  }

  async claimAccountTestPlan(planId: string, expectedNextRunAtIso: string, nextRunAtIso: string | null): Promise<boolean> {
    const plan = this.accountTestPlans.get(planId);
    if (!plan || !plan.enabled || plan.nextRunAtIso === null) return false;
    if (Date.parse(plan.nextRunAtIso) !== Date.parse(expectedNextRunAtIso)) return false;
    plan.nextRunAtIso = nextRunAtIso;
    return true;
  }

  async recordAccountTestPlanResult(planId: string, atIso: string, ok: boolean, message: string): Promise<void> {
    const plan = this.accountTestPlans.get(planId);
    if (!plan) return;
    plan.lastRunAtIso = atIso;
    plan.lastOk = ok;
    plan.lastMessage = message;
  }

  async listAccountTestRuns(accountId: string, limit = ACCOUNT_TEST_HISTORY_LIMIT): Promise<AccountTestRun[]> {
    const n = Math.max(1, Math.min(ACCOUNT_TEST_HISTORY_LIMIT, Math.floor(limit)));
    return (this.accountTestRuns.get(accountId) ?? []).slice(0, n).map((r) => ({ ...r }));
  }

  /** Quota limits and usage; usage is only summed for accounts that have a limit. */
  private accountQuota(acc: InternalAccount, nowMs = Date.now()): AccountQuota {
    const limits = {
      dailyLimitNanoUsd: acc.quotaDailyLimitNanoUsd,
      weeklyLimitNanoUsd: acc.quotaWeeklyLimitNanoUsd,
      totalLimitNanoUsd: acc.quotaTotalLimitNanoUsd,
    };
    const used = { daily: 0n, weekly: 0n, total: 0n };
    if (accountQuotaLimited(limits)) {
      const floor = acc.quotaResetAtIso ? Date.parse(acc.quotaResetAtIso) : Number.NEGATIVE_INFINITY;
      for (const log of this.usageLogs) {
        if (log.accountId !== acc.id) continue;
        const at = Date.parse(log.createdAtIso);
        if (at < floor) continue;
        const cost = BigInt(log.costNanoUsd);
        used.total += cost;
        if (at >= nowMs - ACCOUNT_QUOTA_WEEK_MS) used.weekly += cost;
        if (at >= nowMs - ACCOUNT_QUOTA_DAY_MS) used.daily += cost;
      }
    }
    return {
      ...limits,
      dailyUsedNanoUsd: used.daily.toString(),
      weeklyUsedNanoUsd: used.weekly.toString(),
      totalUsedNanoUsd: used.total.toString(),
      resetAtIso: acc.quotaResetAtIso,
      state: accountQuotaState(limits, used),
    };
  }

  private quotaLimitedAccounts(): InternalAccount[] {
    return Array.from(this.accounts.values()).filter((a) =>
      accountQuotaLimited({
        dailyLimitNanoUsd: a.quotaDailyLimitNanoUsd,
        weeklyLimitNanoUsd: a.quotaWeeklyLimitNanoUsd,
        totalLimitNanoUsd: a.quotaTotalLimitNanoUsd,
      }),
    );
  }

  async listQuotaLimitedAccountIds(): Promise<string[]> {
    return this.quotaLimitedAccounts().map((a) => a.id);
  }

  async listOverQuotaAccountIds(): Promise<string[]> {
    const nowMs = Date.now();
    return this.quotaLimitedAccounts()
      .filter((a) => this.accountQuota(a, nowMs).state !== "ok")
      .map((a) => a.id);
  }

  async getAccountQuotaState(accountId: string): Promise<AccountQuotaState | null> {
    const acc = this.accounts.get(accountId);
    return acc ? this.accountQuota(acc).state : null;
  }

  async recordAccountPrivacy(accountId: string, mode: AccountPrivacyMode, checkedAtIso: string): Promise<void> {
    const acc = this.accounts.get(accountId);
    if (!acc) throw new StoreError("not_found", `Account ${accountId} not found`);
    acc.privacyMode = mode;
    acc.privacyCheckedAtIso = checkedAtIso;
  }

  async listAccountSecrets(accountIds?: string[]): Promise<AccountSecretRecord[]> {
    const wanted = accountIds ? new Set(accountIds) : null;
    const out: AccountSecretRecord[] = [];
    for (const acc of this.accounts.values()) {
      if (wanted && !wanted.has(acc.id)) continue;
      out.push({ accountId: acc.id, encrypted: acc.credentialsEnc, fingerprint: acc.credentialFingerprint });
    }
    return out;
  }

  async findAccountsByFingerprint(fingerprints: string[]): Promise<Map<string, string>> {
    const wanted = new Set(fingerprints);
    const out = new Map<string, string>();
    for (const acc of this.accounts.values()) {
      const fp = acc.credentialFingerprint;
      if (fp && wanted.has(fp) && !out.has(fp)) out.set(fp, acc.id);
    }
    return out;
  }

  async setCredentialFingerprint(accountId: string, fingerprint: string): Promise<void> {
    const acc = this.accounts.get(accountId);
    if (acc) acc.credentialFingerprint = fingerprint;
  }

  async summarizeAccountUsage(sinceIso: string): Promise<AccountUsageSummaryItem[]> {
    const sinceMs = Date.parse(sinceIso);
    const byAccount = new Map<string, { requests: number; errors: number; input: number; output: number; cost: bigint }>();
    for (const log of this.usageLogs) {
      if (Date.parse(log.createdAtIso) < sinceMs) continue;
      const entry = byAccount.get(log.accountId) ?? { requests: 0, errors: 0, input: 0, output: 0, cost: 0n };
      entry.requests += 1;
      if (log.statusCode >= 400) entry.errors += 1;
      entry.input += log.inputTokens;
      entry.output += log.outputTokens;
      entry.cost += BigInt(log.costNanoUsd);
      byAccount.set(log.accountId, entry);
    }
    return Array.from(byAccount.entries()).map(([accountId, v]) => ({
      accountId,
      requests: v.requests,
      errors: v.errors,
      inputTokens: v.input,
      outputTokens: v.output,
      costNanoUsd: v.cost.toString(),
    }));
  }

  /** Spend per rolling window for a key, honouring its window reset. */
  private keyWindowSpend(k: InternalApiKey, nowMs = Date.now()) {
    const floor = k.usageResetAtIso ? Date.parse(k.usageResetAtIso) : Number.NEGATIVE_INFINITY;
    const since5h = Math.max(floor, nowMs - 5 * HOUR_MS);
    const since1d = Math.max(floor, nowMs - 24 * HOUR_MS);
    const since7d = Math.max(floor, nowMs - 168 * HOUR_MS);
    let h5 = 0n;
    let d1 = 0n;
    let d7 = 0n;
    for (const log of this.usageLogs) {
      if (log.apiKeyId !== k.id) continue;
      const t = Date.parse(log.createdAtIso);
      // Spend at the reset instant itself belongs to the old window.
      if (t < since7d || t <= floor) continue;
      const cost = BigInt(log.costNanoUsd);
      d7 += cost;
      if (t >= since1d) d1 += cost;
      if (t >= since5h) h5 += cost;
    }
    return { h5, d1, d7 };
  }

  private keyLimitState(k: InternalApiKey, spend: { h5: bigint; d1: bigint; d7: bigint }): ApiKeyItem["limitState"] {
    const quota = BigInt(k.quotaNanoUsd);
    if (quota > 0n && BigInt(k.spentNanoUsd) >= quota) return "quota_exhausted";
    const over = (limit: string, used: bigint) => BigInt(limit) > 0n && used >= BigInt(limit);
    if (over(k.limit5hNanoUsd, spend.h5) || over(k.limit1dNanoUsd, spend.d1) || over(k.limit7dNanoUsd, spend.d7)) {
      return "window_exhausted";
    }
    return "ok";
  }

  private toKeyItem(k: InternalApiKey, nowMs = Date.now()): ApiKeyItem {
    const { keyHash: _h, usageResetAtIso: _r, ...rest } = k;
    const spend = this.keyWindowSpend(k, nowMs);
    return {
      ...rest,
      ipAllowlist: [...k.ipAllowlist],
      ipDenylist: [...k.ipDenylist],
      groupName: this.groups.get(k.groupId)?.name ?? k.groupId,
      usage5hNanoUsd: spend.h5.toString(),
      usage1dNanoUsd: spend.d1.toString(),
      usage7dNanoUsd: spend.d7.toString(),
      limitState: this.keyLimitState(k, spend),
    };
  }

  async listUserApiKeys(userId: string): Promise<ApiKeyItem[]> {
    const nowMs = Date.now();
    return Array.from(this.apiKeys.values())
      .filter((k) => k.userId === userId)
      .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso))
      .map((k) => this.toKeyItem(k, nowMs));
  }

  async createApiKey(
    userId: string,
    req: CreateApiKeyRequest,
    keyPrefix: string,
    keyHash: Uint8Array,
  ): Promise<ApiKeyItem> {
    const group = this.groups.get(req.groupId);
    if (!group || !group.enabled) {
      throw new StoreError("bad_request", `Group ${req.groupId} is unavailable`);
    }
    const hex = bytesToHex(keyHash);
    for (const k of this.apiKeys.values()) {
      if (bytesToHex(k.keyHash) === hex) throw new StoreError("conflict", "That key is already in use");
    }
    const id = `key_${crypto.randomUUID()}`;
    const record: InternalApiKey = {
      id,
      name: req.name,
      userId,
      groupId: req.groupId,
      keyPrefix,
      keyHash,
      rpmLimit: req.rpmLimit,
      concurrencyLimit: req.concurrencyLimit,
      ipAllowlist: [...req.ipAllowlist],
      ipDenylist: [...req.ipDenylist],
      enabled: true,
      expiresAtIso: req.expiresAtIso,
      createdAtIso: new Date().toISOString(),
      quotaNanoUsd: limitNano(req.quotaUsd),
      spentNanoUsd: "0",
      limit5hNanoUsd: limitNano(req.limit5hUsd),
      limit1dNanoUsd: limitNano(req.limit1dUsd),
      limit7dNanoUsd: limitNano(req.limit7dUsd),
      lastUsedAtIso: null,
      usageResetAtIso: null,
    };
    this.apiKeys.set(id, record);
    return this.toKeyItem(record);
  }

  async updateUserApiKey(
    userId: string,
    keyId: string,
    req: UpdateApiKeyRequest,
  ): Promise<ApiKeyItem> {
    const existing = this.apiKeys.get(keyId);
    if (!existing || existing.userId !== userId) {
      throw new StoreError("not_found", `API key ${keyId} not found`);
    }
    if (req.groupId !== undefined && req.groupId !== existing.groupId) {
      const group = this.groups.get(req.groupId);
      if (!group || !group.enabled) throw new StoreError("bad_request", `Group ${req.groupId} is unavailable`);
      existing.groupId = req.groupId;
    }
    if (req.name !== undefined) existing.name = req.name;
    if (req.rpmLimit !== undefined) existing.rpmLimit = req.rpmLimit;
    if (req.concurrencyLimit !== undefined) existing.concurrencyLimit = req.concurrencyLimit;
    if (req.enabled !== undefined) existing.enabled = req.enabled;
    if (req.ipAllowlist !== undefined) existing.ipAllowlist = [...req.ipAllowlist];
    if (req.ipDenylist !== undefined) existing.ipDenylist = [...req.ipDenylist];
    if (req.expiresAtIso !== undefined) existing.expiresAtIso = req.expiresAtIso;
    existing.quotaNanoUsd = limitNano(req.quotaUsd, existing.quotaNanoUsd);
    existing.limit5hNanoUsd = limitNano(req.limit5hUsd, existing.limit5hNanoUsd);
    existing.limit1dNanoUsd = limitNano(req.limit1dUsd, existing.limit1dNanoUsd);
    existing.limit7dNanoUsd = limitNano(req.limit7dUsd, existing.limit7dNanoUsd);
    if (req.resetQuota) existing.spentNanoUsd = "0";
    if (req.resetWindows) existing.usageResetAtIso = new Date().toISOString();
    return this.toKeyItem(existing);
  }

  async updateUserApiKeys(userId: string, keyIds: string[], req: UpdateApiKeyRequest): Promise<ApiKeyBulkResult> {
    const result: ApiKeyBulkResult = { items: [], failed: [] };
    for (const keyId of new Set(keyIds)) {
      try {
        result.items.push(await this.updateUserApiKey(userId, keyId, req));
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
        result.failed.push({ keyId, error: err });
      }
    }
    return result;
  }

  async listOverLimitKeyIds(): Promise<string[]> {
    const nowMs = Date.now();
    const out: string[] = [];
    for (const k of this.apiKeys.values()) {
      const limited =
        k.quotaNanoUsd !== "0" || k.limit5hNanoUsd !== "0" || k.limit1dNanoUsd !== "0" || k.limit7dNanoUsd !== "0";
      if (limited && this.keyLimitState(k, this.keyWindowSpend(k, nowMs)) !== "ok") out.push(k.id);
    }
    return out;
  }

  async getApiKeyLimitState(keyId: string): Promise<ApiKeyItem["limitState"] | null> {
    const k = this.apiKeys.get(keyId);
    return k ? this.keyLimitState(k, this.keyWindowSpend(k)) : null;
  }

  async listLimitedKeyIds(): Promise<string[]> {
    return Array.from(this.apiKeys.values())
      .filter((k) => k.quotaNanoUsd !== "0" || k.limit5hNanoUsd !== "0" || k.limit1dNanoUsd !== "0" || k.limit7dNanoUsd !== "0")
      .map((k) => k.id);
  }

  async deleteUserApiKey(userId: string, keyId: string): Promise<void> {
    const existing = this.apiKeys.get(keyId);
    if (!existing || existing.userId !== userId) {
      throw new StoreError("not_found", `API key ${keyId} not found`);
    }
    this.apiKeys.delete(keyId);
  }

  async listCompositeRoutes(groupId?: string): Promise<StoredCompositeRoute[]> {
    const out: StoredCompositeRoute[] = [];
    for (const r of this.routes.values()) {
      if (groupId && r.groupId !== groupId) continue;
      out.push({ ...r });
    }
    return out.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }

  async createCompositeRoute(req: CreateCompositeRouteRequest): Promise<StoredCompositeRoute> {
    if (!this.groups.has(req.groupId)) {
      throw new StoreError("not_found", `Group ${req.groupId} not found`);
    }
    const id = `rte_${crypto.randomUUID()}`;
    const item: StoredCompositeRoute = {
      id,
      groupId: req.groupId,
      publicModel: req.publicModel,
      matchType: req.matchType,
      targetPlatform: req.targetPlatform,
      upstreamModel: req.upstreamModel,
      endpoint: req.endpoint,
      priority: req.priority,
      enabled: req.enabled,
      createdAtIso: new Date().toISOString(),
    };
    this.routes.set(id, item);
    return { ...item };
  }

  async deleteCompositeRoute(routeId: string): Promise<void> {
    if (!this.routes.delete(routeId)) {
      throw new StoreError("not_found", `Composite route ${routeId} not found`);
    }
  }

  async exportDataPlaneSnapshot(): Promise<DataPlaneSyncSnapshot> {
    const nowMs = Date.now();
    return {
      revisionUnixMs: nowMs,
      groups: Array.from(this.groups.values()).map((g) => ({
        id: g.id,
        platform: g.platform,
        subscriptionType: g.subscriptionType,
        rateMultiplier: g.rateMultiplier,
        modelAllowlist: [...g.modelAllowlist],
        enabled: g.enabled,
      })),
      routes: await this.listCompositeRoutes(),
      accounts: Array.from(this.accounts.values()).map((a) => {
        const win = this.effectiveWindowQuotas(a, nowMs);
        return {
          id: a.id,
          groupId: a.groupId,
          platform: a.platform,
          executionMode: a.executionMode,
          authKind: a.authKind,
          subscriptionTier: a.subscriptionTier,
          tierMultiplier: a.tierMultiplier,
          credentialsEncHex: bytesToHex(a.credentialsEnc),
          maxConcurrency: a.maxConcurrency,
          priority: a.priority,
          // The data plane only schedules "active"; expiry and cooldown deadlines resolve here.
          status: effectiveAccountStatus(a, nowMs),
          window5hUsedBps: win.window5hUsedBps,
          window7dUsedBps: win.window7dUsedBps,
          ...(win.window5hResetAtUnixMs !== undefined ? { window5hResetAtUnixMs: win.window5hResetAtUnixMs } : {}),
          ...(win.window7dResetAtUnixMs !== undefined ? { window7dResetAtUnixMs: win.window7dResetAtUnixMs } : {}),
          ...(a.tempUnschedRules.length ? { tempUnschedRules: cloneRules(a.tempUnschedRules) } : {}),
        };
      }),
      apiKeys: Array.from(this.apiKeys.values()).map((k) => ({
        id: k.id,
        userId: k.userId,
        groupId: k.groupId,
        keyHashHex: bytesToHex(k.keyHash),
        rpmLimit: k.rpmLimit,
        concurrencyLimit: k.concurrencyLimit,
        ipAllowlist: [...k.ipAllowlist],
        ipDenylist: [...k.ipDenylist],
        enabled: k.enabled,
        expiresAtIso: k.expiresAtIso,
      })),
      wallets: Array.from(this.wallets.entries()).map(([userId, w]) => ({
        userId,
        balanceNanoUsd: w.balanceNano.toString(),
        heldNanoUsd: w.heldNano.toString(),
      })),
      riskBans: Array.from(this.activeRiskBans.values())
        .filter((b) => b.bannedUntilUnixMs === -1 || b.bannedUntilUnixMs > nowMs)
        .map((b) => ({ ...b })),
    };
  }

  async recordTurnSettlement(ev: TurnSettlementEvent): Promise<TurnSettlementResult> {
    // The server-minted settlement id, never the caller's X-Request-Id, decides "already charged".
    const settlementId = settlementIdOf(ev);
    const costNano = BigInt(ev.costNanoUsd);
    const prior = this.settlements.get(settlementId);
    if (prior) {
      return {
        ...ev,
        settlementId,
        duplicate: true,
        id: prior.usageId,
        formattedCostUsd: formatNanoUsd(costNano),
        createdAtIso: prior.createdAtIso,
      };
    }

    // Subscription-billed groups are paid for by the subscription: record the cost for its
    // caps but leave the wallet alone (the data plane takes no hold for them either).
    const billedToWallet = this.groups.get(ev.groupId)?.subscriptionType !== "subscription";
    let walletBalanceAfterNanoUsd: string | undefined;
    if (costNano > 0n && billedToWallet) {
      if (applyMemoryWalletDelta(this.walletState, ev.userId, -costNano, `settle:${settlementId}`, "settle", ev.publicModel)) {
        walletBalanceAfterNanoUsd = this.wallets.get(ev.userId)!.balanceNano.toString();
      }
    }

    const createdAtIso = new Date().toISOString();
    const key = this.apiKeys.get(ev.apiKeyId);
    if (key) {
      if (costNano > 0n) key.spentNanoUsd = (BigInt(key.spentNanoUsd) + costNano).toString();
      key.lastUsedAtIso = createdAtIso;
    }
    const acc = this.accounts.get(ev.accountId);
    if (acc) {
      const nowMs = Date.now();
      if (acc.window5hResetAtMs !== null && acc.window5hResetAtMs <= nowMs) {
        acc.window5hUsedBps = 0;
        acc.window5hResetAtMs = null;
      }
      if (acc.window7dResetAtMs !== null && acc.window7dResetAtMs <= nowMs) {
        acc.window7dUsedBps = 0;
        acc.window7dResetAtMs = null;
      }
      if (ev.window5hUsedBps > 0) {
        acc.window5hUsedBps = ev.window5hUsedBps;
        acc.window5hResetAtMs =
          ev.window5hResetAtUnixMs && ev.window5hResetAtUnixMs > nowMs
            ? ev.window5hResetAtUnixMs
            : (acc.window5hResetAtMs ?? nowMs + 5 * HOUR_MS);
      } else if (ev.window5hResetAtUnixMs && ev.window5hResetAtUnixMs > nowMs) {
        acc.window5hResetAtMs = ev.window5hResetAtUnixMs;
      }
      if (ev.window7dUsedBps > 0) {
        acc.window7dUsedBps = ev.window7dUsedBps;
        acc.window7dResetAtMs =
          ev.window7dResetAtUnixMs && ev.window7dResetAtUnixMs > nowMs
            ? ev.window7dResetAtUnixMs
            : (acc.window7dResetAtMs ?? nowMs + 168 * HOUR_MS);
      } else if (ev.window7dResetAtUnixMs && ev.window7dResetAtUnixMs > nowMs) {
        acc.window7dResetAtMs = ev.window7dResetAtUnixMs;
      }
      acc.lastUsedAtIso = createdAtIso;
    }

    const { settlementId: _sid, coreSettled: _cs, ...usage } = ev;
    const item: UsageLogItem = {
      ...usage,
      id: `usg_${crypto.randomUUID()}`,
      formattedCostUsd: formatNanoUsd(costNano),
      createdAtIso,
    };
    this.rememberSettlement(settlementId, item.id, createdAtIso);
    this.usageLogs.unshift(item);
    if (this.usageLogs.length > 50_000) {
      const cutoff = Date.now() - 35 * 24 * HOUR_MS;
      while (this.usageLogs.length > 50_000 || (this.usageLogs.length > 5_000 && Date.parse(this.usageLogs.at(-1)!.createdAtIso) < cutoff)) {
        this.usageLogs.pop();
      }
    }
    return {
      ...ev,
      ...item,
      settlementId,
      duplicate: false,
      ...(walletBalanceAfterNanoUsd !== undefined ? { walletBalanceAfterNanoUsd } : {}),
    };
  }

  /** Same retention as core.settlement_ids: ids outlive the edge's retry horizon, then go. */
  private rememberSettlement(settlementId: string, usageId: string, createdAtIso: string): void {
    this.settlements.set(settlementId, { usageId, createdAtIso });
    if (this.settlements.size % 1024 !== 0) return;
    const cutoff = Date.now() - SETTLEMENT_ID_RETENTION_DAYS * 24 * HOUR_MS;
    for (const [id, s] of this.settlements) {
      // Map iteration follows insertion order, so the oldest come first.
      if (Date.parse(s.createdAtIso) >= cutoff) break;
      this.settlements.delete(id);
    }
  }

  async listUsageLogs(filter?: UsageLogFilter): Promise<UsageLogItem[]> {
    const cap = filter?.sinceIso ? 100_000 : 200;
    const limit = Math.max(1, Math.min(cap, filter?.limit ?? 50));
    const sinceMs = filter?.sinceIso ? Date.parse(filter.sinceIso) : Number.NEGATIVE_INFINITY;
    const out: UsageLogItem[] = [];
    for (const item of this.usageLogs) {
      if (filter?.userId && item.userId !== filter.userId) continue;
      if (filter?.accountId && item.accountId !== filter.accountId) continue;
      if (filter?.groupIds && !filter.groupIds.includes(item.groupId)) continue;
      if (Date.parse(item.createdAtIso) < sinceMs) continue;
      out.push({ ...item });
      if (out.length >= limit) break;
    }
    return out;
  }

  async recordRiskBanEvent(ev: RecordRiskBanInput): Promise<RiskBanEvent> {
    const nowMs = Date.now();
    const expiresAtMs =
      ev.banDuration === "permanent" ? null : ev.banDuration === "24h" ? nowMs + 24 * 3_600_000 : nowMs + 10 * 60_000;
    const bannedUntilUnixMs = expiresAtMs ?? -1;
    const banKey = `${ev.subjectKind}:${ev.subjectHash}`;
    const prevBan = this.activeRiskBans.get(banKey);
    this.activeRiskBans.set(banKey, {
      subjectKind: ev.subjectKind,
      subjectHash: ev.subjectHash,
      strikeLevel: Math.max(prevBan?.strikeLevel ?? 1, Math.min(3, ev.strikeLevel)),
      bannedUntilUnixMs:
        prevBan?.bannedUntilUnixMs === -1 || bannedUntilUnixMs === -1
          ? -1
          : Math.max(prevBan?.bannedUntilUnixMs ?? 0, bannedUntilUnixMs),
    });
    const record: RiskBanEvent = {
      eventId: `rsk_${crypto.randomUUID()}`,
      subjectKind: ev.subjectKind,
      subjectHash: ev.subjectHash,
      strikeLevel: ev.strikeLevel,
      banDuration: ev.banDuration,
      reason: ev.reason,
      ordinaryUpstream400Count: ev.ordinaryUpstream400Count,
      downgradedCount: ev.downgradedCount,
      active: true,
      unbannedAtIso: null,
      createdAtIso: new Date(nowMs).toISOString(),
    };
    this.riskEvents.unshift({ event: record, expiresAtMs, unbannedAtMs: null });
    if (this.riskEvents.length > 200) {
      this.riskEvents.length = 200;
    }
    return { ...record };
  }

  async listRiskBanEvents(limit = 50): Promise<RiskBanEvent[]> {
    const nowMs = Date.now();
    return this.riskEvents.slice(0, Math.max(1, Math.min(200, limit))).map((entry) => ({
      ...entry.event,
      active: entry.unbannedAtMs === null && (entry.expiresAtMs === null || entry.expiresAtMs > nowMs),
      unbannedAtIso: entry.unbannedAtMs !== null ? new Date(entry.unbannedAtMs).toISOString() : null,
    }));
  }

  async unbanRiskSubject(subjectKind: RiskBanEvent["subjectKind"], subjectHash: string): Promise<number> {
    const nowMs = Date.now();
    const removedActive = this.activeRiskBans.delete(`${subjectKind}:${subjectHash}`);
    let updated = 0;
    for (const entry of this.riskEvents) {
      if (
        entry.event.subjectKind === subjectKind &&
        entry.event.subjectHash === subjectHash &&
        entry.unbannedAtMs === null &&
        (entry.expiresAtMs === null || entry.expiresAtMs > nowMs)
      ) {
        entry.unbannedAtMs = nowMs;
        updated += 1;
      }
    }
    return updated > 0 ? updated : removedActive ? 1 : 0;
  }

  async clearRiskBansAndRefusalCache(): Promise<{ unbanned: number; refusalCacheCleared: number }> {
    const nowMs = Date.now();
    const activeCount = this.activeRiskBans.size;
    this.activeRiskBans.clear();
    let updated = 0;
    for (const entry of this.riskEvents) {
      if (entry.unbannedAtMs === null && (entry.expiresAtMs === null || entry.expiresAtMs > nowMs)) {
        entry.unbannedAtMs = nowMs;
        updated += 1;
      }
    }
    return {
      unbanned: Math.max(updated, activeCount),
      refusalCacheCleared: 0,
    };
  }

  async listPricingRules(): Promise<ModelPricingRule[]> {
    if (this.pricingRules === null) {
      const blob = await this.ops.getBlob("model_pricing");
      const legacy = Array.isArray(blob?.rules) ? blob.rules : [];
      this.pricingRules = legacy.flatMap((r) => {
        const parsed = ModelPricingRuleSchema.safeParse(r);
        return parsed.success ? [parsed.data] : [];
      });
    }
    return structuredClone(this.pricingRules);
  }

  async savePricingRules(rules: ModelPricingRule[]): Promise<void> {
    this.pricingRules = structuredClone(rules);
  }

  async upsertMediaTask(task: Omit<PersistedMediaTaskRecord, "createdAtIso">): Promise<PersistedMediaTaskRecord> {
    const nowMs = Date.now();
    for (const [k, v] of this.mediaTasks) {
      if (Date.parse(v.expiresAtIso) <= nowMs) this.mediaTasks.delete(k);
    }
    const pk = `${task.kind}:${task.id}`;
    const prev = this.mediaTasks.get(pk);
    const saved: PersistedMediaTaskRecord = {
      ...structuredClone(task),
      createdAtIso: prev?.createdAtIso ?? new Date(nowMs).toISOString(),
    };
    this.mediaTasks.set(pk, saved);
    return structuredClone(saved);
  }

  async getMediaTask(
    apiKeyId: string,
    kind: PersistedMediaTaskRecord["kind"],
    id: string,
  ): Promise<PersistedMediaTaskRecord | null> {
    const pk = `${kind}:${id}`;
    const rec = this.mediaTasks.get(pk);
    if (!rec || rec.apiKeyId !== apiKeyId || rec.kind !== kind || Date.parse(rec.expiresAtIso) <= Date.now()) {
      return null;
    }
    return structuredClone(rec);
  }

  async deleteMediaTask(
    apiKeyId: string,
    kind: PersistedMediaTaskRecord["kind"],
    id: string,
  ): Promise<boolean> {
    const pk = `${kind}:${id}`;
    const rec = this.mediaTasks.get(pk);
    if (!rec || rec.apiKeyId !== apiKeyId || rec.kind !== kind || Date.parse(rec.expiresAtIso) <= Date.now()) {
      return false;
    }
    return this.mediaTasks.delete(pk);
  }
}

/** USD quota text ("0" = no limit) to nano-USD digits; `undefined` when not sent. */
function quotaNano(usd: string | undefined): string | undefined {
  return usd === undefined ? undefined : parseUsdToNano(usd).toString();
}
