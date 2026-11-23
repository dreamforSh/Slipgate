import type { BackupRecord, BackupS3Config, BackupSchedule } from "@slipgate/contracts";

/** The S3 target as persisted: plain fields plus the AES-GCM sealed secret access key. */
export interface StoredBackupS3Config extends BackupS3Config {
  secretEnc: Uint8Array | null;
}

export interface DbBackupConfigState {
  /** null until an admin saved one. */
  s3: StoredBackupS3Config | null;
  /** null = DEFAULT_BACKUP_SCHEDULE. */
  schedule: BackupSchedule | null;
  /** Last archive date (YYYY-MM-DD) the monthly-archive rule was evaluated for; "" = never. */
  archiveCheckpoint: string;
}

/** Fields a running backup / restore may change. */
export type BackupRecordPatch = Partial<
  Pick<
    BackupRecord,
    | "status"
    | "fileName"
    | "s3Key"
    | "parts"
    | "sizeBytes"
    | "progress"
    | "errorMessage"
    | "finishedAtIso"
    | "expiresAtIso"
    | "restoreStatus"
    | "restoreStartedAtIso"
    | "restoreError"
    | "restoredAtIso"
    | "restoredBy"
    | "monthlyArchive"
  >
>;

/** Everything that describes the objects in the bucket: kept across a database restore. */
export interface BackupCatalogue {
  config: DbBackupConfigState;
  records: BackupRecord[];
}

export type BeginRestoreResult =
  | { ok: true; record: BackupRecord }
  | { ok: false; reason: "not_found" | "not_completed" | "restore_running" };

/** Upper bound of records read for the history list and the retention walk. */
export const DB_BACKUP_MAX_RECORDS = 2000;

/**
 * Persistence of full-database backups. The memory store implements the same semantics (so the
 * catalogue, schedule and lock behave identically in tests) but cannot be dumped: dumpTarget() is
 * null there and the service reports backups as unsupported unless a test runner is injected.
 */
export interface DbBackupStore {
  readonly kind: "memory" | "postgres";
  /** Connection the dump tools use; null when this store cannot be dumped (memory). */
  dumpTarget(): { databaseUrl: string } | null;
  /** server_version_num of the database (e.g. 170002); null for memory. */
  serverVersionNum(): Promise<number | null>;
  /** Re-applies this feature's DDL (after a restore from an older dump). */
  ensureSchema(): Promise<void>;

  getConfig(): Promise<DbBackupConfigState>;
  saveS3Config(cfg: StoredBackupS3Config): Promise<void>;
  saveSchedule(schedule: BackupSchedule): Promise<void>;

  /** Newest first (started desc, id desc), at most `limit` rows. */
  listRecords(limit: number): Promise<BackupRecord[]>;
  getRecord(id: string): Promise<BackupRecord | null>;
  /** false (nothing written) when a scheduled backup for the same cron slot already exists. */
  insertRecord(record: BackupRecord): Promise<boolean>;
  /** null when the record no longer exists. */
  updateRecord(id: string, patch: BackupRecordPatch): Promise<BackupRecord | null>;
  /**
   * Applies the completion patch and, when `archiveCheckpoint` is set, advances the monthly-archive
   * checkpoint in the same transaction (a retry can neither skip nor repeat an archive date).
   */
  completeRecord(id: string, patch: BackupRecordPatch, archiveCheckpoint: string | null): Promise<BackupRecord | null>;
  /** Deletes the record unless a restore of it is running; false when nothing was deleted. */
  deleteRecord(id: string): Promise<boolean>;
  /** Atomically marks a completed, not-restoring backup as restoring. */
  beginRestore(id: string, nowIso: string, actorId: string): Promise<BeginRestoreResult>;
  /** Unfinished backups and running restores become failed (their owner is gone); returns the ids. */
  failInterrupted(nowIso: string, backupMessage: string, restoreMessage: string): Promise<{ backups: string[]; restores: string[] }>;
  /** The one backup/restore lock shared by every instance; null when someone else holds it. */
  tryAcquireOpLock(): Promise<(() => Promise<void>) | null>;
  snapshotCatalogue(): Promise<BackupCatalogue>;
  /** Replaces every record and the configuration with `catalogue` (one transaction). */
  replaceCatalogue(catalogue: BackupCatalogue): Promise<void>;
}

/** `record` with the patch's defined fields applied (undefined = leave as is, null = clear). */
export function applyBackupPatch(record: BackupRecord, patch: BackupRecordPatch): BackupRecord {
  const next = { ...record } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
  return cloneBackupRecord(next as unknown as BackupRecord);
}

/** Shallow copy with fresh arrays/objects so callers never share mutable state with the store. */
export function cloneBackupRecord(r: BackupRecord): BackupRecord {
  return {
    ...r,
    parts: r.parts.map((p) => ({ ...p })),
    monthlyArchive: r.monthlyArchive ? { dates: [...r.monthlyArchive.dates], retainCount: r.monthlyArchive.retainCount } : null,
  };
}

/** started desc, then id desc (identical in both stores). */
export function compareBackupsNewestFirst(a: BackupRecord, b: BackupRecord): number {
  const ta = Date.parse(a.startedAtIso);
  const tb = Date.parse(b.startedAtIso);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
