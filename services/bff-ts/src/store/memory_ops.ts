import {
  DEFAULT_PORTAL_SETTINGS,
  normalizePortalSettings,
  type AdminUserItem,
  type AdminUserListQuery,
  type AdminUserListResponse,
  type AnnouncementItem,
  type AnnouncementReader,
  type AnnouncementReadStatusItem,
  type AnnouncementReadStatusQuery,
  type AnnouncementReadStatusResponse,
  type AuditLogItem,
  type AuditLogQuery,
  type LinkedIdentity,
  type BalanceLedgerItem,
  type CreatePromoCodeRequest,
  type GenerateRedeemCodesRequest,
  type GroupItem,
  type PortalSettings,
  type PromoCodeCheckResponse,
  type PromoCodeItem,
  type PromoCodeUsageItem,
  type RedeemCodeClaimItem,
  type RedeemCodeItem,
  type RedeemCodeKind,
  type RedeemCodeListQuery,
  type RedeemCodeListResponse,
  type RedeemResult,
  type SetupStatus,
  type SubscriptionAction,
  type SubscriptionLimits,
  type SubscriptionUsage,
  type UpdatePromoCodeRequest,
  type UpdateRedeemCodesRequest,
  type UpsertAnnouncementRequest,
  type UsageLogItem,
  type UsagePageResponse,
  type UsageQuery,
  type UsageRow,
  type UsageSummary,
  type UserAnnouncementItem,
  type UserProfile,
  type UserRole,
  type UserSubscriptionItem,
  type UserSubscriptionListQuery,
} from "@slipgate/contracts";
import {
  ANNOUNCEMENT_FEED_CANDIDATES,
  announcementLive,
  audienceMatches,
  clampPage,
  DAY_MS,
  effectiveRedeemStatus,
  effectiveSubscriptionStatus,
  emptyUsageSummary,
  normalizeRedeemCode,
  randomCode,
  SUBSCRIPTION_WINDOWS_MS,
  subscriptionOverLimit,
  targetingMatches,
  targetingRestricts,
} from "./ops_shared.ts";
import { AUDIT_DELETE_BATCH } from "./ops_types.ts";
import type {
  AdminUserCreateInput,
  AdminUserUpdateInput,
  AuditLogInput,
  OpsStore,
  RegistrationExtras,
  RegistrationOutcome,
  SessionState,
  SubscriptionEntitlement,
  UsageExportQuery,
  UserAccessRecord,
} from "./ops_types.ts";
import type { ApiKeyLabel, ApiKeyLookupRecord } from "./ops_types.ts";
import { StoreError, type StoredUserRecord } from "./types.ts";
import { laterIso, viewerDayStartMs } from "./user_limits_types.ts";
import {
  reduceChannelStatus,
  reduceOpsUsage,
  reduceScopedUsage,
  type ChannelStatusAggregate,
  type ChannelStatusQuery,
  type OpsUsageAggregate,
  type OpsUsageQuery,
  type ScopedUsageAggregate,
  type ScopedUsageQuery,
} from "./usage_aggregates.ts";

/* ------------------------------------------------------------------------------------------ */
/* Shared in-memory state (owned by MemoryControlStore, passed by reference)                  */
/* ------------------------------------------------------------------------------------------ */

/** The API key fields MemoryOpsStore reads from MemoryControlStore's key records. */
export interface MemoryApiKeyView {
  id: string;
  userId: string;
  groupId: string;
  name: string;
  keyPrefix: string;
  keyHash: Uint8Array;
  enabled: boolean;
  expiresAtIso: string | null;
  /** Latest settled turn (admin user list: last API use). */
  lastUsedAtIso?: string | null;
}

/** What still references a user from the payments side (MemoryPaymentsStore registers it). */
export type MemoryPaymentReferences = (userId: string) => { orders: number; rebates: number };

export interface MemoryWallet {
  balanceNano: bigint;
  heldNano: bigint;
  spentNano: bigint;
}

export interface MemoryLedgerEntry {
  id: string;
  userId: string;
  kind: BalanceLedgerItem["kind"];
  deltaNano: bigint;
  balanceAfterNano: bigint;
  reason: string;
  createdAtIso: string;
}

type GroupView = Omit<GroupItem, "accountCount" | "activeAccountCount" | "apiKeyCount">;

export interface MemoryCoreState {
  getSetup(): SetupStatus;
  patchSetup(patch: Partial<SetupStatus>): void;
  users: Map<string, StoredUserRecord>;
  wallets: Map<string, MemoryWallet>;
  idempotencyKeys: Set<string>;
  ledger: MemoryLedgerEntry[];
  groups: ReadonlyMap<string, GroupView>;
  apiKeys: Map<string, MemoryApiKeyView>;
  accounts: ReadonlyMap<string, { id: string; name: string }>;
  usageLogs: UsageLogItem[];
}

/**
 * Applies a signed wallet movement once per idempotency key and journals it. Shared by
 * MemoryControlStore (credits, settlement) and MemoryOpsStore (adjustments, redeem, promo).
 */
export function applyMemoryWalletDelta(
  state: Pick<MemoryCoreState, "wallets" | "idempotencyKeys" | "ledger">,
  userId: string,
  deltaNano: bigint,
  idempotencyKey: string,
  kind: MemoryLedgerEntry["kind"],
  reason: string,
): boolean {
  if (state.idempotencyKeys.has(idempotencyKey)) return false;
  state.idempotencyKeys.add(idempotencyKey);
  const w = state.wallets.get(userId) ?? { balanceNano: 0n, heldNano: 0n, spentNano: 0n };
  w.balanceNano += deltaNano;
  if (kind === "settle" && deltaNano < 0n) w.spentNano += -deltaNano;
  state.wallets.set(userId, w);
  state.ledger.unshift({
    id: `ldg_${crypto.randomUUID()}`,
    userId,
    kind,
    deltaNano,
    balanceAfterNano: w.balanceNano,
    reason,
    createdAtIso: new Date().toISOString(),
  });
  if (state.ledger.length > 5000) state.ledger.length = 5000;
  return true;
}

/* ------------------------------------------------------------------------------------------ */
/* Records                                                                                    */
/* ------------------------------------------------------------------------------------------ */

interface UserMeta {
  totpSecretEnc?: Uint8Array | null;
  notes: string;
  allowedGroupIds: string[];
  inviteCode: string;
  referrerId: string | null;
  lastLoginAtIso: string | null;
}

interface RedeemRecord {
  code: string;
  kind: RedeemCodeKind;
  amountNano: bigint;
  groupId: string | null;
  validityDays: number | null;
  status: "unused" | "used" | "disabled";
  batchId: string;
  notes: string;
  redeemedBy: string | null;
  redeemedAtIso: string | null;
  expiresAtIso: string | null;
  createdAtIso: string;
  maxUses: number;
  usedCount: number;
  perUserLimit: number;
  batchPerUserLimit: number;
}

interface RedeemClaimRecord {
  id: string;
  code: string;
  batchId: string;
  userId: string;
  kind: RedeemCodeKind;
  amountNano: bigint;
  groupId: string | null;
  validityDays: number | null;
  redeemedAtIso: string;
}

interface PromoRecord {
  id: string;
  code: string;
  bonusNano: bigint;
  maxUses: number;
  usedCount: number;
  enabled: boolean;
  expiresAtIso: string | null;
  notes: string;
  createdAtIso: string;
}

interface SubscriptionRecord {
  id: string;
  userId: string;
  groupId: string;
  status: "active" | "revoked";
  source: string;
  notes: string;
  startsAtIso: string;
  expiresAtIso: string;
  usageResetAtIso: string | null;
  dailyResetAtIso: string | null;
  weeklyResetAtIso: string | null;
  monthlyResetAtIso: string | null;
  createdAtIso: string;
}

type AnnouncementRecord = Omit<AnnouncementItem, "readCount">;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class MemoryOpsStore implements OpsStore {
  private settings: PortalSettings = { ...DEFAULT_PORTAL_SETTINGS };
  private readonly meta = new Map<string, UserMeta>();
  private readonly redeem = new Map<string, RedeemRecord>();
  private readonly promos = new Map<string, PromoRecord>();
  private readonly promoUsages: { promoId: string; userId: string; bonusNano: bigint; usedAtIso: string }[] = [];
  private readonly redeemClaims: RedeemClaimRecord[] = [];
  private readonly announcements = new Map<string, AnnouncementRecord>();
  private readonly reads = new Map<string, string>(); // `${annId}\u0000${userId}` -> readAtIso
  private readonly audit: AuditLogItem[] = [];
  private readonly subs = new Map<string, SubscriptionRecord>();

  private readonly blobs = new Map<string, Record<string, unknown>>();
  private readonly blobLocks = new Map<string, Promise<void>>();
  private settingsLock: Promise<void> = Promise.resolve();
  private readonly identities: { userId: string; provider: string; subject: string; createdAtIso: string }[] = [];

  async findUserIdByIdentity(provider: string, subject: string): Promise<string | null> {
    const hit = this.identities.find((i) => i.provider === provider && i.subject === subject);
    return hit && this.core.users.has(hit.userId) ? hit.userId : null;
  }

  async linkIdentity(userId: string, provider: string, subject: string): Promise<void> {
    this.requireUser(userId);
    const owner = this.identities.find((i) => i.provider === provider && i.subject === subject);
    if (owner && owner.userId !== userId) throw new StoreError("conflict", "That account is already linked to another user");
    for (let i = this.identities.length - 1; i >= 0; i--) {
      const it = this.identities[i]!;
      if (it.userId === userId && it.provider === provider) this.identities.splice(i, 1);
    }
    this.identities.push({ userId, provider, subject, createdAtIso: new Date().toISOString() });
  }

  async unlinkIdentity(userId: string, provider: string): Promise<void> {
    for (let i = this.identities.length - 1; i >= 0; i--) {
      const it = this.identities[i]!;
      if (it.userId === userId && it.provider === provider) this.identities.splice(i, 1);
    }
  }

  async listIdentities(userId: string): Promise<LinkedIdentity[]> {
    return this.identities
      .filter((i) => i.userId === userId)
      .map(({ provider, subject, createdAtIso }) => ({ provider, subject, createdAtIso }));
  }
  private readonly emailCodes = new Map<string, { codeHash: string; expiresAtIso: string; attempts: number; createdAtIso: string }>();
  private readonly resets = new Map<string, { userId: string; expiresAtIso: string; used: boolean }>();

  constructor(private readonly core: MemoryCoreState) {}

  /** Orders and rebates live in MemoryPaymentsStore; deleteUser asks it through this probe. */
  private paymentReferences: MemoryPaymentReferences | null = null;

  attachPaymentReferences(probe: MemoryPaymentReferences): void {
    this.paymentReferences = probe;
  }

  async getBlob(key: string): Promise<Record<string, unknown> | null> {
    const v = this.blobs.get(key);
    return v ? structuredClone(v) : null;
  }

  async setBlob(key: string, value: Record<string, unknown>): Promise<void> {
    this.blobs.set(key, structuredClone(value));
  }

  async updateBlob(
    key: string,
    mutator: (current: Record<string, unknown> | null) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const prev = this.blobLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => gate);
    this.blobLocks.set(key, tail);
    await prev;
    try {
      const current = await this.getBlob(key);
      const next = await mutator(current);
      await this.setBlob(key, next);
      return structuredClone(next);
    } finally {
      release();
      if (this.blobLocks.get(key) === tail) this.blobLocks.delete(key);
    }
  }

  async saveEmailCode(email: string, purpose: string, codeHash: string, expiresAtIso: string): Promise<void> {
    this.emailCodes.set(`${email.toLowerCase()}\u0000${purpose}`, {
      codeHash,
      expiresAtIso,
      attempts: 0,
      createdAtIso: new Date().toISOString(),
    });
  }

  async consumeEmailCode(email: string, purpose: string, codeHash: string): Promise<boolean> {
    const key = `${email.toLowerCase()}\u0000${purpose}`;
    const rec = this.emailCodes.get(key);
    if (!rec || Date.parse(rec.expiresAtIso) <= Date.now()) return false;
    if (rec.codeHash !== codeHash) {
      rec.attempts++;
      if (rec.attempts >= 5) this.emailCodes.delete(key);
      return false;
    }
    this.emailCodes.delete(key);
    return true;
  }

  async lastEmailCodeAt(email: string, purpose: string): Promise<string | null> {
    return this.emailCodes.get(`${email.toLowerCase()}\u0000${purpose}`)?.createdAtIso ?? null;
  }

  async savePasswordReset(userId: string, tokenHash: string, expiresAtIso: string): Promise<void> {
    this.resets.set(tokenHash, { userId, expiresAtIso, used: false });
  }

  async consumePasswordReset(tokenHash: string): Promise<string | null> {
    const rec = this.resets.get(tokenHash);
    if (!rec || rec.used || Date.parse(rec.expiresAtIso) <= Date.now() || !this.core.users.has(rec.userId)) return null;
    rec.used = true;
    return rec.userId;
  }

  private metaOf(userId: string): UserMeta {
    let m = this.meta.get(userId);
    if (!m) {
      m = { notes: "", allowedGroupIds: [], inviteCode: "", referrerId: null, lastLoginAtIso: null };
      this.meta.set(userId, m);
    }
    return m;
  }

  private requireUser(userId: string): StoredUserRecord {
    const u = this.core.users.get(userId);
    if (!u) throw new StoreError("not_found", `User ${userId} not found`);
    return u;
  }

  /* ---------------- Sessions ---------------- */

  /** userId -> token version (absent = 0), mirrors commerce.users.token_version. */
  private readonly tokenVersions = new Map<string, number>();
  /** Signed-out token ids -> expiry (ms), mirrors commerce.revoked_tokens. */
  private readonly revokedTokens = new Map<string, number>();

  private bumpVersion(userId: string): number {
    const next = (this.tokenVersions.get(userId) ?? 0) + 1;
    this.tokenVersions.set(userId, next);
    return next;
  }

  /** The user's current token version, synchronously (MemoryControlStore.findUserByEmail reads it with the hash). */
  tokenVersionOf(userId: string): number {
    return this.tokenVersions.get(userId) ?? 0;
  }

  async getSessionState(userId: string, jti?: string): Promise<SessionState> {
    const u = this.core.users.get(userId);
    if (!u) return { user: null, revoked: false };
    return {
      user: { email: u.email, role: u.role, status: u.status, tokenVersion: this.tokenVersionOf(userId) },
      revoked: jti !== undefined && this.revokedTokens.has(jti),
    };
  }

  async bumpTokenVersion(userId: string): Promise<number | null> {
    return this.core.users.has(userId) ? this.bumpVersion(userId) : null;
  }

  async revokeToken(jti: string, _userId: string, expiresAtIso: string): Promise<void> {
    const now = Date.now();
    for (const [id, exp] of this.revokedTokens) if (exp < now) this.revokedTokens.delete(id);
    if (!this.revokedTokens.has(jti)) this.revokedTokens.set(jti, Date.parse(expiresAtIso));
  }

  /* ---------------- Settings ---------------- */

  async getSettings(): Promise<PortalSettings> {
    const setup = this.core.getSetup();
    return normalizePortalSettings({
      ...this.settings,
      siteName: setup.siteName,
      allowRegistration: setup.allowRegistration,
    });
  }

  async saveSettings(settings: PortalSettings): Promise<PortalSettings> {
    this.settings = normalizePortalSettings(settings);
    this.core.patchSetup({ siteName: this.settings.siteName, allowRegistration: this.settings.allowRegistration });
    return this.getSettings();
  }

  async updateSettings(
    mutator: (current: PortalSettings) => PortalSettings | Promise<PortalSettings>,
  ): Promise<{ previous: PortalSettings; saved: PortalSettings }> {
    const prev = this.settingsLock;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => gate);
    this.settingsLock = tail;
    await prev;
    try {
      const previous = await this.getSettings();
      const saved = await this.saveSettings(await mutator(previous));
      return { previous, saved };
    } finally {
      release();
    }
  }

  /* ---------------- Users ---------------- */

  private toAdminUser(u: StoredUserRecord): AdminUserItem {
    const m = this.metaOf(u.id);
    const w = this.core.wallets.get(u.id);
    let apiKeyCount = 0;
    for (const k of this.core.apiKeys.values()) if (k.userId === u.id) apiKeyCount++;
    const now = Date.now();
    let activeSubscriptionCount = 0;
    for (const s of this.subs.values()) {
      if (s.userId === u.id && effectiveSubscriptionStatus(s.status, s.expiresAtIso, now) === "active") {
        activeSubscriptionCount++;
      }
    }
    const { passwordHash: _, ...profile } = u;
    return {
      ...profile,
      notes: m.notes,
      allowedGroupIds: [...m.allowedGroupIds],
      inviteCode: m.inviteCode,
      referrerId: m.referrerId,
      referrerEmail: m.referrerId ? (this.core.users.get(m.referrerId)?.email ?? null) : null,
      lastLoginAtIso: m.lastLoginAtIso,
      balanceNanoUsd: (w?.balanceNano ?? 0n).toString(),
      spentNanoUsd: (w?.spentNano ?? 0n).toString(),
      apiKeyCount,
      activeSubscriptionCount,
    };
  }

  async listAdminUsers(query: AdminUserListQuery): Promise<AdminUserListResponse> {
    const all = Array.from(this.core.users.values()).map((u) => this.toAdminUser(u));
    const q = query.search?.toLowerCase();
    const filtered = all.filter((u) => {
      if (query.role && u.role !== query.role) return false;
      if (query.status && u.status !== query.status) return false;
      if (q && ![u.email, u.username, u.notes, u.id].some((v) => v.toLowerCase().includes(q))) return false;
      if (query.groupId && !u.allowedGroupIds.includes(query.groupId)) return false;
      if (query.apiKeyGroupId && ![...this.core.apiKeys.values()].some((k) => k.userId === u.id && k.groupId === query.apiKeyGroupId)) {
        return false;
      }
      return true;
    });
    const big = (v: string) => BigInt(v);
    const lastUsed = new Map<string, string>();
    for (const k of this.core.apiKeys.values()) {
      if (k.lastUsedAtIso && (lastUsed.get(k.userId) ?? "") < k.lastUsedAtIso) lastUsed.set(k.userId, k.lastUsedAtIso);
    }
    const todayCost = new Map<string, bigint>();
    if (query.sort === "today_cost_desc") {
      const since = viewerDayStartMs(Date.now(), query.tz);
      for (const l of this.core.usageLogs) {
        if (Date.parse(l.createdAtIso) >= since) todayCost.set(l.userId, (todayCost.get(l.userId) ?? 0n) + BigInt(l.costNanoUsd));
      }
    }
    const desc = (x: bigint, y: bigint) => (y > x ? 1 : y < x ? -1 : 0);
    const activeOf = (u: AdminUserItem) => laterIso(u.lastLoginAtIso, lastUsed.get(u.id)) ?? "";
    const sorters: Record<AdminUserListQuery["sort"], (a: AdminUserItem, b: AdminUserItem) => number> = {
      created_desc: (a, b) => cmp(b.createdAtIso, a.createdAtIso),
      created_asc: (a, b) => cmp(a.createdAtIso, b.createdAtIso),
      balance_desc: (a, b) => (big(b.balanceNanoUsd) > big(a.balanceNanoUsd) ? 1 : big(b.balanceNanoUsd) < big(a.balanceNanoUsd) ? -1 : 0),
      balance_asc: (a, b) => (big(a.balanceNanoUsd) > big(b.balanceNanoUsd) ? 1 : big(a.balanceNanoUsd) < big(b.balanceNanoUsd) ? -1 : 0),
      spent_desc: (a, b) => (big(b.spentNanoUsd) > big(a.spentNanoUsd) ? 1 : big(b.spentNanoUsd) < big(a.spentNanoUsd) ? -1 : 0),
      email_asc: (a, b) => cmp(a.email, b.email),
      login_desc: (a, b) => cmp(b.lastLoginAtIso ?? "", a.lastLoginAtIso ?? ""),
      today_cost_desc: (a, b) => desc(todayCost.get(a.id) ?? 0n, todayCost.get(b.id) ?? 0n) || cmp(b.createdAtIso, a.createdAtIso),
      total_cost_desc: (a, b) => desc(big(a.spentNanoUsd), big(b.spentNanoUsd)) || cmp(b.createdAtIso, a.createdAtIso),
      last_used_desc: (a, b) => cmp(lastUsed.get(b.id) ?? "", lastUsed.get(a.id) ?? "") || cmp(b.createdAtIso, a.createdAtIso),
      last_active_desc: (a, b) => cmp(activeOf(b), activeOf(a)) || cmp(b.createdAtIso, a.createdAtIso),
    };
    filtered.sort(sorters[query.sort]);
    const { offset, limit } = clampPage(query.page, query.pageSize);
    const weekAgo = Date.now() - 7 * DAY_MS;
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      stats: {
        total: all.length,
        admins: all.filter((u) => u.role === "admin").length,
        suspended: all.filter((u) => u.status === "suspended").length,
        newLast7d: all.filter((u) => Date.parse(u.createdAtIso) >= weekAgo).length,
        balanceNanoUsd: all.reduce((sum, u) => sum + BigInt(u.balanceNanoUsd), 0n).toString(),
      },
    };
  }

  async getAdminUser(userId: string): Promise<AdminUserItem | null> {
    const u = this.core.users.get(userId);
    return u ? this.toAdminUser(u) : null;
  }

  private assertEmailFree(email: string, exceptId?: string) {
    const normalized = email.toLowerCase();
    for (const u of this.core.users.values()) {
      if (u.id !== exceptId && u.email.toLowerCase() === normalized) {
        throw new StoreError("conflict", "Email is already registered");
      }
    }
  }

  async createUser(input: AdminUserCreateInput): Promise<AdminUserItem> {
    this.assertEmailFree(input.email);
    const id = `usr_${crypto.randomUUID()}`;
    const record: StoredUserRecord = {
      id,
      email: input.email.toLowerCase(),
      username: input.username,
      passwordHash: input.passwordHash,
      role: input.role,
      status: "active",
      totpEnabled: false,
      createdAtIso: new Date().toISOString(),
    };
    this.core.users.set(id, record);
    this.core.wallets.set(id, { balanceNano: 0n, heldNano: 0n, spentNano: 0n });
    const m = this.metaOf(id);
    m.notes = input.notes;
    m.allowedGroupIds = [...new Set(input.allowedGroupIds)];
    if (input.initialBalanceNano > 0n) {
      applyMemoryWalletDelta(this.core, id, input.initialBalanceNano, `signup:${id}`, "credit", "initial_balance");
    }
    return this.toAdminUser(record);
  }

  private activeAdminCount(exceptId?: string): number {
    let n = 0;
    for (const u of this.core.users.values()) {
      if (u.id !== exceptId && u.role === "admin" && u.status === "active") n++;
    }
    return n;
  }

  async updateUser(userId: string, input: AdminUserUpdateInput): Promise<AdminUserItem> {
    const u = this.requireUser(userId);
    const losesAdmin =
      u.role === "admin" &&
      u.status === "active" &&
      ((input.role !== undefined && input.role !== "admin") || input.status === "suspended");
    if (losesAdmin && this.activeAdminCount(userId) === 0) {
      throw new StoreError("conflict", "The last active administrator cannot be demoted or suspended");
    }
    if (input.email !== undefined && input.email.toLowerCase() !== u.email) {
      this.assertEmailFree(input.email, userId);
      u.email = input.email.toLowerCase();
    }
    const endsSessions =
      (input.role !== undefined && input.role !== u.role) ||
      (input.status !== undefined && input.status !== u.status) ||
      input.passwordHash !== undefined;
    if (endsSessions) this.bumpVersion(userId);
    if (input.username !== undefined) u.username = input.username;
    if (input.role !== undefined) u.role = input.role;
    if (input.status !== undefined) u.status = input.status;
    if (input.passwordHash !== undefined) u.passwordHash = input.passwordHash;
    const m = this.metaOf(userId);
    if (input.notes !== undefined) m.notes = input.notes;
    if (input.allowedGroupIds !== undefined) m.allowedGroupIds = [...new Set(input.allowedGroupIds)];
    return this.toAdminUser(u);
  }

  async deleteUser(userId: string): Promise<void> {
    const u = this.requireUser(userId);
    if (u.role === "admin" && this.activeAdminCount(userId) === 0) {
      throw new StoreError("conflict", "The last active administrator cannot be deleted");
    }
    // Same refusals as PostgresOpsStore: orders and rebates keep pointing at the user.
    const refs = this.paymentReferences?.(userId) ?? { orders: 0, rebates: 0 };
    if (refs.orders > 0) throw new StoreError("conflict", "This user has payment orders; suspend the account instead");
    if (refs.rebates > 0) throw new StoreError("conflict", "This user has earned referral rebates; suspend the account instead");
    this.core.users.delete(userId);
    this.core.wallets.delete(userId);
    for (let i = this.core.ledger.length - 1; i >= 0; i--) {
      if (this.core.ledger[i]!.userId === userId) this.core.ledger.splice(i, 1);
    }
    this.meta.delete(userId);
    this.tokenVersions.delete(userId);
    for (const [id, k] of this.core.apiKeys) if (k.userId === userId) this.core.apiKeys.delete(id);
    for (const [id, s] of this.subs) if (s.userId === userId) this.subs.delete(id);
    for (const m of this.meta.values()) if (m.referrerId === userId) m.referrerId = null;
    for (let i = this.identities.length - 1; i >= 0; i--) if (this.identities[i]!.userId === userId) this.identities.splice(i, 1);
    for (let i = this.redeemClaims.length - 1; i >= 0; i--) if (this.redeemClaims[i]!.userId === userId) this.redeemClaims.splice(i, 1);
  }

  async setUsersStatus(userIds: string[], status: "active" | "suspended"): Promise<number> {
    let changed = 0;
    for (const id of new Set(userIds)) {
      const u = this.core.users.get(id);
      if (!u || u.status === status) continue;
      if (status === "suspended" && u.role === "admin") continue; // admins are never bulk-suspended
      u.status = status;
      this.bumpVersion(id);
      changed++;
    }
    return changed;
  }

  async adjustWallet(userId: string, deltaNano: bigint, idempotencyKey: string, reason: string): Promise<bigint> {
    this.requireUser(userId);
    applyMemoryWalletDelta(this.core, userId, deltaNano, idempotencyKey, "adjust", reason);
    return this.core.wallets.get(userId)?.balanceNano ?? 0n;
  }

  async adjustWalletAtomic(
    userId: string,
    operation: "add" | "subtract" | "set",
    amountNano: bigint,
    idempotencyKey: string,
    reason: string,
  ): Promise<{ balanceNano: bigint; deltaNano: bigint }> {
    this.requireUser(userId);
    const current = this.core.wallets.get(userId)?.balanceNano ?? 0n;
    const deltaNano =
      operation === "add" ? amountNano : operation === "subtract" ? -amountNano : amountNano - current;
    if (deltaNano === 0n) return { balanceNano: current, deltaNano: 0n };
    applyMemoryWalletDelta(this.core, userId, deltaNano, idempotencyKey, "adjust", reason);
    return { balanceNano: this.core.wallets.get(userId)?.balanceNano ?? 0n, deltaNano };
  }

  async listLedger(userId: string, limit: number): Promise<BalanceLedgerItem[]> {
    return this.core.ledger
      .filter((e) => e.userId === userId)
      .slice(0, limit)
      .map((e) => ({
        id: e.id,
        kind: e.kind,
        deltaNanoUsd: e.deltaNano.toString(),
        balanceAfterNanoUsd: e.balanceAfterNano.toString(),
        reason: e.reason,
        createdAtIso: e.createdAtIso,
      }));
  }

  async countAdmins(): Promise<number> {
    return this.activeAdminCount();
  }

  async listUserAccess(): Promise<UserAccessRecord[]> {
    return Array.from(this.core.users.values()).map((u) => ({
      id: u.id,
      role: u.role,
      status: u.status,
      allowedGroupIds: [...this.metaOf(u.id).allowedGroupIds],
    }));
  }

  async touchLastLogin(userId: string): Promise<void> {
    if (this.core.users.has(userId)) this.metaOf(userId).lastLoginAtIso = new Date().toISOString();
  }

  async updateOwnProfile(userId: string, username: string): Promise<UserProfile> {
    const u = this.requireUser(userId);
    u.username = username;
    const { passwordHash: _, ...profile } = u;
    return profile;
  }

  async getPasswordHash(userId: string): Promise<string | null> {
    return this.core.users.get(userId)?.passwordHash ?? null;
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<number> {
    this.requireUser(userId).passwordHash = passwordHash;
    return this.bumpVersion(userId);
  }

  async getTotp(userId: string): Promise<{ secretEnc: Uint8Array | null; enabled: boolean } | null> {
    const u = this.core.users.get(userId);
    if (!u) return null;
    return { secretEnc: this.metaOf(userId).totpSecretEnc ?? null, enabled: u.totpEnabled };
  }

  async setTotp(userId: string, secretEnc: Uint8Array | null, enabled: boolean): Promise<void> {
    const u = this.requireUser(userId);
    this.metaOf(userId).totpSecretEnc = secretEnc;
    u.totpEnabled = enabled && secretEnc !== null;
  }

  async applyRegistrationExtras(userId: string, extras: RegistrationExtras): Promise<RegistrationOutcome> {
    const u = this.requireUser(userId);
    if (extras.username) u.username = extras.username;
    let referrerId: string | null = null;
    if (extras.affCode) {
      referrerId = await this.findUserIdByInviteCode(extras.affCode);
      if (referrerId && referrerId !== userId) this.metaOf(userId).referrerId = referrerId;
      else referrerId = null;
    }
    let promoBonusNano = 0n;
    if (extras.promoCode) {
      const code = extras.promoCode.trim().toUpperCase();
      const promo = Array.from(this.promos.values()).find((p) => p.code === code);
      if (promo && this.promoReason(promo) === "ok") {
        promo.usedCount++;
        promoBonusNano = promo.bonusNano;
        this.promoUsages.unshift({ promoId: promo.id, userId, bonusNano: promo.bonusNano, usedAtIso: new Date().toISOString() });
        if (promo.bonusNano > 0n) {
          applyMemoryWalletDelta(this.core, userId, promo.bonusNano, `promo:${promo.id}:${userId}`, "credit", `promo:${promo.code}`);
        }
      }
    }
    return { promoBonusNano, referrerId };
  }

  async isInvitationCodeUsable(code: string): Promise<boolean> {
    const rec = this.redeem.get(normalizeRedeemCode(code));
    return Boolean(
      rec &&
        rec.kind === "invitation" &&
        effectiveRedeemStatus(rec.status, rec.expiresAtIso) === "unused" &&
        rec.usedCount < rec.maxUses,
    );
  }

  async registerWithInvitation<T extends { id: string }>(code: string, register: () => Promise<T>): Promise<T | null> {
    const rec = this.redeem.get(normalizeRedeemCode(code));
    // Check and claim with no await in between: one concurrent registration wins the slot.
    if (
      !rec ||
      rec.kind !== "invitation" ||
      effectiveRedeemStatus(rec.status, rec.expiresAtIso) !== "unused" ||
      rec.usedCount >= rec.maxUses
    ) {
      return null;
    }
    const prevRedeemedAt = rec.redeemedAtIso;
    const prevStatus = rec.status;
    rec.usedCount += 1;
    if (rec.usedCount >= rec.maxUses) rec.status = "used";
    if (rec.maxUses === 1) rec.redeemedBy = null;
    const nowIso = new Date().toISOString();
    rec.redeemedAtIso = nowIso;
    let created: T;
    try {
      created = await register();
    } catch (err) {
      rec.usedCount = Math.max(0, rec.usedCount - 1);
      rec.status = rec.usedCount < rec.maxUses ? "unused" : prevStatus;
      if (rec.maxUses === 1) rec.redeemedAtIso = prevRedeemedAt;
      throw err;
    }
    rec.redeemedBy = created.id;
    this.redeemClaims.unshift({
      id: `rdc_${crypto.randomUUID()}`,
      code: rec.code,
      batchId: rec.batchId,
      userId: created.id,
      kind: "invitation",
      amountNano: 0n,
      groupId: null,
      validityDays: null,
      redeemedAtIso: nowIso,
    });
    return created;
  }

  async findUserIdByInviteCode(inviteCode: string): Promise<string | null> {
    const wanted = inviteCode.trim().toUpperCase();
    if (!wanted) return null;
    for (const [id, m] of this.meta) if (m.inviteCode === wanted && this.core.users.has(id)) return id;
    return null;
  }

  async ensureInviteCode(userId: string): Promise<string> {
    this.requireUser(userId);
    const m = this.metaOf(userId);
    if (!m.inviteCode) {
      let code = randomCode(8);
      while (await this.findUserIdByInviteCode(code)) code = randomCode(8);
      m.inviteCode = code;
    }
    return m.inviteCode;
  }

  async listInvitees(referrerId: string): Promise<{ email: string; username: string; joinedAtIso: string }[]> {
    const out: { email: string; username: string; joinedAtIso: string }[] = [];
    for (const [id, m] of this.meta) {
      const u = this.core.users.get(id);
      if (u && m.referrerId === referrerId) out.push({ email: u.email, username: u.username, joinedAtIso: u.createdAtIso });
    }
    return out.sort((a, b) => cmp(b.joinedAtIso, a.joinedAtIso)).slice(0, 500);
  }

  /* ---------------- Redeem codes ---------------- */

  private toRedeemItem(r: RedeemRecord, nowMs = Date.now()): RedeemCodeItem {
    return {
      code: r.code,
      kind: r.kind,
      amountNanoUsd: r.amountNano.toString(),
      groupId: r.groupId,
      groupName: r.groupId ? (this.core.groups.get(r.groupId)?.name ?? null) : null,
      validityDays: r.validityDays,
      status: effectiveRedeemStatus(r.status, r.expiresAtIso, nowMs),
      batchId: r.batchId,
      notes: r.notes,
      redeemedBy: r.redeemedBy,
      redeemedByEmail: r.redeemedBy ? (this.core.users.get(r.redeemedBy)?.email ?? null) : null,
      redeemedAtIso: r.redeemedAtIso,
      expiresAtIso: r.expiresAtIso,
      createdAtIso: r.createdAtIso,
      maxUses: r.maxUses,
      usedCount: r.usedCount,
      perUserLimit: r.perUserLimit,
      batchPerUserLimit: r.batchPerUserLimit,
    };
  }

  async generateRedeemCodes(
    req: GenerateRedeemCodesRequest,
    codes: string[],
    amountNano: bigint,
    _createdBy: string,
  ): Promise<RedeemCodeItem[]> {
    if (req.kind === "subscription") this.requireSubscriptionGroup(req.groupId ?? "");
    const batchId = `b_${randomCode(10).toLowerCase()}`;
    const now = new Date().toISOString();
    const maxUses = req.maxUses ?? 1;
    const perUserLimit = Math.min(req.perUserLimit ?? 1, maxUses);
    const batchPerUserLimit = req.batchPerUserLimit ?? 0;
    const out: RedeemCodeItem[] = [];
    for (const code of codes) {
      if (this.redeem.has(code)) throw new StoreError("conflict", "Generated a duplicate code, retry");
      const rec: RedeemRecord = {
        code,
        kind: req.kind,
        amountNano: req.kind === "balance" ? amountNano : 0n,
        groupId: req.kind === "subscription" ? (req.groupId ?? null) : null,
        validityDays: req.kind === "subscription" ? (req.validityDays ?? null) : null,
        status: "unused",
        batchId,
        notes: req.notes,
        redeemedBy: null,
        redeemedAtIso: null,
        expiresAtIso: req.expiresAtIso ?? null,
        createdAtIso: now,
        maxUses,
        usedCount: 0,
        perUserLimit,
        batchPerUserLimit,
      };
      this.redeem.set(code, rec);
      out.push(this.toRedeemItem(rec));
    }
    return out;
  }

  async listRedeemCodes(query: RedeemCodeListQuery): Promise<RedeemCodeListResponse> {
    const now = Date.now();
    const all = Array.from(this.redeem.values())
      .map((r) => this.toRedeemItem(r, now))
      .sort((a, b) => cmp(b.createdAtIso, a.createdAtIso) || cmp(a.code, b.code));
    const q = query.search?.toUpperCase();
    const filtered = all.filter((r) => {
      if (query.status && r.status !== query.status) return false;
      if (query.kind && r.kind !== query.kind) return false;
      if (query.batchId && r.batchId !== query.batchId) return false;
      if (q && !r.code.includes(q) && !(r.redeemedByEmail ?? "").toUpperCase().includes(q) && !r.notes.toUpperCase().includes(q)) return false;
      return true;
    });
    const { offset, limit } = clampPage(query.page, query.pageSize);
    const count = (s: string) => all.filter((r) => r.status === s).length;
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      stats: {
        total: all.length,
        unused: count("unused"),
        used: count("used"),
        disabled: count("disabled"),
        expired: count("expired"),
        redeemedNanoUsd: Array.from(this.redeem.values())
          .filter((r) => r.kind === "balance")
          .reduce((sum, r) => sum + r.amountNano * BigInt(Math.max(r.usedCount, r.status === "used" ? 1 : 0)), 0n)
          .toString(),
      },
    };
  }

  async updateRedeemCodes(req: UpdateRedeemCodesRequest): Promise<number> {
    let changed = 0;
    for (const raw of new Set(req.codes)) {
      const code = normalizeRedeemCode(raw);
      const rec = this.redeem.get(code);
      if (!rec) continue;
      switch (req.action) {
        case "disable":
          if (rec.status !== "unused") continue;
          rec.status = "disabled";
          break;
        case "enable":
          if (rec.status !== "disabled") continue;
          rec.status = "unused";
          break;
        case "delete":
          if (rec.status === "used") continue; // used codes stay as redemption history
          this.redeem.delete(code);
          break;
        case "set_expiry":
          if (rec.status === "used") continue;
          rec.expiresAtIso = req.expiresAtIso ?? null;
          break;
        case "set_notes":
          rec.notes = req.notes ?? "";
          break;
      }
      changed++;
    }
    return changed;
  }

  async redeemCode(userId: string, rawCode: string): Promise<RedeemResult> {
    this.requireUser(userId);
    const code = normalizeRedeemCode(rawCode);
    const rec = this.redeem.get(code);
    if (!rec || rec.status === "disabled" || rec.kind === "invitation") {
      throw new StoreError("not_found", "Invalid redeem code");
    }
    if (rec.status === "used" || rec.usedCount >= rec.maxUses) {
      throw new StoreError("conflict", "This code has already been used");
    }
    if (effectiveRedeemStatus(rec.status, rec.expiresAtIso) === "expired") {
      throw new StoreError("bad_request", "This code has expired");
    }
    const priorCodeClaims = this.redeemClaims.filter((c) => c.code === code && c.userId === userId).length;
    if (priorCodeClaims >= rec.perUserLimit) {
      throw new StoreError("conflict", "You have already reached the redemption limit for this code");
    }
    if (rec.batchPerUserLimit > 0 && rec.batchId) {
      const priorBatchClaims = this.redeemClaims.filter((c) => c.batchId === rec.batchId && c.userId === userId).length;
      if (priorBatchClaims >= rec.batchPerUserLimit) {
        throw new StoreError("conflict", "You have already reached the redemption limit for this batch");
      }
    }
    const claimId = `rdc_${crypto.randomUUID()}`;
    const idempotencyKey = rec.maxUses === 1 ? `redeem:${code}` : `redeem:${code}:${claimId}`;
    let subscriptionExpiresAtIso: string | null = null;
    // No await from the checks to recording the claim + incrementing usedCount.
    if (rec.kind === "subscription") {
      const sub = this.grantSubscription(userId, rec.groupId ?? "", rec.validityDays ?? 30, "", idempotencyKey, Date.now());
      subscriptionExpiresAtIso = sub.expiresAtIso;
    } else if (rec.amountNano > 0n) {
      applyMemoryWalletDelta(this.core, userId, rec.amountNano, idempotencyKey, "credit", idempotencyKey);
    }
    const nowIso = new Date().toISOString();
    this.redeemClaims.unshift({
      id: claimId,
      code,
      batchId: rec.batchId,
      userId,
      kind: rec.kind,
      amountNano: rec.amountNano,
      groupId: rec.groupId,
      validityDays: rec.validityDays,
      redeemedAtIso: nowIso,
    });
    rec.usedCount += 1;
    rec.status = rec.usedCount >= rec.maxUses ? "used" : "unused";
    rec.redeemedBy = userId;
    rec.redeemedAtIso = nowIso;
    return {
      code,
      kind: rec.kind,
      amountNanoUsd: rec.amountNano.toString(),
      groupName: rec.groupId ? (this.core.groups.get(rec.groupId)?.name ?? null) : null,
      validityDays: rec.validityDays,
      subscriptionExpiresAtIso,
    };
  }

  async listUserRedeemHistory(userId: string, limit: number): Promise<RedeemCodeItem[]> {
    const out: RedeemCodeItem[] = [];
    const seenCodes = new Set<string>();
    for (const cl of this.redeemClaims) {
      if (cl.userId !== userId) continue;
      const rec = this.redeem.get(cl.code);
      if (!rec) continue;
      seenCodes.add(cl.code);
      const email = this.core.users.get(userId)?.email ?? null;
      out.push({
        ...this.toRedeemItem(rec),
        amountNanoUsd: cl.amountNano.toString(),
        groupId: cl.groupId,
        groupName: cl.groupId ? (this.core.groups.get(cl.groupId)?.name ?? null) : null,
        validityDays: cl.validityDays,
        redeemedBy: userId,
        redeemedByEmail: email,
        redeemedAtIso: cl.redeemedAtIso,
      });
      if (out.length >= limit) break;
    }
    if (out.length < limit) {
      for (const rec of this.redeem.values()) {
        if (rec.redeemedBy === userId && !seenCodes.has(rec.code)) {
          out.push(this.toRedeemItem(rec));
          if (out.length >= limit) break;
        }
      }
    }
    return out.sort((a, b) => cmp(b.redeemedAtIso ?? "", a.redeemedAtIso ?? "")).slice(0, limit);
  }

  async listRedeemCodeClaims(rawCode: string): Promise<RedeemCodeClaimItem[]> {
    const code = normalizeRedeemCode(rawCode);
    const rec = this.redeem.get(code);
    if (!rec) throw new StoreError("not_found", "Redeem code not found");
    const claims = this.redeemClaims.filter((c) => c.code === code);
    if (claims.length === 0 && rec.redeemedBy) {
      return [
        {
          id: `legacy_${rec.code}`,
          code: rec.code,
          batchId: rec.batchId,
          userId: rec.redeemedBy,
          userEmail: this.core.users.get(rec.redeemedBy)?.email ?? "",
          kind: rec.kind,
          amountNanoUsd: rec.amountNano.toString(),
          groupId: rec.groupId,
          validityDays: rec.validityDays,
          redeemedAtIso: rec.redeemedAtIso ?? new Date(0).toISOString(),
        },
      ];
    }
    return claims.slice(0, 500).map((cl) => ({
      id: cl.id,
      code: cl.code,
      batchId: cl.batchId,
      userId: cl.userId,
      userEmail: this.core.users.get(cl.userId)?.email ?? "",
      kind: cl.kind,
      amountNanoUsd: cl.amountNano.toString(),
      groupId: cl.groupId,
      validityDays: cl.validityDays,
      redeemedAtIso: cl.redeemedAtIso,
    }));
  }

  /* ---------------- Promo codes ---------------- */

  private promoReason(p: PromoRecord, nowMs = Date.now()): PromoCodeCheckResponse["reason"] {
    if (!p.enabled) return "disabled";
    if (p.expiresAtIso && Date.parse(p.expiresAtIso) <= nowMs) return "expired";
    if (p.maxUses > 0 && p.usedCount >= p.maxUses) return "exhausted";
    return "ok";
  }

  private toPromoItem(p: PromoRecord): PromoCodeItem {
    return {
      id: p.id,
      code: p.code,
      bonusNanoUsd: p.bonusNano.toString(),
      maxUses: p.maxUses,
      usedCount: p.usedCount,
      enabled: p.enabled,
      expiresAtIso: p.expiresAtIso,
      notes: p.notes,
      createdAtIso: p.createdAtIso,
    };
  }

  async listPromoCodes(): Promise<PromoCodeItem[]> {
    return Array.from(this.promos.values())
      .sort((a, b) => cmp(b.createdAtIso, a.createdAtIso))
      .map((p) => this.toPromoItem(p));
  }

  async createPromoCode(code: string, req: CreatePromoCodeRequest, bonusNano: bigint): Promise<PromoCodeItem> {
    for (const p of this.promos.values()) {
      if (p.code === code) throw new StoreError("conflict", `Promo code ${code} already exists`);
    }
    const rec: PromoRecord = {
      id: `promo_${crypto.randomUUID()}`,
      code,
      bonusNano,
      maxUses: req.maxUses,
      usedCount: 0,
      enabled: req.enabled,
      expiresAtIso: req.expiresAtIso,
      notes: req.notes,
      createdAtIso: new Date().toISOString(),
    };
    this.promos.set(rec.id, rec);
    return this.toPromoItem(rec);
  }

  async updatePromoCode(id: string, req: UpdatePromoCodeRequest, bonusNano: bigint | null): Promise<PromoCodeItem> {
    const p = this.promos.get(id);
    if (!p) throw new StoreError("not_found", "Promo code not found");
    if (bonusNano !== null) p.bonusNano = bonusNano;
    if (req.maxUses !== undefined) p.maxUses = req.maxUses;
    if (req.enabled !== undefined) p.enabled = req.enabled;
    if (req.expiresAtIso !== undefined) p.expiresAtIso = req.expiresAtIso;
    if (req.notes !== undefined) p.notes = req.notes;
    return this.toPromoItem(p);
  }

  async deletePromoCode(id: string): Promise<void> {
    if (!this.promos.delete(id)) throw new StoreError("not_found", "Promo code not found");
  }

  async listPromoCodeUsages(id: string): Promise<PromoCodeUsageItem[]> {
    if (!this.promos.has(id)) throw new StoreError("not_found", "Promo code not found");
    return this.promoUsages
      .filter((u) => u.promoId === id)
      .map((u) => ({
        userId: u.userId,
        userEmail: this.core.users.get(u.userId)?.email ?? "",
        bonusNanoUsd: u.bonusNano.toString(),
        usedAtIso: u.usedAtIso,
      }));
  }

  async checkPromoCode(code: string): Promise<PromoCodeCheckResponse> {
    const wanted = code.trim().toUpperCase();
    const p = Array.from(this.promos.values()).find((x) => x.code === wanted);
    if (!p) return { valid: false, bonusNanoUsd: "0", reason: "not_found" };
    const reason = this.promoReason(p);
    return { valid: reason === "ok", bonusNanoUsd: p.bonusNano.toString(), reason };
  }

  /* ---------------- Announcements ---------------- */

  private readCount(id: string): number {
    let n = 0;
    for (const key of this.reads.keys()) if (key.startsWith(`${id}\u0000`)) n++;
    return n;
  }

  async listAnnouncements(): Promise<AnnouncementItem[]> {
    return Array.from(this.announcements.values())
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || cmp(b.createdAtIso, a.createdAtIso))
      .map((a) => ({ ...a, targeting: structuredClone(a.targeting), readCount: this.readCount(a.id) }));
  }

  async createAnnouncement(req: UpsertAnnouncementRequest, _createdBy: string): Promise<AnnouncementItem> {
    const now = new Date().toISOString();
    const rec: AnnouncementRecord = {
      id: `ann_${crypto.randomUUID()}`,
      ...req,
      targeting: structuredClone(req.targeting ?? { anyOf: [] }),
      createdAtIso: now,
      updatedAtIso: now,
    };
    this.announcements.set(rec.id, rec);
    return { ...rec, targeting: structuredClone(rec.targeting), readCount: 0 };
  }

  async updateAnnouncement(id: string, req: UpsertAnnouncementRequest): Promise<AnnouncementItem> {
    const rec = this.announcements.get(id);
    if (!rec) throw new StoreError("not_found", "Announcement not found");
    // Omitted targeting keeps the stored rule (same as PostgresOpsStore).
    const { targeting, ...rest } = req;
    Object.assign(rec, rest, targeting ? { targeting: structuredClone(targeting) } : {}, { updatedAtIso: new Date().toISOString() });
    return { ...rec, targeting: structuredClone(rec.targeting), readCount: this.readCount(id) };
  }

  /** Wallet balance and active, unexpired subscription groups of one account (targeting input). */
  private targetingContext(userId: string, nowMs: number): { balanceNano: bigint; groups: Set<string> } {
    const groups = new Set<string>();
    for (const s of this.subs.values()) {
      if (s.userId === userId && s.status === "active" && Date.parse(s.expiresAtIso) > nowMs) groups.add(s.groupId);
    }
    return { balanceNano: this.core.wallets.get(userId)?.balanceNano ?? 0n, groups };
  }

  /**
   * Published, live, audience-matching announcements whose targeting this user meets, newest
   * pinned first; like PostgresOpsStore, targeting narrows the newest 500 candidates.
   */
  private visibleAnnouncements(userId: string, role: UserRole, nowMs: number, only?: ReadonlySet<string>): AnnouncementRecord[] {
    const candidates = Array.from(this.announcements.values())
      .filter(
        (a) =>
          (!only || only.has(a.id)) &&
          a.status === "published" &&
          audienceMatches(a.audience, role) &&
          announcementLive(a.startsAtIso, a.endsAtIso, nowMs),
      )
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || cmp(b.startsAtIso ?? b.createdAtIso, a.startsAtIso ?? a.createdAtIso))
      .slice(0, ANNOUNCEMENT_FEED_CANDIDATES);
    if (!candidates.some((a) => targetingRestricts(a.targeting))) return candidates;
    const ctx = this.targetingContext(userId, nowMs);
    return candidates.filter((a) => targetingMatches(a.targeting, ctx.balanceNano, ctx.groups));
  }

  async listAnnouncementReadStatus(id: string, query: AnnouncementReadStatusQuery): Promise<AnnouncementReadStatusResponse> {
    const ann = this.announcements.get(id);
    if (!ann) throw new StoreError("not_found", "Announcement not found");
    const nowMs = Date.now();
    const active = new Map<string, Set<string>>();
    for (const s of this.subs.values()) {
      if (s.status !== "active" || Date.parse(s.expiresAtIso) <= nowMs) continue;
      const set = active.get(s.userId) ?? new Set<string>();
      set.add(s.groupId);
      active.set(s.userId, set);
    }
    const none = new Set<string>();
    const rows: AnnouncementReadStatusItem[] = Array.from(this.core.users.values()).map((u) => {
      const balanceNano = this.core.wallets.get(u.id)?.balanceNano ?? 0n;
      const readAtIso = this.reads.get(`${id}\u0000${u.id}`) ?? null;
      return {
        userId: u.id,
        email: u.email,
        username: u.username ?? "",
        role: u.role,
        status: u.status,
        balanceNanoUsd: balanceNano.toString(),
        read: readAtIso !== null,
        readAtIso,
        eligible: audienceMatches(ann.audience, u.role) && targetingMatches(ann.targeting, balanceNano, active.get(u.id) ?? none),
      };
    });
    const stats = {
      users: rows.length,
      eligible: rows.filter((r) => r.eligible).length,
      read: rows.filter((r) => r.read).length,
      eligibleRead: rows.filter((r) => r.eligible && r.read).length,
    };
    const q = query.q?.toLowerCase();
    const filtered = rows.filter((r) => {
      if (query.read === "read" && !r.read) return false;
      if (query.read === "unread" && r.read) return false;
      if (query.eligible === "eligible" && !r.eligible) return false;
      if (query.eligible === "ineligible" && r.eligible) return false;
      if (q && !r.email.toLowerCase().includes(q) && !r.username.toLowerCase().includes(q)) return false;
      return true;
    });
    const byEmail = (a: AnnouncementReadStatusItem, b: AnnouncementReadStatusItem) => cmp(a.email, b.email) || cmp(a.userId, b.userId);
    const byBalance = (a: AnnouncementReadStatusItem, b: AnnouncementReadStatusItem) => {
      const x = BigInt(a.balanceNanoUsd);
      const y = BigInt(b.balanceNanoUsd);
      return x < y ? -1 : x > y ? 1 : 0;
    };
    // Unread accounts always sort after read ones on the read-time orders (NULLS LAST).
    const byReadAt = (dir: 1 | -1) => (a: AnnouncementReadStatusItem, b: AnnouncementReadStatusItem) => {
      if (a.readAtIso === null || b.readAtIso === null) {
        return a.readAtIso === b.readAtIso ? byEmail(a, b) : a.readAtIso === null ? 1 : -1;
      }
      return dir * cmp(a.readAtIso, b.readAtIso) || byEmail(a, b);
    };
    const sorters: Record<AnnouncementReadStatusQuery["sort"], (a: AnnouncementReadStatusItem, b: AnnouncementReadStatusItem) => number> = {
      email_asc: byEmail,
      email_desc: (a, b) => byEmail(b, a),
      read_at_desc: byReadAt(-1),
      read_at_asc: byReadAt(1),
      // Accounts without a username sort last either way.
      username_asc: (a, b) => Number(a.username === "") - Number(b.username === "") || cmp(a.username, b.username) || byEmail(a, b),
      username_desc: (a, b) => Number(a.username === "") - Number(b.username === "") || cmp(b.username, a.username) || byEmail(a, b),
      balance_desc: (a, b) => byBalance(b, a) || byEmail(a, b),
      balance_asc: (a, b) => byBalance(a, b) || byEmail(a, b),
    };
    filtered.sort(sorters[query.sort]);
    const { offset, limit } = clampPage(query.page, query.pageSize);
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, stats };
  }

  async deleteAnnouncement(id: string): Promise<void> {
    if (!this.announcements.delete(id)) throw new StoreError("not_found", "Announcement not found");
    for (const key of [...this.reads.keys()]) if (key.startsWith(`${id}\u0000`)) this.reads.delete(key);
  }

  async listAnnouncementReaders(id: string): Promise<AnnouncementReader[]> {
    if (!this.announcements.has(id)) throw new StoreError("not_found", "Announcement not found");
    const out: AnnouncementReader[] = [];
    for (const [key, readAtIso] of this.reads) {
      const [annId, userId] = key.split("\u0000");
      if (annId !== id || !userId) continue;
      out.push({ userId, email: this.core.users.get(userId)?.email ?? "", readAtIso });
    }
    return out.sort((a, b) => cmp(b.readAtIso, a.readAtIso));
  }

  async listUserAnnouncements(userId: string, role: UserRole): Promise<UserAnnouncementItem[]> {
    return this.visibleAnnouncements(userId, role, Date.now())
      .slice(0, 50)
      .map(({ status: _s, audience: _a, targeting: _t, ...rest }) => ({ ...rest, read: this.reads.has(`${rest.id}\u0000${userId}`) }));
  }

  async markAnnouncementsRead(userId: string, ids: string[] | "all", role: UserRole): Promise<void> {
    if (ids !== "all" && ids.length === 0) return;
    // Only what this user may see right now: no read marks on drafts, other audiences or
    // announcements whose targeting they do not meet.
    const visible = this.visibleAnnouncements(userId, role, Date.now(), ids === "all" ? undefined : new Set(ids)).map((a) => a.id);
    const now = new Date().toISOString();
    for (const id of visible) {
      const key = `${id}\u0000${userId}`;
      if (!this.reads.has(key)) this.reads.set(key, now);
    }
  }

  /* ---------------- Audit ---------------- */

  async recordAudit(entry: AuditLogInput): Promise<void> {
    this.audit.unshift({ ...entry, id: `aud_${crypto.randomUUID()}`, createdAtIso: new Date().toISOString() });
    if (this.audit.length > 5000) this.audit.length = 5000;
  }

  async listAudit(query: AuditLogQuery): Promise<{ items: AuditLogItem[]; total: number }> {
    const q = query.search?.toLowerCase();
    const since = query.sinceIso ? Date.parse(query.sinceIso) : Number.NEGATIVE_INFINITY;
    const until = query.untilIso ? Date.parse(query.untilIso) : Number.POSITIVE_INFINITY;
    const filtered = this.audit.filter((a) => {
      if (query.method && a.method !== query.method) return false;
      if (query.actorId && a.actorId !== query.actorId) return false;
      if (query.outcome === "success" && a.statusCode >= 400) return false;
      if (query.outcome === "failure" && a.statusCode < 400) return false;
      const t = Date.parse(a.createdAtIso);
      if (t < since || t >= until) return false;
      if (q && ![a.actorEmail, a.path, a.route, a.ip, a.targetId].some((v) => v.toLowerCase().includes(q))) return false;
      return true;
    });
    const { offset, limit } = clampPage(query.page, query.pageSize);
    return { items: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  async clearAudit(): Promise<number> {
    const n = this.audit.length;
    this.audit.length = 0;
    return n;
  }

  async deleteAuditBefore(cutoff: Date, limit = AUDIT_DELETE_BATCH): Promise<number> {
    const cutoffMs = cutoff.getTime();
    const max = Math.max(1, Math.floor(limit));
    let deleted = 0;
    // Newest first (recordAudit unshifts): the oldest rows sit at the end.
    for (let i = this.audit.length - 1; i >= 0 && deleted < max; i--) {
      if (Date.parse(this.audit[i]!.createdAtIso) < cutoffMs) {
        this.audit.splice(i, 1);
        deleted++;
      }
    }
    return deleted;
  }

  /* ---------------- Subscriptions ---------------- */

  private requireSubscriptionGroup(groupId: string): GroupView {
    const g = this.core.groups.get(groupId);
    if (!g) throw new StoreError("not_found", `Group ${groupId} not found`);
    if (g.subscriptionType !== "subscription") {
      throw new StoreError("bad_request", `Group ${g.name} is not subscription-billed`);
    }
    return g;
  }

  private limitsOf(groupId: string): SubscriptionLimits {
    const g = this.core.groups.get(groupId);
    return {
      dailyLimitNanoUsd: g?.dailyLimitNanoUsd ?? "0",
      weeklyLimitNanoUsd: g?.weeklyLimitNanoUsd ?? "0",
      monthlyLimitNanoUsd: g?.monthlyLimitNanoUsd ?? "0",
    };
  }

  private usageOf(s: SubscriptionRecord, nowMs = Date.now()): SubscriptionUsage {
    const floor = s.usageResetAtIso ? Date.parse(s.usageResetAtIso) : Number.NEGATIVE_INFINITY;
    const dailyReset = s.dailyResetAtIso ? Date.parse(s.dailyResetAtIso) : Number.NEGATIVE_INFINITY;
    const weeklyReset = s.weeklyResetAtIso ? Date.parse(s.weeklyResetAtIso) : Number.NEGATIVE_INFINITY;
    const monthlyReset = s.monthlyResetAtIso ? Date.parse(s.monthlyResetAtIso) : Number.NEGATIVE_INFINITY;
    const since = {
      daily: nowMs - SUBSCRIPTION_WINDOWS_MS.daily,
      weekly: nowMs - SUBSCRIPTION_WINDOWS_MS.weekly,
      monthly: nowMs - SUBSCRIPTION_WINDOWS_MS.monthly,
    };
    let d = 0n;
    let w = 0n;
    let m = 0n;
    for (const log of this.core.usageLogs) {
      if (log.userId !== s.userId || log.groupId !== s.groupId) continue;
      const t = Date.parse(log.createdAtIso);
      // Spend at the reset instant itself belongs to the old window.
      if (t < since.monthly || t <= floor) continue;
      const cost = BigInt(log.costNanoUsd);
      if (t > monthlyReset) m += cost;
      if (t >= since.weekly && t > weeklyReset) w += cost;
      if (t >= since.daily && t > dailyReset) d += cost;
    }
    return { dailyNanoUsd: d.toString(), weeklyNanoUsd: w.toString(), monthlyNanoUsd: m.toString() };
  }

  private toSubItem(s: SubscriptionRecord, nowMs = Date.now()): UserSubscriptionItem {
    const limits = this.limitsOf(s.groupId);
    const usage = this.usageOf(s, nowMs);
    return {
      id: s.id,
      userId: s.userId,
      userEmail: this.core.users.get(s.userId)?.email ?? "",
      groupId: s.groupId,
      groupName: this.core.groups.get(s.groupId)?.name ?? s.groupId,
      status: effectiveSubscriptionStatus(s.status, s.expiresAtIso, nowMs),
      source: s.source,
      notes: s.notes,
      startsAtIso: s.startsAtIso,
      expiresAtIso: s.expiresAtIso,
      usageResetAtIso: s.usageResetAtIso,
      dailyResetAtIso: s.dailyResetAtIso,
      weeklyResetAtIso: s.weeklyResetAtIso,
      monthlyResetAtIso: s.monthlyResetAtIso,
      createdAtIso: s.createdAtIso,
      limits,
      usage,
      overLimit: subscriptionOverLimit(limits, usage),
    };
  }

  async listSubscriptions(query: UserSubscriptionListQuery): Promise<{ items: UserSubscriptionItem[]; total: number }> {
    const now = Date.now();
    const q = query.search?.toLowerCase();
    const filtered = Array.from(this.subs.values())
      .map((s) => this.toSubItem(s, now))
      .filter((s) => {
        if (query.status && s.status !== query.status) return false;
        if (query.groupId && s.groupId !== query.groupId) return false;
        if (query.userId && s.userId !== query.userId) return false;
        if (q && !s.userEmail.toLowerCase().includes(q) && !s.groupName.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => cmp(b.createdAtIso, a.createdAtIso));
    const { offset, limit } = clampPage(query.page, query.pageSize);
    return { items: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  async listUserSubscriptions(userId: string): Promise<UserSubscriptionItem[]> {
    const now = Date.now();
    return Array.from(this.subs.values())
      .filter((s) => s.userId === userId)
      .map((s) => this.toSubItem(s, now))
      .sort((a, b) => cmp(b.expiresAtIso, a.expiresAtIso));
  }

  async assignSubscription(
    userId: string,
    groupId: string,
    validityDays: number,
    notes: string,
    source: string,
  ): Promise<UserSubscriptionItem> {
    const now = Date.now();
    return this.toSubItem(this.grantSubscription(userId, groupId, validityDays, notes, source, now), now);
  }

  /**
   * Synchronous grant (no await between the lookup and the write, like the Postgres advisory
   * lock on the pair): concurrent grants for one (user, group) stack onto a single subscription.
   */
  private grantSubscription(userId: string, groupId: string, validityDays: number, notes: string, source: string, now: number): SubscriptionRecord {
    this.requireUser(userId);
    this.requireSubscriptionGroup(groupId);
    const addMs = validityDays * DAY_MS;
    // Extend the newest non-revoked subscription to this group rather than stacking a second one.
    const existing = Array.from(this.subs.values())
      .filter((s) => s.userId === userId && s.groupId === groupId && s.status === "active")
      .sort((a, b) => cmp(b.expiresAtIso, a.expiresAtIso))[0];
    if (existing) {
      const base = Math.max(now, Date.parse(existing.expiresAtIso));
      if (Date.parse(existing.expiresAtIso) <= now) existing.startsAtIso = new Date(now).toISOString();
      existing.expiresAtIso = new Date(base + addMs).toISOString();
      if (notes) existing.notes = notes;
      return existing;
    }
    const rec: SubscriptionRecord = {
      id: `sub_${crypto.randomUUID()}`,
      userId,
      groupId,
      status: "active",
      source,
      notes,
      startsAtIso: new Date(now).toISOString(),
      expiresAtIso: new Date(now + addMs).toISOString(),
      usageResetAtIso: null,
      dailyResetAtIso: null,
      weeklyResetAtIso: null,
      monthlyResetAtIso: null,
      createdAtIso: new Date(now).toISOString(),
    };
    this.subs.set(rec.id, rec);
    return rec;
  }

  async updateSubscription(
    id: string,
    action: SubscriptionAction,
    days: number,
    notes?: string,
    resetWindow: "all" | "daily" | "weekly" | "monthly" = "all",
  ): Promise<UserSubscriptionItem> {
    const s = this.subs.get(id);
    if (!s) throw new StoreError("not_found", "Subscription not found");
    const now = Date.now();
    switch (action) {
      case "extend": {
        if (days === 0) break;
        const expired = Date.parse(s.expiresAtIso) <= now;
        if (expired && days < 0) throw new StoreError("bad_request", "An expired subscription cannot be shortened");
        const base = expired ? now : Date.parse(s.expiresAtIso);
        if (expired) s.startsAtIso = new Date(now).toISOString();
        const next = base + days * DAY_MS;
        if (next <= Date.parse(s.startsAtIso)) throw new StoreError("bad_request", "That would end the subscription before it starts");
        s.expiresAtIso = new Date(next).toISOString();
        break;
      }
      case "revoke":
        s.status = "revoked";
        break;
      case "reactivate":
        s.status = "active";
        break;
      case "reset_usage": {
        const at = new Date(now).toISOString();
        if (resetWindow === "all") {
          s.usageResetAtIso = at;
          s.dailyResetAtIso = at;
          s.weeklyResetAtIso = at;
          s.monthlyResetAtIso = at;
        } else if (resetWindow === "daily") {
          s.dailyResetAtIso = at;
        } else if (resetWindow === "weekly") {
          s.weeklyResetAtIso = at;
        } else if (resetWindow === "monthly") {
          s.monthlyResetAtIso = at;
        }
        break;
      }
    }
    if (notes !== undefined) s.notes = notes;
    return this.toSubItem(s, now);
  }

  async deleteSubscription(id: string): Promise<void> {
    if (!this.subs.delete(id)) throw new StoreError("not_found", "Subscription not found");
  }

  async subscriptionEntitlements(): Promise<SubscriptionEntitlement[]> {
    const now = Date.now();
    const byPair = new Map<string, SubscriptionEntitlement>();
    for (const s of this.subs.values()) {
      const item = this.toSubItem(s, now);
      const usable = item.status === "active" && !item.overLimit;
      const key = `${s.userId}\u0000${s.groupId}`;
      const prev = byPair.get(key);
      if (!prev || (!prev.usable && usable)) byPair.set(key, { userId: s.userId, groupId: s.groupId, usable });
    }
    return [...byPair.values()];
  }

  async isSubscriptionOverLimit(userId: string, groupId: string): Promise<boolean> {
    const now = Date.now();
    const subs = Array.from(this.subs.values()).filter(
      (s) => s.userId === userId && s.groupId === groupId && effectiveSubscriptionStatus(s.status, s.expiresAtIso, now) === "active",
    );
    if (subs.length === 0) return true;
    return subs.every((s) => this.toSubItem(s, now).overLimit);
  }

  /* ---------------- Usage ---------------- */

  private matchUsage(log: UsageLogItem, q: Omit<UsageQuery, "page" | "pageSize">): boolean {
    if (q.userId && log.userId !== q.userId) return false;
    if (q.apiKeyId && log.apiKeyId !== q.apiKeyId) return false;
    if (q.groupId && log.groupId !== q.groupId) return false;
    if (q.accountId && log.accountId !== q.accountId) return false;
    if (q.model && !log.publicModel.toLowerCase().includes(q.model.toLowerCase())) return false;
    if (q.outcome === "success" && log.statusCode >= 400) return false;
    if (q.outcome === "error" && log.statusCode < 400) return false;
    const t = Date.parse(log.createdAtIso);
    if (q.sinceIso && t < Date.parse(q.sinceIso)) return false;
    if (q.untilIso && t >= Date.parse(q.untilIso)) return false;
    return true;
  }

  private toRow(log: UsageLogItem): UsageRow {
    return {
      ...log,
      userEmail: this.core.users.get(log.userId)?.email ?? "",
      apiKeyName: this.core.apiKeys.get(log.apiKeyId)?.name ?? "",
      groupName: this.core.groups.get(log.groupId)?.name ?? "",
      accountName: this.core.accounts.get(log.accountId)?.name ?? "",
    };
  }

  async queryUsage(query: UsageQuery): Promise<UsagePageResponse> {
    const matched = this.core.usageLogs.filter((l) => this.matchUsage(l, query));
    const { offset, limit } = clampPage(query.page, query.pageSize);
    if (query.summary === false) {
      // Same contract as Postgres: no summary, and the total is only what this page proves.
      const items = matched.slice(offset, offset + limit).map((l) => this.toRow(l));
      return { items, total: offset + items.length, summary: null };
    }
    const summary: UsageSummary = emptyUsageSummary();
    let cost = 0n;
    let durSum = 0;
    let durN = 0;
    let ttftSum = 0;
    let ttftN = 0;
    for (const l of matched) {
      summary.requests++;
      if (l.statusCode >= 400) summary.errors++;
      summary.inputTokens += l.inputTokens;
      summary.outputTokens += l.outputTokens;
      summary.cacheReadTokens += l.cacheReadTokens;
      summary.cacheWriteTokens += l.cacheWriteTokens;
      cost += BigInt(l.costNanoUsd);
      if (l.durationMs > 0) {
        durSum += l.durationMs;
        durN++;
      }
      if (l.ttftMs > 0) {
        ttftSum += l.ttftMs;
        ttftN++;
      }
    }
    summary.costNanoUsd = cost.toString();
    summary.avgDurationMs = durN ? Math.round(durSum / durN) : 0;
    summary.avgTtftMs = ttftN ? Math.round(ttftSum / ttftN) : 0;
    return { items: matched.slice(offset, offset + limit).map((l) => this.toRow(l)), total: matched.length, summary };
  }

  async exportUsage(query: UsageExportQuery): Promise<UsageRow[]> {
    return this.core.usageLogs
      .filter((l) => this.matchUsage(l, query))
      .slice(0, query.limit)
      .map((l) => this.toRow(l));
  }

  /* ---------------- Usage aggregates ---------------- */

  async scopedUsage(query: ScopedUsageQuery): Promise<ScopedUsageAggregate> {
    if (query.userId === undefined && query.apiKeyId === undefined) throw new StoreError("bad_request", "A user or key scope is required");
    return reduceScopedUsage(query, this.core.usageLogs);
  }

  async channelStatusUsage(query: ChannelStatusQuery): Promise<ChannelStatusAggregate> {
    return reduceChannelStatus(query, this.core.usageLogs);
  }

  async opsUsage(query: OpsUsageQuery): Promise<OpsUsageAggregate> {
    return reduceOpsUsage(query, this.core.usageLogs, {
      userEmail: (id) => this.core.users.get(id)?.email ?? "",
      groupName: (id) => this.core.groups.get(id)?.name ?? "",
    });
  }

  /* ---------------- API key lookups ---------------- */

  async findApiKeyByHash(keyHash: Uint8Array): Promise<ApiKeyLookupRecord | null> {
    for (const k of this.core.apiKeys.values()) {
      if (k.keyHash.length !== keyHash.length || !k.keyHash.every((b, i) => b === keyHash[i])) continue;
      const g = this.core.groups.get(k.groupId);
      return {
        id: k.id,
        userId: k.userId,
        name: k.name,
        keyPrefix: k.keyPrefix,
        enabled: k.enabled,
        expiresAtIso: k.expiresAtIso,
        groupId: k.groupId,
        groupName: g?.name ?? "",
        billing: g?.subscriptionType ?? "balance",
      };
    }
    return null;
  }

  async listApiKeyLabels(userId: string): Promise<ApiKeyLabel[]> {
    return Array.from(this.core.apiKeys.values())
      .filter((k) => k.userId === userId)
      .map((k) => ({ id: k.id, name: k.name, enabled: k.enabled }));
  }
}
