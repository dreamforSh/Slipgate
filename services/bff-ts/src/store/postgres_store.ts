import postgres from "postgres";
import {
  formatNanoUsd,
  isSubscriptionTierAllowedForProvider,
  SubscriptionTierSchema,
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

type SqlExecutor = ReturnType<typeof postgres>;

type SetupSettingsValue = {
  initialized: boolean;
  siteName: string;
  allowRegistration: boolean;
};

function mapPgError(err: unknown): never {
  const pgCode = (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : "Database error";
  if (pgCode === "23505" || pgCode === "23503") {
    throw new StoreError("conflict", message);
  }
  throw err;
}

function toIso(val: Date | string | null | undefined): string {
  if (!val) return new Date().toISOString();
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

export class PostgresControlStore implements ControlStore {
  private readonly sql: SqlExecutor;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      onnotice: () => {},
    });
  }

  async init(): Promise<void> {
    // Ensure required schemas/tables/columns exist even against a fresh database.
    await this.sql.unsafe(`
      CREATE SCHEMA IF NOT EXISTS commerce;
      CREATE SCHEMA IF NOT EXISTS core;

      CREATE TABLE IF NOT EXISTS commerce.portal_settings (
          key         TEXT PRIMARY KEY,
          value_json  JSONB NOT NULL,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE core.accounts
          ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'stealth_http',
          ADD COLUMN IF NOT EXISTS subscription_tier TEXT NOT NULL DEFAULT 'standard',
          ADD COLUMN IF NOT EXISTS credential_preview TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS last_test_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_test_ok BOOLEAN,
          ADD COLUMN IF NOT EXISTS last_test_model TEXT,
          ADD COLUMN IF NOT EXISTS last_test_duration_ms INTEGER,
          ADD COLUMN IF NOT EXISTS last_test_message TEXT;

      ALTER TABLE core.groups
          ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS is_exclusive BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE core.api_keys
          ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'default';
    `);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async getSetupStatus(): Promise<SetupStatus> {
    const rows = await this.sql<{ value_json: SetupSettingsValue }[]>`
      SELECT value_json FROM commerce.portal_settings WHERE key = 'setup_state'
    `;
    if (rows.length > 0 && rows[0]?.value_json) {
      return {
        initialized: Boolean(rows[0].value_json.initialized),
        siteName: rows[0].value_json.siteName || "Slipgate Gateway",
        allowRegistration: Boolean(rows[0].value_json.allowRegistration),
      };
    }

    const adminRows = await this.sql<{ count: string }[]>`
      SELECT COUNT(*)::text AS count FROM commerce.users WHERE role = 'admin'
    `;
    const hasAdmin = Number.parseInt(adminRows[0]?.count ?? "0", 10) > 0;
    return {
      initialized: hasAdmin,
      siteName: "Slipgate Gateway",
      allowRegistration: true,
    };
  }

  async initializeSetup(
    req: SetupInitializeRequest,
    adminPasswordHash: string,
  ): Promise<UserProfile> {
    try {
      return await this.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as SqlExecutor;
        const existingAdmins = await tx<{ id: string }[]>`
          SELECT id FROM commerce.users WHERE role = 'admin' LIMIT 1
        `;
        if (existingAdmins.length > 0) {
          throw new StoreError("conflict", "Slipgate is already initialized");
        }

        const adminId = `usr_${crypto.randomUUID()}`;
        const email = req.adminEmail.toLowerCase();
        const userRows = await tx<
          {
            id: string;
            email: string;
            role: "admin" | "user";
            status: "active" | "suspended";
            totp_enabled: boolean;
            created_at: Date;
          }[]
        >`
          INSERT INTO commerce.users (id, email, password_hash, role, status)
          VALUES (${adminId}, ${email}, ${adminPasswordHash}, 'admin', 'active')
          RETURNING id, email, role, status, totp_enabled, created_at
        `;

        await tx`
          INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
          VALUES (${adminId}, 0, 0)
          ON CONFLICT (user_id) DO NOTHING
        `;

        await tx`
          INSERT INTO core.groups (id, name, platform, subscription_type, rate_multiplier, model_allowlist, enabled)
          VALUES ('grp_default', 'default-composite', 'composite', 'balance', 1.0, '[]'::jsonb, TRUE)
          ON CONFLICT (name) DO NOTHING
        `;

        const setupState: SetupSettingsValue = {
          initialized: true,
          siteName: req.siteName,
          allowRegistration: req.allowRegistration,
        };
        await tx`
          INSERT INTO commerce.portal_settings (key, value_json, updated_at)
          VALUES ('setup_state', ${JSON.stringify(setupState)}::jsonb, NOW())
          ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
        `;

        const row = userRows[0]!;
        return {
          id: row.id,
          email: row.email,
          role: row.role,
          status: row.status,
          totpEnabled: row.totp_enabled,
          createdAtIso: toIso(row.created_at),
        };
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async registerUser(email: string, passwordHash: string): Promise<UserProfile> {
    const status = await this.getSetupStatus();
    if (!status.initialized) {
      throw new StoreError("conflict", "System setup has not completed yet");
    }
    if (!status.allowRegistration) {
      throw new StoreError("forbidden", "Public user registration is disabled");
    }

    try {
      return await this.sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as SqlExecutor;
        const userId = `usr_${crypto.randomUUID()}`;
        const rows = await tx<
          {
            id: string;
            email: string;
            role: "admin" | "user";
            status: "active" | "suspended";
            totp_enabled: boolean;
            created_at: Date;
          }[]
        >`
          INSERT INTO commerce.users (id, email, password_hash, role, status)
          VALUES (${userId}, ${email.toLowerCase()}, ${passwordHash}, 'user', 'active')
          RETURNING id, email, role, status, totp_enabled, created_at
        `;
        await tx`
          INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
          VALUES (${userId}, 0, 0)
          ON CONFLICT (user_id) DO NOTHING
        `;
        const row = rows[0]!;
        return {
          id: row.id,
          email: row.email,
          role: row.role,
          status: row.status,
          totpEnabled: row.totp_enabled,
          createdAtIso: toIso(row.created_at),
        };
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async findUserByEmail(email: string): Promise<StoredUserRecord | null> {
    const rows = await this.sql<
      {
        id: string;
        email: string;
        password_hash: string | null;
        role: "admin" | "user";
        status: "active" | "suspended";
        totp_enabled: boolean;
        created_at: Date;
      }[]
    >`
      SELECT id, email, password_hash, role, status, totp_enabled, created_at
      FROM commerce.users
      WHERE LOWER(email) = LOWER(${email})
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      passwordHash: row.password_hash,
      role: row.role,
      status: row.status,
      totpEnabled: row.totp_enabled,
      createdAtIso: toIso(row.created_at),
    };
  }

  async getUserById(userId: string): Promise<UserProfile | null> {
    const rows = await this.sql<
      {
        id: string;
        email: string;
        role: "admin" | "user";
        status: "active" | "suspended";
        totp_enabled: boolean;
        created_at: Date;
      }[]
    >`
      SELECT id, email, role, status, totp_enabled, created_at
      FROM commerce.users
      WHERE id = ${userId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      totpEnabled: row.totp_enabled,
      createdAtIso: toIso(row.created_at),
    };
  }

  async listUsers(): Promise<UserProfile[]> {
    const rows = await this.sql<
      {
        id: string;
        email: string;
        role: "admin" | "user";
        status: "active" | "suspended";
        totp_enabled: boolean;
        created_at: Date;
      }[]
    >`
      SELECT id, email, role, status, totp_enabled, created_at
      FROM commerce.users
      ORDER BY created_at DESC
    `;
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      status: row.status,
      totpEnabled: row.totp_enabled,
      createdAtIso: toIso(row.created_at),
    }));
  }

  async getWallet(userId: string): Promise<WalletSummary> {
    const rows = await this.sql<{ balance_nano_usd: string; held_nano_usd: string }[]>`
      SELECT balance_nano_usd::text, held_nano_usd::text
      FROM core.quota_wallets
      WHERE user_id = ${userId}
      LIMIT 1
    `;
    if (rows.length === 0) {
      const user = await this.getUserById(userId);
      if (!user) {
        throw new StoreError("not_found", `User ${userId} not found`);
      }
      return {
        userId,
        balanceNanoUsd: "0",
        heldNanoUsd: "0",
        availableNanoUsd: "0",
        formattedAvailableUsd: "$0.00",
      };
    }
    const balance = BigInt(rows[0]!.balance_nano_usd);
    const held = BigInt(rows[0]!.held_nano_usd);
    const available = balance - held;
    return {
      userId,
      balanceNanoUsd: balance.toString(),
      heldNanoUsd: held.toString(),
      availableNanoUsd: available.toString(),
      formattedAvailableUsd: formatNanoUsd(available),
    };
  }

  async creditWallet(
    userId: string,
    amountNanoUsd: bigint,
    idempotencyKey: string,
    reason: string,
  ): Promise<WalletSummary> {
    if (amountNanoUsd <= 0n) {
      throw new StoreError("bad_request", "Credit amount must be positive");
    }
    const user = await this.getUserById(userId);
    if (!user) {
      throw new StoreError("not_found", `User ${userId} not found`);
    }

    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as SqlExecutor;
      const existing = await tx<{ id: string }[]>`
        SELECT id FROM core.ledger_entries WHERE idempotency_key = ${idempotencyKey} LIMIT 1
      `;
      if (existing.length > 0) return;

      await tx`
        INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
        VALUES (${userId}, 0, 0)
        ON CONFLICT (user_id) DO NOTHING
      `;

      const updated = await tx<{ balance_nano_usd: string }[]>`
        UPDATE core.quota_wallets
        SET balance_nano_usd = balance_nano_usd + ${amountNanoUsd.toString()}::numeric,
            updated_at = NOW()
        WHERE user_id = ${userId}
        RETURNING balance_nano_usd::text
      `;

      const entryId = `ldg_${crypto.randomUUID()}`;
      await tx`
        INSERT INTO core.ledger_entries (id, idempotency_key, user_id, entry_kind, delta_nano_usd, balance_after_nano, metadata)
        VALUES (
          ${entryId},
          ${idempotencyKey},
          ${userId},
          'credit',
          ${amountNanoUsd.toString()}::numeric,
          ${updated[0]!.balance_nano_usd}::numeric,
          ${JSON.stringify({ reason })}::jsonb
        )
      `;

      await tx`
        INSERT INTO commerce.outbox_events (id, event_type, aggregate_id, payload, status, dispatched_at)
        VALUES (
          ${`obx_${crypto.randomUUID()}`},
          'core.v1.CreditWallet',
          ${userId},
          ${JSON.stringify({ idempotencyKey, amountNanoUsd: amountNanoUsd.toString(), reason })}::jsonb,
          'dispatched',
          NOW()
        )
      `;
    });

    return this.getWallet(userId);
  }

  async listGroups(enabledOnly = false): Promise<GroupItem[]> {
    return this.queryGroups({ enabledOnly });
  }

  private async queryGroups(filter: { enabledOnly?: boolean; groupId?: string }): Promise<GroupItem[]> {
    const rows = await this.sql<
      {
        id: string;
        name: string;
        description: string;
        platform: GroupItem["platform"];
        subscription_type: GroupItem["subscriptionType"];
        rate_multiplier: string;
        model_allowlist: string[];
        is_exclusive: boolean;
        sort_order: number;
        enabled: boolean;
        account_count: string;
        active_account_count: string;
        api_key_count: string;
        created_at: Date;
      }[]
    >`
      SELECT
        g.id,
        g.name,
        g.description,
        g.platform,
        g.subscription_type,
        g.rate_multiplier::text,
        g.model_allowlist,
        g.is_exclusive,
        g.sort_order,
        g.enabled,
        COUNT(a.id)::text AS account_count,
        COUNT(a.id) FILTER (WHERE a.status = 'active')::text AS active_account_count,
        (SELECT COUNT(*) FROM core.api_keys k WHERE k.group_id = g.id)::text AS api_key_count,
        g.created_at
      FROM core.groups g
      LEFT JOIN core.accounts a ON a.group_id = g.id
      WHERE (${!filter.enabledOnly} OR g.enabled = TRUE)
        AND (${filter.groupId ?? null}::text IS NULL OR g.id = ${filter.groupId ?? null})
      GROUP BY g.id
      ORDER BY g.sort_order ASC, g.created_at ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description ?? "",
      platform: r.platform,
      subscriptionType: r.subscription_type,
      rateMultiplier: Number.parseFloat(r.rate_multiplier),
      modelAllowlist: Array.isArray(r.model_allowlist) ? r.model_allowlist : [],
      isExclusive: Boolean(r.is_exclusive),
      sortOrder: r.sort_order ?? 0,
      enabled: r.enabled,
      accountCount: Number.parseInt(r.account_count, 10),
      activeAccountCount: Number.parseInt(r.active_account_count, 10),
      apiKeyCount: Number.parseInt(r.api_key_count, 10),
      createdAtIso: toIso(r.created_at),
    }));
  }

  async createGroup(req: CreateGroupRequest): Promise<GroupItem> {
    try {
      const id = `grp_${crypto.randomUUID()}`;
      await this.sql`
        INSERT INTO core.groups (
          id, name, description, platform, subscription_type, rate_multiplier,
          model_allowlist, is_exclusive, sort_order, enabled
        )
        VALUES (
          ${id},
          ${req.name},
          ${req.description},
          ${req.platform},
          ${req.subscriptionType},
          ${req.rateMultiplier},
          ${JSON.stringify(req.modelAllowlist)}::jsonb,
          ${req.isExclusive},
          ${req.sortOrder},
          ${req.enabled}
        )
      `;
      const [created] = await this.queryGroups({ groupId: id });
      if (!created) {
        throw new StoreError("not_found", `Group ${id} missing after insert`);
      }
      return created;
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async updateGroup(groupId: string, req: UpdateGroupRequest): Promise<GroupItem> {
    try {
      const allowlistJson = req.modelAllowlist ? JSON.stringify(req.modelAllowlist) : null;
      const rows = await this.sql<{ id: string }[]>`
        UPDATE core.groups
        SET name = COALESCE(${req.name ?? null}, name),
            description = COALESCE(${req.description ?? null}, description),
            subscription_type = COALESCE(${req.subscriptionType ?? null}, subscription_type),
            rate_multiplier = COALESCE(${req.rateMultiplier ?? null}, rate_multiplier),
            model_allowlist = COALESCE(${allowlistJson}::jsonb, model_allowlist),
            is_exclusive = COALESCE(${req.isExclusive ?? null}, is_exclusive),
            sort_order = COALESCE(${req.sortOrder ?? null}, sort_order),
            enabled = COALESCE(${req.enabled ?? null}, enabled),
            updated_at = NOW()
        WHERE id = ${groupId}
        RETURNING id
      `;
      if (rows.length === 0) {
        throw new StoreError("not_found", `Group ${groupId} not found`);
      }
      const [updated] = await this.queryGroups({ groupId });
      return updated!;
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async deleteGroup(groupId: string): Promise<void> {
    try {
      // core.accounts cascades on group delete; refuse instead of silently dropping accounts.
      const accountRows = await this.sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM core.accounts WHERE group_id = ${groupId}
      `;
      if (Number.parseInt(accountRows[0]?.count ?? "0", 10) > 0) {
        throw new StoreError("conflict", "Cannot delete group that still contains accounts");
      }
      const rows = await this.sql<{ id: string }[]>`
        DELETE FROM core.groups WHERE id = ${groupId} RETURNING id
      `;
      if (rows.length === 0) {
        throw new StoreError("not_found", `Group ${groupId} not found`);
      }
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async duplicateGroup(groupId: string): Promise<GroupItem> {
    const [source] = await this.queryGroups({ groupId });
    if (!source) {
      throw new StoreError("not_found", `Group ${groupId} not found`);
    }
    const taken = new Set((await this.queryGroups({})).map((g) => g.name.toLowerCase()));
    let name = `${source.name}-copy`.slice(0, 64);
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
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
    return this.queryAccounts(filter ?? {});
  }

  async getAccount(accountId: string): Promise<UpstreamAccount | null> {
    const [item] = await this.queryAccounts({ accountId });
    return item ?? null;
  }

  private async queryAccounts(filter: {
    groupId?: string;
    executionMode?: string;
    accountId?: string;
  }): Promise<UpstreamAccount[]> {
    const rows = await this.sql<
      {
        id: string;
        name: string;
        notes: string | null;
        group_id: string;
        group_name: string;
        platform: UpstreamAccount["platform"];
        execution_mode: UpstreamAccount["executionMode"];
        auth_kind: UpstreamAccount["authKind"];
        subscription_tier: string | null;
        credential_preview: string;
        max_concurrency: number;
        priority: number;
        status: UpstreamAccount["status"];
        window_5h_used_bps: number | null;
        window_7d_used_bps: number | null;
        last_test_at: Date | null;
        last_test_ok: boolean | null;
        last_test_model: string | null;
        last_test_duration_ms: number | null;
        last_test_message: string | null;
        created_at: Date;
      }[]
    >`
      SELECT
        a.id,
        COALESCE(NULLIF(a.name, ''), a.id) AS name,
        a.notes,
        a.group_id,
        g.name AS group_name,
        a.platform,
        a.execution_mode,
        a.auth_kind,
        a.subscription_tier,
        a.credential_preview,
        a.max_concurrency,
        a.priority,
        a.status,
        q.window_5h_used_bps,
        q.window_7d_used_bps,
        a.last_test_at,
        a.last_test_ok,
        a.last_test_model,
        a.last_test_duration_ms,
        a.last_test_message,
        a.created_at
      FROM core.accounts a
      JOIN core.groups g ON g.id = a.group_id
      LEFT JOIN core.account_window_quotas q ON q.account_id = a.id
      WHERE (${filter.groupId ?? null}::text IS NULL OR a.group_id = ${filter.groupId ?? null})
        AND (${filter.executionMode ?? null}::text IS NULL OR a.execution_mode = ${filter.executionMode ?? null})
        AND (${filter.accountId ?? null}::text IS NULL OR a.id = ${filter.accountId ?? null})
      ORDER BY a.priority ASC, a.created_at DESC
    `;
    return rows.map((r) => {
      const subscriptionTier = SubscriptionTierSchema.catch("standard").parse(r.subscription_tier);
      return {
        id: r.id,
        name: r.name,
        notes: r.notes ?? "",
        groupId: r.group_id,
        groupName: r.group_name,
        platform: r.platform,
        executionMode: r.execution_mode,
        authKind: r.auth_kind,
        subscriptionTier,
        tierMultiplier: subscriptionTierMultiplier(r.platform, subscriptionTier),
        credentialPreview: r.credential_preview || "****",
        maxConcurrency: r.max_concurrency,
        priority: r.priority,
        status: r.status,
        window5hUsedBps: r.window_5h_used_bps ?? 0,
        window7dUsedBps: r.window_7d_used_bps ?? 0,
        lastTest:
          r.last_test_at && r.last_test_ok !== null
            ? {
                ok: r.last_test_ok,
                atIso: toIso(r.last_test_at),
                model: r.last_test_model ?? "",
                durationMs: r.last_test_duration_ms ?? 0,
                message: r.last_test_message ?? "",
              }
            : null,
        createdAtIso: toIso(r.created_at),
      };
    });
  }

  async createAccount(
    req: CreateAccountRequest,
    encryptedSecret: Uint8Array,
    credentialPreview: string,
  ): Promise<UpstreamAccount> {
    if (!isSubscriptionTierAllowedForProvider(req.platform, req.subscriptionTier)) {
      throw new StoreError(
        "bad_request",
        `Subscription tier ${req.subscriptionTier} is not valid for provider ${req.platform}`,
      );
    }
    try {
      const id = `acc_${crypto.randomUUID()}`;
      await this.sql`
        INSERT INTO core.accounts (
          id, name, notes, group_id, platform, execution_mode, auth_kind, subscription_tier,
          credentials_enc, credential_preview, max_concurrency, priority, status
        )
        VALUES (
          ${id},
          ${req.name},
          ${req.notes},
          ${req.groupId},
          ${req.platform},
          ${req.executionMode},
          ${req.authKind},
          ${req.subscriptionTier},
          ${Buffer.from(encryptedSecret)},
          ${credentialPreview},
          ${req.maxConcurrency},
          ${req.priority},
          'active'
        )
      `;
      const created = await this.getAccount(id);
      if (!created) {
        throw new StoreError("not_found", `Account ${id} missing after insert`);
      }
      return created;
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async updateAccount(
    accountId: string,
    req: UpdateAccountRequest,
    encryptedSecret?: Uint8Array,
    credentialPreview?: string,
  ): Promise<UpstreamAccount> {
    try {
      if (req.subscriptionTier !== undefined) {
        const current = await this.sql<{ platform: UpstreamAccount["platform"] }[]>`
          SELECT platform FROM core.accounts WHERE id = ${accountId} LIMIT 1
        `;
        if (current.length === 0) {
          throw new StoreError("not_found", `Account ${accountId} not found`);
        }
        if (!isSubscriptionTierAllowedForProvider(current[0]!.platform, req.subscriptionTier)) {
          throw new StoreError(
            "bad_request",
            `Subscription tier ${req.subscriptionTier} is not valid for provider ${current[0]!.platform}`,
          );
        }
      }
      const secretBuf = encryptedSecret ? Buffer.from(encryptedSecret) : null;
      const rows = await this.sql<{ id: string }[]>`
        UPDATE core.accounts
        SET name = COALESCE(${req.name ?? null}, name),
            notes = COALESCE(${req.notes ?? null}, notes),
            group_id = COALESCE(${req.groupId ?? null}, group_id),
            execution_mode = COALESCE(${req.executionMode ?? null}, execution_mode),
            auth_kind = COALESCE(${req.authKind ?? null}, auth_kind),
            subscription_tier = COALESCE(${req.subscriptionTier ?? null}, subscription_tier),
            max_concurrency = COALESCE(${req.maxConcurrency ?? null}, max_concurrency),
            priority = COALESCE(${req.priority ?? null}, priority),
            status = COALESCE(${req.status ?? null}, status),
            credentials_enc = COALESCE(${secretBuf}, credentials_enc),
            credential_preview = COALESCE(${credentialPreview ?? null}, credential_preview),
            updated_at = NOW()
        WHERE id = ${accountId}
        RETURNING id
      `;
      if (rows.length === 0) {
        throw new StoreError("not_found", `Account ${accountId} not found`);
      }
      return (await this.getAccount(accountId))!;
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async deleteAccount(accountId: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM core.accounts WHERE id = ${accountId} RETURNING id
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `Account ${accountId} not found`);
    }
  }

  async recordAccountTestResult(accountId: string, result: AccountTestResult): Promise<void> {
    await this.sql`
      UPDATE core.accounts
      SET last_test_at = ${new Date(result.atIso)},
          last_test_ok = ${result.ok},
          last_test_model = ${result.model},
          last_test_duration_ms = ${result.durationMs},
          last_test_message = ${result.message}
      WHERE id = ${accountId}
    `;
  }

  async listUserApiKeys(userId: string): Promise<ApiKeyItem[]> {
    const rows = await this.sql<
      {
        id: string;
        name: string;
        user_id: string;
        group_id: string;
        group_name: string;
        key_prefix: string;
        rpm_limit: number;
        concurrency_limit: number;
        ip_allowlist: string[];
        enabled: boolean;
        expires_at: Date | null;
        created_at: Date;
      }[]
    >`
      SELECT
        k.id,
        k.name,
        k.user_id,
        k.group_id,
        g.name AS group_name,
        k.key_prefix,
        k.rpm_limit,
        k.concurrency_limit,
        k.ip_allowlist,
        k.enabled,
        k.expires_at,
        k.created_at
      FROM core.api_keys k
      JOIN core.groups g ON g.id = k.group_id
      WHERE k.user_id = ${userId}
      ORDER BY k.created_at DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      userId: r.user_id,
      groupId: r.group_id,
      groupName: r.group_name,
      keyPrefix: r.key_prefix,
      rpmLimit: r.rpm_limit,
      concurrencyLimit: r.concurrency_limit,
      ipAllowlist: Array.isArray(r.ip_allowlist) ? r.ip_allowlist : [],
      enabled: r.enabled,
      expiresAtIso: r.expires_at ? toIso(r.expires_at) : null,
      createdAtIso: toIso(r.created_at),
    }));
  }

  async createApiKey(
    userId: string,
    req: CreateApiKeyRequest,
    keyPrefix: string,
    keyHash: Uint8Array,
  ): Promise<ApiKeyItem> {
    try {
      const id = `key_${crypto.randomUUID()}`;
      await this.sql`
        INSERT INTO core.api_keys (
          id, name, user_id, group_id, key_prefix, key_hash_blake3,
          rpm_limit, concurrency_limit, ip_allowlist, enabled, expires_at
        )
        VALUES (
          ${id},
          ${req.name},
          ${userId},
          ${req.groupId},
          ${keyPrefix},
          ${Buffer.from(keyHash)},
          ${req.rpmLimit},
          ${req.concurrencyLimit},
          ${JSON.stringify(req.ipAllowlist)}::jsonb,
          TRUE,
          ${req.expiresAtIso ? new Date(req.expiresAtIso) : null}
        )
      `;
      const keys = await this.listUserApiKeys(userId);
      return keys.find((k) => k.id === id)!;
    } catch (err) {
      mapPgError(err);
    }
  }

  async updateUserApiKey(
    userId: string,
    keyId: string,
    req: UpdateApiKeyRequest,
  ): Promise<ApiKeyItem> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE core.api_keys
      SET name = COALESCE(${req.name ?? null}, name),
          rpm_limit = COALESCE(${req.rpmLimit ?? null}, rpm_limit),
          concurrency_limit = COALESCE(${req.concurrencyLimit ?? null}, concurrency_limit),
          enabled = COALESCE(${req.enabled ?? null}, enabled)
      WHERE id = ${keyId} AND user_id = ${userId}
      RETURNING id
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `API key ${keyId} not found`);
    }
    const keys = await this.listUserApiKeys(userId);
    return keys.find((k) => k.id === keyId)!;
  }

  async deleteUserApiKey(userId: string, keyId: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM core.api_keys WHERE id = ${keyId} AND user_id = ${userId} RETURNING id
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `API key ${keyId} not found`);
    }
  }

  async listCompositeRoutes(groupId?: string): Promise<StoredCompositeRoute[]> {
    const rows = await this.sql<
      {
        id: string;
        group_id: string;
        public_model: string;
        match_type: StoredCompositeRoute["matchType"];
        target_platform: StoredCompositeRoute["targetPlatform"];
        upstream_model: string;
        endpoint: StoredCompositeRoute["endpoint"];
        priority: number;
        enabled: boolean;
        created_at: Date;
      }[]
    >`
      SELECT
        id,
        group_id,
        public_model,
        match_type,
        target_platform,
        upstream_model,
        endpoint,
        priority,
        enabled,
        created_at
      FROM core.composite_routes
      WHERE (${groupId ?? null}::text IS NULL OR group_id = ${groupId ?? null})
      ORDER BY priority ASC, id ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      publicModel: r.public_model,
      matchType: r.match_type,
      targetPlatform: r.target_platform,
      upstreamModel: r.upstream_model,
      endpoint: r.endpoint,
      priority: r.priority,
      enabled: r.enabled,
      createdAtIso: toIso(r.created_at),
    }));
  }

  async createCompositeRoute(req: CreateCompositeRouteRequest): Promise<StoredCompositeRoute> {
    try {
      const id = `rte_${crypto.randomUUID()}`;
      const rows = await this.sql<{ created_at: Date }[]>`
        INSERT INTO core.composite_routes (
          id, group_id, public_model, match_type, target_platform,
          upstream_model, endpoint, priority, enabled
        )
        VALUES (
          ${id},
          ${req.groupId},
          ${req.publicModel},
          ${req.matchType},
          ${req.targetPlatform},
          ${req.upstreamModel},
          ${req.endpoint},
          ${req.priority},
          ${req.enabled}
        )
        RETURNING created_at
      `;
      return {
        id,
        groupId: req.groupId,
        publicModel: req.publicModel,
        matchType: req.matchType,
        targetPlatform: req.targetPlatform,
        upstreamModel: req.upstreamModel,
        endpoint: req.endpoint,
        priority: req.priority,
        enabled: req.enabled,
        createdAtIso: toIso(rows[0]?.created_at),
      };
    } catch (err) {
      mapPgError(err);
    }
  }

  async deleteCompositeRoute(routeId: string): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM core.composite_routes WHERE id = ${routeId} RETURNING id
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `Composite route ${routeId} not found`);
    }
  }

  async exportDataPlaneSnapshot(): Promise<DataPlaneSyncSnapshot> {
    const [groups, routes, accRows, keyRows, walletRows] = await Promise.all([
      this.listGroups(false),
      this.listCompositeRoutes(),
      this.sql<
        {
          id: string;
          group_id: string;
          platform: UpstreamAccount["platform"];
          execution_mode: UpstreamAccount["executionMode"];
          auth_kind: string;
          subscription_tier: string | null;
          credentials_enc_hex: string;
          max_concurrency: number;
          priority: number;
          status: string;
          window_5h_used_bps: number | null;
          window_7d_used_bps: number | null;
        }[]
      >`
        SELECT
          a.id,
          a.group_id,
          a.platform,
          a.execution_mode,
          a.auth_kind,
          a.subscription_tier,
          encode(a.credentials_enc, 'hex') AS credentials_enc_hex,
          a.max_concurrency,
          a.priority,
          a.status,
          q.window_5h_used_bps,
          q.window_7d_used_bps
        FROM core.accounts a
        LEFT JOIN core.account_window_quotas q ON q.account_id = a.id
        ORDER BY a.priority ASC, a.id ASC
      `,
      this.sql<
        {
          id: string;
          user_id: string;
          group_id: string;
          key_hash_hex: string;
          rpm_limit: number;
          concurrency_limit: number;
          ip_allowlist: string[];
          enabled: boolean;
          expires_at: Date | null;
        }[]
      >`
        SELECT
          id,
          user_id,
          group_id,
          encode(key_hash_blake3, 'hex') AS key_hash_hex,
          rpm_limit,
          concurrency_limit,
          ip_allowlist,
          enabled,
          expires_at
        FROM core.api_keys
      `,
      this.sql<
        {
          user_id: string;
          balance_nano_usd: string;
          held_nano_usd: string;
        }[]
      >`
        SELECT user_id, balance_nano_usd::text, held_nano_usd::text
        FROM core.quota_wallets
      `,
    ]);

    return {
      revisionUnixMs: Date.now(),
      groups: groups.map((g) => ({
        id: g.id,
        platform: g.platform,
        subscriptionType: g.subscriptionType,
        rateMultiplier: g.rateMultiplier,
        modelAllowlist: g.modelAllowlist,
        enabled: g.enabled,
      })),
      routes,
      accounts: accRows.map((a) => {
        const subscriptionTier = SubscriptionTierSchema.catch("standard").parse(
          a.subscription_tier,
        );
        return {
          id: a.id,
          groupId: a.group_id,
          platform: a.platform,
          executionMode: a.execution_mode,
          authKind: a.auth_kind,
          subscriptionTier,
          tierMultiplier: subscriptionTierMultiplier(a.platform, subscriptionTier),
          credentialsEncHex: a.credentials_enc_hex,
          maxConcurrency: a.max_concurrency,
          priority: a.priority,
          status: a.status,
          window5hUsedBps: a.window_5h_used_bps ?? 0,
          window7dUsedBps: a.window_7d_used_bps ?? 0,
        };
      }),
      apiKeys: keyRows.map((k) => ({
        id: k.id,
        userId: k.user_id,
        groupId: k.group_id,
        keyHashHex: k.key_hash_hex,
        rpmLimit: k.rpm_limit,
        concurrencyLimit: k.concurrency_limit,
        ipAllowlist: Array.isArray(k.ip_allowlist) ? k.ip_allowlist : [],
        enabled: k.enabled,
        expiresAtIso: k.expires_at ? toIso(k.expires_at) : null,
      })),
      wallets: walletRows.map((w) => ({
        userId: w.user_id,
        balanceNanoUsd: w.balance_nano_usd,
        heldNanoUsd: w.held_nano_usd,
      })),
    };
  }

  async recordTurnSettlement(ev: TurnSettlementEvent): Promise<UsageLogItem> {
    const costNano = BigInt(ev.costNanoUsd);
    const idemKey = `settle:${ev.requestId}`;

    return await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as SqlExecutor;
      const existingRows = await tx<{ id: string; created_at: Date }[]>`
        SELECT id, created_at
        FROM core.usage_logs
        WHERE request_id = ${ev.requestId}
        LIMIT 1
      `;
      if (existingRows.length > 0) {
        return {
          ...ev,
          id: existingRows[0]!.id,
          formattedCostUsd: formatNanoUsd(costNano),
          createdAtIso: toIso(existingRows[0]!.created_at),
        };
      }

      if (costNano > 0n) {
        const existingLedger = await tx<{ id: string }[]>`
          SELECT id FROM core.ledger_entries WHERE idempotency_key = ${idemKey} LIMIT 1
        `;
        if (existingLedger.length === 0) {
          await tx`
            INSERT INTO core.quota_wallets (user_id, balance_nano_usd, held_nano_usd)
            VALUES (${ev.userId}, 0, 0)
            ON CONFLICT (user_id) DO NOTHING
          `;
          const updatedWallet = await tx<{ balance_nano_usd: string }[]>`
            UPDATE core.quota_wallets
            SET balance_nano_usd = balance_nano_usd - ${costNano.toString()}::numeric,
                updated_at = NOW()
            WHERE user_id = ${ev.userId}
            RETURNING balance_nano_usd::text
          `;
          await tx`
            INSERT INTO core.ledger_entries (
              id, idempotency_key, user_id, entry_kind, delta_nano_usd,
              balance_after_nano, reference_id, metadata
            )
            VALUES (
              ${`ldg_${crypto.randomUUID()}`},
              ${idemKey},
              ${ev.userId},
              'settle',
              ${(-costNano).toString()}::numeric,
              ${updatedWallet[0]!.balance_nano_usd}::numeric,
              ${ev.requestId},
              ${JSON.stringify({
                accountId: ev.accountId,
                publicModel: ev.publicModel,
                upstreamModel: ev.upstreamModel,
                inputTokens: ev.inputTokens,
                outputTokens: ev.outputTokens,
              })}::jsonb
            )
          `;
        }
      }

      const usageId = `usg_${crypto.randomUUID()}`;
      const inserted = await tx<{ created_at: Date }[]>`
        INSERT INTO core.usage_logs (
          id, request_id, user_id, api_key_id, account_id, group_id,
          platform, public_model, upstream_model, ingress_codec, egress_codec,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_nano_usd, ttft_ms, duration_ms, status_code
        )
        VALUES (
          ${usageId},
          ${ev.requestId},
          ${ev.userId},
          ${ev.apiKeyId},
          ${ev.accountId},
          ${ev.groupId},
          ${ev.platform},
          ${ev.publicModel},
          ${ev.upstreamModel},
          ${ev.ingressCodec},
          ${ev.egressCodec},
          ${ev.inputTokens},
          ${ev.outputTokens},
          ${ev.cacheReadTokens},
          ${ev.cacheWriteTokens},
          ${costNano.toString()}::numeric,
          ${ev.ttftMs},
          ${ev.durationMs},
          ${ev.statusCode}
        )
        RETURNING created_at
      `;

      const totalTokens = ev.inputTokens + ev.outputTokens;
      await tx`
        INSERT INTO core.account_window_quotas (
          account_id, window_5h_used_bps, window_7d_used_bps, lifetime_tokens, lifetime_cost_nano_usd, updated_at
        )
        VALUES (
          ${ev.accountId},
          ${ev.window5hUsedBps},
          ${ev.window7dUsedBps},
          ${totalTokens},
          ${costNano.toString()}::numeric,
          NOW()
        )
        ON CONFLICT (account_id) DO UPDATE SET
          window_5h_used_bps = CASE
            WHEN EXCLUDED.window_5h_used_bps > 0 THEN EXCLUDED.window_5h_used_bps
            ELSE core.account_window_quotas.window_5h_used_bps
          END,
          window_7d_used_bps = CASE
            WHEN EXCLUDED.window_7d_used_bps > 0 THEN EXCLUDED.window_7d_used_bps
            ELSE core.account_window_quotas.window_7d_used_bps
          END,
          lifetime_tokens = core.account_window_quotas.lifetime_tokens + EXCLUDED.lifetime_tokens,
          lifetime_cost_nano_usd = core.account_window_quotas.lifetime_cost_nano_usd + EXCLUDED.lifetime_cost_nano_usd,
          updated_at = NOW()
      `;

      return {
        ...ev,
        id: usageId,
        formattedCostUsd: formatNanoUsd(costNano),
        createdAtIso: toIso(inserted[0]?.created_at),
      };
    });
  }

  async listUsageLogs(filter?: { userId?: string; limit?: number; sinceIso?: string }): Promise<UsageLogItem[]> {
    const cap = filter?.sinceIso ? 100_000 : 200;
    const limit = Math.max(1, Math.min(cap, filter?.limit ?? 50));
    const since = filter?.sinceIso ? new Date(filter.sinceIso) : null;
    const rows = await this.sql<
      {
        id: string;
        request_id: string;
        user_id: string;
        api_key_id: string;
        account_id: string;
        group_id: string;
        platform: UsageLogItem["platform"];
        public_model: string;
        upstream_model: string;
        ingress_codec: string;
        egress_codec: string;
        input_tokens: string;
        output_tokens: string;
        cache_read_tokens: string;
        cache_write_tokens: string;
        cost_nano_usd: string;
        ttft_ms: number | null;
        duration_ms: number | null;
        status_code: number;
        created_at: Date;
      }[]
    >`
      SELECT
        id, request_id, user_id, api_key_id, account_id, group_id,
        platform, public_model, upstream_model, ingress_codec, egress_codec,
        input_tokens::text, output_tokens::text, cache_read_tokens::text, cache_write_tokens::text,
        cost_nano_usd::text, ttft_ms, duration_ms, status_code, created_at
      FROM core.usage_logs
      WHERE (${filter?.userId ?? null}::text IS NULL OR user_id = ${filter?.userId ?? null})
        AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map((r) => {
      const cost = BigInt(r.cost_nano_usd);
      return {
        id: r.id,
        requestId: r.request_id,
        userId: r.user_id,
        apiKeyId: r.api_key_id,
        accountId: r.account_id,
        groupId: r.group_id,
        platform: r.platform,
        publicModel: r.public_model,
        upstreamModel: r.upstream_model,
        ingressCodec: r.ingress_codec,
        egressCodec: r.egress_codec,
        inputTokens: Number.parseInt(r.input_tokens, 10),
        outputTokens: Number.parseInt(r.output_tokens, 10),
        cacheReadTokens: Number.parseInt(r.cache_read_tokens, 10),
        cacheWriteTokens: Number.parseInt(r.cache_write_tokens, 10),
        costNanoUsd: cost.toString(),
        formattedCostUsd: formatNanoUsd(cost),
        ttftMs: r.ttft_ms ?? 0,
        durationMs: r.duration_ms ?? 0,
        // Quota watermarks live on the account (core.account_window_quotas), not on each usage row.
        window5hUsedBps: 0,
        window7dUsedBps: 0,
        statusCode: r.status_code,
        createdAtIso: toIso(r.created_at),
      };
    });
  }

  async recordRiskBanEvent(ev: RecordRiskBanInput): Promise<RiskBanEvent> {
    const id = `rsk_${crypto.randomUUID()}`;
    const now = Date.now();
    let expiresAt: Date | null = null;
    if (ev.banDuration === "10m") {
      expiresAt = new Date(now + 10 * 60_000);
    } else if (ev.banDuration === "24h") {
      expiresAt = new Date(now + 24 * 3_600_000);
    }

    const rows = await this.sql<{ created_at: Date }[]>`
      INSERT INTO core.risk_ban_records (
        id, subject_kind, subject_hash, strike_level,
        ban_reason, source_request_id, expires_at
      )
      VALUES (
        ${id},
        ${ev.subjectKind},
        ${ev.subjectHash},
        ${ev.strikeLevel},
        ${ev.reason},
        ${ev.sourceRequestId ?? null},
        ${expiresAt}
      )
      RETURNING created_at
    `;
    return {
      eventId: id,
      subjectKind: ev.subjectKind,
      strikeLevel: ev.strikeLevel,
      banDuration: ev.banDuration,
      reason: ev.reason,
      ordinaryUpstream400Count: ev.ordinaryUpstream400Count,
      downgradedCount: ev.downgradedCount,
      createdAtIso: toIso(rows[0]?.created_at),
    };
  }

  async listRiskBanEvents(limit = 50): Promise<RiskBanEvent[]> {
    const capped = Math.max(1, Math.min(200, limit));
    const rows = await this.sql<
      {
        id: string;
        subject_kind: RiskBanEvent["subjectKind"];
        strike_level: number;
        ban_reason: string;
        expires_at: Date | null;
        created_at: Date;
      }[]
    >`
      SELECT id, subject_kind, strike_level, ban_reason, expires_at, created_at
      FROM core.risk_ban_records
      ORDER BY created_at DESC
      LIMIT ${capped}
    `;
    return rows.map((r) => {
      let banDuration: RiskBanEvent["banDuration"] = "permanent";
      if (r.expires_at) {
        const diffMs = r.expires_at.getTime() - r.created_at.getTime();
        banDuration = diffMs > 3_600_000 ? "24h" : "10m";
      }
      return {
        eventId: r.id,
        subjectKind: r.subject_kind,
        strikeLevel: r.strike_level,
        banDuration,
        reason: r.ban_reason,
        ordinaryUpstream400Count: 0,
        downgradedCount: 0,
        createdAtIso: toIso(r.created_at),
      };
    });
  }
}
