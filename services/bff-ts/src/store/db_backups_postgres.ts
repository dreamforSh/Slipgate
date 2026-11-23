import type postgres from "postgres";
import {
  BackupMonthlyArchiveSchema,
  BackupPartSchema,
  BackupS3ConfigSchema,
  BackupScheduleSchema,
  type BackupRecord,
  type BackupSchedule,
} from "@slipgate/contracts";
import { z } from "zod";
import {
  applyBackupPatch,
  DB_BACKUP_MAX_RECORDS,
  type BackupCatalogue,
  type BackupRecordPatch,
  type BeginRestoreResult,
  type DbBackupConfigState,
  type DbBackupStore,
  type StoredBackupS3Config,
} from "./db_backups_types.ts";

type Sql = ReturnType<typeof postgres>;

/**
 * Idempotent DDL for full-database backups, mirrored by migrations/commerce/0011_db_backups.sql.
 * Applied by PostgresControlStore.init() and again right after a restore (an older dump may predate
 * these tables). Both tables stay tiny, so every statement is a cheap no-op after the first start.
 */
export const PG_DB_BACKUPS_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS commerce;

  CREATE TABLE IF NOT EXISTS commerce.db_backups (
      id                  TEXT PRIMARY KEY,
      status              TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'running', 'completed', 'failed')),
      backup_type         TEXT NOT NULL DEFAULT 'postgres',
      triggered_by        TEXT NOT NULL CHECK (triggered_by IN ('manual', 'scheduled')),
      created_by          TEXT,
      file_name           TEXT NOT NULL,
      s3_key              TEXT NOT NULL DEFAULT '',
      parts               JSONB NOT NULL DEFAULT '[]'::jsonb,
      size_bytes          BIGINT NOT NULL DEFAULT 0,
      progress            TEXT NOT NULL DEFAULT '',
      error_message       TEXT NOT NULL DEFAULT '',
      started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at         TIMESTAMPTZ,
      expires_at          TIMESTAMPTZ,
      scheduled_for       TIMESTAMPTZ,
      restore_status      TEXT NOT NULL DEFAULT ''
                          CHECK (restore_status IN ('', 'running', 'completed', 'failed')),
      restore_started_at  TIMESTAMPTZ,
      restore_error       TEXT NOT NULL DEFAULT '',
      restored_at         TIMESTAMPTZ,
      restored_by         TEXT,
      monthly_archive     JSONB,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_commerce_db_backups_started
      ON commerce.db_backups (started_at DESC, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS uq_commerce_db_backups_scheduled_for
      ON commerce.db_backups (scheduled_for) WHERE scheduled_for IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_commerce_db_backups_unfinished
      ON commerce.db_backups (id) WHERE status IN ('pending', 'running') OR restore_status = 'running';

  CREATE TABLE IF NOT EXISTS commerce.db_backup_config (
      id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      s3_config           JSONB,
      s3_secret_enc       BYTEA,
      schedule            JSONB,
      archive_checkpoint  TEXT NOT NULL DEFAULT '',
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/** pg_try_advisory_lock(int4, int4) key of the one backup/restore lock ('SGDB', 1). */
const OP_LOCK_SPACE = 0x53474442;
const OP_LOCK_KEY = 1;

interface BackupRow {
  id: string;
  status: BackupRecord["status"];
  backup_type: string;
  triggered_by: BackupRecord["triggeredBy"];
  created_by: string | null;
  file_name: string;
  s3_key: string;
  parts: unknown;
  size_bytes: string | number;
  progress: string;
  error_message: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  expires_at: Date | string | null;
  scheduled_for: Date | string | null;
  restore_status: string;
  restore_started_at: Date | string | null;
  restore_error: string;
  restored_at: Date | string | null;
  restored_by: string | null;
  monthly_archive: unknown;
}

interface ConfigRow {
  s3_config: unknown;
  s3_secret_enc: Uint8Array | null;
  schedule: unknown;
  archive_checkpoint: string;
}

const COLUMNS = `id, status, backup_type, triggered_by, created_by, file_name, s3_key, parts, size_bytes, progress,
  error_message, started_at, finished_at, expires_at, scheduled_for, restore_status, restore_started_at,
  restore_error, restored_at, restored_by, monthly_archive`;

/** Older writers may have stored a JSON string in a jsonb column; decode either. */
function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function iso(v: Date | string | null): string | null {
  if (v === null || v === undefined) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

const PROGRESS = new Set(["", "pending", "dumping", "compressing", "uploading"]);
const RESTORE = new Set(["", "running", "completed", "failed"]);

function toRecord(r: BackupRow): BackupRecord {
  const parts = z.array(BackupPartSchema).safeParse(json(r.parts));
  const archive = BackupMonthlyArchiveSchema.nullable().safeParse(json(r.monthly_archive) ?? null);
  return {
    id: r.id,
    status: r.status,
    backupType: "postgres",
    triggeredBy: r.triggered_by,
    createdBy: r.created_by,
    fileName: r.file_name,
    s3Key: r.s3_key,
    parts: parts.success ? parts.data : [],
    sizeBytes: Number(r.size_bytes),
    progress: (PROGRESS.has(r.progress) ? r.progress : "") as BackupRecord["progress"],
    errorMessage: r.error_message,
    startedAtIso: iso(r.started_at)!,
    finishedAtIso: iso(r.finished_at),
    expiresAtIso: iso(r.expires_at),
    scheduledForIso: iso(r.scheduled_for),
    restoreStatus: (RESTORE.has(r.restore_status) ? r.restore_status : "") as BackupRecord["restoreStatus"],
    restoreStartedAtIso: iso(r.restore_started_at),
    restoreError: r.restore_error,
    restoredAtIso: iso(r.restored_at),
    restoredBy: r.restored_by,
    monthlyArchive: archive.success ? archive.data : null,
  };
}

/** Row values for jsonb_to_recordset / the single-row writers. */
function toRowJson(r: BackupRecord): Record<string, unknown> {
  return {
    id: r.id,
    status: r.status,
    backup_type: r.backupType,
    triggered_by: r.triggeredBy,
    created_by: r.createdBy,
    file_name: r.fileName,
    s3_key: r.s3Key,
    parts: r.parts,
    size_bytes: r.sizeBytes,
    progress: r.progress,
    error_message: r.errorMessage,
    started_at: r.startedAtIso,
    finished_at: r.finishedAtIso,
    expires_at: r.expiresAtIso,
    scheduled_for: r.scheduledForIso,
    restore_status: r.restoreStatus,
    restore_started_at: r.restoreStartedAtIso,
    restore_error: r.restoreError,
    restored_at: r.restoredAtIso,
    restored_by: r.restoredBy,
    monthly_archive: r.monthlyArchive,
  };
}

const RECORDSET_COLUMNS = `id text, status text, backup_type text, triggered_by text, created_by text, file_name text,
  s3_key text, parts jsonb, size_bytes bigint, progress text, error_message text, started_at timestamptz,
  finished_at timestamptz, expires_at timestamptz, scheduled_for timestamptz, restore_status text,
  restore_started_at timestamptz, restore_error text, restored_at timestamptz, restored_by text, monthly_archive jsonb`;

function toConfig(row: ConfigRow | undefined): DbBackupConfigState {
  if (!row) return { s3: null, schedule: null, archiveCheckpoint: "" };
  const s3 = BackupS3ConfigSchema.safeParse(json(row.s3_config));
  const schedule = BackupScheduleSchema.safeParse(json(row.schedule));
  return {
    s3: s3.success ? { ...s3.data, secretEnc: row.s3_secret_enc ? new Uint8Array(row.s3_secret_enc) : null } : null,
    schedule: schedule.success ? schedule.data : null,
    archiveCheckpoint: row.archive_checkpoint ?? "",
  };
}

function s3Json(cfg: StoredBackupS3Config): postgres.JSONValue {
  const { secretEnc: _secret, ...plain } = cfg;
  return plain as unknown as postgres.JSONValue;
}

export class PostgresDbBackupStore implements DbBackupStore {
  readonly kind = "postgres" as const;

  constructor(
    private readonly sql: Sql,
    private readonly databaseUrl: string,
  ) {}

  dumpTarget(): { databaseUrl: string } {
    return { databaseUrl: this.databaseUrl };
  }

  async serverVersionNum(): Promise<number | null> {
    const rows = await this.sql<{ v: string }[]>`SELECT current_setting('server_version_num') AS v`;
    const n = Number.parseInt(rows[0]?.v ?? "", 10);
    return Number.isFinite(n) ? n : null;
  }

  async ensureSchema(): Promise<void> {
    await this.sql.unsafe(PG_DB_BACKUPS_SCHEMA_SQL);
  }

  async getConfig(): Promise<DbBackupConfigState> {
    const rows = await this.sql<ConfigRow[]>`
      SELECT s3_config, s3_secret_enc, schedule, archive_checkpoint FROM commerce.db_backup_config WHERE id = 1
    `;
    return toConfig(rows[0]);
  }

  async saveS3Config(cfg: StoredBackupS3Config): Promise<void> {
    const secret = cfg.secretEnc ? Buffer.from(cfg.secretEnc) : null;
    await this.sql`
      INSERT INTO commerce.db_backup_config (id, s3_config, s3_secret_enc, updated_at)
      VALUES (1, ${this.sql.json(s3Json(cfg))}, ${secret}, NOW())
      ON CONFLICT (id) DO UPDATE
         SET s3_config = EXCLUDED.s3_config, s3_secret_enc = EXCLUDED.s3_secret_enc, updated_at = NOW()
    `;
  }

  async saveSchedule(schedule: BackupSchedule): Promise<void> {
    await this.sql`
      INSERT INTO commerce.db_backup_config (id, schedule, updated_at)
      VALUES (1, ${this.sql.json(schedule as unknown as postgres.JSONValue)}, NOW())
      ON CONFLICT (id) DO UPDATE SET schedule = EXCLUDED.schedule, updated_at = NOW()
    `;
  }

  async listRecords(limit: number): Promise<BackupRecord[]> {
    const n = Math.max(0, Math.min(DB_BACKUP_MAX_RECORDS, Math.trunc(limit)));
    // While this instance restores, the service answers from its snapshot instead of reading here.
    const rows = (await this.sql.unsafe(
      `SELECT ${COLUMNS} FROM commerce.db_backups ORDER BY started_at DESC, id DESC LIMIT ${n}`,
    )) as unknown as BackupRow[];
    return rows.map(toRecord);
  }

  async getRecord(id: string): Promise<BackupRecord | null> {
    const rows = (await this.sql.unsafe(`SELECT ${COLUMNS} FROM commerce.db_backups WHERE id = $1`, [id])) as unknown as BackupRow[];
    return rows[0] ? toRecord(rows[0]) : null;
  }

  private async insertRows(tx: Sql, records: BackupRecord[], onConflictNothing: boolean): Promise<number> {
    if (records.length === 0) return 0;
    const result = await tx.unsafe(
      `INSERT INTO commerce.db_backups (${COLUMNS})
       SELECT ${COLUMNS} FROM jsonb_to_recordset($1::text::jsonb) AS r(${RECORDSET_COLUMNS})
       ${onConflictNothing ? "ON CONFLICT DO NOTHING" : ""}`,
      [JSON.stringify(records.map(toRowJson))],
    );
    return result.count;
  }

  async insertRecord(record: BackupRecord): Promise<boolean> {
    // A clash on the id or on the scheduled slot's unique index leaves nothing written.
    return (await this.insertRows(this.sql, [record], true)) === 1;
  }

  private async writeRecord(tx: Sql, r: BackupRecord): Promise<void> {
    await tx`
      UPDATE commerce.db_backups
         SET status = ${r.status}, file_name = ${r.fileName}, s3_key = ${r.s3Key},
             parts = ${tx.json(r.parts as unknown as postgres.JSONValue)}, size_bytes = ${r.sizeBytes},
             progress = ${r.progress}, error_message = ${r.errorMessage},
             finished_at = ${r.finishedAtIso}, expires_at = ${r.expiresAtIso},
             restore_status = ${r.restoreStatus}, restore_started_at = ${r.restoreStartedAtIso},
             restore_error = ${r.restoreError}, restored_at = ${r.restoredAtIso}, restored_by = ${r.restoredBy},
             monthly_archive = ${r.monthlyArchive ? tx.json(r.monthlyArchive as unknown as postgres.JSONValue) : null},
             updated_at = NOW()
       WHERE id = ${r.id}
    `;
  }

  private async patchInTx(tx: Sql, id: string, patch: BackupRecordPatch): Promise<BackupRecord | null> {
    const rows = (await tx.unsafe(`SELECT ${COLUMNS} FROM commerce.db_backups WHERE id = $1 FOR UPDATE`, [id])) as unknown as BackupRow[];
    if (!rows[0]) return null;
    const next = applyBackupPatch(toRecord(rows[0]), patch);
    await this.writeRecord(tx, next);
    return next;
  }

  async updateRecord(id: string, patch: BackupRecordPatch): Promise<BackupRecord | null> {
    return (await this.sql.begin((txRaw) => this.patchInTx(txRaw as unknown as Sql, id, patch))) as BackupRecord | null;
  }

  async completeRecord(id: string, patch: BackupRecordPatch, archiveCheckpoint: string | null): Promise<BackupRecord | null> {
    return (await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const next = await this.patchInTx(tx, id, patch);
      if (next && archiveCheckpoint !== null) {
        await tx`
          INSERT INTO commerce.db_backup_config (id, archive_checkpoint, updated_at) VALUES (1, ${archiveCheckpoint}, NOW())
          ON CONFLICT (id) DO UPDATE SET archive_checkpoint = EXCLUDED.archive_checkpoint, updated_at = NOW()
        `;
      }
      return next;
    })) as BackupRecord | null;
  }

  async deleteRecord(id: string): Promise<boolean> {
    const result = await this.sql`DELETE FROM commerce.db_backups WHERE id = ${id} AND restore_status <> 'running'`;
    return result.count === 1;
  }

  async beginRestore(id: string, nowIso: string, actorId: string): Promise<BeginRestoreResult> {
    return (await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const rows = (await tx.unsafe(`SELECT ${COLUMNS} FROM commerce.db_backups WHERE id = $1 FOR UPDATE`, [id])) as unknown as BackupRow[];
      if (!rows[0]) return { ok: false, reason: "not_found" } as const;
      const current = toRecord(rows[0]);
      if (current.status !== "completed") return { ok: false, reason: "not_completed" } as const;
      if (current.restoreStatus === "running") return { ok: false, reason: "restore_running" } as const;
      const next = applyBackupPatch(current, { restoreStatus: "running", restoreStartedAtIso: nowIso, restoreError: "", restoredBy: actorId });
      await this.writeRecord(tx, next);
      return { ok: true, record: next } as const;
    })) as BeginRestoreResult;
  }

  async failInterrupted(nowIso: string, backupMessage: string, restoreMessage: string) {
    return (await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      const backups = await tx<{ id: string }[]>`
        UPDATE commerce.db_backups
           SET status = 'failed', progress = '', error_message = ${backupMessage},
               finished_at = COALESCE(finished_at, ${nowIso}::timestamptz), updated_at = NOW()
         WHERE status IN ('pending', 'running')
        RETURNING id
      `;
      const restores = await tx<{ id: string }[]>`
        UPDATE commerce.db_backups
           SET restore_status = 'failed', restore_error = ${restoreMessage}, updated_at = NOW()
         WHERE restore_status = 'running'
        RETURNING id
      `;
      return { backups: backups.map((r) => r.id).sort(), restores: restores.map((r) => r.id).sort() };
    })) as { backups: string[]; restores: string[] };
  }

  async tryAcquireOpLock(): Promise<(() => Promise<void>) | null> {
    // Session-level lock on a reserved connection, held for the whole backup / restore.
    const conn = await this.sql.reserve();
    const db = conn as unknown as Sql;
    try {
      const rows = await db<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${OP_LOCK_SPACE}::int, ${OP_LOCK_KEY}::int) AS ok`;
      if (!rows[0]?.ok) {
        conn.release();
        return null;
      }
    } catch (err) {
      conn.release();
      throw err;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await db`SELECT pg_advisory_unlock(${OP_LOCK_SPACE}::int, ${OP_LOCK_KEY}::int)`;
      } catch {
        // The lock ends with the session anyway.
      } finally {
        conn.release();
      }
    };
  }

  async snapshotCatalogue(): Promise<BackupCatalogue> {
    const config = await this.getConfig();
    const records = await this.listRecords(DB_BACKUP_MAX_RECORDS);
    return { config, records };
  }

  async replaceCatalogue(catalogue: BackupCatalogue): Promise<void> {
    const { config } = catalogue;
    await this.sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as Sql;
      await tx`DELETE FROM commerce.db_backups`;
      await this.insertRows(tx, catalogue.records, false);
      await tx`
        INSERT INTO commerce.db_backup_config (id, s3_config, s3_secret_enc, schedule, archive_checkpoint, updated_at)
        VALUES (
          1,
          ${config.s3 ? tx.json(s3Json(config.s3)) : null},
          ${config.s3?.secretEnc ? Buffer.from(config.s3.secretEnc) : null},
          ${config.schedule ? tx.json(config.schedule as unknown as postgres.JSONValue) : null},
          ${config.archiveCheckpoint},
          NOW()
        )
        ON CONFLICT (id) DO UPDATE
           SET s3_config = EXCLUDED.s3_config, s3_secret_enc = EXCLUDED.s3_secret_enc,
               schedule = EXCLUDED.schedule, archive_checkpoint = EXCLUDED.archive_checkpoint, updated_at = NOW()
      `;
    });
  }
}
