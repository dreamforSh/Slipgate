import type {
  AdminCreateUserRequest,
  AdminUpdateUserRequest,
  AdminUserItem,
  AdminUserListQuery,
  AdminUserListResponse,
  AnnouncementItem,
  AnnouncementReader,
  AnnouncementReadStatusQuery,
  AnnouncementReadStatusResponse,
  AuditLogItem,
  AuditLogQuery,
  LinkedIdentity,
  BalanceLedgerItem,
  CreatePromoCodeRequest,
  GenerateRedeemCodesRequest,
  PortalSettings,
  PromoCodeCheckResponse,
  PromoCodeItem,
  PromoCodeUsageItem,
  RedeemCodeClaimItem,
  RedeemCodeItem,
  RedeemCodeListQuery,
  RedeemCodeListResponse,
  RedeemResult,
  SubscriptionAction,
  UpdatePromoCodeRequest,
  UpdateRedeemCodesRequest,
  UpsertAnnouncementRequest,
  UsagePageResponse,
  UsageQuery,
  UsageRow,
  UserAnnouncementItem,
  UserProfile,
  UserRole,
  UserSubscriptionItem,
  UserSubscriptionListQuery,
} from "@slipgate/contracts";
import type {
  ChannelStatusAggregate,
  ChannelStatusQuery,
  OpsUsageAggregate,
  OpsUsageQuery,
  ScopedUsageAggregate,
  ScopedUsageQuery,
} from "./usage_aggregates.ts";

/** What the snapshot needs to know about a user to decide whether their keys may serve. */
export interface UserAccessRecord {
  id: string;
  role: UserRole;
  status: "active" | "suspended";
  allowedGroupIds: string[];
}

/** What every authenticated request re-checks about its user (see middleware/auth.ts). */
export interface UserAuthState {
  email: string;
  role: UserRole;
  status: "active" | "suspended";
  /** Tokens carrying an older version are dead (bumped by password/role/status changes and sign-out-everywhere). */
  tokenVersion: number;
}

export interface SessionState {
  /** null once the user no longer exists. */
  user: UserAuthState | null;
  /** The token id was signed out (logout denylist). */
  revoked: boolean;
}

/** One (user, group) subscription entitlement as seen by the data-plane snapshot. */
export interface SubscriptionEntitlement {
  userId: string;
  groupId: string;
  /** Active, inside its validity window and under every spend cap. */
  usable: boolean;
}

/** Rows one deleteAuditBefore call removes at most when no limit is given. */
export const AUDIT_DELETE_BATCH = 5000;

/** Fields of a new audit entry; id and timestamp are assigned by the store. */
export type AuditLogInput = Omit<AuditLogItem, "id" | "createdAtIso">;

export interface AdminUserCreateInput extends Omit<AdminCreateUserRequest, "password" | "initialBalanceUsd"> {
  passwordHash: string;
  initialBalanceNano: bigint;
  avatarUrl?: string;
  emailVerified?: boolean;
}

export interface PendingOAuthSignupRecord {
  tokenHash: string;
  provider: import("@slipgate/contracts").OAuthProviderId;
  subject: string;
  suggestedEmail: string;
  suggestedUsername: string;
  avatarUrl: string;
  bindingHash: string;
  redirectPath: string;
  expiresAtIso: string;
}

export type CreatePendingOAuthSignupInput = PendingOAuthSignupRecord;

export interface AdminUserUpdateInput extends Omit<AdminUpdateUserRequest, "password"> {
  passwordHash?: string;
}

export interface UsageExportQuery extends Omit<UsageQuery, "page" | "pageSize"> {
  limit: number;
}

export interface RegistrationExtras {
  username?: string;
  promoCode?: string;
  /** Referrer's affiliate code. (Invitation codes are consumed by registerWithInvitation.) */
  affCode?: string;
}

/** What the public key-usage lookup may show about a key it found by digest. */
export interface ApiKeyLookupRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  enabled: boolean;
  expiresAtIso: string | null;
  groupId: string;
  /** "" when the group no longer exists. */
  groupName: string;
  billing: "balance" | "subscription";
}

/** A key's identity without its spend windows (cheap list for names and counts). */
export interface ApiKeyLabel {
  id: string;
  name: string;
  enabled: boolean;
}

export interface RegistrationOutcome {
  /** Bonus actually credited from the promo code (0 when none or no longer valid). */
  promoBonusNano: bigint;
  referrerId: string | null;
}

/**
 * Operations & commerce persistence: user administration, portal settings, redeem/promo codes,
 * announcements, audit log, subscriptions and usage browsing.
 *
 * Implemented by MemoryOpsStore (tests, no DATABASE_URL) and PostgresOpsStore. Both share their
 * user/wallet/usage state with the owning ControlStore so balances stay one source of truth.
 */
export interface OpsStore {
  /* ---- Portal settings ---- */
  getSettings(): Promise<PortalSettings>;
  /** Persists the full settings object; siteName/allowRegistration are mirrored into the setup state. */
  saveSettings(settings: PortalSettings): Promise<PortalSettings>;
  /** Atomically reads, mutates, validates and writes portal settings under an exclusive lock. */
  updateSettings(
    mutator: (current: PortalSettings) => PortalSettings | Promise<PortalSettings>,
  ): Promise<{ previous: PortalSettings; saved: PortalSettings }>;

  /** Opaque JSON documents in commerce.portal_settings (email config, …). */
  getBlob(key: string): Promise<Record<string, unknown> | null>;
  setBlob(key: string, value: Record<string, unknown>): Promise<void>;
  /** Atomically reads, mutates and writes a JSON document in commerce.portal_settings under a per-key lock. */
  updateBlob(
    key: string,
    mutator: (current: Record<string, unknown> | null) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;

  /* ---- Email codes & password resets ---- */
  /** Replaces any earlier code for this (email, purpose). */
  saveEmailCode(email: string, purpose: string, codeHash: string, expiresAtIso: string): Promise<void>;
  /** True once for a matching, unexpired code; five wrong guesses burn the code. */
  consumeEmailCode(email: string, purpose: string, codeHash: string): Promise<boolean>;
  /** Last time a code was issued for this (email, purpose), for resend cooldowns. */
  lastEmailCodeAt(email: string, purpose: string): Promise<string | null>;
  savePasswordReset(userId: string, tokenHash: string, expiresAtIso: string): Promise<void>;
  /** Returns the user id once for an unexpired, unused token. */
  consumePasswordReset(tokenHash: string): Promise<string | null>;

  /* ---- Third-party identities ---- */
  findUserIdByIdentity(provider: string, subject: string): Promise<string | null>;
  /** Replaces this user's link for the provider; conflict when the subject belongs to someone else. */
  linkIdentity(userId: string, provider: string, subject: string): Promise<void>;
  unlinkIdentity(userId: string, provider: string): Promise<void>;
  listIdentities(userId: string): Promise<LinkedIdentity[]>;
  createPendingOAuthSignup(input: CreatePendingOAuthSignupInput): Promise<void>;
  getPendingOAuthSignup(tokenHash: string): Promise<PendingOAuthSignupRecord | null>;
  consumePendingOAuthSignup(tokenHash: string): Promise<PendingOAuthSignupRecord | null>;

  /* ---- Sessions ---- */
  /** Role, status and token version of the user, and whether token id `jti` was signed out. */
  getSessionState(userId: string, jti?: string): Promise<SessionState>;
  /** Ends every session of the user; returns the new token version (null when the user does not exist). */
  bumpTokenVersion(userId: string): Promise<number | null>;
  /** Denylists one token id until `expiresAtIso` (server-side logout); prunes expired entries. */
  revokeToken(jti: string, userId: string, expiresAtIso: string): Promise<void>;

  /* ---- Users ---- */
  listAdminUsers(query: AdminUserListQuery): Promise<AdminUserListResponse>;
  getAdminUser(userId: string): Promise<AdminUserItem | null>;
  createUser(input: AdminUserCreateInput): Promise<AdminUserItem>;
  /**
   * A role, status or password change bumps the token version (ends the user's sessions). Refuses
   * to demote or suspend the last active administrator, race-free across concurrent requests.
   */
  updateUser(userId: string, input: AdminUserUpdateInput): Promise<AdminUserItem>;
  /** Refuses when the user still owns payment orders (suspend them instead) or is the last active admin. */
  deleteUser(userId: string): Promise<void>;
  /** Bumps the token version of every user whose status changed (never suspends admins). */
  setUsersStatus(userIds: string[], status: "active" | "suspended"): Promise<number>;
  /** Signed wallet movement recorded as an `adjust` ledger entry (idempotent by key). */
  adjustWallet(userId: string, deltaNano: bigint, idempotencyKey: string, reason: string): Promise<bigint>;
  /**
   * Atomically reads the locked wallet balance, computes the delta for `add` / `subtract` / `set`,
   * and applies it in one transaction (race-free against concurrent adjustments or settlements).
   */
  adjustWalletAtomic(
    userId: string,
    operation: "add" | "subtract" | "set",
    amountNano: bigint,
    idempotencyKey: string,
    reason: string,
  ): Promise<{ balanceNano: bigint; deltaNano: bigint }>;
  listLedger(userId: string, limit: number): Promise<BalanceLedgerItem[]>;
  countAdmins(): Promise<number>;
  listUserAccess(): Promise<UserAccessRecord[]>;
  touchLastLogin(userId: string): Promise<void>;
  updateOwnProfile(userId: string, username: string, avatarUrl?: string): Promise<UserProfile>;
  bindPlaceholderEmail(userId: string, email: string, emailVerified: boolean): Promise<UserProfile>;
  getPasswordHash(userId: string): Promise<string | null>;
  /** Two-factor state; the secret is the vault-encrypted base32 text (pending while disabled). */
  getTotp(userId: string): Promise<{ secretEnc: Uint8Array | null; enabled: boolean } | null>;
  setTotp(userId: string, secretEnc: Uint8Array | null, enabled: boolean): Promise<void>;
  /** Sets the password and ends every session (token version bump); returns the new token version. */
  setPasswordHash(userId: string, passwordHash: string): Promise<number>;
  /**
   * After registerUser: username, referrer binding and promo bonus. Callers validate promo codes
   * first; this re-checks and skips what no longer applies.
   */
  applyRegistrationExtras(userId: string, extras: RegistrationExtras): Promise<RegistrationOutcome>;
  /** An invitation redeem code that is unused, enabled and unexpired (a read-only pre-check). */
  isInvitationCodeUsable(code: string): Promise<boolean>;
  /**
   * Runs `register` only for the one caller that wins this invitation code: the code is claimed
   * atomically first (concurrent registrations with the same code: exactly one proceeds), handed
   * back when `register` throws, and then recorded as redeemed by the new user. Returns null,
   * without calling `register`, when the code is unknown, used, disabled or expired.
   */
  registerWithInvitation<T extends { id: string }>(code: string, register: () => Promise<T>): Promise<T | null>;
  findUserIdByInviteCode(inviteCode: string): Promise<string | null>;
  /** Lazily assigns a stable invite code. */
  ensureInviteCode(userId: string): Promise<string>;
  /** Users who registered with this user's affiliate code, newest first. */
  listInvitees(referrerId: string): Promise<{ email: string; username: string; joinedAtIso: string }[]>;

  /* ---- Redeem codes ---- */
  generateRedeemCodes(req: GenerateRedeemCodesRequest, codes: string[], amountNano: bigint, createdBy: string): Promise<RedeemCodeItem[]>;
  listRedeemCodes(query: RedeemCodeListQuery): Promise<RedeemCodeListResponse>;
  updateRedeemCodes(req: UpdateRedeemCodesRequest): Promise<number>;
  /** Atomically consumes the code and credits balance or grants/extends the subscription. */
  redeemCode(userId: string, code: string): Promise<RedeemResult>;
  listUserRedeemHistory(userId: string, limit: number): Promise<RedeemCodeItem[]>;
  listRedeemCodeClaims(code: string): Promise<RedeemCodeClaimItem[]>;

  /* ---- Promo codes ---- */
  listPromoCodes(): Promise<PromoCodeItem[]>;
  createPromoCode(code: string, req: CreatePromoCodeRequest, bonusNano: bigint): Promise<PromoCodeItem>;
  updatePromoCode(id: string, req: UpdatePromoCodeRequest, bonusNano: bigint | null): Promise<PromoCodeItem>;
  deletePromoCode(id: string): Promise<void>;
  listPromoCodeUsages(id: string): Promise<PromoCodeUsageItem[]>;
  checkPromoCode(code: string): Promise<PromoCodeCheckResponse>;

  /* ---- Announcements ---- */
  listAnnouncements(): Promise<AnnouncementItem[]>;
  createAnnouncement(req: UpsertAnnouncementRequest, createdBy: string): Promise<AnnouncementItem>;
  updateAnnouncement(id: string, req: UpsertAnnouncementRequest): Promise<AnnouncementItem>;
  deleteAnnouncement(id: string): Promise<void>;
  listAnnouncementReaders(id: string): Promise<AnnouncementReader[]>;
  /**
   * Every account with its read state for this announcement and whether it is eligible (role
   * matches the audience and the targeting holds for its balance / active subscriptions now).
   */
  listAnnouncementReadStatus(id: string, query: AnnouncementReadStatusQuery): Promise<AnnouncementReadStatusResponse>;
  /**
   * Published, in-window announcements for this audience whose targeting the user meets, newest
   * pinned first, with read flags. Targeting applies to administrators too (no bypass).
   */
  listUserAnnouncements(userId: string, role: UserRole): Promise<UserAnnouncementItem[]>;
  /** Marks only announcements listUserAnnouncements would show this user; other ids are ignored. */
  markAnnouncementsRead(userId: string, ids: string[] | "all", role: UserRole): Promise<void>;

  /* ---- Audit log ---- */
  recordAudit(entry: AuditLogInput): Promise<void>;
  listAudit(query: AuditLogQuery): Promise<{ items: AuditLogItem[]; total: number }>;
  clearAudit(): Promise<number>;
  /**
   * Deletes up to `limit` (default AUDIT_DELETE_BATCH) of the oldest rows created before `cutoff`;
   * returns how many went. Callers loop until it returns less than the limit. Safe to run from
   * several instances at once (rows another sweeper holds are skipped).
   */
  deleteAuditBefore(cutoff: Date, limit?: number): Promise<number>;

  /* ---- Subscriptions ---- */
  listSubscriptions(query: UserSubscriptionListQuery): Promise<{ items: UserSubscriptionItem[]; total: number }>;
  listUserSubscriptions(userId: string): Promise<UserSubscriptionItem[]>;
  assignSubscription(userId: string, groupId: string, validityDays: number, notes: string, source: string): Promise<UserSubscriptionItem>;
  updateSubscription(
    id: string,
    action: SubscriptionAction,
    days: number,
    notes?: string,
    resetWindow?: import("@slipgate/contracts").SubscriptionResetWindow,
  ): Promise<UserSubscriptionItem>;
  deleteSubscription(id: string): Promise<void>;
  subscriptionEntitlements(): Promise<SubscriptionEntitlement[]>;
  /** True when this (user, group) subscription just reached a cap (cheap single-pair check). */
  isSubscriptionOverLimit(userId: string, groupId: string): Promise<boolean>;

  /* ---- Usage browsing ---- */
  /** One page of rows; the COUNT/SUM summary (and exact total) only when `query.summary !== false`. */
  queryUsage(query: UsageQuery): Promise<UsagePageResponse>;
  exportUsage(query: UsageExportQuery): Promise<UsageRow[]>;

  /*
   * ---- Usage aggregates ----
   * Exact over every row of a bounded window: Postgres groups by time bucket in SQL on the
   * usage_logs indexes (user/key/group/time), so no row list is shipped to the BFF. Results go
   * through the shared finalizers in usage_aggregates.ts.
   */
  /**
   * One user's (dashboard) or one key's (public lookup) totals, series and breakdowns. Postgres
   * reads it in one scan on one connection and gives up after SCOPED_USAGE_TIMEOUT_MS
   * (UsageAggregateTimeoutError); callers cache it per scope rather than re-running it per view.
   */
  scopedUsage(query: ScopedUsageQuery): Promise<ScopedUsageAggregate>;
  /** Per-group, per-bucket traffic for the public status page. */
  channelStatusUsage(query: ChannelStatusQuery): Promise<ChannelStatusAggregate>;
  /** Totals, percentiles, series, breakdowns and the newest errors for the ops monitor. */
  opsUsage(query: OpsUsageQuery): Promise<OpsUsageAggregate>;

  /* ---- API key lookups (no spend windows) ---- */
  /** The key whose SHA-256 digest is `keyHash` (one unique-index probe), or null. */
  findApiKeyByHash(keyHash: Uint8Array): Promise<ApiKeyLookupRecord | null>;
  listApiKeyLabels(userId: string): Promise<ApiKeyLabel[]>;
}
