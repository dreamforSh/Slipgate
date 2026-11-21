import type {
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

  listAccounts(filter?: { groupId?: string; executionMode?: string }): Promise<UpstreamAccount[]>;
  createAccount(
    req: CreateAccountRequest,
    encryptedSecret: Uint8Array,
    credentialPreview: string,
  ): Promise<UpstreamAccount>;
  updateAccount(
    accountId: string,
    req: UpdateAccountRequest,
    encryptedSecret?: Uint8Array,
    credentialPreview?: string,
  ): Promise<UpstreamAccount>;
  deleteAccount(accountId: string): Promise<void>;

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
  listUsageLogs(filter?: { userId?: string; limit?: number }): Promise<UsageLogItem[]>;

  recordRiskBanEvent(ev: RecordRiskBanInput): Promise<RiskBanEvent>;
  listRiskBanEvents(limit?: number): Promise<RiskBanEvent[]>;
}
