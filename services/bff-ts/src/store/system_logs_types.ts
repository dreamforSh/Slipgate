import {
  SYSTEM_LOG_LEVEL_RANK,
  SYSTEM_LOG_LEVELS,
  type SystemLogItem,
  type SystemLogLevel,
  type SystemLogSource,
} from "@slipgate/contracts";

/** One entry as the sink hands it to the store: already redacted and size-capped. */
export interface SystemLogInsert {
  createdAtIso: string;
  level: SystemLogLevel;
  source: SystemLogSource;
  component: string;
  host: string;
  message: string;
  requestId: string;
  clientRequestId: string;
  userId: string | null;
  apiKeyId: string | null;
  accountId: string | null;
  platform: string;
  model: string;
  /** Redacted context as JSON text ("{}" when empty). */
  contextJson: string;
}

/** Resolved list / cleanup filter; every given field must match (AND). */
export interface SystemLogFilter {
  /** Inclusive. */
  sinceIso?: string;
  /** Exclusive. */
  untilIso?: string;
  level?: SystemLogLevel;
  minLevel?: SystemLogLevel;
  source?: SystemLogSource;
  component?: string;
  host?: string;
  requestId?: string;
  clientRequestId?: string;
  userId?: string;
  apiKeyId?: string;
  accountId?: string;
  platform?: string;
  model?: string;
  /** Case-insensitive substring of message, request_id, client_request_id or context. */
  q?: string;
  /** Only rows with a larger id (decimal string). */
  afterId?: string;
}

export interface SystemLogCleanupAudit {
  operatorId: string;
  conditions: Record<string, unknown>;
  deletedRows: number;
}

/** Refused cleanup: an unfiltered delete would wipe the whole table. */
export class SystemLogFilterRequiredError extends Error {
  constructor() {
    super("cleanup requires at least one filter condition");
    this.name = "SystemLogFilterRequiredError";
  }
}

/** Rows kept by the in-memory store (oldest dropped first); Postgres relies on retention instead. */
export const MEMORY_SYSTEM_LOG_LIMIT = 50_000;
/** Rows deleted per statement by the retention prune, so no single delete holds locks for long. */
export const SYSTEM_LOG_PRUNE_BATCH = 10_000;
/** commerce.portal_settings key holding the admin's runtime log config. */
export const RUNTIME_LOG_CONFIG_KEY = "ops_runtime_log_config";

/** Persistence of system logs and the runtime log config. Memory and Postgres behave identically. */
export interface SystemLogStore {
  /** Inserts the rows in order (ids follow that order); returns how many were stored. */
  insertSystemLogs(rows: SystemLogInsert[]): Promise<number>;
  /** Newest first (created_at DESC, id DESC); `total` counts every match. */
  listSystemLogs(filter: SystemLogFilter, page: number, pageSize: number): Promise<{ items: SystemLogItem[]; total: number }>;
  /** Deletes every match; throws SystemLogFilterRequiredError for a filter without any constraint. */
  deleteSystemLogs(filter: SystemLogFilter): Promise<number>;
  recordSystemLogCleanup(audit: SystemLogCleanupAudit): Promise<void>;
  /** Retention: deletes system logs and cleanup audits created before `cutoffIso`; returns the log rows deleted. */
  pruneSystemLogs(cutoffIso: string): Promise<number>;
  /** The saved runtime log config document, or null when none is saved (baseline applies). */
  getRuntimeLogConfig(): Promise<Record<string, unknown> | null>;
  /** Saves the document, or removes it with null (reset to baseline). */
  setRuntimeLogConfig(value: Record<string, unknown> | null): Promise<void>;
}

/** Whether the filter narrows the rows at all (the cleanup refuses one that does not). */
export function hasSystemLogConstraint(f: SystemLogFilter): boolean {
  return Boolean(
    f.sinceIso ||
      f.untilIso ||
      f.level ||
      f.minLevel ||
      f.source ||
      f.component ||
      f.host ||
      f.requestId ||
      f.clientRequestId ||
      f.userId ||
      f.apiKeyId ||
      f.accountId ||
      f.platform ||
      f.model ||
      f.q ||
      f.afterId,
  );
}

/** Levels at or above `min`, for an IN (...) filter. */
export function levelsAtLeast(min: SystemLogLevel): SystemLogLevel[] {
  return SYSTEM_LOG_LEVELS.filter((l) => SYSTEM_LOG_LEVEL_RANK[l] >= SYSTEM_LOG_LEVEL_RANK[min]);
}

/** Parses a stored context JSON text; anything but an object reads as {}. */
export function parseSystemLogContext(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
