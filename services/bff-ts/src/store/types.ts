import type {
  AccountTestResult,
  AccountUsageSummaryItem,
  ApiKeyItem,
  CreateAccountRequest,
  CreateApiKeyRequest,
  CreateCompositeRouteRequest,
  CreateGroupRequest,
  DataPlaneSyncSnapshot,
  GroupItem,
  RecordRiskBanInput,
  RiskBanEvent,
  SetupInitializeRequest,
  SetupStatus,
  StoredCompositeRoute,
  TurnSettlementEvent,
  UpdateAccountRequest,
  UpdateApiKeyRequest,
  UpdateGroupRequest,
  UpstreamAccount,
  UsageLogItem,
  UserProfile,
  WalletSummary,
} from "@slipgate/contracts";
import type { OpsStore } from "./ops_types.ts";
import type { PaymentsStore } from "./payments_types.ts";
import type { SystemLogStore } from "./system_logs_types.ts";
import type { RegistrationConflict, RegistrationGuard } from "./auth_guards_store.ts";
import type { DbBackupStore } from "./db_backups_types.ts";
import type { UserLimitsStore } from "./user_limits_types.ts";

export type StoreErrorCode = "conflict" | "not_found" | "forbidden" | "bad_request";

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  readonly status: 400 | 403 | 404 | 409;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    switch (code) {
      case "conflict":
        this.status = 409;
        break;
      case "not_found":
        this.status = 404;
        break;
      case "forbidden":
        this.status = 403;
        break;
      case "bad_request":
        this.status = 400;
        break;
    }
  }
}

/** updateUserApiKeys' outcome: the updated keys, and each key that was refused with why. */
export interface ApiKeyBulkResult {
  items: ApiKeyItem[];
  failed: { keyId: string; error: StoreError }[];
}

export interface StoredUserRecord extends UserProfile {
  passwordHash: string | null;
}

/**
 * findUserByEmail's row: the password hash and the user's token version from one read. Sign-in
 * signs its session at this version, so a session granted for a password that was changed or reset
 * meanwhile carries the old version and is refused.
 */
export interface UserCredentialRecord extends StoredUserRecord {
  tokenVersion: number;
}

/** Credential material as persisted: AES-GCM blob, display mask and duplicate-detection HMAC. */
export interface StoredCredential {
  encrypted: Uint8Array;
  preview: string;
  fingerprint: string;
}

export interface AccountSecretRecord {
  accountId: string;
  encrypted: Uint8Array;
  /** `null` for rows written before fingerprints existed (backfilled at startup). */
  fingerprint: string | null;
}

export interface UsageLogFilter {
  userId?: string;
  accountId?: string;
  limit?: number;
  sinceIso?: string;
}

/** recordTurnSettlement's outcome: the usage row plus what the settlement path acts on next. */
export interface TurnSettlementResult extends UsageLogItem {
  /** Settlement id the turn was recorded under (server-minted; the billing idempotency key). */
  settlementId: string;
  /** true when this settlement id was already recorded: nothing was charged or logged again. */
  duplicate: boolean;
  /** Wallet balance right after this settlement's debit; set only when the wallet was charged. */
  walletBalanceAfterNanoUsd?: string;
}

/**
 * Settlement ids are kept for three times slipgate-net's 24 h delivery horizon (its outbox drops
 * events older than that, spooled or not), then pruned. Longer only grows the hot dedupe index.
 */
export const SETTLEMENT_ID_RETENTION_DAYS = 3;

/** Mints the settlement id for an event that arrived without one (older edges): never deduped. */
export function settlementIdOf(ev: TurnSettlementEvent): string {
  return ev.settlementId ?? `stl_bff_${crypto.randomUUID().replaceAll("-", "")}`;
}

export interface ControlStore {
  /** Operations & commerce: users admin, settings, codes, announcements, audit, subscriptions, usage. */
  readonly ops: OpsStore;
  /** Plans, orders, fulfilment, payment dashboard and referral rebates. */
  readonly payments: PaymentsStore;
  /** Persisted system logs and the runtime log config. */
  readonly systemLogs: SystemLogStore;
  /** Full-database backup catalogue, S3 target, schedule and the backup/restore lock. */
  readonly dbBackups: DbBackupStore;
  /** Per-user caps, per-user group rates / RPM overrides and cross-owner key tooling (lane U1). */
  readonly userLimits: UserLimitsStore;

  init(): Promise<void>;
  close(): Promise<void>;

  getSetupStatus(): Promise<SetupStatus>;
  initializeSetup(req: SetupInitializeRequest, adminPasswordHash: string): Promise<UserProfile>;

  /**
   * Self-registration. With `guard` (auth_guards_store.ts) the address is also refused when an
   * existing account uses the same inbox (alias identity) or, under a per-domain quota, when the
   * domain already has an account: checked and inserted atomically, refused with
   * RegistrationGuardError.
   */
  registerUser(email: string, passwordHash: string, guard?: RegistrationGuard): Promise<UserProfile>;
  /** Read-only pre-check of registerUser's guard (exact address first, then alias, then domain). */
  registrationEmailConflict(email: string, guard: RegistrationGuard): Promise<RegistrationConflict | null>;
  findUserByEmail(email: string): Promise<UserCredentialRecord | null>;
  getUserById(userId: string): Promise<UserProfile | null>;
  listUsers(): Promise<UserProfile[]>;

  getWallet(userId: string): Promise<WalletSummary>;
  creditWallet(
    userId: string,
    amountNanoUsd: bigint,
    idempotencyKey: string,
    reason: string,
  ): Promise<WalletSummary>;

  listGroups(enabledOnly?: boolean): Promise<GroupItem[]>;
  createGroup(req: CreateGroupRequest): Promise<GroupItem>;
  updateGroup(groupId: string, req: UpdateGroupRequest): Promise<GroupItem>;
  deleteGroup(groupId: string): Promise<void>;
  /** Copy a group's settings into a new, disabled group (accounts and keys are not copied). */
  duplicateGroup(groupId: string): Promise<GroupItem>;

  listAccounts(filter?: { groupId?: string; executionMode?: string }): Promise<UpstreamAccount[]>;
  getAccount(accountId: string): Promise<UpstreamAccount | null>;
  createAccount(req: CreateAccountRequest, credential: StoredCredential): Promise<UpstreamAccount>;
  /** Omit `credential` to keep the stored one. */
  updateAccount(accountId: string, req: UpdateAccountRequest, credential?: StoredCredential): Promise<UpstreamAccount>;
  deleteAccount(accountId: string): Promise<void>;
  recordAccountTestResult(accountId: string, result: AccountTestResult): Promise<void>;
  /** Encrypted credentials for export and fingerprint backfill; every account when `accountIds` is omitted. */
  listAccountSecrets(accountIds?: string[]): Promise<AccountSecretRecord[]>;
  /** Maps each known fingerprint to the id of an account holding it. */
  findAccountsByFingerprint(fingerprints: string[]): Promise<Map<string, string>>;
  setCredentialFingerprint(accountId: string, fingerprint: string): Promise<void>;
  /** Per-account totals of usage created at or after `sinceIso` (accounts without usage omitted). */
  summarizeAccountUsage(sinceIso: string): Promise<AccountUsageSummaryItem[]>;

  listUserApiKeys(userId: string): Promise<ApiKeyItem[]>;
  createApiKey(
    userId: string,
    req: CreateApiKeyRequest,
    keyPrefix: string,
    keyHash: Uint8Array,
  ): Promise<ApiKeyItem>;
  updateUserApiKey(userId: string, keyId: string, req: UpdateApiKeyRequest): Promise<ApiKeyItem>;
  /**
   * One patch for many of the user's keys: a single UPDATE and one listing of just those keys.
   * Per key the outcome is updateUserApiKey's: unknown or foreign ids fail not_found, a move to
   * an unavailable group fails bad_request (keys already in that group still take the patch).
   * `items` and `failed` follow the order of the distinct `keyIds`.
   */
  updateUserApiKeys(userId: string, keyIds: string[], req: UpdateApiKeyRequest): Promise<ApiKeyBulkResult>;
  deleteUserApiKey(userId: string, keyId: string): Promise<void>;
  /** Keys with any spend cap (quota or rolling window). */
  listLimitedKeyIds(): Promise<string[]>;
  /** Keys currently at or over their quota or a rolling-window cap (paused in the snapshot). */
  listOverLimitKeyIds(): Promise<string[]>;
  /**
   * Limit state of one key (null when it does not exist), the same verdict listUserApiKeys gives.
   * Only the windows that have a cap are summed, so quota-only and uncapped keys read no usage.
   */
  getApiKeyLimitState(keyId: string): Promise<ApiKeyItem["limitState"] | null>;

  listCompositeRoutes(groupId?: string): Promise<StoredCompositeRoute[]>;
  createCompositeRoute(req: CreateCompositeRouteRequest): Promise<StoredCompositeRoute>;
  deleteCompositeRoute(routeId: string): Promise<void>;

  exportDataPlaneSnapshot(): Promise<DataPlaneSyncSnapshot>;
  /**
   * Records one settled turn exactly once per settlement id (retries are no-ops). The client's
   * requestId is only stored for correlation; it never decides whether a turn is charged.
   */
  recordTurnSettlement(ev: TurnSettlementEvent): Promise<TurnSettlementResult>;
  /** Newest first. With `sinceIso` the row cap rises from 200 to 100k (dashboard aggregation). */
  listUsageLogs(filter?: UsageLogFilter): Promise<UsageLogItem[]>;

  recordRiskBanEvent(ev: RecordRiskBanInput): Promise<RiskBanEvent>;
  listRiskBanEvents(limit?: number): Promise<RiskBanEvent[]>;
}
