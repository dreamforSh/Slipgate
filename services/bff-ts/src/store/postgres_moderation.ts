import type postgres from "postgres";
import type {
  DataPlaneSyncModeration,
  ModerationAction,
  ModerationEvent,
  ModerationEventQuery,
  ModerationRule,
  ModerationRuleKind,
  ModerationSettings,
  ModerationSource,
  RecordModerationEventInput,
  UpdateModerationSettingsRequest,
  UpsertModerationRuleRequest,
} from "@slipgate/contracts";
import {
  bytesToHexLower,
  DEFAULT_MODERATION_SETTINGS_BASE,
  type ModerationStore,
} from "./moderation_types.ts";
import { StoreError } from "./types.ts";

type SqlExecutor = ReturnType<typeof postgres>;

/**
 * Idempotent DDL for prompt moderation & risk unban tracking, mirrored by migrations/core/0016_moderation.sql.
 * Applied at startup by PostgresControlStore.init().
 */
export const PG_MODERATION_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS core;

  CREATE TABLE IF NOT EXISTS core.moderation_settings (
      id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled              BOOLEAN NOT NULL DEFAULT FALSE,
      external_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
      external_endpoint    TEXT NOT NULL DEFAULT '',
      external_api_key_enc BYTEA,
      external_model       TEXT NOT NULL DEFAULT 'omni-moderation-latest',
      external_timeout_ms  INTEGER NOT NULL DEFAULT 3000,
      external_fail_open   BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS core.moderation_rules (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      enabled         BOOLEAN NOT NULL DEFAULT TRUE,
      kind            TEXT NOT NULL CHECK (kind IN ('keyword', 'regex')),
      pattern         TEXT NOT NULL,
      case_sensitive  BOOLEAN NOT NULL DEFAULT FALSE,
      action          TEXT NOT NULL CHECK (action IN ('block', 'log_only', 'strike')),
      scope_platforms TEXT[] NOT NULL DEFAULT '{}',
      scope_group_ids TEXT[] NOT NULL DEFAULT '{}',
      reject_message  TEXT NOT NULL DEFAULT 'Request blocked by content moderation policy',
      priority        INTEGER NOT NULL DEFAULT 100,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS core.moderation_events (
      id              TEXT PRIMARY KEY,
      request_id      TEXT NOT NULL DEFAULT '',
      user_id         TEXT,
      api_key_id      TEXT,
      group_id        TEXT,
      platform        TEXT NOT NULL DEFAULT '',
      public_model    TEXT NOT NULL DEFAULT '',
      rule_id         TEXT,
      rule_name       TEXT NOT NULL DEFAULT '',
      source          TEXT NOT NULL CHECK (source IN ('local_rule', 'external_api')),
      action          TEXT NOT NULL CHECK (action IN ('block', 'log_only', 'strike')),
      matched_excerpt TEXT NOT NULL DEFAULT '',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_core_moderation_events_created
      ON core.moderation_events (created_at DESC);

  ALTER TABLE core.risk_ban_records
      ADD COLUMN IF NOT EXISTS unbanned_at TIMESTAMPTZ;

  INSERT INTO core.moderation_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

function toIso(val: Date | string | null | undefined): string {
  if (!val) return new Date().toISOString();
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

type RuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  kind: ModerationRuleKind;
  pattern: string;
  case_sensitive: boolean;
  action: ModerationAction;
  scope_platforms: string[];
  scope_group_ids: string[];
  reject_message: string;
  priority: number;
  created_at: Date;
  updated_at: Date;
};

function toRuleItem(r: RuleRow): ModerationRule {
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    kind: r.kind,
    pattern: r.pattern,
    caseSensitive: r.case_sensitive,
    action: r.action,
    scopePlatforms: Array.isArray(r.scope_platforms) ? r.scope_platforms : [],
    scopeGroupIds: Array.isArray(r.scope_group_ids) ? r.scope_group_ids : [],
    rejectMessage: r.reject_message,
    priority: r.priority,
    createdAtIso: toIso(r.created_at),
    updatedAtIso: toIso(r.updated_at),
  };
}

export class PostgresModerationStore implements ModerationStore {
  private readonly sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.sql = sql;
  }

  private async readRawSettings() {
    await this.sql`INSERT INTO core.moderation_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
    const rows = await this.sql<
      {
        enabled: boolean;
        external_enabled: boolean;
        external_endpoint: string;
        external_api_key_enc: Buffer | null;
        external_model: string;
        external_timeout_ms: number;
        external_fail_open: boolean;
        updated_at: Date;
      }[]
    >`
      SELECT
        enabled, external_enabled, external_endpoint, external_api_key_enc,
        external_model, external_timeout_ms, external_fail_open, updated_at
      FROM core.moderation_settings
      WHERE id = 1
    `;
    return rows[0];
  }

  async getSettings(): Promise<ModerationSettings> {
    const r = await this.readRawSettings();
    if (!r) {
      return { ...DEFAULT_MODERATION_SETTINGS_BASE, updatedAtIso: new Date().toISOString() };
    }
    return {
      enabled: r.enabled,
      externalEnabled: r.external_enabled,
      externalEndpoint: r.external_endpoint,
      externalApiKeySet: Boolean(r.external_api_key_enc && r.external_api_key_enc.length > 0),
      externalModel: r.external_model,
      externalTimeoutMs: r.external_timeout_ms,
      externalFailOpen: r.external_fail_open,
      updatedAtIso: toIso(r.updated_at),
    };
  }

  async updateSettings(
    req: UpdateModerationSettingsRequest,
    encryptKey: (plain: string) => Promise<Uint8Array>,
  ): Promise<ModerationSettings> {
    await this.readRawSettings();

    let keyAction: "keep" | "clear" | "set" = "keep";
    let keyBytes: Buffer | null = null;
    if (req.externalApiKey !== undefined) {
      if (req.externalApiKey === "") {
        keyAction = "clear";
      } else {
        keyAction = "set";
        keyBytes = Buffer.from(await encryptKey(req.externalApiKey));
      }
    }

    await this.sql`
      UPDATE core.moderation_settings
      SET enabled = COALESCE(${req.enabled ?? null}, enabled),
          external_enabled = COALESCE(${req.externalEnabled ?? null}, external_enabled),
          external_endpoint = COALESCE(${req.externalEndpoint ?? null}, external_endpoint),
          external_api_key_enc = CASE
            WHEN ${keyAction} = 'clear' THEN NULL
            WHEN ${keyAction} = 'set' THEN ${keyBytes}::bytea
            ELSE external_api_key_enc
          END,
          external_model = COALESCE(${req.externalModel ?? null}, external_model),
          external_timeout_ms = COALESCE(${req.externalTimeoutMs ?? null}, external_timeout_ms),
          external_fail_open = COALESCE(${req.externalFailOpen ?? null}, external_fail_open),
          updated_at = NOW()
      WHERE id = 1
    `;
    return this.getSettings();
  }

  async listRules(): Promise<ModerationRule[]> {
    const rows = await this.sql<RuleRow[]>`
      SELECT
        id, name, enabled, kind, pattern, case_sensitive, action,
        scope_platforms, scope_group_ids, reject_message, priority, created_at, updated_at
      FROM core.moderation_rules
      ORDER BY priority ASC, created_at ASC
    `;
    return rows.map(toRuleItem);
  }

  async createRule(req: UpsertModerationRuleRequest): Promise<ModerationRule> {
    const id = `mod_${crypto.randomUUID()}`;
    const rows = await this.sql<RuleRow[]>`
      INSERT INTO core.moderation_rules (
        id, name, enabled, kind, pattern, case_sensitive, action,
        scope_platforms, scope_group_ids, reject_message, priority
      )
      VALUES (
        ${id}, ${req.name}, ${req.enabled}, ${req.kind}, ${req.pattern},
        ${req.caseSensitive}, ${req.action},
        ${this.sql.array(req.scopePlatforms)}, ${this.sql.array(req.scopeGroupIds)},
        ${req.rejectMessage}, ${req.priority}
      )
      RETURNING
        id, name, enabled, kind, pattern, case_sensitive, action,
        scope_platforms, scope_group_ids, reject_message, priority, created_at, updated_at
    `;
    return toRuleItem(rows[0]!);
  }

  async updateRule(id: string, req: UpsertModerationRuleRequest): Promise<ModerationRule> {
    const rows = await this.sql<RuleRow[]>`
      UPDATE core.moderation_rules
      SET name = ${req.name},
          enabled = ${req.enabled},
          kind = ${req.kind},
          pattern = ${req.pattern},
          case_sensitive = ${req.caseSensitive},
          action = ${req.action},
          scope_platforms = ${this.sql.array(req.scopePlatforms)},
          scope_group_ids = ${this.sql.array(req.scopeGroupIds)},
          reject_message = ${req.rejectMessage},
          priority = ${req.priority},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING
        id, name, enabled, kind, pattern, case_sensitive, action,
        scope_platforms, scope_group_ids, reject_message, priority, created_at, updated_at
    `;
    if (rows.length === 0) {
      throw new StoreError("not_found", `Moderation rule ${id} not found`);
    }
    return toRuleItem(rows[0]!);
  }

  async deleteRule(id: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM core.moderation_rules WHERE id = ${id} RETURNING id
    `;
    return rows.length > 0;
  }

  async recordEvent(ev: RecordModerationEventInput): Promise<ModerationEvent> {
    const id = `mev_${crypto.randomUUID()}`;
    const rows = await this.sql<
      {
        id: string;
        request_id: string;
        user_id: string | null;
        api_key_id: string | null;
        group_id: string | null;
        platform: string;
        public_model: string;
        rule_id: string | null;
        rule_name: string;
        source: ModerationSource;
        action: ModerationAction;
        matched_excerpt: string;
        created_at: Date;
      }[]
    >`
      INSERT INTO core.moderation_events (
        id, request_id, user_id, api_key_id, group_id, platform, public_model,
        rule_id, rule_name, source, action, matched_excerpt
      )
      VALUES (
        ${id}, ${ev.requestId}, ${ev.userId ?? null}, ${ev.apiKeyId ?? null},
        ${ev.groupId ?? null}, ${ev.platform}, ${ev.publicModel},
        ${ev.ruleId ?? null}, ${ev.ruleName}, ${ev.source}, ${ev.action},
        ${ev.matchedExcerpt}
      )
      RETURNING
        id, request_id, user_id, api_key_id, group_id, platform, public_model,
        rule_id, rule_name, source, action, matched_excerpt, created_at
    `;
    const r = rows[0]!;
    return {
      id: r.id,
      requestId: r.request_id,
      userId: r.user_id,
      apiKeyId: r.api_key_id,
      groupId: r.group_id,
      platform: r.platform,
      publicModel: r.public_model,
      ruleId: r.rule_id,
      ruleName: r.rule_name,
      source: r.source,
      action: r.action,
      matchedExcerpt: r.matched_excerpt,
      createdAtIso: toIso(r.created_at),
    };
  }

  async listEvents(query: ModerationEventQuery): Promise<ModerationEvent[]> {
    const capped = Math.max(1, Math.min(200, query.limit ?? 50));
    const actionFilter = query.action ?? null;
    const sourceFilter = query.source ?? null;
    const rows = await this.sql<
      {
        id: string;
        request_id: string;
        user_id: string | null;
        api_key_id: string | null;
        group_id: string | null;
        platform: string;
        public_model: string;
        rule_id: string | null;
        rule_name: string;
        source: ModerationSource;
        action: ModerationAction;
        matched_excerpt: string;
        created_at: Date;
      }[]
    >`
      SELECT
        id, request_id, user_id, api_key_id, group_id, platform, public_model,
        rule_id, rule_name, source, action, matched_excerpt, created_at
      FROM core.moderation_events
      WHERE (${actionFilter}::text IS NULL OR action = ${actionFilter})
        AND (${sourceFilter}::text IS NULL OR source = ${sourceFilter})
      ORDER BY created_at DESC
      LIMIT ${capped}
    `;
    return rows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      userId: r.user_id,
      apiKeyId: r.api_key_id,
      groupId: r.group_id,
      platform: r.platform,
      publicModel: r.public_model,
      ruleId: r.rule_id,
      ruleName: r.rule_name,
      source: r.source,
      action: r.action,
      matchedExcerpt: r.matched_excerpt,
      createdAtIso: toIso(r.created_at),
    }));
  }

  async exportDataPlaneModeration(): Promise<DataPlaneSyncModeration> {
    const [rawSettings, rules] = await Promise.all([this.readRawSettings(), this.listRules()]);
    return {
      enabled: rawSettings?.enabled ?? false,
      externalEnabled: rawSettings?.external_enabled ?? false,
      externalEndpoint: rawSettings?.external_endpoint ?? "",
      externalApiKeyEncHex: bytesToHexLower(rawSettings?.external_api_key_enc),
      externalModel: rawSettings?.external_model ?? "omni-moderation-latest",
      externalTimeoutMs: rawSettings?.external_timeout_ms ?? 3000,
      externalFailOpen: rawSettings?.external_fail_open ?? true,
      rules: rules.filter((r) => r.enabled),
    };
  }
}
