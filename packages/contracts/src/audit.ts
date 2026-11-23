import { z } from "zod";

/**
 * Audit-log maintenance: the guarded clear and the retention sweeper.
 *
 * Leaf module (zod only); the retention period itself is the portal setting
 * `auditLogRetentionDays` (commerce.ts), 0 = keep forever.
 */

export const AUDIT_LOG_RETENTION_DEFAULT_DAYS = 180;
export const AUDIT_LOG_RETENTION_MAX_DAYS = 3650;

export const AuditLogRetentionDaysSchema = z.number().int().min(0).max(AUDIT_LOG_RETENTION_MAX_DAYS);

/**
 * Whether going from `current` to `next` retention days keeps fewer entries (0 = forever, so any
 * period below it shortens). Shortening deletes history, so it needs the same fresh two-factor
 * code as a clear.
 */
export function auditRetentionShortens(current: number, next: number): boolean {
  const keep = (days: number) => (days > 0 ? days : Number.POSITIVE_INFINITY);
  return keep(next) < keep(current);
}

/**
 * The fresh two-factor code every destructive audit-log action carries (Linksyncx AuditLogHandler:
 * code only, verified on every call, never covered by an earlier sign-in or step-up).
 *
 * Refusals (all JSON `{ error, message }`):
 * - 403 `totp_not_enabled`: the administrator has not turned on two-factor authentication.
 * - 403 `totp_required`: no code was sent.
 * - 403 `invalid_totp`: wrong, expired or already used (the per-user replay guard refuses a step
 *   accepted before, the sign-in one included).
 * - 429 `too_many_attempts` (Retry-After): too many codes tried in 5 minutes.
 */
export const AuditTotpCodeSchema = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");

export const AUDIT_STEP_UP_ERRORS = ["totp_not_enabled", "totp_required", "invalid_totp", "too_many_attempts"] as const;
export type AuditStepUpError = (typeof AUDIT_STEP_UP_ERRORS)[number];

/** POST /api/v1/admin/audit-logs/clear. A password is never accepted. */
export const AuditClearRequestSchema = z.object({ totpCode: AuditTotpCodeSchema.optional() });
export type AuditClearRequest = z.infer<typeof AuditClearRequestSchema>;

export const AuditClearResponseSchema = z.object({ deleted: z.number().int().nonnegative() });
export type AuditClearResponse = z.infer<typeof AuditClearResponseSchema>;

/** GET/PUT /api/v1/admin/audit-logs/retention, POST …/retention/run. */
export const AuditRetentionStatusSchema = z.object({
  /** Current setting; 0 keeps the log forever (only a manual clear removes rows). */
  retentionDays: AuditLogRetentionDaysSchema,
  /** A sweep is running in this BFF instance. */
  running: z.boolean(),
  lastRunAtIso: z.string().nullable(),
  /** Rows the last sweep of this instance removed. */
  lastDeleted: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  /** When this instance sweeps next (null while the scheduler is off, e.g. in tests). */
  nextRunAtIso: z.string().nullable(),
});
export type AuditRetentionStatus = z.infer<typeof AuditRetentionStatusSchema>;

/**
 * PUT /api/v1/admin/audit-logs/retention. `totpCode` is required when the change shortens the
 * period (auditRetentionShortens); keeping entries longer needs none.
 */
export const UpdateAuditRetentionRequestSchema = z.object({
  retentionDays: AuditLogRetentionDaysSchema,
  totpCode: AuditTotpCodeSchema.optional(),
});
export type UpdateAuditRetentionRequest = z.infer<typeof UpdateAuditRetentionRequestSchema>;

/** POST /api/v1/admin/audit-logs/retention/run: always needs a fresh code. */
export const AuditRetentionRunRequestSchema = z.object({ totpCode: AuditTotpCodeSchema.optional() });
export type AuditRetentionRunRequest = z.infer<typeof AuditRetentionRunRequestSchema>;

/** One sweep's outcome. */
export const AuditRetentionRunSchema = z.object({
  retentionDays: z.number().int().nonnegative(),
  /** Retention is off (0 days): nothing was looked at. */
  skipped: z.boolean(),
  deleted: z.number().int().nonnegative(),
});
export type AuditRetentionRun = z.infer<typeof AuditRetentionRunSchema>;

/** POST /api/v1/admin/audit-logs/retention/run: the status after the sweep plus its outcome. */
export const AuditRetentionRunResponseSchema = AuditRetentionStatusSchema.extend({ run: AuditRetentionRunSchema });
export type AuditRetentionRunResponse = z.infer<typeof AuditRetentionRunResponseSchema>;
