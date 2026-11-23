import {
  DB_BACKUP_ERROR_CODES,
  type BackupOperationStage,
  type BackupRecord,
  type BackupStatus,
} from "@slipgate/contracts";
import { i18n } from "../../../i18n";
import { ApiError, errorText } from "../../../lib/api";
import { formatDateShort, type Tone } from "../../../lib/format";

/** Admin routes of the database backup feature. */
export const DB_BACKUP_API = "/api/v1/admin/db-backups";

/** Codes with their own copy; anything else shows the server's message. */
const KNOWN_CODES = new Set<string>([...DB_BACKUP_ERROR_CODES, "backup_s3_incomplete"]);

/** The server message only (no generic HTTP fallback), for `{detail}` in the friendly copy. */
function serverDetail(err: unknown): string {
  return err instanceof Error ? err.message : "";
}

/**
 * Friendly text for a failed backup call: the error code's copy (with the server's detail where
 * it helps, e.g. the provider error), falling back to the server message, then `fallback`.
 */
export function backupErrorText(err: unknown, fallback: string): string {
  const t = i18n.global.t;
  if (err instanceof ApiError) {
    if (err.code && KNOWN_CODES.has(err.code)) return t(`dbBackups.errors.${err.code}`, { detail: serverDetail(err) });
    if (err.status === 429) return t("dbBackups.errors.too_many_attempts");
  }
  return errorText(err, fallback);
}

/** Copy for a code returned inside a 200 body (connection test, cron preview). */
export function backupCodeText(code: string | null | undefined, detail: string, fallback: string): string {
  if (code && KNOWN_CODES.has(code)) return i18n.global.t(`dbBackups.errors.${code}`, { detail });
  return detail || fallback;
}

/* ---------------- Records ---------------- */

export const STATUS_TONE: Record<BackupStatus, Tone> = {
  pending: "info",
  running: "info",
  completed: "success",
  failed: "danger",
};

/** Stages shown in the live stepper (a backup's "pending" comes before the first one). */
export const BACKUP_STAGES: BackupOperationStage[] = ["dumping", "compressing", "uploading"];
export const RESTORE_STAGES: BackupOperationStage[] = ["downloading", "restoring"];

export function isBusy(r: BackupRecord): boolean {
  return r.status === "running" || r.status === "pending" || r.restoreStatus === "running";
}

/** Status text; a running backup shows its stage (the live one from /status when known). */
export function statusText(r: BackupRecord, liveStage?: BackupOperationStage | null): string {
  const t = i18n.global.t;
  if (r.status === "running") {
    const stage = liveStage || r.progress;
    if (stage) return t(`dbBackups.stages.${stage}`);
  }
  return t(`dbBackups.status.${r.status}`);
}

/** How long a record is kept: its own expiry, the schedule's retention, or its archive pool. */
export function retentionText(r: BackupRecord): string {
  const t = i18n.global.t;
  if (r.monthlyArchive) {
    return r.monthlyArchive.retainCount === 0
      ? t("dbBackups.history.archiveForever")
      : t("dbBackups.history.archivePool", { n: r.monthlyArchive.retainCount });
  }
  if (r.expiresAtIso) return t("dbBackups.history.expires", { date: formatDateShort(r.expiresAtIso) });
  return r.triggeredBy === "scheduled" ? t("dbBackups.history.bySchedule") : t("dbBackups.history.never");
}

/** Who started it: "You", the schedule, or the admin id. */
export function actorText(id: string | null, meId: string | null | undefined): string {
  const t = i18n.global.t;
  if (!id) return t("dbBackups.detail.system");
  return id === meId ? t("dbBackups.detail.you") : id;
}

/** 1536 → "1.5 KB", up to TB (base 1024). */
export function formatSize(bytes: number | null | undefined): string {
  const n = Math.max(0, bytes ?? 0);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** 2026-11-22 03:00 in local time. */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Elapsed ms between two ISO stamps (or until `nowMs` when `to` is null). */
export function spanMs(from: string | null | undefined, to: string | null | undefined, nowMs = Date.now()): number | null {
  const a = from ? Date.parse(from) : NaN;
  if (!Number.isFinite(a)) return null;
  const b = to ? Date.parse(to) : nowMs;
  return Number.isFinite(b) ? Math.max(0, b - a) : null;
}

/** "45s" / "3m 05s" / "1h 02m" for operation timings. */
export function formatElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/* ---------------- Schedule ---------------- */

/** Monthly archive form state: `forever` stands for the wire value retainCount = 0. */
export interface ArchiveDraft {
  enabled: boolean;
  days: number[];
  includeMonthEnd: boolean;
  forever: boolean;
  /** Typed archive pool size (kept while "forever" is chosen, so switching back restores it). */
  count: number | string;
}

export interface CronPreset {
  key: "hourly" | "every6h" | "daily" | "weekly" | "monthly";
  expr: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { key: "daily", expr: "0 3 * * *" },
  { key: "every6h", expr: "0 */6 * * *" },
  { key: "hourly", expr: "0 * * * *" },
  { key: "weekly", expr: "0 3 * * 0" },
  { key: "monthly", expr: "0 3 1 * *" },
];

const FALLBACK_ZONES = [
  "UTC",
  "Asia/Shanghai",
  "Asia/Hong_Kong",
  "Asia/Taipei",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Australia/Sydney",
];

let zoneCache: string[] | null = null;

/** IANA zones the browser knows (UTC first). */
export function timeZones(): string[] {
  if (zoneCache) return zoneCache;
  let list: string[] = [];
  try {
    list = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    list = [];
  }
  if (list.length === 0) list = FALLBACK_ZONES;
  zoneCache = ["UTC", ...list.filter((z) => z !== "UTC")];
  return zoneCache;
}

/** Whether the browser accepts `zone` (the server has the final say). */
export function isKnownZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "11-22 周日 03:00" in `zone`, in the active locale. */
export function formatInZone(iso: string, zone: string): string {
  try {
    return new Intl.DateTimeFormat(i18n.global.locale.value, {
      timeZone: zone,
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  } catch {
    return formatStamp(iso);
  }
}
