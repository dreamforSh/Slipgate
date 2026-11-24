import type postgres from "postgres";
import type {
  AlertEvent,
  AlertEventStatus,
  AlertMetric,
  AlertOperator,
  AlertRule,
  AlertSeverity,
  AlertSilence,
  CreateAlertRuleRequest,
  CreateAlertSilenceRequest,
  UpdateAlertRuleRequest,
} from "@slipgate/contracts";
import { clampPage } from "./ops_shared.ts";
import {
  parseAlertDetails,
  parseAlertScope,
  parseNotifyEmails,
  type AlertEventFilter,
  type AlertStore,
  type CreateAlertEventInput,
} from "./alerts_types.ts";

type Sql = ReturnType<typeof postgres>;
type Fragment = postgres.Fragment;

/**
 * Idempotent DDL for alerts, mirrored by migrations/commerce/0019_alerts.sql.
 * Applied at startup by PostgresControlStore.init().
 */
export const PG_ALERTS_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS commerce;

  CREATE TABLE IF NOT EXISTS commerce.alert_rules (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      enabled           BOOLEAN NOT NULL DEFAULT TRUE,
      metric            TEXT NOT NULL
                        CHECK (metric IN ('error_rate', 'latency_p95', 'account_unhealthy', 'request_errors_count', 'dead_letter_count')),
      operator          TEXT NOT NULL DEFAULT 'gte'
                        CHECK (operator IN ('gt', 'gte', 'lt', 'lte')),
      threshold         DOUBLE PRECISION NOT NULL,
      window_minutes    INTEGER NOT NULL DEFAULT 15,
      cooldown_minutes  INTEGER NOT NULL DEFAULT 30,
      severity          TEXT NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('info', 'warning', 'critical')),
      scope_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
      notify_emails     JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by        TEXT NOT NULL DEFAULT '',
      last_evaluated_at TIMESTAMPTZ,
      last_triggered_at TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS commerce.alert_events (
      id              TEXT PRIMARY KEY,
      rule_id         TEXT NOT NULL REFERENCES commerce.alert_rules(id) ON DELETE CASCADE,
      rule_name       TEXT NOT NULL DEFAULT '',
      metric          TEXT NOT NULL,
      severity        TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
      status          TEXT NOT NULL DEFAULT 'firing'
                      CHECK (status IN ('firing', 'resolved', 'silenced')),
      observed_value  DOUBLE PRECISION NOT NULL DEFAULT 0,
      threshold       DOUBLE PRECISION NOT NULL DEFAULT 0,
      message         TEXT NOT NULL DEFAULT '',
      details_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
      notified        BOOLEAN NOT NULL DEFAULT FALSE,
      notify_error    TEXT NOT NULL DEFAULT '',
      fired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at     TIMESTAMPTZ,
      acknowledged_by TEXT NOT NULL DEFAULT '',
      acknowledged_at TIMESTAMPTZ
  );

  CREATE TABLE IF NOT EXISTS commerce.alert_silences (
      id         TEXT PRIMARY KEY,
      rule_id    TEXT REFERENCES commerce.alert_rules(id) ON DELETE CASCADE,
      reason     TEXT NOT NULL DEFAULT '',
      starts_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at    TIMESTAMPTZ NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_commerce_alert_events_rule_fired
      ON commerce.alert_events (rule_id, fired_at DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_alert_events_status_fired
      ON commerce.alert_events (status, fired_at DESC);
  CREATE INDEX IF NOT EXISTS idx_commerce_alert_silences_ends
      ON commerce.alert_silences (ends_at DESC);
`;

interface AlertRuleRow {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  metric: AlertMetric;
  operator: AlertOperator;
  threshold: number;
  window_minutes: number;
  cooldown_minutes: number;
  severity: AlertSeverity;
  scope_json: unknown;
  notify_emails: unknown;
  created_by: string;
  last_evaluated_at: Date | null;
  last_triggered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AlertEventRow {
  id: string;
  rule_id: string;
  rule_name: string;
  metric: AlertMetric;
  severity: AlertSeverity;
  status: AlertEventStatus;
  observed_value: number;
  threshold: number;
  message: string;
  details_json: unknown;
  notified: boolean;
  notify_error: string;
  fired_at: Date;
  resolved_at: Date | null;
  acknowledged_by: string;
  acknowledged_at: Date | null;
}

interface AlertSilenceRow {
  id: string;
  rule_id: string | null;
  rule_name: string | null;
  reason: string;
  starts_at: Date;
  ends_at: Date;
  created_by: string;
  created_at: Date;
}

function toIso(d: Date | string | null | undefined): string {
  if (!d) return new Date().toISOString();
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function toRule(r: AlertRuleRow): AlertRule {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    enabled: Boolean(r.enabled),
    metric: r.metric,
    operator: r.operator,
    threshold: Number(r.threshold),
    windowMinutes: Number(r.window_minutes),
    cooldownMinutes: Number(r.cooldown_minutes),
    severity: r.severity,
    scope: parseAlertScope(r.scope_json),
    notifyEmails: parseNotifyEmails(r.notify_emails),
    createdBy: r.created_by,
    lastEvaluatedAtIso: r.last_evaluated_at ? toIso(r.last_evaluated_at) : null,
    lastTriggeredAtIso: r.last_triggered_at ? toIso(r.last_triggered_at) : null,
    createdAtIso: toIso(r.created_at),
    updatedAtIso: toIso(r.updated_at),
  };
}

function toEvent(r: AlertEventRow): AlertEvent {
  return {
    id: r.id,
    ruleId: r.rule_id,
    ruleName: r.rule_name,
    metric: r.metric,
    severity: r.severity,
    status: r.status,
    observedValue: Number(r.observed_value),
    threshold: Number(r.threshold),
    message: r.message,
    details: parseAlertDetails(r.details_json),
    notified: Boolean(r.notified),
    notifyError: r.notify_error ?? "",
    firedAtIso: toIso(r.fired_at),
    resolvedAtIso: r.resolved_at ? toIso(r.resolved_at) : null,
    acknowledgedBy: r.acknowledged_by ?? "",
    acknowledgedAtIso: r.acknowledged_at ? toIso(r.acknowledged_at) : null,
  };
}

function toSilence(r: AlertSilenceRow): AlertSilence {
  return {
    id: r.id,
    ruleId: r.rule_id,
    ruleName: r.rule_name ?? "",
    reason: r.reason,
    startsAtIso: toIso(r.starts_at),
    endsAtIso: toIso(r.ends_at),
    createdBy: r.created_by,
    createdAtIso: toIso(r.created_at),
  };
}

export class PostgresAlertStore implements AlertStore {
  constructor(private readonly sql: Sql) {}

  async listRules(): Promise<AlertRule[]> {
    const rows = await this.sql<AlertRuleRow[]>`
      SELECT * FROM commerce.alert_rules ORDER BY created_at DESC, id ASC
    `;
    return rows.map(toRule);
  }

  async getRule(id: string): Promise<AlertRule | null> {
    const rows = await this.sql<AlertRuleRow[]>`
      SELECT * FROM commerce.alert_rules WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? toRule(rows[0]) : null;
  }

  async createRule(req: CreateAlertRuleRequest, createdBy: string): Promise<AlertRule> {
    const id = `alr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = new Date();
    const rows = await this.sql<AlertRuleRow[]>`
      INSERT INTO commerce.alert_rules (
        id, name, description, enabled, metric, operator, threshold,
        window_minutes, cooldown_minutes, severity, scope_json, notify_emails,
        created_by, created_at, updated_at
      )
      VALUES (
        ${id}, ${req.name}, ${req.description}, ${req.enabled}, ${req.metric}, ${req.operator}, ${req.threshold},
        ${req.windowMinutes}, ${req.cooldownMinutes}, ${req.severity},
        ${this.sql.json(req.scope as unknown as postgres.JSONValue)},
        ${this.sql.json(req.notifyEmails as unknown as postgres.JSONValue)},
        ${createdBy}, ${now}, ${now}
      )
      RETURNING *
    `;
    return toRule(rows[0]!);
  }

  async updateRule(id: string, req: UpdateAlertRuleRequest): Promise<AlertRule | null> {
    const current = await this.getRule(id);
    if (!current) return null;
    const rows = await this.sql<AlertRuleRow[]>`
      UPDATE commerce.alert_rules
      SET
        name = ${req.name ?? current.name},
        description = ${req.description ?? current.description},
        enabled = ${req.enabled ?? current.enabled},
        metric = ${req.metric ?? current.metric},
        operator = ${req.operator ?? current.operator},
        threshold = ${req.threshold ?? current.threshold},
        window_minutes = ${req.windowMinutes ?? current.windowMinutes},
        cooldown_minutes = ${req.cooldownMinutes ?? current.cooldownMinutes},
        severity = ${req.severity ?? current.severity},
        scope_json = ${this.sql.json((req.scope ?? current.scope) as unknown as postgres.JSONValue)},
        notify_emails = ${this.sql.json((req.notifyEmails ?? current.notifyEmails) as unknown as postgres.JSONValue)},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? toRule(rows[0]) : null;
  }

  async deleteRule(id: string): Promise<boolean> {
    const res = await this.sql`DELETE FROM commerce.alert_rules WHERE id = ${id}`;
    return res.count > 0;
  }

  async markRuleEvaluated(id: string, evaluatedAtIso: string, triggeredAtIso?: string): Promise<void> {
    const evalAt = new Date(evaluatedAtIso);
    if (triggeredAtIso) {
      const trigAt = new Date(triggeredAtIso);
      await this.sql`
        UPDATE commerce.alert_rules
        SET last_evaluated_at = ${evalAt}, last_triggered_at = ${trigAt}, updated_at = NOW()
        WHERE id = ${id}
      `;
    } else {
      await this.sql`
        UPDATE commerce.alert_rules
        SET last_evaluated_at = ${evalAt}, updated_at = NOW()
        WHERE id = ${id}
      `;
    }
  }

  async listEvents(
    filter: AlertEventFilter,
    page: number,
    pageSize: number,
  ): Promise<{ items: AlertEvent[]; total: number; firingCount: number }> {
    const sql = this.sql;
    const parts: Fragment[] = [];
    if (filter.ruleId) parts.push(sql`rule_id = ${filter.ruleId}`);
    if (filter.status) parts.push(sql`status = ${filter.status}`);
    if (filter.severity) parts.push(sql`severity = ${filter.severity}`);
    const where = parts.length ? parts.reduce((acc, p) => sql`${acc} AND ${p}`) : sql`TRUE`;
    const { offset, limit } = clampPage(page, pageSize);
    const [rows, totals, firingRows] = await Promise.all([
      sql<AlertEventRow[]>`
        SELECT * FROM commerce.alert_events
        WHERE ${where}
        ORDER BY fired_at DESC, id DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM commerce.alert_events WHERE ${where}
      `,
      sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n FROM commerce.alert_events WHERE status = 'firing'
      `,
    ]);
    return {
      items: rows.map(toEvent),
      total: Number(totals[0]?.n ?? "0"),
      firingCount: Number(firingRows[0]?.n ?? "0"),
    };
  }

  async findOpenEventForRule(ruleId: string): Promise<AlertEvent | null> {
    const rows = await this.sql<AlertEventRow[]>`
      SELECT * FROM commerce.alert_events
      WHERE rule_id = ${ruleId} AND status IN ('firing', 'silenced')
      ORDER BY fired_at DESC
      LIMIT 1
    `;
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async createEvent(input: CreateAlertEventInput): Promise<AlertEvent> {
    const id = `ale_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const rows = await this.sql<AlertEventRow[]>`
      INSERT INTO commerce.alert_events (
        id, rule_id, rule_name, metric, severity, status,
        observed_value, threshold, message, details_json,
        notified, notify_error, fired_at
      )
      VALUES (
        ${id}, ${input.ruleId}, ${input.ruleName}, ${input.metric}, ${input.severity}, ${input.status},
        ${input.observedValue}, ${input.threshold}, ${input.message},
        ${this.sql.json(input.details as unknown as postgres.JSONValue)},
        ${input.notified}, ${input.notifyError}, ${new Date(input.firedAtIso)}
      )
      RETURNING *
    `;
    return toEvent(rows[0]!);
  }

  async resolveEvent(id: string, resolvedAtIso: string): Promise<AlertEvent | null> {
    const rows = await this.sql<AlertEventRow[]>`
      UPDATE commerce.alert_events
      SET status = 'resolved', resolved_at = COALESCE(resolved_at, ${new Date(resolvedAtIso)})
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async acknowledgeEvent(id: string, operatorId: string): Promise<AlertEvent | null> {
    const rows = await this.sql<AlertEventRow[]>`
      UPDATE commerce.alert_events
      SET acknowledged_by = ${operatorId}, acknowledged_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async listSilences(activeOnly = false): Promise<AlertSilence[]> {
    const rows = await this.sql<AlertSilenceRow[]>`
      SELECT s.*, r.name AS rule_name
      FROM commerce.alert_silences s
      LEFT JOIN commerce.alert_rules r ON r.id = s.rule_id
      ${activeOnly ? this.sql`WHERE s.ends_at > NOW()` : this.sql``}
      ORDER BY s.ends_at DESC, s.created_at DESC
    `;
    return rows.map(toSilence);
  }

  async createSilence(req: CreateAlertSilenceRequest, createdBy: string): Promise<AlertSilence> {
    const id = `als_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const startsAt = req.startsAtIso ? new Date(req.startsAtIso) : new Date();
    const endsAt = new Date(req.endsAtIso);
    await this.sql`
      INSERT INTO commerce.alert_silences (id, rule_id, reason, starts_at, ends_at, created_by, created_at)
      VALUES (${id}, ${req.ruleId}, ${req.reason}, ${startsAt}, ${endsAt}, ${createdBy}, NOW())
    `;
    const rows = await this.sql<AlertSilenceRow[]>`
      SELECT s.*, r.name AS rule_name
      FROM commerce.alert_silences s
      LEFT JOIN commerce.alert_rules r ON r.id = s.rule_id
      WHERE s.id = ${id}
      LIMIT 1
    `;
    return toSilence(rows[0]!);
  }

  async deleteSilence(id: string): Promise<boolean> {
    const res = await this.sql`DELETE FROM commerce.alert_silences WHERE id = ${id}`;
    return res.count > 0;
  }

  async hasActiveSilence(ruleId: string, nowIso: string): Promise<boolean> {
    const at = new Date(nowIso);
    const rows = await this.sql<{ found: number }[]>`
      SELECT 1 AS found
      FROM commerce.alert_silences
      WHERE starts_at <= ${at}
        AND ends_at > ${at}
        AND (rule_id IS NULL OR rule_id = ${ruleId})
      LIMIT 1
    `;
    return Boolean(rows[0]);
  }
}
