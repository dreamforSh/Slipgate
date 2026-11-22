import {
  formatNanoUsd,
  isSubscriptionTierAllowedForProvider,
  subscriptionTierMultiplier,
  type AccountTestResult,
  type ApiKeyItem,
  type CreateAccountRequest,
  type CreateApiKeyRequest,
  type CreateCompositeRouteRequest,
  type CreateGroupRequest,
  type DataPlaneSyncSnapshot,
  type GroupItem,
  type RecordRiskBanInput,
  type RiskBanEvent,
  type SetupInitializeRequest,
  type SetupStatus,
  type StoredCompositeRoute,
  type TurnSettlementEvent,
  type UpdateAccountRequest,
  type UpdateApiKeyRequest,
  type UpdateGroupRequest,
  type UpstreamAccount,
  type UsageLogItem,
  type UserProfile,
  type WalletSummary,
} from "@slipgate/contracts";
import { StoreError, type ControlStore, type StoredUserRecord } from "./types.ts";

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, "0");
  }
  return out;
}

type InternalGroup = Omit<GroupItem, "accountCount" | "activeAccountCount" | "apiKeyCount">;

interface InternalAccount extends Omit<UpstreamAccount, "groupName"> {
  credentialsEnc: Uint8Array;
}

interface InternalApiKey extends Omit<ApiKeyItem, "groupName"> {
  keyHash: Uint8Array;
}

interface InternalWallet {
  balanceNano: bigint;
  heldNano: bigint;
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
  private readonly apiKeys = new Map<string, InternalApiKey>();
  private readonly routes = new Map<string, StoredCompositeRoute>();
  private readonly usageByRequestId = new Map<string, UsageLogItem>();
  private readonly usageLogs: UsageLogItem[] = [];
  private readonly riskEvents: RiskBanEvent[] = [];

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
      passwordHash: adminPasswordHash,
      role: "admin",
      status: "active",
      totpEnabled: false,
      createdAtIso: now,
    };
    this.users.set(adminId, admin);
    this.wallets.set(adminId, { balanceNano: 0n, heldNano: 0n });

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

  async registerUser(email: string, passwordHash: string): Promise<UserProfile> {
    if (!this.setup.initialized) {
      throw new StoreError("conflict", "System setup has not completed yet");
    }
    if (!this.setup.allowRegistration) {
      throw new StoreError("forbidden", "Public user registration is disabled");
    }
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
      passwordHash,
      role: "user",
      status: "active",
      totpEnabled: false,
      createdAtIso: new Date().toISOString(),
    };
    this.users.set(userId, user);
    this.wallets.set(userId, { balanceNano: 0n, heldNano: 0n });
    const { passwordHash: _, ...profile } = user;
    return profile;
  }

  async findUserByEmail(email: string): Promise<StoredUserRecord | null> {
    const normalized = email.toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === normalized) {
        return { ...u };
      }
    }
    return null;
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
    const w = this.wallets.get(userId) ?? { balanceNano: 0n, heldNano: 0n };
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
    if (!this.idempotencyKeys.has(idempotencyKey)) {
      this.idempotencyKeys.add(idempotencyKey);
      const w = this.wallets.get(userId) ?? { balanceNano: 0n, heldNano: 0n };
      w.balanceNano += amountNanoUsd;
      this.wallets.set(userId, w);
    }
    return this.getWallet(userId);
  }

  private withGroupCounts(g: InternalGroup): GroupItem {
    let accountCount = 0;
    let activeAccountCount = 0;
    for (const acc of this.accounts.values()) {
      if (acc.groupId !== g.id) continue;
      accountCount += 1;
      if (acc.status === "active") activeAccountCount += 1;
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
    return this.withGroupCounts(existing);
  }

  async deleteGroup(groupId: string): Promise<void> {
    if (!this.groups.has(groupId)) {
      throw new StoreError("not_found", `Group ${groupId} not found`);
    }
    for (const acc of this.accounts.values()) {
      if (acc.groupId === groupId) {
        throw new StoreError("conflict", "Cannot delete group that still contains accounts");
      }
    }
    for (const key of this.apiKeys.values()) {
      if (key.groupId === groupId) {
        throw new StoreError("conflict", "Cannot delete group referenced by active API keys");
      }
    }
    for (const [routeId, route] of this.routes.entries()) {
      if (route.groupId === groupId) {
        this.routes.delete(routeId);
      }
    }
    this.groups.delete(groupId);
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
    });
  }

  async listAccounts(filter?: { groupId?: string; executionMode?: string }): Promise<UpstreamAccount[]> {
    const out: UpstreamAccount[] = [];
    for (const acc of this.accounts.values()) {
      if (filter?.groupId && acc.groupId !== filter.groupId) continue;
      if (filter?.executionMode && acc.executionMode !== filter.executionMode) continue;
      const { credentialsEnc: _, ...rest } = acc;
      out.push({
        ...rest,
        groupName: this.groups.get(acc.groupId)?.name ?? acc.groupId,
      });
    }
    return out;
  }

  async getAccount(accountId: string): Promise<UpstreamAccount | null> {
    const acc = this.accounts.get(accountId);
    if (!acc) return null;
    const { credentialsEnc: _, ...rest } = acc;
    return { ...rest, groupName: this.groups.get(acc.groupId)?.name ?? acc.groupId };
  }

  async createAccount(
    req: CreateAccountRequest,
    encryptedSecret: Uint8Array,
    credentialPreview: string,
  ): Promise<UpstreamAccount> {
    const group = this.groups.get(req.groupId);
    if (!group) {
      throw new StoreError("not_found", `Group ${req.groupId} not found`);
    }
    if (!isSubscriptionTierAllowedForProvider(req.platform, req.subscriptionTier)) {
      throw new StoreError(
        "bad_request",
        `Subscription tier ${req.subscriptionTier} is not valid for provider ${req.platform}`,
      );
    }
    const id = `acc_${crypto.randomUUID()}`;
    const record: InternalAccount = {
      id,
      name: req.name,
      notes: req.notes,
      groupId: req.groupId,
      platform: req.platform,
      executionMode: req.executionMode,
      authKind: req.authKind,
      subscriptionTier: req.subscriptionTier,
      tierMultiplier: subscriptionTierMultiplier(req.platform, req.subscriptionTier),
      credentialPreview,
      credentialsEnc: encryptedSecret,
      maxConcurrency: req.maxConcurrency,
      priority: req.priority,
      status: "active",
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      lastTest: null,
      createdAtIso: new Date().toISOString(),
    };
    this.accounts.set(id, record);
    const { credentialsEnc: _, ...rest } = record;
    return { ...rest, groupName: group.name };
  }

  async updateAccount(
    accountId: string,
    req: UpdateAccountRequest,
    encryptedSecret?: Uint8Array,
    credentialPreview?: string,
  ): Promise<UpstreamAccount> {
    const acc = this.accounts.get(accountId);
    if (!acc) {
      throw new StoreError("not_found", `Account ${accountId} not found`);
    }
    if (req.groupId !== undefined) {
      if (!this.groups.has(req.groupId)) {
        throw new StoreError("not_found", `Group ${req.groupId} not found`);
      }
      acc.groupId = req.groupId;
    }
    if (req.name !== undefined) acc.name = req.name;
    if (req.notes !== undefined) acc.notes = req.notes;
    if (req.executionMode !== undefined) acc.executionMode = req.executionMode;
    if (req.authKind !== undefined) acc.authKind = req.authKind;
    if (req.subscriptionTier !== undefined) {
      if (!isSubscriptionTierAllowedForProvider(acc.platform, req.subscriptionTier)) {
        throw new StoreError(
          "bad_request",
          `Subscription tier ${req.subscriptionTier} is not valid for provider ${acc.platform}`,
        );
      }
      acc.subscriptionTier = req.subscriptionTier;
      acc.tierMultiplier = subscriptionTierMultiplier(acc.platform, req.subscriptionTier);
    }
    if (req.maxConcurrency !== undefined) acc.maxConcurrency = req.maxConcurrency;
    if (req.priority !== undefined) acc.priority = req.priority;
    if (req.status !== undefined) acc.status = req.status;
    if (encryptedSecret !== undefined && credentialPreview !== undefined) {
      acc.credentialsEnc = encryptedSecret;
      acc.credentialPreview = credentialPreview;
    }
    const { credentialsEnc: _, ...rest } = acc;
    return {
      ...rest,
      groupName: this.groups.get(acc.groupId)?.name ?? acc.groupId,
    };
  }

  async deleteAccount(accountId: string): Promise<void> {
    if (!this.accounts.delete(accountId)) {
      throw new StoreError("not_found", `Account ${accountId} not found`);
    }
  }

  async recordAccountTestResult(accountId: string, result: AccountTestResult): Promise<void> {
    const acc = this.accounts.get(accountId);
    if (acc) acc.lastTest = { ...result };
  }

  async listUserApiKeys(userId: string): Promise<ApiKeyItem[]> {
    const out: ApiKeyItem[] = [];
    for (const k of this.apiKeys.values()) {
      if (k.userId !== userId) continue;
      const { keyHash: _, ...rest } = k;
      out.push({
        ...rest,
        groupName: this.groups.get(k.groupId)?.name ?? k.groupId,
      });
    }
    return out;
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
      enabled: true,
      expiresAtIso: req.expiresAtIso,
      createdAtIso: new Date().toISOString(),
    };
    this.apiKeys.set(id, record);
    const { keyHash: _, ...rest } = record;
    return { ...rest, groupName: group.name };
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
    if (req.name !== undefined) existing.name = req.name;
    if (req.rpmLimit !== undefined) existing.rpmLimit = req.rpmLimit;
    if (req.concurrencyLimit !== undefined) existing.concurrencyLimit = req.concurrencyLimit;
    if (req.enabled !== undefined) existing.enabled = req.enabled;
    const { keyHash: _, ...rest } = existing;
    return {
      ...rest,
      groupName: this.groups.get(existing.groupId)?.name ?? existing.groupId,
    };
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
    return {
      revisionUnixMs: Date.now(),
      groups: Array.from(this.groups.values()).map((g) => ({
        id: g.id,
        platform: g.platform,
        subscriptionType: g.subscriptionType,
        rateMultiplier: g.rateMultiplier,
        modelAllowlist: [...g.modelAllowlist],
        enabled: g.enabled,
      })),
      routes: await this.listCompositeRoutes(),
      accounts: Array.from(this.accounts.values()).map((a) => ({
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
        status: a.status,
        window5hUsedBps: a.window5hUsedBps,
        window7dUsedBps: a.window7dUsedBps,
      })),
      apiKeys: Array.from(this.apiKeys.values()).map((k) => ({
        id: k.id,
        userId: k.userId,
        groupId: k.groupId,
        keyHashHex: bytesToHex(k.keyHash),
        rpmLimit: k.rpmLimit,
        concurrencyLimit: k.concurrencyLimit,
        ipAllowlist: [...k.ipAllowlist],
        enabled: k.enabled,
        expiresAtIso: k.expiresAtIso,
      })),
      wallets: Array.from(this.wallets.entries()).map(([userId, w]) => ({
        userId,
        balanceNanoUsd: w.balanceNano.toString(),
        heldNanoUsd: w.heldNano.toString(),
      })),
    };
  }

  async recordTurnSettlement(ev: TurnSettlementEvent): Promise<UsageLogItem> {
    const existing = this.usageByRequestId.get(ev.requestId);
    if (existing) {
      return { ...existing };
    }

    const costNano = BigInt(ev.costNanoUsd);
    const idemKey = `settle:${ev.requestId}`;
    if (!this.idempotencyKeys.has(idemKey)) {
      this.idempotencyKeys.add(idemKey);
      if (costNano > 0n) {
        const w = this.wallets.get(ev.userId) ?? { balanceNano: 0n, heldNano: 0n };
        w.balanceNano -= costNano;
        this.wallets.set(ev.userId, w);
      }
      const acc = this.accounts.get(ev.accountId);
      if (acc) {
        if (ev.window5hUsedBps > 0) acc.window5hUsedBps = ev.window5hUsedBps;
        if (ev.window7dUsedBps > 0) acc.window7dUsedBps = ev.window7dUsedBps;
      }
    }

    const item: UsageLogItem = {
      ...ev,
      id: `usg_${crypto.randomUUID()}`,
      formattedCostUsd: formatNanoUsd(costNano),
      createdAtIso: new Date().toISOString(),
    };
    this.usageByRequestId.set(ev.requestId, item);
    this.usageLogs.unshift(item);
    if (this.usageLogs.length > 500) {
      this.usageLogs.length = 500;
    }
    return { ...item };
  }

  async listUsageLogs(filter?: { userId?: string; limit?: number; sinceIso?: string }): Promise<UsageLogItem[]> {
    const cap = filter?.sinceIso ? 100_000 : 200;
    const limit = Math.max(1, Math.min(cap, filter?.limit ?? 50));
    const sinceMs = filter?.sinceIso ? Date.parse(filter.sinceIso) : Number.NEGATIVE_INFINITY;
    const out: UsageLogItem[] = [];
    for (const item of this.usageLogs) {
      if (filter?.userId && item.userId !== filter.userId) continue;
      if (Date.parse(item.createdAtIso) < sinceMs) continue;
      out.push({ ...item });
      if (out.length >= limit) break;
    }
    return out;
  }

  async recordRiskBanEvent(ev: RecordRiskBanInput): Promise<RiskBanEvent> {
    const record: RiskBanEvent = {
      eventId: `rsk_${crypto.randomUUID()}`,
      subjectKind: ev.subjectKind,
      strikeLevel: ev.strikeLevel,
      banDuration: ev.banDuration,
      reason: ev.reason,
      ordinaryUpstream400Count: ev.ordinaryUpstream400Count,
      downgradedCount: ev.downgradedCount,
      createdAtIso: new Date().toISOString(),
    };
    this.riskEvents.unshift(record);
    if (this.riskEvents.length > 200) {
      this.riskEvents.length = 200;
    }
    return { ...record };
  }

  async listRiskBanEvents(limit = 50): Promise<RiskBanEvent[]> {
    return this.riskEvents.slice(0, Math.max(1, Math.min(200, limit))).map((e) => ({ ...e }));
  }
}
