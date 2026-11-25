import { z } from "zod";

/**
 * Request & Upstream Error Center (Lane O1).
 *
 * Captures per-request failures across ingress validation, core policy/ledger evaluation,
 * outbound execution, upstream HTTP error responses, and stream interruption without
 * storing sensitive credentials.
 *
 * Pure ESM/Zod leaf module (no Node/Bun APIs).
 */

export const REQUEST_ERROR_PHASES = [
  "ingress",
  "core_eval",
  "outbound",
  "upstream_http",
  "stream_relay",
  "other",
] as const;
export const RequestErrorPhaseSchema = z.enum(REQUEST_ERROR_PHASES);
export type RequestErrorPhase = z.infer<typeof RequestErrorPhaseSchema>;

export const REQUEST_ERROR_TIME_RANGES = ["5m", "30m", "1h", "6h", "24h", "7d", "30d"] as const;
export const RequestErrorTimeRangeSchema = z.enum(REQUEST_ERROR_TIME_RANGES);
export type RequestErrorTimeRange = z.infer<typeof RequestErrorTimeRangeSchema>;

export const REQUEST_ERROR_TIME_RANGE_MS: Record<RequestErrorTimeRange, number> = {
  "5m": 5 * 60_000,
  "30m": 30 * 60_000,
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export const REQUEST_ERROR_DEFAULT_TIME_RANGE: RequestErrorTimeRange = "24h";
export const REQUEST_ERROR_DEFAULT_PAGE_SIZE = 20;
export const REQUEST_ERROR_MAX_PAGE_SIZE = 200;

export const RequestErrorItemSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  clientRequestId: z.string(),
  userId: z.string().nullable(),
  userEmail: z.string().default(""),
  apiKeyId: z.string().nullable(),
  accountId: z.string().nullable(),
  accountName: z.string().default(""),
  groupId: z.string().nullable(),
  groupName: z.string().default(""),
  platform: z.string(),
  model: z.string(),
  upstreamModel: z.string(),
  phase: RequestErrorPhaseSchema,
  kind: z.string(),
  statusCode: z.number().int(),
  upstreamStatus: z.number().int(),
  errorType: z.string(),
  errorCode: z.string(),
  errorMessage: z.string(),
  upstreamBody: z.string(),
  attempt: z.number().int().positive(),
  failoverUsed: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  executionMode: z.string(),
  metadata: z.record(z.unknown()),
  resolved: z.boolean(),
  resolvedAtIso: z.string().nullable(),
  resolvedBy: z.string(),
  createdAtIso: z.string(),
});
export type RequestErrorItem = z.infer<typeof RequestErrorItemSchema>;

const optionalIdField = z
  .string()
  .trim()
  .max(128)
  .nullable()
  .optional()
  .transform((v) => (v && v.length > 0 ? v : null));

export const IngestRequestErrorItemSchema = z.object({
  requestId: z.string().trim().max(128).default(""),
  clientRequestId: z.string().trim().max(128).default(""),
  userId: optionalIdField,
  apiKeyId: optionalIdField,
  accountId: optionalIdField,
  groupId: optionalIdField,
  platform: z.string().trim().max(64).default(""),
  model: z.string().trim().max(160).default(""),
  upstreamModel: z.string().trim().max(160).default(""),
  phase: RequestErrorPhaseSchema.catch("other").default("other"),
  kind: z.string().trim().max(128).default(""),
  statusCode: z.coerce.number().int().min(0).max(999).default(500),
  upstreamStatus: z.coerce.number().int().min(0).max(999).default(0),
  errorType: z.string().trim().max(128).default(""),
  errorCode: z.string().trim().max(128).default(""),
  errorMessage: z.string().max(16_384).default(""),
  upstreamBody: z.string().max(65_536).default(""),
  attempt: z.coerce.number().int().min(1).max(100).default(1),
  failoverUsed: z.boolean().default(false),
  durationMs: z.coerce.number().int().min(0).max(86_400_000).default(0),
  executionMode: z.string().trim().max(64).default(""),
  metadata: z.record(z.unknown()).default({}),
  createdAtIso: z.string().datetime({ offset: true }).optional(),
});
export type IngestRequestErrorItem = z.infer<typeof IngestRequestErrorItemSchema>;

export const IngestRequestErrorsBatchSchema = z.object({
  items: z.array(IngestRequestErrorItemSchema).min(1).max(200),
});
export type IngestRequestErrorsBatch = z.infer<typeof IngestRequestErrorsBatchSchema>;

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

export const RequestErrorStatusClassSchema = z.enum(["4xx", "5xx", "upstream"]);
export type RequestErrorStatusClass = z.infer<typeof RequestErrorStatusClassSchema>;

export const RequestErrorResolvedFilterSchema = z.enum(["all", "open", "resolved"]);
export type RequestErrorResolvedFilter = z.infer<typeof RequestErrorResolvedFilterSchema>;

export const RequestErrorQuerySchema = z
  .object({
    phase: optionalEnum(RequestErrorPhaseSchema),
    statusCode: z
      .string()
      .trim()
      .regex(/^\d{3}$/)
      .optional()
      .or(z.literal("").transform(() => undefined)),
    statusClass: optionalEnum(RequestErrorStatusClassSchema),
    accountId: filterText(64),
    userId: filterText(64),
    apiKeyId: filterText(64),
    groupId: filterText(64),
    platform: filterText(64),
    model: filterText(160),
    /** Case-insensitive substring of the model (the usage page's model filter); `model` is exact. */
    modelContains: filterText(160),
    requestId: filterText(128),
    resolved: RequestErrorResolvedFilterSchema.optional().catch("all").default("all"),
    q: filterText(200),
    timeRange: RequestErrorTimeRangeSchema.optional(),
    sinceIso: isoInstant,
    untilIso: isoInstant,
    page: z.coerce.number().int().min(1).max(100_000).catch(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(REQUEST_ERROR_MAX_PAGE_SIZE)
      .catch(REQUEST_ERROR_DEFAULT_PAGE_SIZE)
      .default(REQUEST_ERROR_DEFAULT_PAGE_SIZE),
  })
  .refine((q) => !q.sinceIso || !q.untilIso || Date.parse(q.sinceIso) <= Date.parse(q.untilIso), {
    message: "sinceIso must not be after untilIso",
    path: ["sinceIso"],
  });
export type RequestErrorQuery = z.infer<typeof RequestErrorQuerySchema>;

export const RequestErrorSummaryQuerySchema = z
  .object({
    timeRange: RequestErrorTimeRangeSchema.optional(),
    sinceIso: isoInstant,
    untilIso: isoInstant,
  })
  .refine((q) => !q.sinceIso || !q.untilIso || Date.parse(q.sinceIso) <= Date.parse(q.untilIso), {
    message: "sinceIso must not be after untilIso",
    path: ["sinceIso"],
  });
export type RequestErrorSummaryQuery = z.infer<typeof RequestErrorSummaryQuerySchema>;

export const RequestErrorPhaseCountSchema = z.object({
  phase: RequestErrorPhaseSchema,
  count: z.number().int().nonnegative(),
});

export const RequestErrorModelCountSchema = z.object({
  model: z.string(),
  count: z.number().int().nonnegative(),
});

export const RequestErrorAccountCountSchema = z.object({
  accountId: z.string(),
  accountName: z.string(),
  count: z.number().int().nonnegative(),
});

export const RequestErrorSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  openCount: z.number().int().nonnegative(),
  resolvedCount: z.number().int().nonnegative(),
  status4xx: z.number().int().nonnegative(),
  status5xx: z.number().int().nonnegative(),
  byPhase: z.array(RequestErrorPhaseCountSchema),
  topModels: z.array(RequestErrorModelCountSchema),
  topAccounts: z.array(RequestErrorAccountCountSchema),
  sinceIso: z.string(),
  untilIso: z.string(),
});
export type RequestErrorSummary = z.infer<typeof RequestErrorSummarySchema>;

export const RequestErrorListResponseSchema = z.object({
  items: z.array(RequestErrorItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  sinceIso: z.string(),
  untilIso: z.string(),
});
export type RequestErrorListResponse = z.infer<typeof RequestErrorListResponseSchema>;

export const ResolveRequestErrorRequestSchema = z.object({
  resolved: z.boolean().default(true),
});
export type ResolveRequestErrorRequest = z.infer<typeof ResolveRequestErrorRequestSchema>;

export const RequestErrorCleanupRequestSchema = z
  .object({
    olderThanDays: z.coerce.number().int().min(1).max(3650).optional(),
    beforeIso: isoInstant,
    phase: optionalEnum(RequestErrorPhaseSchema),
    statusCode: z.coerce.number().int().min(100).max(599).optional(),
    resolvedOnly: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.olderThanDays !== undefined ||
      v.beforeIso !== undefined ||
      v.phase !== undefined ||
      v.statusCode !== undefined ||
      v.resolvedOnly === true,
    { message: "Cleanup requires at least one constraint" },
  );
export type RequestErrorCleanupRequest = z.infer<typeof RequestErrorCleanupRequestSchema>;

export const RequestErrorCleanupResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
});
export type RequestErrorCleanupResponse = z.infer<typeof RequestErrorCleanupResponseSchema>;
