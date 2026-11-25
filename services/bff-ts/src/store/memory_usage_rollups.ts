import type {
  UpdateUsageRollupConfigRequest,
  UsageLogItem,
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
  type MutableRollupBucket,
  type UsageRollupBackfillInput,
  type UsageRollupsStore,
  utcDayDateStr,
  utcHourIso,
} from "./usage_rollups_types.ts";

export interface MemoryUsageRollupsDeps {
  usageLogs: UsageLogItem[];
}

function reduceLogsIntoMap(
  logs: readonly UsageLogItem[],
  startMs: number,
  endMs: number,
  bucketOf: (ms: number) => string,
  target: Map<string, MutableRollupBucket>,
): number {
  const touched = new Map<string, MutableRollupBucket>();
  for (const log of logs) {
    const ms = Date.parse(log.createdAtIso);
    if (!Number.isFinite(ms) || ms < startMs || ms >= endMs) continue;
    const bucketIso = bucketOf(ms);
    const key = [
      bucketIso,
      log.userId,
      log.groupId,
      log.platform,
      log.publicModel,
      log.accountId,
    ].join("\0");
    let acc = touched.get(key);
    if (!acc) {
      acc = {
        bucketIso,
        userId: log.userId,
        groupId: log.groupId,
        platform: log.platform,
        publicModel: log.publicModel,
        accountId: log.accountId,
        requests: 0,
        errors: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costNanoUsd: 0n,
        durationSumMs: 0,
        durationCount: 0,
        ttftSumMs: 0,
        ttftCount: 0,
      };
      touched.set(key, acc);
    }
    acc.requests += 1;
    if (log.statusCode >= 400) acc.errors += 1;
    acc.inputTokens += log.inputTokens;
    acc.outputTokens += log.outputTokens;
    acc.cacheReadTokens += log.cacheReadTokens;
    acc.cacheWriteTokens += log.cacheWriteTokens;
    acc.costNanoUsd += BigInt(log.costNanoUsd);
    if (Number.isFinite(log.durationMs)) {
      acc.durationSumMs += log.durationMs;
      acc.durationCount += 1;
    }
    if (Number.isFinite(log.ttftMs)) {
      acc.ttftSumMs += log.ttftMs;
      acc.ttftCount += 1;
    }
  }
  for (const [k, v] of touched) {
    target.set(k, v);
  }
  return touched.size;
}

export class MemoryUsageRollupsStore implements UsageRollupsStore {
  private readonly usageLogs: UsageLogItem[];
  private readonly hourly = new Map<string, MutableRollupBucket>();
  private readonly daily = new Map<string, MutableRollupBucket>();
  private rollupEnabled = true;
  private usageRetentionDays = 90;
  private lastHourlyAtIso: string | null = null;
  private lastDailyAtIso: string | null = null;
  private lastCleanupAtIso: string | null = null;
  private lastCleanupDeleted = 0;
  /** Sealed horizon (see clampToSealed); only ever moves forward. */
  private sealedBeforeMs: number | null = null;

  constructor(deps: MemoryUsageRollupsDeps) {
    this.usageLogs = deps.usageLogs;
  }

  async getStatus(): Promise<UsageRollupStatus> {
    let oldestMs: number | null = null;
    for (const log of this.usageLogs) {
      const ms = Date.parse(log.createdAtIso);
      if (Number.isFinite(ms) && (oldestMs === null || ms < oldestMs)) {
        oldestMs = ms;
      }
    }
    return {
      rollupEnabled: this.rollupEnabled,
      usageRetentionDays: this.usageRetentionDays,
      lastHourlyAtIso: this.lastHourlyAtIso,
      lastDailyAtIso: this.lastDailyAtIso,
      lastCleanupAtIso: this.lastCleanupAtIso,
      lastCleanupDeleted: this.lastCleanupDeleted,
      hourlyRows: this.hourly.size,
      dailyRows: this.daily.size,
      oldestLogIso: oldestMs !== null ? new Date(oldestMs).toISOString() : null,
      sealedBeforeIso: this.sealedBeforeMs !== null ? new Date(this.sealedBeforeMs).toISOString() : null,
    };
  }

  async updateConfig(req: UpdateUsageRollupConfigRequest): Promise<UsageRollupStatus> {
    if (req.rollupEnabled !== undefined) this.rollupEnabled = req.rollupEnabled;
    if (req.usageRetentionDays !== undefined) this.usageRetentionDays = req.usageRetentionDays;
    return this.getStatus();
  }

  async backfill(req: UsageRollupBackfillInput): Promise<UsageRollupBackfillResponse> {
    const untilDate = req.untilIso ? new Date(req.untilIso) : new Date();
    const days = Math.max(1, Math.min(365, req.days ?? 30));
    const sinceDate = req.sinceIso ? new Date(req.sinceIso) : new Date(untilDate.getTime() - days * 86_400_000);
    let hourlyUpserted = 0;
    let dailyUpserted = 0;

    if (req.granularity === "hourly" || req.granularity === "both") {
      const aggSinceMs = clampToSealed(floorUtcHourDate(sinceDate).getTime(), this.sealedBeforeMs);
      const aggUntilMs = ceilUtcHourDate(untilDate).getTime();
      if (aggSinceMs < aggUntilMs) {
        hourlyUpserted = reduceLogsIntoMap(this.usageLogs, aggSinceMs, aggUntilMs, utcHourIso, this.hourly);
      }
      this.lastHourlyAtIso = new Date().toISOString();
    }

    if (req.granularity === "daily" || req.granularity === "both") {
      const aggSinceMs = clampToSealed(floorUtcDayDate(sinceDate).getTime(), this.sealedBeforeMs);
      const aggUntilMs = ceilUtcDayDate(untilDate).getTime();
      if (aggSinceMs < aggUntilMs) {
        dailyUpserted = reduceLogsIntoMap(
          this.usageLogs,
          aggSinceMs,
          aggUntilMs,
          (ms) => `${utcDayDateStr(ms)}T00:00:00.000Z`,
          this.daily,
        );
      }
      this.lastDailyAtIso = new Date().toISOString();
    }

    return {
      hourlyUpserted,
      dailyUpserted,
      sinceIso: sinceDate.toISOString(),
      untilIso: untilDate.toISOString(),
    };
  }

  async cleanupUsageLogs(req: UsageRollupCleanupRequest): Promise<UsageRollupCleanupResponse> {
    const retentionDays = req.retentionDays ?? this.usageRetentionDays;
    if (retentionDays <= 0) {
      return {
        dryRun: req.dryRun,
        cutoffIso: new Date(0).toISOString(),
        matchedOrDeleted: 0,
        rolledUpBeforeDelete: false,
      };
    }

    // Whole UTC days only (retentionCutoffDate): no bucket is ever left half-deleted.
    const cutoffMs = retentionCutoffDate(Date.now(), retentionDays).getTime();
    const cutoffIso = new Date(cutoffMs).toISOString();

    let matched = 0;
    let oldestMs: number | null = null;
    for (const log of this.usageLogs) {
      const ms = Date.parse(log.createdAtIso);
      if (Number.isFinite(ms) && ms < cutoffMs) {
        matched += 1;
        if (oldestMs === null || ms < oldestMs) oldestMs = ms;
      }
    }

    if (req.dryRun) {
      return {
        dryRun: true,
        cutoffIso,
        matchedOrDeleted: matched,
        rolledUpBeforeDelete: false,
      };
    }

    let rolledUpBeforeDelete = false;
    if (oldestMs !== null) {
      await this.backfill({
        sinceIso: new Date(oldestMs).toISOString(),
        untilIso: cutoffIso,
        granularity: "both",
      });
      rolledUpBeforeDelete = true;
    }

    // Seal before deleting: no later backfill may recompute these buckets from fewer rows.
    this.sealedBeforeMs = Math.max(this.sealedBeforeMs ?? cutoffMs, cutoffMs);
    let writeIdx = 0;
    let deleted = 0;
    for (let i = 0; i < this.usageLogs.length; i += 1) {
      const log = this.usageLogs[i]!;
      const ms = Date.parse(log.createdAtIso);
      if (Number.isFinite(ms) && ms < cutoffMs) {
        deleted += 1;
      } else {
        this.usageLogs[writeIdx] = log;
        writeIdx += 1;
      }
    }
    this.usageLogs.length = writeIdx;

    this.lastCleanupAtIso = new Date().toISOString();
    this.lastCleanupDeleted = deleted;

    return {
      dryRun: false,
      cutoffIso,
      matchedOrDeleted: deleted,
      rolledUpBeforeDelete,
    };
  }

  async querySeries(query: UsageRollupSeriesQuery): Promise<UsageRollupSeriesResponse> {
    const untilMs = Date.now();
    const sinceMs = untilMs - query.days * 86_400_000;
    const sinceDayIso = `${utcDayDateStr(sinceMs)}T00:00:00.000Z`;
    const source = query.granularity === "hourly" ? this.hourly : this.daily;

    const byBucket = new Map<
      string,
      {
        requests: number;
        errors: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        costNanoUsd: bigint;
        durationSumMs: number;
        durationCount: number;
        ttftSumMs: number;
        ttftCount: number;
      }
    >();

    for (const row of source.values()) {
      const bucketMs = Date.parse(row.bucketIso);
      if (query.granularity === "hourly") {
        if (bucketMs < sinceMs || bucketMs > untilMs) continue;
      } else {
        if (row.bucketIso < sinceDayIso) continue;
      }
      if (query.userId && row.userId !== query.userId) continue;
      if (query.groupId && row.groupId !== query.groupId) continue;
      if (query.platform && row.platform !== query.platform) continue;
      if (query.publicModel && row.publicModel !== query.publicModel) continue;

      let agg = byBucket.get(row.bucketIso);
      if (!agg) {
        agg = {
          requests: 0,
          errors: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costNanoUsd: 0n,
          durationSumMs: 0,
          durationCount: 0,
          ttftSumMs: 0,
          ttftCount: 0,
        };
        byBucket.set(row.bucketIso, agg);
      }
      agg.requests += row.requests;
      agg.errors += row.errors;
      agg.inputTokens += row.inputTokens;
      agg.outputTokens += row.outputTokens;
      agg.cacheReadTokens += row.cacheReadTokens;
      agg.cacheWriteTokens += row.cacheWriteTokens;
      agg.costNanoUsd += row.costNanoUsd;
      agg.durationSumMs += row.durationSumMs;
      agg.durationCount += row.durationCount;
      agg.ttftSumMs += row.ttftSumMs;
      agg.ttftCount += row.ttftCount;
    }

    const sortedBuckets = Array.from(byBucket.keys()).sort();
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

    const points: UsageRollupSeriesPoint[] = sortedBuckets.map((bucketIso) => {
      const a = byBucket.get(bucketIso)!;
      totalRequests += a.requests;
      totalErrors += a.errors;
      totalInput += a.inputTokens;
      totalOutput += a.outputTokens;
      totalCacheRead += a.cacheReadTokens;
      totalCacheWrite += a.cacheWriteTokens;
      totalCost += a.costNanoUsd;
      totalDurSum += a.durationSumMs;
      totalDurCount += a.durationCount;
      totalTtftSum += a.ttftSumMs;
      totalTtftCount += a.ttftCount;
      return {
        bucketIso,
        requests: a.requests,
        errors: a.errors,
        inputTokens: a.inputTokens,
        outputTokens: a.outputTokens,
        cacheReadTokens: a.cacheReadTokens,
        cacheWriteTokens: a.cacheWriteTokens,
        costNanoUsd: a.costNanoUsd.toString(),
        avgDurationMs: a.durationCount > 0 ? roundOneDecimal(a.durationSumMs / a.durationCount) : 0,
        avgTtftMs: a.ttftCount > 0 ? roundOneDecimal(a.ttftSumMs / a.ttftCount) : 0,
      };
    });

    return {
      granularity: query.granularity,
      sinceIso: new Date(sinceMs).toISOString(),
      untilIso: new Date(untilMs).toISOString(),
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
