import { z } from "zod";

/**
 * Alert Rules, Events, Silences & Email Notifications (Lane O2).
 *
 * Metrics:
 *   - error_rate: percentage 0..100 (e.g. 5 means 5%) over `windowMinutes`
 *   - latency_p95: P95 duration in milliseconds over `windowMinutes`
 *   - account_unhealthy: count of upstream accounts whose effectiveStatus !== 'active'
 *   - request_errors_count: count of unresolved request errors in `windowMinutes`
 *   - dead_letter_count: count of parked settlement dead-letters in slipgate-net
 *
 * Pure ESM/Zod leaf module (no Node/Bun APIs).
 */

export const ALERT_METRICS = [
  "error_rate",
  "latency_p95",
  "account_unhealthy",
  "request_errors_count",
  "dead_letter_count",
] as const;
export const AlertMetricSchema = z.enum(ALERT_METRICS);
export type AlertMetric = z.infer<typeof AlertMetricSchema>;

export const ALERT_OPERATORS = ["gt", "gte", "lt", "lte"] as const;
export const AlertOperatorSchema = z.enum(ALERT_OPERATORS);
export type AlertOperator = z.infer<typeof AlertOperatorSchema>;

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export const AlertSeveritySchema = z.enum(ALERT_SEVERITIES);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const ALERT_EVENT_STATUSES = ["firing", "resolved", "silenced"] as const;
export const AlertEventStatusSchema = z.enum(ALERT_EVENT_STATUSES);
export type AlertEventStatus = z.infer<typeof AlertEventStatusSchema>;

const optScopeText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const AlertScopeSchema = z
  .object({
    platform: optScopeText(64),
    accountId: optScopeText(64),
    groupId: optScopeText(64),
    model: optScopeText(160),
  })
  .default({});
export type AlertScope = z.infer<typeof AlertScopeSchema>;

const EmailListSchema = z
  .array(z.string().trim().email().max(254))
  .max(20)
  .default([]);

export const AlertRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  metric: AlertMetricSchema,
  operator: AlertOperatorSchema,
  threshold: z.number(),
  windowMinutes: z.number().int().positive(),
  cooldownMinutes: z.number().int().nonnegative(),
  severity: AlertSeveritySchema,
  scope: AlertScopeSchema,
  notifyEmails: z.array(z.string()),
  createdBy: z.string(),
  lastEvaluatedAtIso: z.string().nullable(),
  lastTriggeredAtIso: z.string().nullable(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export const CreateAlertRuleRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).default(""),
  enabled: z.boolean().default(true),
  metric: AlertMetricSchema,
  operator: AlertOperatorSchema.default("gte"),
  threshold: z.coerce.number().finite().min(0).max(1_000_000_000),
  windowMinutes: z.coerce.number().int().min(1).max(10_080).default(15),
  cooldownMinutes: z.coerce.number().int().min(0).max(10_080).default(30),
  severity: AlertSeveritySchema.default("warning"),
  scope: AlertScopeSchema,
  notifyEmails: EmailListSchema,
});
export type CreateAlertRuleRequest = z.infer<typeof CreateAlertRuleRequestSchema>;

export const UpdateAlertRuleRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).optional(),
  enabled: z.boolean().optional(),
  metric: AlertMetricSchema.optional(),
  operator: AlertOperatorSchema.optional(),
  threshold: z.coerce.number().finite().min(0).max(1_000_000_000).optional(),
  windowMinutes: z.coerce.number().int().min(1).max(10_080).optional(),
  cooldownMinutes: z.coerce.number().int().min(0).max(10_080).optional(),
  severity: AlertSeveritySchema.optional(),
  scope: AlertScopeSchema.optional(),
  notifyEmails: EmailListSchema.optional(),
});
export type UpdateAlertRuleRequest = z.infer<typeof UpdateAlertRuleRequestSchema>;

export const AlertEventSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string(),
  metric: AlertMetricSchema,
  severity: AlertSeveritySchema,
  status: AlertEventStatusSchema,
  observedValue: z.number(),
  threshold: z.number(),
  message: z.string(),
  details: z.record(z.unknown()),
  notified: z.boolean(),
  notifyError: z.string(),
  firedAtIso: z.string(),
  resolvedAtIso: z.string().nullable(),
  acknowledgedBy: z.string(),
  acknowledgedAtIso: z.string().nullable(),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;

export const AlertEventQuerySchema = z.object({
  ruleId: optScopeText(64),
  status: AlertEventStatusSchema.optional().or(z.literal("").transform(() => undefined)),
  severity: AlertSeveritySchema.optional().or(z.literal("").transform(() => undefined)),
  page: z.coerce.number().int().min(1).max(100_000).catch(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(20).default(20),
});
export type AlertEventQuery = z.infer<typeof AlertEventQuerySchema>;

export const AlertEventListResponseSchema = z.object({
  items: z.array(AlertEventSchema),
  total: z.number().int().nonnegative(),
  firingCount: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type AlertEventListResponse = z.infer<typeof AlertEventListResponseSchema>;

export const AlertSilenceSchema = z.object({
  id: z.string(),
  ruleId: z.string().nullable(),
  ruleName: z.string().default(""),
  reason: z.string(),
  startsAtIso: z.string(),
  endsAtIso: z.string(),
  createdBy: z.string(),
  createdAtIso: z.string(),
});
export type AlertSilence = z.infer<typeof AlertSilenceSchema>;

const isoInstant = z.string().datetime({ offset: true });

export const CreateAlertSilenceRequestSchema = z
  .object({
    ruleId: z
      .string()
      .trim()
      .max(64)
      .nullable()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : null)),
    reason: z.string().trim().max(300).default(""),
    startsAtIso: isoInstant.optional(),
    endsAtIso: isoInstant,
  })
  .refine(
    (s) => {
      const start = s.startsAtIso ? Date.parse(s.startsAtIso) : Date.now();
      return Date.parse(s.endsAtIso) > start;
    },
    { message: "endsAtIso must be after startsAtIso", path: ["endsAtIso"] },
  );
export type CreateAlertSilenceRequest = z.infer<typeof CreateAlertSilenceRequestSchema>;

export const AlertEvaluateResponseSchema = z.object({
  evaluated: z.number().int().nonnegative(),
  fired: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  silenced: z.number().int().nonnegative(),
});
export type AlertEvaluateResponse = z.infer<typeof AlertEvaluateResponseSchema>;
