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

export interface StoredUserRecord extends UserProfile {
  passwordHash: string | null;
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

export interface ControlStore {
  init(): Promise<void>;
  close(): Promise<void>;

  getSetupStatus(): Promise<SetupStatus>;
  initializeSetup(req: SetupInitializeRequest, adminPasswordHash: string): Promise<UserProfile>;

  registerUser(email: string, passwordHash: string): Promise<UserProfile>;
  findUserByEmail(email: string): Promise<StoredUserRecord | null>;
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
  deleteUserApiKey(userId: string, keyId: string): Promise<void>;

  listCompositeRoutes(groupId?: string): Promise<StoredCompositeRoute[]>;
  createCompositeRoute(req: CreateCompositeRouteRequest): Promise<StoredCompositeRoute>;
  deleteCompositeRoute(routeId: string): Promise<void>;

  exportDataPlaneSnapshot(): Promise<DataPlaneSyncSnapshot>;
  recordTurnSettlement(ev: TurnSettlementEvent): Promise<UsageLogItem>;
  /** Newest first. With `sinceIso` the row cap rises from 200 to 100k (dashboard aggregation). */
  listUsageLogs(filter?: UsageLogFilter): Promise<UsageLogItem[]>;

  recordRiskBanEvent(ev: RecordRiskBanInput): Promise<RiskBanEvent>;
  listRiskBanEvents(limit?: number): Promise<RiskBanEvent[]>;
}
