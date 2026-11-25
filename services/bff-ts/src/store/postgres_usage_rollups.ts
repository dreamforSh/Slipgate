import type postgres from "postgres";
import type {
  UpdateUsageRollupConfigRequest,
  UsageRollupBackfillResponse,
  UsageRollupCleanupRequest,
  UsageRollupCleanupResponse,
  UsageRollupSeriesPoint,
  UsageRollupSeriesQuery,
  UsageRollupSeriesResponse,
  UsageRollupStatus,
} from "@slipgate/contracts";
import {
  ceilUtcDayDate,
  ceilUtcHourDate,
  clampToSealed,
  floorUtcDayDate,
  floorUtcHourDate,
  retentionCutoffDate,
  roundOneDecimal,
  type UsageRollupBackfillInput,
  type UsageRollupsStore,
} from "./usage_rollups_types.ts";

type SqlExecutor = ReturnType<typeof postgres>;

/**
 * Idempotent DDL for usage rollups & retention state, mirrored by migrations/core/0015_usage_rollups.sql.
 * Applied at startup by PostgresControlStore.init().
 */
export const PG_USAGE_ROLLUPS_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS core;

  CREATE TABLE IF NOT EXISTS core.usage_rollups_hourly (
      bucket_start       TIMESTAMPTZ NOT NULL,
      user_id            TEXT NOT NULL,
      group_id           TEXT NOT NULL,
      platform           TEXT NOT NULL,
      public_model       TEXT NOT NULL,
      account_id         TEXT NOT NULL,
      requests           BIGINT NOT NULL DEFAULT 0,
      errors             BIGINT NOT NULL DEFAULT 0,
      input_tokens       BIGINT NOT NULL DEFAULT 0,
      output_tokens      BIGINT NOT NULL DEFAULT 0,
      cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
      cache_write_tokens BIGINT NOT NULL DEFAULT 0,
      cost_nano_usd      NUMERIC(39, 0) NOT NULL DEFAULT 0,
      duration_sum_ms    BIGINT NOT NULL DEFAULT 0,
      duration_count     BIGINT NOT NULL DEFAULT 0,
      ttft_sum_ms        BIGINT NOT NULL DEFAULT 0,
      ttft_count         BIGINT NOT NULL DEFAULT 0,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bucket_start, user_id, group_id, platform, public_model, account_id)
  );

  CREATE INDEX IF NOT EXISTS idx_core_usage_rollups_hourly_bucket
      ON core.usage_rollups_hourly (bucket_start DESC);
  CREATE INDEX IF NOT EXISTS idx_core_usage_rollups_hourly_user
      ON core.usage_rollups_hourly (user_id, bucket_start DESC);

  CREATE TABLE IF NOT EXISTS core.usage_rollups_daily (
      bucket_date        DATE NOT NULL,
      user_id            TEXT NOT NULL,
      group_id           TEXT NOT NULL,
      platform           TEXT NOT NULL,
      public_model       TEXT NOT NULL,
      account_id         TEXT NOT NULL,
      requests           BIGINT NOT NULL DEFAULT 0,
      errors             BIGINT NOT NULL DEFAULT 0,
      input_tokens       BIGINT NOT NULL DEFAULT 0,
      output_tokens      BIGINT NOT NULL DEFAULT 0,
      cache_read_tokens  BIGINT NOT NULL DEFAULT 0,
      cache_write_tokens BIGINT NOT NULL DEFAULT 0,
      cost_nano_usd      NUMERIC(39, 0) NOT NULL DEFAULT 0,
      duration_sum_ms    BIGINT NOT NULL DEFAULT 0,
      duration_count     BIGINT NOT NULL DEFAULT 0,
      ttft_sum_ms        BIGINT NOT NULL DEFAULT 0,
      ttft_count         BIGINT NOT NULL DEFAULT 0,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bucket_date, user_id, group_id, platform, public_model, account_id)
  );

  CREATE INDEX IF NOT EXISTS idx_core_usage_rollups_daily_date
      ON core.usage_rollups_daily (bucket_date DESC);
  CREATE INDEX IF NOT EXISTS idx_core_usage_rollups_daily_user
      ON core.usage_rollups_daily (user_id, bucket_date DESC);

  CREATE TABLE IF NOT EXISTS core.usage_rollup_state (
      id                   SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      last_hourly_at       TIMESTAMPTZ,
      last_daily_at        TIMESTAMPTZ,
      last_cleanup_at      TIMESTAMPTZ,
      last_cleanup_deleted INTEGER NOT NULL DEFAULT 0,
      usage_retention_days INTEGER NOT NULL DEFAULT 90,
      rollup_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- Sealed horizon (migrations/core/0022_usage_rollup_sealed_before.sql): buckets before it are
  -- never recomputed, because a retention cleanup has deleted (some of) their detail rows.
  ALTER TABLE core.usage_rollup_state ADD COLUMN IF NOT EXISTS sealed_before TIMESTAMPTZ;

  INSERT INTO core.usage_rollup_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

function toIsoOrNull(val: Date | string | null | undefined): string | null {
  if (!val) return null;
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

export class PostgresUsageRollupsStore implements UsageRollupsStore {
  private readonly sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.sql = sql;
  }

  private async ensureState(): Promise<{
    rollup_enabled: boolean;
    usage_retention_days: number;
    last_hourly_at: Date | null;
    last_daily_at: Date | null;
    last_cleanup_at: Date | null;
    last_cleanup_deleted: number;
    sealed_before: Date | null;
  }> {
    await this.sql`INSERT INTO core.usage_rollup_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
    const rows = await this.sql<
      {
        rollup_enabled: boolean;
        usage_retention_days: number;
        last_hourly_at: Date | null;
        last_daily_at: Date | null;
        last_cleanup_at: Date | null;
        last_cleanup_deleted: number;
        sealed_before: Date | null;
      }[]
    >`
      SELECT rollup_enabled, usage_retention_days, last_hourly_at, last_daily_at, last_cleanup_at, last_cleanup_deleted,
             sealed_before
      FROM core.usage_rollup_state
      WHERE id = 1
    `;
    return (
      rows[0] ?? {
        rollup_enabled: true,
        usage_retention_days: 90,
        last_hourly_at: null,
        last_daily_at: null,
        last_cleanup_at: null,
        last_cleanup_deleted: 0,
        sealed_before: null,
      }
    );
  }

  async getStatus(): Promise<UsageRollupStatus> {
    const [state, counts] = await Promise.all([
      this.ensureState(),
      this.sql<{ hourly_rows: string; daily_rows: string; oldest_log: Date | null }[]>`
        SELECT
          (SELECT COUNT(*)::text FROM core.usage_rollups_hourly) AS hourly_rows,
          (SELECT COUNT(*)::text FROM core.usage_rollups_daily) AS daily_rows,
          (SELECT MIN(created_at) FROM core.usage_logs) AS oldest_log
      `,
    ]);
    const c = counts[0];
    return {
      rollupEnabled: state.rollup_enabled,
      usageRetentionDays: state.usage_retention_days,
      lastHourlyAtIso: toIsoOrNull(state.last_hourly_at),
      lastDailyAtIso: toIsoOrNull(state.last_daily_at),
      lastCleanupAtIso: toIsoOrNull(state.last_cleanup_at),
      lastCleanupDeleted: state.last_cleanup_deleted,
      sealedBeforeIso: toIsoOrNull(state.sealed_before),
      hourlyRows: Number.parseInt(c?.hourly_rows ?? "0", 10),
      dailyRows: Number.parseInt(c?.daily_rows ?? "0", 10),
      oldestLogIso: toIsoOrNull(c?.oldest_log),
    };
  }

  async updateConfig(req: UpdateUsageRollupConfigRequest): Promise<UsageRollupStatus> {
    await this.ensureState();
    await this.sql`
      UPDATE core.usage_rollup_state
      SET rollup_enabled = COALESCE(${req.rollupEnabled ?? null}, rollup_enabled),
          usage_retention_days = COALESCE(${req.usageRetentionDays ?? null}, usage_retention_days),
          updated_at = NOW()
      WHERE id = 1
    `;
    return this.getStatus();
  }

  async backfill(req: UsageRollupBackfillInput): Promise<UsageRollupBackfillResponse> {
    const state = await this.ensureState();
    const sealedMs = state.sealed_before ? new Date(state.sealed_before).getTime() : null;
    const untilDate = req.untilIso ? new Date(req.untilIso) : new Date();
    const days = Math.max(1, Math.min(365, req.days ?? 30));
    const sinceDate = req.sinceIso ? new Date(req.sinceIso) : new Date(untilDate.getTime() - days * 86_400_000);
    let hourlyUpserted = 0;
    let dailyUpserted = 0;

    if (req.granularity === "hourly" || req.granularity === "both") {
      // Align to UTC hour boundaries so partial-hour queries never overwrite a bucket with incomplete counts.
      const aggSince = new Date(clampToSealed(floorUtcHourDate(sinceDate).getTime(), sealedMs));
      const aggUntil = ceilUtcHourDate(untilDate);
      const rows = aggSince >= aggUntil ? [] : await this.sql<{ bucket_start: Date }[]>`
        INSERT INTO core.usage_rollups_hourly (
          bucket_start, user_id, group_id, platform, public_model, account_id,
          requests, errors, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_nano_usd, duration_sum_ms, duration_count, ttft_sum_ms, ttft_count, updated_at
        )
        SELECT
          date_trunc('hour', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket_start,
          COALESCE(user_id, ''),
          COALESCE(group_id, ''),
          COALESCE(platform, ''),
          COALESCE(public_model, ''),
          COALESCE(account_id, ''),
          COUNT(*)::bigint,
          COUNT(*) FILTER (WHERE status_code >= 400)::bigint,
          COALESCE(SUM(input_tokens), 0)::bigint,
          COALESCE(SUM(output_tokens), 0)::bigint,
          COALESCE(SUM(cache_read_tokens), 0)::bigint,
          COALESCE(SUM(cache_write_tokens), 0)::bigint,
          COALESCE(SUM(cost_nano_usd), 0)::numeric(39, 0),
          COALESCE(SUM(COALESCE(duration_ms, 0)), 0)::bigint,
          COUNT(*) FILTER (WHERE duration_ms IS NOT NULL)::bigint,
          COALESCE(SUM(COALESCE(ttft_ms, 0)), 0)::bigint,
          COUNT(*) FILTER (WHERE ttft_ms IS NOT NULL)::bigint,
          NOW()
        FROM core.usage_logs
        WHERE created_at >= ${aggSince} AND created_at < ${aggUntil}
        GROUP BY 1, 2, 3, 4, 5, 6
        ON CONFLICT (bucket_start, user_id, group_id, platform, public_model, account_id) DO UPDATE SET
          requests = EXCLUDED.requests,
          errors = EXCLUDED.errors,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          cache_write_tokens = EXCLUDED.cache_write_tokens,
          cost_nano_usd = EXCLUDED.cost_nano_usd,
          duration_sum_ms = EXCLUDED.duration_sum_ms,
          duration_count = EXCLUDED.duration_count,
          ttft_sum_ms = EXCLUDED.ttft_sum_ms,
          ttft_count = EXCLUDED.ttft_count,
          updated_at = NOW()
        RETURNING bucket_start
      `;
      hourlyUpserted = rows.length;
      await this.sql`
        UPDATE core.usage_rollup_state SET last_hourly_at = NOW(), updated_at = NOW() WHERE id = 1
      `;
    }

    if (req.granularity === "daily" || req.granularity === "both") {
      // Align to UTC day boundaries for the same reason.
      const aggSince = new Date(clampToSealed(floorUtcDayDate(sinceDate).getTime(), sealedMs));
      const aggUntil = ceilUtcDayDate(untilDate);
      const rows = aggSince >= aggUntil ? [] : await this.sql<{ bucket_date: string }[]>`
        INSERT INTO core.usage_rollups_daily (
          bucket_date, user_id, group_id, platform, public_model, account_id,
          requests, errors, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_nano_usd, duration_sum_ms, duration_count, ttft_sum_ms, ttft_count, updated_at
        )
        SELECT
          (created_at AT TIME ZONE 'UTC')::date AS bucket_date,
          COALESCE(user_id, ''),
          COALESCE(group_id, ''),
          COALESCE(platform, ''),
          COALESCE(public_model, ''),
          COALESCE(account_id, ''),
          COUNT(*)::bigint,
          COUNT(*) FILTER (WHERE status_code >= 400)::bigint,
          COALESCE(SUM(input_tokens), 0)::bigint,
          COALESCE(SUM(output_tokens), 0)::bigint,
          COALESCE(SUM(cache_read_tokens), 0)::bigint,
          COALESCE(SUM(cache_write_tokens), 0)::bigint,
          COALESCE(SUM(cost_nano_usd), 0)::numeric(39, 0),
          COALESCE(SUM(COALESCE(duration_ms, 0)), 0)::bigint,
          COUNT(*) FILTER (WHERE duration_ms IS NOT NULL)::bigint,
          COALESCE(SUM(COALESCE(ttft_ms, 0)), 0)::bigint,
          COUNT(*) FILTER (WHERE ttft_ms IS NOT NULL)::bigint,
          NOW()
        FROM core.usage_logs
        WHERE created_at >= ${aggSince} AND created_at < ${aggUntil}
        GROUP BY 1, 2, 3, 4, 5, 6
        ON CONFLICT (bucket_date, user_id, group_id, platform, public_model, account_id) DO UPDATE SET
          requests = EXCLUDED.requests,
          errors = EXCLUDED.errors,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          cache_read_tokens = EXCLUDED.cache_read_tokens,
          cache_write_tokens = EXCLUDED.cache_write_tokens,
          cost_nano_usd = EXCLUDED.cost_nano_usd,
          duration_sum_ms = EXCLUDED.duration_sum_ms,
          duration_count = EXCLUDED.duration_count,
          ttft_sum_ms = EXCLUDED.ttft_sum_ms,
          ttft_count = EXCLUDED.ttft_count,
          updated_at = NOW()
        RETURNING bucket_date::text AS bucket_date
      `;
      dailyUpserted = rows.length;
      await this.sql`
        UPDATE core.usage_rollup_state SET last_daily_at = NOW(), updated_at = NOW() WHERE id = 1
      `;
    }

    return {
      hourlyUpserted,
      dailyUpserted,
      sinceIso: sinceDate.toISOString(),
      untilIso: untilDate.toISOString(),
    };
  }

  async cleanupUsageLogs(req: UsageRollupCleanupRequest): Promise<UsageRollupCleanupResponse> {
    const state = await this.ensureState();
    const retentionDays = req.retentionDays ?? state.usage_retention_days;
    if (retentionDays <= 0) {
      return {
        dryRun: req.dryRun,
        cutoffIso: new Date(0).toISOString(),
        matchedOrDeleted: 0,
        rolledUpBeforeDelete: false,
      };
    }

    // Whole UTC days only (retentionCutoffDate): no bucket is ever left half-deleted.
    const cutoffDate = retentionCutoffDate(Date.now(), retentionDays);
    const cutoffIso = cutoffDate.toISOString();

    if (req.dryRun) {
      const countRows = await this.sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM core.usage_logs
        WHERE created_at < ${cutoffDate}
      `;
      return {
        dryRun: true,
        cutoffIso,
        matchedOrDeleted: Number.parseInt(countRows[0]?.count ?? "0", 10),
        rolledUpBeforeDelete: false,
      };
    }

    const oldestRows = await this.sql<{ oldest: Date | null }[]>`
      SELECT MIN(created_at) AS oldest
      FROM core.usage_logs
      WHERE created_at < ${cutoffDate}
    `;
    const oldest = oldestRows[0]?.oldest;
    let rolledUpBeforeDelete = false;
    if (oldest) {
      await this.backfill({
        sinceIso: oldest.toISOString(),
        untilIso: cutoffIso,
        granularity: "both",
      });
      rolledUpBeforeDelete = true;
    }

    // Seal before deleting: when the time budget below runs out mid-day, the rest of that day is
    // deleted by the next run, and no backfill in between may recompute it from fewer rows.
    await this.sql`
      UPDATE core.usage_rollup_state
      SET sealed_before = GREATEST(COALESCE(sealed_before, ${cutoffDate}), ${cutoffDate}),
          updated_at = NOW()
      WHERE id = 1
    `;

    const startedMs = Date.now();
    let deleted = 0;
    while (Date.now() - startedMs < 15_000) {
      const removed = await this.sql<{ id: string }[]>`
        WITH batch AS (
          SELECT id
          FROM core.usage_logs
          WHERE created_at < ${cutoffDate}
          LIMIT 10000
        )
        DELETE FROM core.usage_logs u
        USING batch
        WHERE u.id = batch.id
        RETURNING u.id
      `;
      deleted += removed.length;
      if (removed.length < 10_000) break;
    }

    await this.sql`
      UPDATE core.usage_rollup_state
      SET last_cleanup_at = NOW(),
          last_cleanup_deleted = ${deleted},
          updated_at = NOW()
      WHERE id = 1
    `;

    return {
      dryRun: false,
      cutoffIso,
      matchedOrDeleted: deleted,
      rolledUpBeforeDelete,
    };
  }

  async querySeries(query: UsageRollupSeriesQuery): Promise<UsageRollupSeriesResponse> {
    const untilDate = new Date();
    const sinceDate = new Date(untilDate.getTime() - query.days * 86_400_000);

    type AggRow = {
      bucket: string;
      requests: string;
      errors: string;
      input_tokens: string;
      output_tokens: string;
      cache_read_tokens: string;
      cache_write_tokens: string;
      cost_nano_usd: string;
      duration_sum_ms: string;
      duration_count: string;
      ttft_sum_ms: string;
      ttft_count: string;
    };

    const userFilter = query.userId ?? null;
    const groupFilter = query.groupId ?? null;
    const platformFilter = query.platform ?? null;
    const modelFilter = query.publicModel ?? null;

    const rows =
      query.granularity === "hourly"
        ? await this.sql<AggRow[]>`
            SELECT
              to_char(bucket_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS bucket,
              COALESCE(SUM(requests), 0)::text AS requests,
              COALESCE(SUM(errors), 0)::text AS errors,
              COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
              COALESCE(SUM(cost_nano_usd), 0)::text AS cost_nano_usd,
              COALESCE(SUM(duration_sum_ms), 0)::text AS duration_sum_ms,
              COALESCE(SUM(duration_count), 0)::text AS duration_count,
              COALESCE(SUM(ttft_sum_ms), 0)::text AS ttft_sum_ms,
              COALESCE(SUM(ttft_count), 0)::text AS ttft_count
            FROM core.usage_rollups_hourly
            WHERE bucket_start >= ${sinceDate}
              AND bucket_start <= ${untilDate}
              AND (${userFilter}::text IS NULL OR user_id = ${userFilter})
              AND (${groupFilter}::text IS NULL OR group_id = ${groupFilter})
              AND (${platformFilter}::text IS NULL OR platform = ${platformFilter})
              AND (${modelFilter}::text IS NULL OR public_model = ${modelFilter})
            GROUP BY bucket_start
            ORDER BY bucket_start ASC
          `
        : await this.sql<AggRow[]>`
            SELECT
              to_char(bucket_date, 'YYYY-MM-DD"T00:00:00.000Z"') AS bucket,
              COALESCE(SUM(requests), 0)::text AS requests,
              COALESCE(SUM(errors), 0)::text AS errors,
              COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
              COALESCE(SUM(cache_read_tokens), 0)::text AS cache_read_tokens,
              COALESCE(SUM(cache_write_tokens), 0)::text AS cache_write_tokens,
              COALESCE(SUM(cost_nano_usd), 0)::text AS cost_nano_usd,
              COALESCE(SUM(duration_sum_ms), 0)::text AS duration_sum_ms,
              COALESCE(SUM(duration_count), 0)::text AS duration_count,
              COALESCE(SUM(ttft_sum_ms), 0)::text AS ttft_sum_ms,
              COALESCE(SUM(ttft_count), 0)::text AS ttft_count
            FROM core.usage_rollups_daily
            WHERE bucket_date >= (${sinceDate}::timestamptz AT TIME ZONE 'UTC')::date
              AND bucket_date <= (${untilDate}::timestamptz AT TIME ZONE 'UTC')::date
              AND (${userFilter}::text IS NULL OR user_id = ${userFilter})
              AND (${groupFilter}::text IS NULL OR group_id = ${groupFilter})
              AND (${platformFilter}::text IS NULL OR platform = ${platformFilter})
              AND (${modelFilter}::text IS NULL OR public_model = ${modelFilter})
            GROUP BY bucket_date
            ORDER BY bucket_date ASC
          `;

    let totalRequests = 0;
    let totalErrors = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0n;
    let totalDurSum = 0;
    let totalDurCount = 0;
    let totalTtftSum = 0;
    let totalTtftCount = 0;

    const points: UsageRollupSeriesPoint[] = rows.map((r) => {
      const requests = Number.parseInt(r.requests, 10);
      const errors = Number.parseInt(r.errors, 10);
      const inputTokens = Number.parseInt(r.input_tokens, 10);
      const outputTokens = Number.parseInt(r.output_tokens, 10);
      const cacheReadTokens = Number.parseInt(r.cache_read_tokens, 10);
      const cacheWriteTokens = Number.parseInt(r.cache_write_tokens, 10);
      const durSum = Number.parseInt(r.duration_sum_ms, 10);
      const durCount = Number.parseInt(r.duration_count, 10);
      const ttftSum = Number.parseInt(r.ttft_sum_ms, 10);
      const ttftCount = Number.parseInt(r.ttft_count, 10);
      const cost = BigInt(r.cost_nano_usd);

      totalRequests += requests;
      totalErrors += errors;
      totalInput += inputTokens;
      totalOutput += outputTokens;
      totalCacheRead += cacheReadTokens;
      totalCacheWrite += cacheWriteTokens;
      totalCost += cost;
      totalDurSum += durSum;
      totalDurCount += durCount;
      totalTtftSum += ttftSum;
      totalTtftCount += ttftCount;

      return {
        bucketIso: r.bucket,
        requests,
        errors,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        costNanoUsd: cost.toString(),
        avgDurationMs: durCount > 0 ? roundOneDecimal(durSum / durCount) : 0,
        avgTtftMs: ttftCount > 0 ? roundOneDecimal(ttftSum / ttftCount) : 0,
      };
    });

    return {
      granularity: query.granularity,
      sinceIso: sinceDate.toISOString(),
      untilIso: untilDate.toISOString(),
      totals: {
        requests: totalRequests,
        errors: totalErrors,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheReadTokens: totalCacheRead,
        cacheWriteTokens: totalCacheWrite,
        costNanoUsd: totalCost.toString(),
        avgDurationMs: totalDurCount > 0 ? roundOneDecimal(totalDurSum / totalDurCount) : 0,
        avgTtftMs: totalTtftCount > 0 ? roundOneDecimal(totalTtftSum / totalTtftCount) : 0,
      },
      points,
    };
  }
}
