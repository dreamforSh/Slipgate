import type { BackupRecord, BackupSchedule } from "@slipgate/contracts";
import {
  applyBackupPatch,
  cloneBackupRecord,
  compareBackupsNewestFirst,
  type BackupCatalogue,
  type BackupRecordPatch,
  type BeginRestoreResult,
  type DbBackupConfigState,
  type DbBackupStore,
  type StoredBackupS3Config,
} from "./db_backups_types.ts";

function cloneConfig(c: DbBackupConfigState): DbBackupConfigState {
  return {
    s3: c.s3 ? { ...c.s3, secretEnc: c.s3.secretEnc ? new Uint8Array(c.s3.secretEnc) : null } : null,
    schedule: c.schedule ? { ...c.schedule, monthlyArchive: { ...c.schedule.monthlyArchive, days: [...c.schedule.monthlyArchive.days] } } : null,
    archiveCheckpoint: c.archiveCheckpoint,
  };
}

/** In-process backup catalogue (same semantics as Postgres); the memory store itself cannot be dumped. */
export class MemoryDbBackupStore implements DbBackupStore {
  readonly kind = "memory" as const;
  private config: DbBackupConfigState = { s3: null, schedule: null, archiveCheckpoint: "" };
  private readonly records = new Map<string, BackupRecord>();
  private locked = false;

  dumpTarget(): null {
    return null;
  }

  async serverVersionNum(): Promise<null> {
    return null;
  }

  async ensureSchema(): Promise<void> {}

  async getConfig(): Promise<DbBackupConfigState> {
    return cloneConfig(this.config);
  }

  async saveS3Config(cfg: StoredBackupS3Config): Promise<void> {
    this.config = cloneConfig({ ...this.config, s3: cfg });
  }

  async saveSchedule(schedule: BackupSchedule): Promise<void> {
    this.config = cloneConfig({ ...this.config, schedule });
  }

  async listRecords(limit: number): Promise<BackupRecord[]> {
    return [...this.records.values()].sort(compareBackupsNewestFirst).slice(0, Math.max(0, limit)).map(cloneBackupRecord);
  }

  async getRecord(id: string): Promise<BackupRecord | null> {
    const r = this.records.get(id);
    return r ? cloneBackupRecord(r) : null;
  }

  async insertRecord(record: BackupRecord): Promise<boolean> {
    if (this.records.has(record.id)) return false;
    if (record.scheduledForIso) {
      const slot = Date.parse(record.scheduledForIso);
      for (const r of this.records.values()) if (r.scheduledForIso && Date.parse(r.scheduledForIso) === slot) return false;
    }
    this.records.set(record.id, cloneBackupRecord(record));
    return true;
  }

  async updateRecord(id: string, patch: BackupRecordPatch): Promise<BackupRecord | null> {
    const r = this.records.get(id);
    if (!r) return null;
    const next = applyBackupPatch(r, patch);
    this.records.set(id, next);
    return cloneBackupRecord(next);
  }

  async completeRecord(id: string, patch: BackupRecordPatch, archiveCheckpoint: string | null): Promise<BackupRecord | null> {
    const updated = await this.updateRecord(id, patch);
    if (updated && archiveCheckpoint !== null) this.config = { ...this.config, archiveCheckpoint };
    return updated;
  }

  async deleteRecord(id: string): Promise<boolean> {
    const r = this.records.get(id);
    if (!r || r.restoreStatus === "running") return false;
    this.records.delete(id);
    return true;
  }

  async beginRestore(id: string, nowIso: string, actorId: string): Promise<BeginRestoreResult> {
    const r = this.records.get(id);
    if (!r) return { ok: false, reason: "not_found" };
    if (r.status !== "completed") return { ok: false, reason: "not_completed" };
    if (r.restoreStatus === "running") return { ok: false, reason: "restore_running" };
    const next: BackupRecord = { ...r, restoreStatus: "running", restoreStartedAtIso: nowIso, restoreError: "", restoredBy: actorId };
    this.records.set(id, next);
    return { ok: true, record: cloneBackupRecord(next) };
  }

  async failInterrupted(nowIso: string, backupMessage: string, restoreMessage: string) {
    const backups: string[] = [];
    const restores: string[] = [];
    for (const [id, r] of this.records) {
      let next = r;
      if (r.status === "pending" || r.status === "running") {
        next = { ...next, status: "failed", progress: "", errorMessage: backupMessage, finishedAtIso: r.finishedAtIso ?? nowIso };
        backups.push(id);
      }
      if (r.restoreStatus === "running") {
        next = { ...next, restoreStatus: "failed", restoreError: restoreMessage };
        restores.push(id);
      }
      if (next !== r) this.records.set(id, next);
    }
    return { backups: backups.sort(), restores: restores.sort() };
  }

  async tryAcquireOpLock(): Promise<(() => Promise<void>) | null> {
    if (this.locked) return null;
    this.locked = true;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      this.locked = false;
    };
  }

  async snapshotCatalogue(): Promise<BackupCatalogue> {
    return { config: cloneConfig(this.config), records: [...this.records.values()].map(cloneBackupRecord) };
  }

  async replaceCatalogue(catalogue: BackupCatalogue): Promise<void> {
    this.config = cloneConfig(catalogue.config);
    this.records.clear();
    for (const r of catalogue.records) this.records.set(r.id, cloneBackupRecord(r));
  }
}
