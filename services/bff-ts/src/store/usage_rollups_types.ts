import type {
  UpdateUsageRollupConfigRequest,
  UsageRollupBackfillResponse,
  UsageRollupCleanupRequest,
  UsageRollupCleanupResponse,
  UsageRollupSeriesQuery,
  UsageRollupSeriesResponse,
  UsageRollupStatus,
} from "@slipgate/contracts";

export interface UsageRollupBackfillInput {
  days?: number;
  sinceIso?: string;
  untilIso?: string;
  granularity: "hourly" | "daily" | "both";
}

export interface UsageRollupsStore {
  getStatus(): Promise<UsageRollupStatus>;
  updateConfig(req: UpdateUsageRollupConfigRequest): Promise<UsageRollupStatus>;
  backfill(req: UsageRollupBackfillInput): Promise<UsageRollupBackfillResponse>;
  cleanupUsageLogs(req: UsageRollupCleanupRequest): Promise<UsageRollupCleanupResponse>;
  querySeries(query: UsageRollupSeriesQuery): Promise<UsageRollupSeriesResponse>;
}

export interface MutableRollupBucket {
  bucketIso: string;
  userId: string;
  groupId: string;
  platform: string;
  publicModel: string;
  accountId: string;
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

export function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function utcHourIso(ms: number): string {
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export function utcDayDateStr(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function floorUtcHourDate(date: Date): Date {
  const d = new Date(date.getTime());
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function ceilUtcHourDate(date: Date): Date {
  const floor = floorUtcHourDate(date);
  return floor.getTime() < date.getTime() ? new Date(floor.getTime() + 3_600_000) : floor;
}

export function floorUtcDayDate(date: Date): Date {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export function ceilUtcDayDate(date: Date): Date {
  const floor = floorUtcDayDate(date);
  return floor.getTime() < date.getTime() ? new Date(floor.getTime() + 86_400_000) : floor;
}
