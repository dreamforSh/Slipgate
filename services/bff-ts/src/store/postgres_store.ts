import postgres from "postgres";
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
          ADD COLUMN IF NOT EXISTS credential_preview TEXT NOT NULL DEFAULT '';

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
    const rows = await this.sql<
      {
        id: string;
        name: string;
        platform: GroupItem["platform"];
        subscription_type: GroupItem["subscriptionType"];
        rate_multiplier: string;
        model_allowlist: string[];
        enabled: boolean;
        account_count: string;
        created_at: Date;
      }[]
    >`
      SELECT
        g.id,
        g.name,
        g.platform,
        g.subscription_type,
        g.rate_multiplier::text,
        g.model_allowlist,
        g.enabled,
        COUNT(a.id)::text AS account_count,
        g.created_at
      FROM core.groups g
      LEFT JOIN core.accounts a ON a.group_id = g.id
      WHERE (${!enabledOnly} OR g.enabled = TRUE)
      GROUP BY g.id
      ORDER BY g.created_at ASC
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      platform: r.platform,
      subscriptionType: r.subscription_type,
      rateMultiplier: Number.parseFloat(r.rate_multiplier),
      modelAllowlist: Array.isArray(r.model_allowlist) ? r.model_allowlist : [],
      enabled: r.enabled,
      accountCount: Number.parseInt(r.account_count, 10),
      createdAtIso: toIso(r.created_at),
    }));
  }

  async createGroup(req: CreateGroupRequest): Promise<GroupItem> {
    try {
      const id = `grp_${crypto.randomUUID()}`;
      const rows = await this.sql<{ created_at: Date }[]>`
        INSERT INTO core.groups (id, name, platform, subscription_type, rate_multiplier, model_allowlist, enabled)
        VALUES (
          ${id},
          ${req.name},
          ${req.platform},
          ${req.subscriptionType},
          ${req.rateMultiplier},
          ${JSON.stringify(req.modelAllowlist)}::jsonb,
          ${req.enabled}
        )
        RETURNING created_at
      `;
      return {
        id,
        name: req.name,
        platform: req.platform,
        subscriptionType: req.subscriptionType,
        rateMultiplier: req.rateMultiplier,
        modelAllowlist: [...req.modelAllowlist],
        enabled: req.enabled,
        accountCount: 0,
        createdAtIso: toIso(rows[0]?.created_at),
      };
    } catch (err) {
      mapPgError(err);
    }
  }

  async updateGroup(groupId: string, req: UpdateGroupRequest): Promise<GroupItem> {
    try {
      const allowlistJson = req.modelAllowlist ? JSON.stringify(req.modelAllowlist) : null;
      const rows = await this.sql<{ id: string }[]>`
        UPDATE core.groups
        SET name = COALESCE(${req.name ?? null}, name),
            rate_multiplier = COALESCE(${req.rateMultiplier ?? null}, rate_multiplier),
            model_allowlist = COALESCE(${allowlistJson}::jsonb, model_allowlist),
            enabled = COALESCE(${req.enabled ?? null}, enabled),
            updated_at = NOW()
        WHERE id = ${groupId}
        RETURNING id
      `;
      if (rows.length === 0) {
        throw new StoreError("not_found", `Group ${groupId} not found`);
      }
      const list = await this.listGroups();
      return list.find((g) => g.id === groupId)!;
    } catch (err) {
      if (err instanceof StoreError) throw err;
      mapPgError(err);
    }
  }

  async deleteGroup(groupId: string): Promise<void> {
    try {
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

  async listAccounts(filter?: { groupId?: string; executionMode?: string }): Promise<UpstreamAccount[]> {
    const rows = await this.sql<
      {
        id: string;
        name: string;
        group_id: string;
        group_name: string;
        platform: UpstreamAccount["platform"];
        execution_mode: UpstreamAccount["executionMode"];
        auth_kind: UpstreamAccount["authKind"];
        credential_preview: string;
        max_concurrency: number;
        priority: number;
        status: UpstreamAccount["status"];
        window_5h_used_bps: number | null;
        window_7d_used_bps: number | null;
        created_at: Date;
      }[]
    >`
      SELECT
        a.id,
        COALESCE(NULLIF(a.name, ''), a.id) AS name,
        a.group_id,
        g.name AS group_name,
        a.platform,
        a.execution_mode,
        a.auth_kind,
        a.credential_preview,
        a.max_concurrency,
        a.priority,
        a.status,
        q.window_5h_used_bps,
        q.window_7d_used_bps,
        a.created_at
      FROM core.accounts a
      JOIN core.groups g ON g.id = a.group_id
      LEFT JOIN core.account_window_quotas q ON q.account_id = a.id
      WHERE (${filter?.groupId ?? null}::text IS NULL OR a.group_id = ${filter?.groupId ?? null})
        AND (${filter?.executionMode ?? null}::text IS NULL OR a.execution_mode = ${filter?.executionMode ?? null})
      ORDER BY a.priority ASC, a.created_at DESC
    `;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      groupId: r.group_id,
      groupName: r.group_name,
      platform: r.platform,
      executionMode: r.execution_mode,
      authKind: r.auth_kind,
      credentialPreview: r.credential_preview || "****",
      maxConcurrency: r.max_concurrency,
      priority: r.priority,
      status: r.status,
      window5hUsedBps: r.window_5h_used_bps ?? 0,
      window7dUsedBps: r.window_7d_used_bps ?? 0,
      createdAtIso: toIso(r.created_at),
    }));
  }

  async createAccount(
    req: CreateAccountRequest,
    encryptedSecret: Uint8Array,
    credentialPreview: string,
  ): Promise<UpstreamAccount> {
    try {
      const id = `acc_${crypto.randomUUID()}`;
      await this.sql`
        INSERT INTO core.accounts (
          id, name, group_id, platform, execution_mode, auth_kind,
          credentials_enc, credential_preview, max_concurrency, priority, status
        )
        VALUES (
          ${id},
          ${req.name},
          ${req.groupId},
          ${req.platform},
          ${req.executionMode},
          ${req.authKind},
          ${Buffer.from(encryptedSecret)},
          ${credentialPreview},
          ${req.maxConcurrency},
          ${req.priority},
          'active'
        )
      `;
      const items = await this.listAccounts();
      const created = items.find((item) => item.id === id);
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
      const secretBuf = encryptedSecret ? Buffer.from(encryptedSecret) : null;
      const rows = await this.sql<{ id: string }[]>`
        UPDATE core.accounts
        SET name = COALESCE(${req.name ?? null}, name),
            group_id = COALESCE(${req.groupId ?? null}, group_id),
            execution_mode = COALESCE(${req.executionMode ?? null}, execution_mode),
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
      const items = await this.listAccounts();
      return items.find((item) => item.id === accountId)!;
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
}
