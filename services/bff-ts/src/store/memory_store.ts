import {
  formatNanoUsd,
  type ApiKeyItem,
  type CreateAccountRequest,
  type CreateApiKeyRequest,
  type CreateGroupRequest,
  type GroupItem,
  type SetupInitializeRequest,
  type SetupStatus,
  type UpdateAccountRequest,
  type UpdateApiKeyRequest,
  type UpdateGroupRequest,
  type UpstreamAccount,
  type UserProfile,
  type WalletSummary,
} from "@slipgate/contracts";
import { StoreError, type ControlStore, type StoredUserRecord } from "./types.ts";

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
  private readonly groups = new Map<string, Omit<GroupItem, "accountCount">>();
  private readonly accounts = new Map<string, InternalAccount>();
  private readonly apiKeys = new Map<string, InternalApiKey>();

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
        platform: "composite",
        subscriptionType: "balance",
        rateMultiplier: 1,
        modelAllowlist: [],
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

  async listGroups(enabledOnly = false): Promise<GroupItem[]> {
    const counts = new Map<string, number>();
    for (const acc of this.accounts.values()) {
      counts.set(acc.groupId, (counts.get(acc.groupId) ?? 0) + 1);
    }
    return Array.from(this.groups.values())
      .filter((g) => !enabledOnly || g.enabled)
      .map((g) => ({
        ...g,
        accountCount: counts.get(g.id) ?? 0,
      }));
  }

  async createGroup(req: CreateGroupRequest): Promise<GroupItem> {
    for (const g of this.groups.values()) {
      if (g.name.toLowerCase() === req.name.toLowerCase()) {
        throw new StoreError("conflict", `Group "${req.name}" already exists`);
      }
    }
    const id = `grp_${crypto.randomUUID()}`;
    const item = {
      id,
      name: req.name,
      platform: req.platform,
      subscriptionType: req.subscriptionType,
      rateMultiplier: req.rateMultiplier,
      modelAllowlist: [...req.modelAllowlist],
      enabled: req.enabled,
      createdAtIso: new Date().toISOString(),
    };
    this.groups.set(id, item);
    return { ...item, accountCount: 0 };
  }

  async updateGroup(groupId: string, req: UpdateGroupRequest): Promise<GroupItem> {
    const existing = this.groups.get(groupId);
    if (!existing) {
      throw new StoreError("not_found", `Group ${groupId} not found`);
    }
    if (req.name) {
      for (const [id, g] of this.groups.entries()) {
        if (id !== groupId && g.name.toLowerCase() === req.name.toLowerCase()) {
          throw new StoreError("conflict", `Group "${req.name}" already exists`);
        }
      }
      existing.name = req.name;
    }
    if (req.rateMultiplier !== undefined) existing.rateMultiplier = req.rateMultiplier;
    if (req.modelAllowlist !== undefined) existing.modelAllowlist = [...req.modelAllowlist];
    if (req.enabled !== undefined) existing.enabled = req.enabled;
    const all = await this.listGroups();
    return all.find((g) => g.id === groupId)!;
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
    this.groups.delete(groupId);
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

  async createAccount(
    req: CreateAccountRequest,
    encryptedSecret: Uint8Array,
    credentialPreview: string,
  ): Promise<UpstreamAccount> {
    const group = this.groups.get(req.groupId);
    if (!group) {
      throw new StoreError("not_found", `Group ${req.groupId} not found`);
    }
    const id = `acc_${crypto.randomUUID()}`;
    const record: InternalAccount = {
      id,
      name: req.name,
      groupId: req.groupId,
      platform: req.platform,
      executionMode: req.executionMode,
      authKind: req.authKind,
      credentialPreview,
      credentialsEnc: encryptedSecret,
      maxConcurrency: req.maxConcurrency,
      priority: req.priority,
      status: "active",
      window5hUsedBps: 0,
      window7dUsedBps: 0,
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
    if (req.executionMode !== undefined) acc.executionMode = req.executionMode;
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
}
