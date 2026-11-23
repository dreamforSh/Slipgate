import { z } from "zod";

/**
 * Persisted system logs (admin → Ops → System logs).
 *
 * Every process logs with a level, a component and structured fields. What is worth keeping
 * (warnings and errors, audit events, and request access events when enabled) goes through a
 * bounded in-memory queue into commerce.system_logs in batches: the BFF writes its own entries,
 * slipgate-net forwards its own and slipgate-core's lines to the BFF's internal ingest endpoint.
 * Entries are redacted before they are stored and pruned after the runtime retention.
 *
 * Pure ESM/Zod leaf module (no Node/Bun APIs).
 */

export const SYSTEM_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const SystemLogLevelSchema = z.enum(SYSTEM_LOG_LEVELS);
export type SystemLogLevel = z.infer<typeof SystemLogLevelSchema>;

/** Severity order: an entry passes a `minLevel` / runtime level when its rank is at least that level's. */
export const SYSTEM_LOG_LEVEL_RANK: Record<SystemLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Common spellings of a level (zap, Go, Zig std.log, syslog) mapped onto the four stored ones. */
export function normalizeSystemLogLevel(raw: unknown): SystemLogLevel | null {
  if (typeof raw !== "string") return null;
  switch (raw.trim().toLowerCase()) {
    case "trace":
    case "debug":
      return "debug";
    case "info":
    case "information":
    case "notice":
      return "info";
    case "warn":
    case "warning":
      return "warn";
    case "err":
    case "error":
    case "fatal":
    case "panic":
    case "dpanic":
    case "critical":
    case "crit":
      return "error";
    default:
      return null;
  }
}

/** Process that emitted an entry: the console API (bff), the edge (net) or the data-plane core. */
export const SYSTEM_LOG_SOURCES = ["bff", "net", "core"] as const;
export const SystemLogSourceSchema = z.enum(SYSTEM_LOG_SOURCES);
export type SystemLogSource = z.infer<typeof SystemLogSourceSchema>;

export const SystemLogItemSchema = z.object({
  /** Monotonic row id (decimal string); newer rows have larger ids. */
  id: z.string(),
  createdAtIso: z.string(),
  level: SystemLogLevelSchema,
  source: SystemLogSourceSchema,
  /** Subsystem, e.g. "http", "app", "security", "audit.log_config_change", "http.access", "supervisor". */
  component: z.string(),
  /** Host name of the process that wrote the entry. */
  host: z.string(),
  message: z.string(),
  /** X-Request-Id of the request being served when the entry was written ("" outside a request). */
  requestId: z.string(),
  clientRequestId: z.string(),
  userId: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  accountId: z.string().nullable(),
  platform: z.string(),
  model: z.string(),
  /** Remaining structured fields (redacted): error, stack, caller, method, path, … */
  context: z.record(z.unknown()),
});
export type SystemLogItem = z.infer<typeof SystemLogItemSchema>;

/** Relative windows for the list (`timeRange`), counted back from now. */
export const SYSTEM_LOG_TIME_RANGES = ["5m", "30m", "1h", "6h", "24h", "7d", "30d"] as const;
export const SystemLogTimeRangeSchema = z.enum(SYSTEM_LOG_TIME_RANGES);
export type SystemLogTimeRange = z.infer<typeof SystemLogTimeRangeSchema>;
export const SYSTEM_LOG_TIME_RANGE_MS: Record<SystemLogTimeRange, number> = {
  "5m": 5 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};
/** Window of a list query that gives neither `sinceIso` nor `timeRange`. */
export const SYSTEM_LOG_DEFAULT_TIME_RANGE: SystemLogTimeRange = "1h";
export const SYSTEM_LOG_DEFAULT_PAGE_SIZE = 50;
export const SYSTEM_LOG_MAX_PAGE_SIZE = 200;

/** Empty strings mean "no filter". */
const filterText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));
const isoInstant = z
  .string()
  .datetime({ offset: true })
  .optional()
  .or(z.literal("").transform(() => undefined));
const optionalEnum = <T extends [string, ...string[]]>(schema: z.ZodEnum<T>) =>
  schema.optional().or(z.literal("").transform(() => undefined));

/** Filters shared by the list and the cleanup; every given one must match (AND). */
const SystemLogFilterFields = {
  /** Exact level. */
  level: optionalEnum(SystemLogLevelSchema),
  /** This level and above (e.g. "warn" = warn + error). */
  minLevel: optionalEnum(SystemLogLevelSchema),
  source: optionalEnum(SystemLogSourceSchema),
  /** Exact component. */
  component: filterText(128),
  host: filterText(255),
  requestId: filterText(128),
  clientRequestId: filterText(128),
  userId: filterText(64),
  apiKeyId: filterText(64),
  accountId: filterText(64),
  platform: filterText(32),
  model: filterText(128),
  /** Case-insensitive substring of the message, request ids or the context JSON. */
  q: filterText(200),
  /** Inclusive start / exclusive end of the window. */
  sinceIso: isoInstant,
  untilIso: isoInstant,
};

/**
 * GET /api/v1/admin/ops/system-logs query. Without `sinceIso` the window is the last `timeRange`
 * (default 1h); `untilIso` defaults to now. `afterId` returns only rows newer than that id (live
 * tail: poll page 1 with the largest id already shown). Newest first.
 */
export const SystemLogQuerySchema = z
  .object({
    ...SystemLogFilterFields,
    timeRange: SystemLogTimeRangeSchema.optional(),
    afterId: z
      .string()
      .trim()
      .regex(/^\d{1,18}$/)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    page: z.coerce.number().int().min(1).max(100_000).catch(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(SYSTEM_LOG_MAX_PAGE_SIZE)
      .catch(SYSTEM_LOG_DEFAULT_PAGE_SIZE)
      .default(SYSTEM_LOG_DEFAULT_PAGE_SIZE),
  })
  .refine((q) => !q.sinceIso || !q.untilIso || Date.parse(q.sinceIso) <= Date.parse(q.untilIso), {
    message: "sinceIso must not be after untilIso",
    path: ["sinceIso"],
  });
export type SystemLogQuery = z.infer<typeof SystemLogQuerySchema>;

export const SystemLogListResponseSchema = z.object({
  items: z.array(SystemLogItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  /** The window actually searched. */
  sinceIso: z.string(),
  untilIso: z.string(),
});
export type SystemLogListResponse = z.infer<typeof SystemLogListResponseSchema>;

/**
 * POST /api/v1/admin/ops/system-logs/cleanup body: deletes every matching row. At least one
 * filter is required (400 `cleanup_filter_required`), and `sinceIso` must not be after
 * `untilIso` (400 `cleanup_invalid_range`). Unknown filter values are refused, never ignored.
 */
export const SystemLogCleanupRequestSchema = z.object(SystemLogFilterFields).strict();
export type SystemLogCleanupRequest = z.infer<typeof SystemLogCleanupRequestSchema>;

export const SystemLogCleanupResponseSchema = z.object({ deleted: z.number().int().nonnegative() });
export type SystemLogCleanupResponse = z.infer<typeof SystemLogCleanupResponseSchema>;

/** Queue/delivery counters slipgate-net reports for its forwarder with every batch. */
export const SystemLogForwarderHealthSchema = z.object({
  queueDepth: z.number().int().nonnegative(),
  queueCapacity: z.number().int().nonnegative(),
  droppedCount: z.number().int().nonnegative(),
  sentCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  lastError: z.string().max(500).default(""),
});
export type SystemLogForwarderHealth = z.infer<typeof SystemLogForwarderHealthSchema>;

/** GET /api/v1/admin/ops/system-logs/health */
export const SystemLogSinkHealthSchema = z.object({
  /** Host name of this BFF process. */
  host: z.string(),
  /** Entries waiting for the next batch insert. */
  queueDepth: z.number().int().nonnegative(),
  queueCapacity: z.number().int().positive(),
  /** Entries discarded: queue full (back-pressure), write backoff window, or shutdown. */
  droppedCount: z.number().int().nonnegative(),
  /** Entries whose batch insert failed. */
  writeFailedCount: z.number().int().nonnegative(),
  writtenCount: z.number().int().nonnegative(),
  /** Mean duration of a successful batch insert. */
  avgWriteDelayMs: z.number().int().nonnegative(),
  /** Last insert error ("" once a later insert succeeded). */
  lastError: z.string(),
  lastFlushAtIso: z.string().nullable(),
  /** Events the logger skipped because of sampling. */
  sampledOutCount: z.number().int().nonnegative(),
  /** Last report of each slipgate-net forwarder (one per host), newest first. */
  forwarders: z.array(
    SystemLogForwarderHealthSchema.extend({
      source: z.literal("net"),
      host: z.string(),
      reportedAtIso: z.string(),
    }),
  ),
});
export type SystemLogSinkHealth = z.infer<typeof SystemLogSinkHealthSchema>;

export const RUNTIME_LOG_STACKTRACE_LEVELS = ["none", "error"] as const;

/**
 * GET/PUT /api/v1/admin/ops/runtime/logging, POST …/reset. Applied immediately to the BFF and
 * picked up by slipgate-net (and the slipgate-core lines it forwards) within 30 s.
 */
export const RuntimeLogConfigSchema = z.object({
  /** Minimum level emitted (BFF console + storage) and forwarded (net, core). */
  level: SystemLogLevelSchema,
  /** Also store one info entry per BFF request (component "http.access"). */
  persistAccessLogs: z.boolean(),
  /** Per second and message: keep the first `samplingInitial`, then every `samplingThereafter`-th. */
  enableSampling: z.boolean(),
  samplingInitial: z.number().int().min(1).max(100_000),
  samplingThereafter: z.number().int().min(1).max(100_000),
  /** Record the calling source location in each stored BFF entry's context. */
  caller: z.boolean(),
  /** Attach error stack traces to stored error entries ("error") or never ("none"). */
  stacktraceLevel: z.enum(RUNTIME_LOG_STACKTRACE_LEVELS),
  /** Stored entries older than this are pruned (hourly). */
  retentionDays: z.number().int().min(1).max(3650),
  /** "baseline" = environment defaults (never changed or reset), "runtime_setting" = saved by an admin. */
  source: z.enum(["baseline", "runtime_setting"]),
  updatedAtIso: z.string().nullable(),
  /** User id of the admin who last saved or reset it. */
  updatedBy: z.string().nullable(),
});
export type RuntimeLogConfig = z.infer<typeof RuntimeLogConfigSchema>;

/** PUT body: any subset of the editable fields, merged over the current config. */
export const UpdateRuntimeLogConfigRequestSchema = RuntimeLogConfigSchema.pick({
  level: true,
  persistAccessLogs: true,
  enableSampling: true,
  samplingInitial: true,
  samplingThereafter: true,
  caller: true,
  stacktraceLevel: true,
  retentionDays: true,
}).partial();
export type UpdateRuntimeLogConfigRequest = z.infer<typeof UpdateRuntimeLogConfigRequestSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Internal ingest (slipgate-net → BFF, X-Slipgate-Internal-Token)                            */
/* ------------------------------------------------------------------------------------------ */

const ingestText = (max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ?? "").trim().slice(0, max));

export const SystemLogIngestEntrySchema = z.object({
  source: z.enum(["net", "core"]),
  timeIso: z.string().datetime({ offset: true }).optional(),
  /** Any common spelling (warning, err, fatal, …); unknown levels are stored as info. */
  level: z
    .string()
    .max(16)
    .transform((v) => normalizeSystemLogLevel(v) ?? "info"),
  component: ingestText(128),
  message: z.string().max(16_384),
  requestId: ingestText(128),
  clientRequestId: ingestText(128),
  userId: ingestText(64),
  apiKeyId: ingestText(64),
  accountId: ingestText(64),
  platform: ingestText(32),
  model: ingestText(128),
  context: z.record(z.unknown()).optional(),
});
export type SystemLogIngestEntry = z.infer<typeof SystemLogIngestEntrySchema>;

export const SYSTEM_LOG_INGEST_MAX_ENTRIES = 500;

/** POST /api/v1/internal/system-logs */
export const SystemLogIngestRequestSchema = z.object({
  host: ingestText(255),
  entries: z.array(SystemLogIngestEntrySchema).max(SYSTEM_LOG_INGEST_MAX_ENTRIES),
  health: SystemLogForwarderHealthSchema.optional(),
});
export type SystemLogIngestRequest = z.infer<typeof SystemLogIngestRequestSchema>;

export const SystemLogIngestResponseSchema = z.object({
  /** Entries queued for storage. */
  accepted: z.number().int().nonnegative(),
  /** Entries below the runtime level or not worth storing (info/debug outside audit). */
  filtered: z.number().int().nonnegative(),
  /** Entries refused because the BFF queue was full. */
  dropped: z.number().int().nonnegative(),
  config: RuntimeLogConfigSchema,
});
export type SystemLogIngestResponse = z.infer<typeof SystemLogIngestResponseSchema>;
