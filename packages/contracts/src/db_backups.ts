import { z } from "zod";
import { AdminStepUpSchema } from "./step_up.ts";

/*
 * Full database backups to S3-compatible storage (admin only): S3 target, cron schedule with
 * retention and monthly archive copies, history, download (signed, streamed through the BFF or
 * presigned) and restore (password / two-factor re-check plus a typed confirmation).
 */

/** Backup ids: `bk_` + 10 lowercase hex characters (what the restore confirmation asks to type). */
export const DB_BACKUP_ID_RE = /^bk_[0-9a-f]{10}$/;

/** Default prefix inside the bucket when none is configured. */
export const DB_BACKUP_DEFAULT_PREFIX = "backups";

const S3_PREFIX_RE = /^[A-Za-z0-9!_.*'()\-/]*$/;

export const BackupS3ConfigSchema = z.object({
  /** S3-compatible endpoint (`https://<account>.r2.cloudflarestorage.com`, `http://minio:9000`); "" = AWS S3. */
  endpoint: z.string().trim().max(512),
  /** "" = `us-east-1` (R2 uses `auto`). */
  region: z.string().trim().max(64),
  bucket: z.string().trim().max(255),
  accessKeyId: z.string().trim().max(256),
  /** Key prefix inside the bucket, without leading/trailing slashes; "" = `backups`. */
  prefix: z.string().trim().max(256),
  /** Path-style addressing (`endpoint/bucket/key`); off = virtual-hosted (`bucket.endpoint/key`). */
  forcePathStyle: z.boolean(),
});
export type BackupS3Config = z.infer<typeof BackupS3ConfigSchema>;

/** What GET returns: never the secret, only whether one is stored. */
export const BackupS3ConfigViewSchema = BackupS3ConfigSchema.extend({
  secretAccessKeySet: z.boolean(),
  /** bucket, access key id and secret are all present. */
  configured: z.boolean(),
});
export type BackupS3ConfigView = z.infer<typeof BackupS3ConfigViewSchema>;

export const DEFAULT_BACKUP_S3_CONFIG: BackupS3ConfigView = {
  endpoint: "",
  region: "",
  bucket: "",
  accessKeyId: "",
  prefix: "",
  forcePathStyle: true,
  secretAccessKeySet: false,
  configured: false,
};

/**
 * PUT body (and the connection-test body, which may carry unsaved values).
 * secretAccessKey: omitted = keep the stored one, "" = clear it, otherwise replace.
 */
export const UpdateBackupS3ConfigRequestSchema = BackupS3ConfigSchema.extend({
  secretAccessKey: z.string().max(512).optional(),
  /** Required to save (not to test): the target receives every future full-database dump. */
  confirm: AdminStepUpSchema.optional(),
}).superRefine((v, ctx) => {
  if (v.endpoint && !/^https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/i.test(v.endpoint)) {
    ctx.addIssue({ code: "custom", path: ["endpoint"], message: "Expected an http(s) URL" });
  }
  if (v.bucket && !/^[A-Za-z0-9._-]{1,255}$/.test(v.bucket)) {
    ctx.addIssue({ code: "custom", path: ["bucket"], message: "Bucket names use letters, digits, dots, hyphens and underscores" });
  }
  if (v.region && !/^[A-Za-z0-9-]{1,64}$/.test(v.region)) {
    ctx.addIssue({ code: "custom", path: ["region"], message: "Invalid region" });
  }
  if (!S3_PREFIX_RE.test(v.prefix) || v.prefix.split("/").some((seg) => seg === "." || seg === "..")) {
    ctx.addIssue({ code: "custom", path: ["prefix"], message: "Invalid key prefix" });
  }
});
export type UpdateBackupS3ConfigRequest = z.infer<typeof UpdateBackupS3ConfigRequestSchema>;

export const TestBackupS3RequestSchema = UpdateBackupS3ConfigRequestSchema;
export type TestBackupS3Request = z.infer<typeof TestBackupS3RequestSchema>;

/** The probe writes and deletes one small object, so it checks write and delete permission too. */
export const TestBackupS3ResponseSchema = z.object({
  ok: z.boolean(),
  /** Provider error text on failure (secrets scrubbed). */
  message: z.string(),
  /** `backup_s3_incomplete` | `backup_s3_error` on failure. */
  code: z.string().optional(),
});
export type TestBackupS3Response = z.infer<typeof TestBackupS3ResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Schedule, retention and monthly archive                                                    */
/* ------------------------------------------------------------------------------------------ */

export const BackupMonthlyArchiveConfigSchema = z.object({
  enabled: z.boolean(),
  /** Days of the month (1-31) whose scheduled backup is kept as an archive copy; 31 = last day in short months. */
  days: z.array(z.number().int().min(1).max(31)).max(31),
  includeMonthEnd: z.boolean(),
  /** Archive copies kept (newest first); 0 = keep forever. */
  retainCount: z.number().int().min(0).max(1000),
});
export type BackupMonthlyArchiveConfig = z.infer<typeof BackupMonthlyArchiveConfigSchema>;

export const BackupScheduleSchema = z.object({
  enabled: z.boolean(),
  /** Five-field cron (minute hour day-of-month month day-of-week), or @hourly/@daily/@weekly/@monthly/@yearly. */
  cronExpr: z.string().trim().max(120),
  /** IANA time zone the cron expression and archive dates are evaluated in. */
  timezone: z.string().trim().min(1).max(64),
  /** Scheduled backups older than this many days are deleted; 0 = no age limit. */
  retainDays: z.number().int().min(0).max(3650),
  /** Newest scheduled backups kept; 0 = no count limit. Archive copies are not counted. */
  retainCount: z.number().int().min(0).max(1000),
  monthlyArchive: BackupMonthlyArchiveConfigSchema,
});
export type BackupSchedule = z.infer<typeof BackupScheduleSchema>;

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  enabled: false,
  cronExpr: "0 3 * * *",
  timezone: "UTC",
  retainDays: 14,
  retainCount: 10,
  monthlyArchive: { enabled: false, days: [1], includeMonthEnd: false, retainCount: 12 },
};

/** PUT body: the whole schedule. Archive days are de-duplicated and sorted. */
export const UpdateBackupScheduleRequestSchema = BackupScheduleSchema.transform((v) => ({
  ...v,
  monthlyArchive: { ...v.monthlyArchive, days: [...new Set(v.monthlyArchive.days)].sort((a, b) => a - b) },
})).superRefine((v, ctx) => {
  if (v.enabled && !v.cronExpr) ctx.addIssue({ code: "custom", path: ["cronExpr"], message: "A cron expression is required when the schedule is on" });
  const a = v.monthlyArchive;
  if (a.enabled && a.days.length === 0 && !a.includeMonthEnd) {
    ctx.addIssue({ code: "custom", path: ["monthlyArchive", "days"], message: "Select at least one archive date" });
  }
});
export type UpdateBackupScheduleRequest = z.infer<typeof UpdateBackupScheduleRequestSchema>;

export const BackupScheduleViewSchema = BackupScheduleSchema.extend({
  /** Next scheduled run (null when the schedule is off or the expression never fires). */
  nextRunAtIso: z.string().nullable(),
});
export type BackupScheduleView = z.infer<typeof BackupScheduleViewSchema>;

/** Most upcoming runs GET /schedule/preview returns. */
export const DB_BACKUP_CRON_PREVIEW_MAX = 10;

/**
 * GET /schedule/preview?cronExpr=…&timezone=…&count=… (read-only, not audited): checks an unsaved
 * expression the same way PUT /schedule does and lists its next runs. Always 200; `valid` says
 * whether PUT would accept it, `error` / `message` say why not.
 */
export const BackupCronPreviewResponseSchema = z.object({
  valid: z.boolean(),
  error: z.enum(["backup_invalid_cron", "backup_invalid_timezone"]).nullable(),
  message: z.string(),
  /** Upcoming runs (UTC ISO), oldest first; empty when invalid or the expression never fires. */
  runsIso: z.array(z.string()),
});
export type BackupCronPreviewResponse = z.infer<typeof BackupCronPreviewResponseSchema>;

/* ------------------------------------------------------------------------------------------ */
/* Backup records                                                                             */
/* ------------------------------------------------------------------------------------------ */

export const BackupStatusSchema = z.enum(["pending", "running", "completed", "failed"]);
export type BackupStatus = z.infer<typeof BackupStatusSchema>;

export const BackupTriggerSchema = z.enum(["manual", "scheduled"]);
export type BackupTrigger = z.infer<typeof BackupTriggerSchema>;

/** Stage of a running backup ("" once it finished). */
export const BackupProgressSchema = z.enum(["", "pending", "dumping", "compressing", "uploading"]);
export type BackupProgress = z.infer<typeof BackupProgressSchema>;

/** Restore state of a backup ("" = never restored). */
export const BackupRestoreStatusSchema = z.enum(["", "running", "completed", "failed"]);
export type BackupRestoreStatus = z.infer<typeof BackupRestoreStatusSchema>;

/** One stored object of a backup: the gzip archive split at the part size (one part for most backups). */
export const BackupPartSchema = z.object({
  index: z.number().int().min(1),
  s3Key: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  /** Hex SHA-256 of the part's bytes (verified before a restore). */
  sha256: z.string(),
});
export type BackupPart = z.infer<typeof BackupPartSchema>;

export const BackupMonthlyArchiveSchema = z.object({
  /** Archive dates (YYYY-MM-DD, schedule time zone) this backup stands for. */
  dates: z.array(z.string()),
  /** Archive pool size when it was archived; 0 = kept forever. */
  retainCount: z.number().int().nonnegative(),
});
export type BackupMonthlyArchive = z.infer<typeof BackupMonthlyArchiveSchema>;

export const BackupRecordSchema = z.object({
  id: z.string(),
  status: BackupStatusSchema,
  backupType: z.literal("postgres"),
  triggeredBy: BackupTriggerSchema,
  /** Admin who started a manual backup; null for scheduled ones. */
  createdBy: z.string().nullable(),
  /** Download name of the whole archive (`.sql.gz`: plain pg_dump output, gzip). */
  fileName: z.string(),
  /** Object key of a single-part backup; "" when it is split into several parts. */
  s3Key: z.string(),
  parts: z.array(BackupPartSchema),
  sizeBytes: z.number().int().nonnegative(),
  progress: BackupProgressSchema,
  errorMessage: z.string(),
  startedAtIso: z.string(),
  finishedAtIso: z.string().nullable(),
  /** When it is deleted automatically; null = never (or kept by the schedule's retention / archive). */
  expiresAtIso: z.string().nullable(),
  /** Cron slot a scheduled backup ran for. */
  scheduledForIso: z.string().nullable(),
  restoreStatus: BackupRestoreStatusSchema,
  restoreStartedAtIso: z.string().nullable(),
  restoreError: z.string(),
  restoredAtIso: z.string().nullable(),
  restoredBy: z.string().nullable(),
  /** Set when kept as a monthly archive copy (protected from ordinary deletion). */
  monthlyArchive: BackupMonthlyArchiveSchema.nullable(),
});
export type BackupRecord = z.infer<typeof BackupRecordSchema>;

export const BackupListResponseSchema = z.object({ items: z.array(BackupRecordSchema) });
export type BackupListResponse = z.infer<typeof BackupListResponseSchema>;

export const CreateBackupRequestSchema = z.object({
  /** Days until this manual backup is deleted automatically; 0 = never. */
  expireDays: z.number().int().min(0).max(3650).default(14),
});
export type CreateBackupRequest = z.infer<typeof CreateBackupRequestSchema>;

/** Re-authentication for download and restore: the admin's password, plus the 2FA code when 2FA is on. */
export const BackupStepUpRequestSchema = AdminStepUpSchema;
export type BackupStepUpRequest = z.infer<typeof BackupStepUpRequestSchema>;

export const BackupDownloadRequestSchema = BackupStepUpRequestSchema;
export type BackupDownloadRequest = z.infer<typeof BackupDownloadRequestSchema>;

export const BackupDownloadPartSchema = z.object({
  index: z.number().int().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string(),
  /** Signed, short-lived link streamed through the console (`/api/v1/db-backups/download/<ticket>`); no auth header needed. */
  url: z.string(),
  /** Presigned link straight to the bucket (only useful when the browser can reach the endpoint). */
  presignedUrl: z.string().nullable(),
  /** Name to save this part as (`<fileName>` or `<fileName>.part-000001`). */
  fileName: z.string(),
});
export type BackupDownloadPart = z.infer<typeof BackupDownloadPartSchema>;

export const BackupDownloadResponseSchema = z.object({
  backupId: z.string(),
  /** Name of the whole archive; parts concatenate (in index order) into it. */
  fileName: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  expiresAtIso: z.string(),
  parts: z.array(BackupDownloadPartSchema).min(1),
});
export type BackupDownloadResponse = z.infer<typeof BackupDownloadResponseSchema>;

/** Restore replaces the whole database. `confirm` must be the backup's id, typed by the admin. */
export const RestoreBackupRequestSchema = BackupStepUpRequestSchema.extend({
  confirm: z.string().trim().min(1).max(64),
});
export type RestoreBackupRequest = z.infer<typeof RestoreBackupRequestSchema>;

export const BackupUnsupportedReasonSchema = z.enum(["memory_store", "tool_missing", "version_mismatch", "check_failed"]);
export type BackupUnsupportedReason = z.infer<typeof BackupUnsupportedReasonSchema>;

/** Stage of the running operation: a backup's stages, or a restore's downloading → restoring. */
export const BackupOperationStageSchema = z.enum(["", "pending", "dumping", "compressing", "uploading", "downloading", "restoring"]);
export type BackupOperationStage = z.infer<typeof BackupOperationStageSchema>;

export const BackupActiveOperationSchema = z.object({
  kind: z.enum(["backup", "restore"]),
  backupId: z.string(),
  progress: BackupOperationStageSchema,
  startedAtIso: z.string(),
});
export type BackupActiveOperation = z.infer<typeof BackupActiveOperationSchema>;

/** GET /status: cheap, safe to poll (answers from memory while a restore holds the database). */
export const BackupSystemStatusSchema = z.object({
  /** Backups can run here (Postgres store with pg_dump/psql available, or a test runner). */
  supported: z.boolean(),
  reason: BackupUnsupportedReasonSchema.nullable(),
  /** Tool version line, or why it is unsupported. */
  detail: z.string(),
  s3Configured: z.boolean(),
  /** The backup or restore this instance is running right now. */
  activeOperation: BackupActiveOperationSchema.nullable(),
  schedule: z.object({ enabled: z.boolean(), nextRunAtIso: z.string().nullable() }),
});
export type BackupSystemStatus = z.infer<typeof BackupSystemStatusSchema>;

/** `error` codes the /api/v1/admin/db-backups routes answer with (besides `bad_request`). */
export const DB_BACKUP_ERROR_CODES = [
  "backup_unsupported",
  "backup_tool_unavailable",
  "backup_s3_not_configured",
  "backup_s3_error",
  "backup_in_progress",
  "restore_in_progress",
  "backup_not_found",
  "backup_not_completed",
  "backup_archive_protected",
  "backup_invalid_cron",
  "backup_invalid_timezone",
  "backup_corrupt",
  "invalid_password",
  "too_many_attempts",
  "totp_required",
  "invalid_totp",
  "confirm_mismatch",
  "download_link_invalid",
] as const;
export type DbBackupErrorCode = (typeof DB_BACKUP_ERROR_CODES)[number];
