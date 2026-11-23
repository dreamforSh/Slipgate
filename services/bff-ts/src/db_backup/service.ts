import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  DB_BACKUP_CRON_PREVIEW_MAX,
  DEFAULT_BACKUP_S3_CONFIG,
  DEFAULT_BACKUP_SCHEDULE,
  type BackupCronPreviewResponse,
  type BackupMonthlyArchive,
  type BackupMonthlyArchiveConfig,
  type BackupOperationStage,
  type BackupPart,
  type BackupProgress,
  type BackupRecord,
  type BackupS3ConfigView,
  type BackupSchedule,
  type BackupScheduleView,
  type BackupSystemStatus,
  type BackupTrigger,
  type BackupUnsupportedReason,
  type DbBackupErrorCode,
  type TestBackupS3Response,
  type UpdateBackupS3ConfigRequest,
  type UpdateBackupScheduleRequest,
} from "@slipgate/contracts";
import { redactLogText } from "../insights.ts";
import { decryptSecret, encryptSecret } from "../security/crypto.ts";
import { DB_BACKUP_MAX_RECORDS, type BackupCatalogue, type DbBackupConfigState, type DbBackupStore, type StoredBackupS3Config } from "../store/db_backups_types.ts";
import { CronError, isValidTimeZone, nextCronRun, parseCron, zonedDate, zonedParts } from "./cron.ts";
import { PgToolRunner, type DbDumpRunner } from "./dump_runner.ts";
import { createBunObjectStore, isS3Configured, normalizePrefix, type BackupObjectStore, type BackupObjectStoreFactory, type ResolvedS3Target } from "./s3.ts";

/** Errors the routes answer with `{ error: code, message }` at `status`. */
export class DbBackupError extends Error {
  constructor(
    readonly code: DbBackupErrorCode,
    readonly status: 400 | 403 | 404 | 409 | 429 | 501 | 502 | 503,
    message: string,
  ) {
    super(message);
    this.name = "DbBackupError";
  }
}

export interface DbBackupServiceOptions {
  store: DbBackupStore;
  vaultSecret: string;
  /** undefined = pg_dump/psql against the store's database (none for the memory store); null = unsupported. */
  runner?: DbDumpRunner | null;
  objectStoreFactory?: BackupObjectStoreFactory;
  /** Archives larger than this are stored as several objects (default 4 GiB, below S3's 5 GiB PUT limit). */
  splitPartSizeBytes?: number;
  /** Where dumps are staged (default SLIPGATE_BACKUP_TMP_DIR or the OS temp dir). */
  tmpDir?: string;
  /** Runs after a successful restore (re-apply schema, reload caches, push the data plane). */
  afterRestore?: () => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export const DEFAULT_SPLIT_PART_BYTES = 4 * 1024 * 1024 * 1024;
const DAY_MS = 86_400_000;
/** Failed backups (metadata and any leftover objects) are dropped after this long. */
const FAILED_RETENTION_MS = 30 * DAY_MS;
const MAINTENANCE_INTERVAL_MS = 5 * 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
/** Longest single timer; the scheduler re-arms (and re-reads the schedule) at least this often. */
const MAX_TIMER_MS = 5 * 60_000;
const INTERRUPTED_BACKUP = "Interrupted: the server stopped before the backup finished";
const INTERRUPTED_RESTORE = "Interrupted: the server stopped before the restore finished";

interface ActiveOp {
  kind: "backup" | "restore" | "maintenance";
  backupId: string;
  progress: BackupOperationStage;
  startedAtIso: string;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** Error text safe to store and show: URL query strings (signatures) cut, credential shapes scrubbed. */
export function cleanErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactLogText(raw.replace(/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, "$1")).slice(0, 1000);
}

/** Archive dates (YYYY-MM-DD) of the month containing `year`/`month` that the rule selects. */
export function monthlyArchiveDates(year: number, month: number, cfg: BackupMonthlyArchiveConfig): string[] {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days = new Set<number>();
  for (const d of cfg.days) days.add(Math.min(d, lastDay));
  if (cfg.includeMonthEnd) days.add(lastDay);
  return [...days].sort((a, b) => a - b).map((d) => `${pad(year, 4)}-${pad(month)}-${pad(d)}`);
}

/**
 * Monthly-archive decision for a completed scheduled backup (Linksyncx semantics): the durable
 * checkpoint moves to the backup's date even when no archive date is due, and every archive date
 * after the checkpoint up to that date is covered by this backup.
 */
export function assignMonthlyArchive(
  startedAtIso: string,
  schedule: BackupSchedule,
  checkpoint: string,
): { checkpoint: string; archive: BackupMonthlyArchive | null } | null {
  const cfg = schedule.monthlyArchive;
  if (!cfg.enabled) return null;
  const at = Date.parse(startedAtIso);
  const tz = isValidTimeZone(schedule.timezone) ? schedule.timezone : "UTC";
  const today = zonedDate(at, tz);
  const since = /^\d{4}-\d{2}-\d{2}$/.test(checkpoint) ? checkpoint : "";
  if (since && since >= today) return null;
  const p = zonedParts(at, tz);
  const due = monthlyArchiveDates(p.year, p.month, cfg).filter((d) => d > since && d <= today);
  return { checkpoint: today, archive: due.length ? { dates: due, retainCount: cfg.retainCount } : null };
}

/** Parts sorted by index, rejected unless they are 1..n with keys and sizes. */
function orderedParts(record: BackupRecord): BackupPart[] {
  const parts = [...record.parts].sort((a, b) => a.index - b.index);
  if (parts.length === 0) throw new DbBackupError("backup_corrupt", 409, "The backup has no stored parts");
  parts.forEach((p, i) => {
    if (p.index !== i + 1 || !p.s3Key || p.sizeBytes <= 0) {
      throw new DbBackupError("backup_corrupt", 409, `Invalid part metadata at index ${i + 1}`);
    }
  });
  return parts;
}

/** Every object key a record refers to (single object and parts), de-duplicated. */
function objectKeys(record: BackupRecord): string[] {
  return [...new Set([record.s3Key, ...record.parts.map((p) => p.s3Key)].filter(Boolean))];
}

async function sha256OfFile(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

/** Copies bytes [start, end) of `src` to `dst`; returns their SHA-256. */
async function copyRange(src: string, start: number, end: number, dst: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(
    createReadStream(src, { start, end: end - 1 }),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb(null, chunk);
      },
    }),
    createWriteStream(dst),
  );
  return hash.digest("hex");
}

async function gzipFile(src: string, dst: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dst));
}

function view(s3: StoredBackupS3Config | null): BackupS3ConfigView {
  if (!s3) return { ...DEFAULT_BACKUP_S3_CONFIG };
  const secretAccessKeySet = Boolean(s3.secretEnc && s3.secretEnc.byteLength > 0);
  return {
    endpoint: s3.endpoint,
    region: s3.region,
    bucket: s3.bucket,
    accessKeyId: s3.accessKeyId,
    prefix: s3.prefix,
    forcePathStyle: s3.forcePathStyle,
    secretAccessKeySet,
    configured: isS3Configured(s3, secretAccessKeySet),
  };
}

/**
 * Full database backups to S3-compatible storage: dump → gzip → (split) → upload with per-part
 * SHA-256, cron schedule with retention and monthly archive copies, signed downloads and restore.
 * One backup or restore runs at a time across every instance (store advisory lock + an in-process
 * claim); interrupted operations are failed by the maintenance pass once nobody holds the lock.
 */
export class DbBackupService {
  private readonly store: DbBackupStore;
  private readonly runner: DbDumpRunner | null;
  private readonly factory: BackupObjectStoreFactory;
  private readonly splitBytes: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private active: ActiveOp | null = null;
  /** Running backup / restore (tests and shutdown wait on it). */
  private running: Promise<unknown> = Promise.resolve();
  /** The catalogue as it was when the running restore began: served while the restore holds the tables. */
  private restoreView: BackupCatalogue | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private lastPruneAt = 0;

  constructor(private readonly opts: DbBackupServiceOptions) {
    this.store = opts.store;
    const target = opts.store.dumpTarget();
    this.runner =
      opts.runner !== undefined ? opts.runner : target ? new PgToolRunner(target.databaseUrl, () => opts.store.serverVersionNum()) : null;
    this.factory = opts.objectStoreFactory ?? ((t) => createBunObjectStore(t));
    this.splitBytes = Math.max(1, Math.trunc(opts.splitPartSizeBytes ?? DEFAULT_SPLIT_PART_BYTES));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(`[slipgate-bff] db-backup: ${m}`));
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Resolves once the running backup / restore (if any) has finished. */
  async whenIdle(): Promise<void> {
    await this.running.catch(() => undefined);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Support, status                                                                          */
  /* ---------------------------------------------------------------------------------------- */

  private async support(): Promise<{ ok: true; detail: string } | { ok: false; reason: BackupUnsupportedReason; detail: string }> {
    if (!this.runner) {
      return { ok: false, reason: "memory_store", detail: "Backups need the Postgres store (DATABASE_URL); the in-memory store cannot be backed up" };
    }
    return this.runner.check();
  }

  private async requireRunner(): Promise<DbDumpRunner> {
    const s = await this.support();
    if (!s.ok) {
      if (s.reason === "memory_store") throw new DbBackupError("backup_unsupported", 501, s.detail);
      throw new DbBackupError("backup_tool_unavailable", 503, s.detail);
    }
    return this.runner!;
  }

  private assertNotRestoring(): void {
    if (this.active?.kind === "restore") {
      throw new DbBackupError("restore_in_progress", 409, "A restore is running; try again when it has finished");
    }
  }

  private async config(): Promise<DbBackupConfigState> {
    return this.restoreView ? this.restoreView.config : this.store.getConfig();
  }

  private nextRun(schedule: BackupSchedule): string | null {
    if (!schedule.enabled || !schedule.cronExpr) return null;
    try {
      return nextCronRun(parseCron(schedule.cronExpr), new Date(this.now()), schedule.timezone)?.toISOString() ?? null;
    } catch {
      return null;
    }
  }

  async status(): Promise<BackupSystemStatus> {
    const support = await this.support();
    const config = await this.config();
    const schedule = config.schedule ?? DEFAULT_BACKUP_SCHEDULE;
    const op = this.active && this.active.kind !== "maintenance" ? this.active : null;
    return {
      supported: support.ok,
      reason: support.ok ? null : support.reason,
      detail: support.detail,
      s3Configured: view(config.s3).configured,
      activeOperation: op ? { kind: op.kind as "backup" | "restore", backupId: op.backupId, progress: op.progress, startedAtIso: op.startedAtIso } : null,
      schedule: { enabled: schedule.enabled, nextRunAtIso: this.nextRun(schedule) },
    };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* S3 target                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  async getS3Config(): Promise<BackupS3ConfigView> {
    return view((await this.config()).s3);
  }

  async updateS3Config(req: UpdateBackupS3ConfigRequest): Promise<BackupS3ConfigView> {
    this.assertNotRestoring();
    const current = (await this.store.getConfig()).s3;
    // An omitted secret keeps the stored ciphertext as it is (it is never decrypted to be re-saved).
    let secretEnc = current?.secretEnc ?? null;
    if (req.secretAccessKey !== undefined) {
      secretEnc = req.secretAccessKey ? await encryptSecret(req.secretAccessKey, this.opts.vaultSecret) : null;
    }
    const next: StoredBackupS3Config = {
      endpoint: req.endpoint.replace(/\/+$/, ""),
      region: req.region,
      bucket: req.bucket,
      accessKeyId: req.accessKeyId,
      prefix: req.prefix.replace(/^\/+|\/+$/g, ""),
      forcePathStyle: req.forcePathStyle,
      secretEnc,
    };
    await this.store.saveS3Config(next);
    return view(next);
  }

  private async decryptStored(s3: StoredBackupS3Config | null): Promise<string> {
    if (!s3?.secretEnc || s3.secretEnc.byteLength === 0) return "";
    try {
      return await decryptSecret(s3.secretEnc, this.opts.vaultSecret);
    } catch {
      throw new DbBackupError(
        "backup_s3_not_configured",
        400,
        "The stored S3 secret cannot be decrypted with the current vault key; enter it again",
      );
    }
  }

  private async resolveTarget(): Promise<ResolvedS3Target> {
    const { s3 } = await this.config();
    const secretAccessKey = await this.decryptStored(s3);
    if (!s3 || !isS3Configured(s3, Boolean(secretAccessKey))) {
      throw new DbBackupError("backup_s3_not_configured", 400, "Backup storage is not configured (bucket, access key id and secret are required)");
    }
    const { secretEnc: _secret, ...plain } = s3;
    return { ...plain, secretAccessKey };
  }

  private async objectStore(): Promise<{ target: ResolvedS3Target; objects: BackupObjectStore }> {
    const target = await this.resolveTarget();
    return { target, objects: this.factory(target) };
  }

  async testS3(req: UpdateBackupS3ConfigRequest): Promise<TestBackupS3Response> {
    let secret = req.secretAccessKey;
    if (secret === undefined) {
      try {
        secret = await this.decryptStored((await this.config()).s3);
      } catch (err) {
        return { ok: false, code: "backup_s3_not_configured", message: err instanceof Error ? err.message : String(err) };
      }
    }
    if (!req.bucket || !req.accessKeyId || !secret) {
      return { ok: false, code: "backup_s3_incomplete", message: "Bucket, access key id and secret access key are required" };
    }
    try {
      const objects = this.factory({ ...req, endpoint: req.endpoint.replace(/\/+$/, ""), secretAccessKey: secret });
      await objects.probe(req.prefix);
      return { ok: true, message: "Connection successful" };
    } catch (err) {
      return { ok: false, code: "backup_s3_error", message: cleanErrorMessage(err) };
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Schedule                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  private async loadSchedule(): Promise<BackupSchedule> {
    return (await this.config()).schedule ?? DEFAULT_BACKUP_SCHEDULE;
  }

  async getSchedule(): Promise<BackupScheduleView> {
    const schedule = await this.loadSchedule();
    return { ...schedule, nextRunAtIso: this.nextRun(schedule) };
  }

  async updateSchedule(req: UpdateBackupScheduleRequest): Promise<BackupScheduleView> {
    this.assertNotRestoring();
    if (!isValidTimeZone(req.timezone)) throw new DbBackupError("backup_invalid_timezone", 400, `Unknown time zone "${req.timezone}"`);
    if (req.cronExpr) {
      try {
        parseCron(req.cronExpr);
      } catch (err) {
        throw new DbBackupError("backup_invalid_cron", 400, err instanceof CronError ? err.message : "Invalid cron expression");
      }
    }
    const schedule: BackupSchedule = { ...req, monthlyArchive: { ...req.monthlyArchive, days: [...req.monthlyArchive.days] } };
    const nextRunAtIso = this.nextRun(schedule);
    if (schedule.enabled && !nextRunAtIso) throw new DbBackupError("backup_invalid_cron", 400, "The cron expression never fires");
    await this.store.saveSchedule(schedule);
    void this.arm();
    return { ...schedule, nextRunAtIso };
  }

  /** Checks an unsaved expression the way updateSchedule does and lists its next `count` runs. */
  previewCron(cronExpr: string, timezone: string, count: number): BackupCronPreviewResponse {
    const expr = cronExpr.trim();
    const zone = timezone.trim() || "UTC";
    if (!isValidTimeZone(zone)) return { valid: false, error: "backup_invalid_timezone", message: `Unknown time zone "${zone}"`, runsIso: [] };
    let spec;
    try {
      spec = parseCron(expr);
    } catch (err) {
      return { valid: false, error: "backup_invalid_cron", message: err instanceof CronError ? err.message : "Invalid cron expression", runsIso: [] };
    }
    const runsIso: string[] = [];
    let after = new Date(this.now());
    const limit = Math.max(1, Math.min(DB_BACKUP_CRON_PREVIEW_MAX, Math.floor(count) || 1));
    while (runsIso.length < limit) {
      const next = nextCronRun(spec, after, zone);
      if (!next) break;
      runsIso.push(next.toISOString());
      after = next;
    }
    if (runsIso.length === 0) return { valid: false, error: "backup_invalid_cron", message: "The cron expression never fires", runsIso };
    return { valid: true, error: null, message: "", runsIso };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Records                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  async list(): Promise<BackupRecord[]> {
    if (this.restoreView) return this.restoreView.records.slice(0, DB_BACKUP_MAX_RECORDS);
    return this.store.listRecords(DB_BACKUP_MAX_RECORDS);
  }

  async get(id: string): Promise<BackupRecord> {
    const record = this.restoreView ? (this.restoreView.records.find((r) => r.id === id) ?? null) : await this.store.getRecord(id);
    if (!record) throw new DbBackupError("backup_not_found", 404, "Backup not found");
    return record;
  }

  private async deleteObjects(record: BackupRecord): Promise<void> {
    const keys = objectKeys(record);
    if (keys.length === 0) return;
    const { s3 } = await this.config();
    const secret = await this.decryptStored(s3).catch(() => "");
    // Records written while no storage was configured can still be removed.
    if (!s3 || !isS3Configured(s3, Boolean(secret))) return;
    const { secretEnc: _secret, ...plain } = s3;
    const objects = this.factory({ ...plain, secretAccessKey: secret });
    const errors: string[] = [];
    for (const key of keys) {
      try {
        await objects.delete(key);
      } catch (err) {
        errors.push(`${key}: ${cleanErrorMessage(err)}`);
      }
    }
    if (errors.length) throw new DbBackupError("backup_s3_error", 502, `Could not delete stored objects (record kept): ${errors.join("; ")}`);
  }

  async deleteBackup(id: string, deleteArchived: boolean): Promise<void> {
    this.assertNotRestoring();
    const record = await this.get(id);
    if (record.status === "pending" || record.status === "running") {
      throw new DbBackupError("backup_in_progress", 409, "The backup is still running");
    }
    if (record.restoreStatus === "running") throw new DbBackupError("restore_in_progress", 409, "This backup is being restored");
    if (record.monthlyArchive && !deleteArchived) {
      throw new DbBackupError("backup_archive_protected", 409, "This is a monthly archive copy; confirm deleting archived backups");
    }
    await this.deleteObjects(record);
    if (!(await this.store.deleteRecord(id))) {
      const again = await this.store.getRecord(id);
      if (again?.restoreStatus === "running") throw new DbBackupError("restore_in_progress", 409, "This backup is being restored");
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Operation lock                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  /** Claims the in-process slot and the cross-instance lock; the returned release frees both. */
  private async claim(kind: ActiveOp["kind"], backupId: string): Promise<() => Promise<void>> {
    if (this.active) {
      if (this.active.kind === "restore") throw new DbBackupError("restore_in_progress", 409, "A restore is running");
      if (this.active.kind === "maintenance") throw new DbBackupError("backup_in_progress", 409, "Backup maintenance is running; try again in a moment");
      throw new DbBackupError("backup_in_progress", 409, "A backup is already running");
    }
    const op: ActiveOp = { kind, backupId, progress: kind === "maintenance" ? "" : "pending", startedAtIso: this.nowIso() };
    this.active = op;
    let unlock: (() => Promise<void>) | null;
    try {
      unlock = await this.store.tryAcquireOpLock();
    } catch (err) {
      this.active = null;
      throw err;
    }
    if (!unlock) {
      this.active = null;
      throw new DbBackupError("backup_in_progress", 409, "Another backup or restore is running");
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await unlock!();
      } finally {
        if (this.active === op) this.active = null;
      }
    };
  }

  private async setStage(id: string, stage: BackupOperationStage, persist?: BackupProgress): Promise<void> {
    if (this.active && this.active.backupId === id) this.active.progress = stage;
    if (persist !== undefined) await this.store.updateRecord(id, { progress: persist });
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Backup                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  private newRecord(trigger: BackupTrigger, actorId: string | null, expireDays: number, scheduledFor: Date | null, target: ResolvedS3Target): BackupRecord {
    const now = this.now();
    const d = new Date(now);
    const id = `bk_${randomHex(5)}`;
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    const fileName = `slipgate_${stamp}_${id}.sql.gz`;
    const dir = `${normalizePrefix(target.prefix)}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
    return {
      id,
      status: "running",
      backupType: "postgres",
      triggeredBy: trigger,
      createdBy: actorId,
      fileName,
      s3Key: `${dir}/${fileName}`,
      parts: [],
      sizeBytes: 0,
      progress: "pending",
      errorMessage: "",
      startedAtIso: d.toISOString(),
      finishedAtIso: null,
      expiresAtIso: expireDays > 0 ? new Date(now + expireDays * DAY_MS).toISOString() : null,
      scheduledForIso: scheduledFor ? scheduledFor.toISOString() : null,
      restoreStatus: "",
      restoreStartedAtIso: null,
      restoreError: "",
      restoredAtIso: null,
      restoredBy: null,
      monthlyArchive: null,
    };
  }

  /**
   * Validates, claims the lock and records the backup; the dump/upload continues in the background.
   * Returns null when a scheduled slot was already taken by another instance.
   */
  private async beginBackup(input: {
    trigger: BackupTrigger;
    actorId: string | null;
    expireDays: number;
    scheduledFor: Date | null;
    schedule: BackupSchedule | null;
  }): Promise<{ record: BackupRecord; done: Promise<BackupRecord> } | null> {
    this.assertNotRestoring();
    const runner = await this.requireRunner();
    const { target, objects } = await this.objectStore();
    const release = await this.claim("backup", "");
    try {
      const record = this.newRecord(input.trigger, input.actorId, input.expireDays, input.scheduledFor, target);
      if (!(await this.store.insertRecord(record))) {
        await release();
        return null;
      }
      this.active!.backupId = record.id;
      const done = this.executeBackup(record, runner, target, objects, input.schedule).finally(release);
      this.running = done;
      return { record, done };
    } catch (err) {
      await release();
      throw err;
    }
  }

  /** Starts a manual backup (202): the record comes back while the dump runs. */
  async startManualBackup(actorId: string, expireDays: number): Promise<BackupRecord> {
    const begun = await this.beginBackup({ trigger: "manual", actorId, expireDays, scheduledFor: null, schedule: null });
    if (!begun) throw new DbBackupError("backup_in_progress", 409, "A backup is already running");
    return begun.record;
  }

  /** Runs the scheduled backup of one cron slot to completion (retention included); null when skipped. */
  async runScheduledBackup(slot: Date): Promise<BackupRecord | null> {
    const schedule = await this.loadSchedule();
    if (!schedule.enabled) return null;
    try {
      const begun = await this.beginBackup({ trigger: "scheduled", actorId: null, expireDays: schedule.retainDays, scheduledFor: slot, schedule });
      if (!begun) {
        this.log(`scheduled backup for ${slot.toISOString()} skipped: another instance ran it`);
        return null;
      }
      return await begun.done;
    } catch (err) {
      this.log(`scheduled backup for ${slot.toISOString()} not run: ${cleanErrorMessage(err)}`);
      return null;
    }
  }

  private async executeBackup(
    record: BackupRecord,
    runner: DbDumpRunner,
    target: ResolvedS3Target,
    objects: BackupObjectStore,
    schedule: BackupSchedule | null,
  ): Promise<BackupRecord> {
    const abort = new AbortController();
    let dir: string | null = null;
    try {
      const root = this.opts.tmpDir ?? process.env.SLIPGATE_BACKUP_TMP_DIR?.trim() ?? tmpdir();
      await mkdir(root, { recursive: true });
      dir = await mkdtemp(join(root, `slipgate-backup-${record.id}-`));
      const dumpPath = join(dir, "dump.sql");
      const gzPath = join(dir, "dump.sql.gz");

      await this.setStage(record.id, "dumping", "dumping");
      await runner.dump(dumpPath, abort.signal);
      await this.setStage(record.id, "compressing", "compressing");
      await gzipFile(dumpPath, gzPath);
      await rm(dumpPath, { force: true });
      const size = Bun.file(gzPath).size;
      if (size <= 0) throw new Error("The dump is empty");

      // Plan the objects first so a failure (or a crash) knows every key to clean up.
      const single = size <= this.splitBytes;
      const partRoot = record.s3Key.slice(0, record.s3Key.lastIndexOf("/") + 1) + record.id;
      const plan: (BackupPart & { start: number; end: number })[] = [];
      for (let start = 0, index = 1; start < size; start += this.splitBytes, index++) {
        const end = Math.min(size, start + this.splitBytes);
        plan.push({
          index,
          s3Key: single ? record.s3Key : `${partRoot}/payload.part-${pad(index, 6)}`,
          sizeBytes: end - start,
          sha256: "",
          start,
          end,
        });
      }
      const parts = (): BackupPart[] => plan.map(({ index, s3Key, sizeBytes, sha256 }) => ({ index, s3Key, sizeBytes, sha256 }));
      await this.setStage(record.id, "uploading");
      await this.store.updateRecord(record.id, { progress: "uploading", sizeBytes: size, s3Key: single ? record.s3Key : "", parts: parts() });

      try {
        for (const p of plan) {
          let path = gzPath;
          if (single) {
            p.sha256 = await sha256OfFile(gzPath);
          } else {
            path = join(dir, `part-${p.index}`);
            p.sha256 = await copyRange(gzPath, p.start, p.end, path);
          }
          await objects.uploadFile(p.s3Key, path, single ? "application/gzip" : "application/octet-stream");
          if (!single) await rm(path, { force: true });
        }
      } catch (err) {
        // A PUT may have landed although the client saw an error: drop every planned key.
        for (const p of plan) await objects.delete(p.s3Key).catch(() => undefined);
        throw err;
      }

      let checkpoint: string | null = null;
      let archive: BackupMonthlyArchive | null = null;
      if (record.triggeredBy === "scheduled" && schedule) {
        const decided = assignMonthlyArchive(record.startedAtIso, schedule, (await this.store.getConfig()).archiveCheckpoint);
        if (decided) {
          checkpoint = decided.checkpoint;
          archive = decided.archive;
        }
      }
      const completed = await this.store.completeRecord(
        record.id,
        {
          status: "completed",
          progress: "",
          errorMessage: "",
          finishedAtIso: this.nowIso(),
          sizeBytes: size,
          parts: parts(),
          ...(archive ? { monthlyArchive: archive, expiresAtIso: null } : {}),
        },
        checkpoint,
      );
      if (schedule) await this.applyRetention(schedule).catch((err) => this.log(`retention failed: ${cleanErrorMessage(err)}`));
      return completed ?? record;
    } catch (err) {
      abort.abort();
      const message = cleanErrorMessage(err);
      this.log(`backup ${record.id} failed: ${message}`);
      const failed = await this.store
        .updateRecord(record.id, { status: "failed", progress: "", errorMessage: message, finishedAtIso: this.nowIso() })
        .catch(() => null);
      return failed ?? { ...record, status: "failed", progress: "", errorMessage: message };
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Retention                                                                                */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Scheduled backups: newest `retainCount` kept and none older than `retainDays` (archive copies
   * not counted). Archive copies: a finite pool per their stored count (a changed count applies
   * while the rule is on); permanent copies are never deleted. Manual backups: deleted once their
   * own expiry passed. Failed records: dropped after 30 days. With `schedule` null (maintenance
   * pass) only manual expiry and old failures are handled. Restoring backups are never touched.
   */
  async applyRetention(schedule: BackupSchedule | null): Promise<string[]> {
    const now = this.now();
    const records = await this.store.listRecords(DB_BACKUP_MAX_RECORDS);
    const doomed: BackupRecord[] = [];
    let ordinary = 0;
    let archived = 0;
    for (const r of records) {
      if (r.restoreStatus === "running" || r.status === "pending" || r.status === "running") continue;
      if (r.status === "failed") {
        if (now - Date.parse(r.startedAtIso) > FAILED_RETENTION_MS) doomed.push(r);
        continue;
      }
      if (r.monthlyArchive) {
        if (!schedule || r.monthlyArchive.retainCount === 0) continue;
        archived++;
        let limit = r.monthlyArchive.retainCount;
        const cfg = schedule.monthlyArchive;
        if (cfg.enabled && cfg.retainCount > 0 && cfg.retainCount !== limit) {
          limit = cfg.retainCount;
          await this.store.updateRecord(r.id, { monthlyArchive: { dates: r.monthlyArchive.dates, retainCount: limit } });
        }
        if (archived > limit) doomed.push(r);
        continue;
      }
      if (r.triggeredBy === "scheduled") {
        if (!schedule) continue;
        ordinary++;
        const tooMany = schedule.retainCount > 0 && ordinary > schedule.retainCount;
        const tooOld = schedule.retainDays > 0 && now > Date.parse(r.startedAtIso) + schedule.retainDays * DAY_MS;
        if (tooMany || tooOld) doomed.push(r);
        continue;
      }
      if (r.expiresAtIso && Date.parse(r.expiresAtIso) <= now) doomed.push(r);
    }
    const removed: string[] = [];
    for (const r of doomed) {
      try {
        await this.deleteObjects(r);
        if (await this.store.deleteRecord(r.id)) removed.push(r.id);
      } catch (err) {
        // Objects that could not be deleted keep their record, so the next pass retries.
        this.log(`retention could not remove ${r.id}: ${cleanErrorMessage(err)}`);
      }
    }
    return removed;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Download                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  /** A completed backup's parts with presigned links (the routes add the signed console links). */
  async downloadPlan(id: string, expiresInSeconds: number): Promise<{ record: BackupRecord; parts: (BackupPart & { presignedUrl: string | null; fileName: string })[] }> {
    const record = await this.get(id);
    if (record.status !== "completed") throw new DbBackupError("backup_not_completed", 409, "Only completed backups can be downloaded");
    const parts = orderedParts(record);
    const { objects } = await this.objectStore();
    const single = parts.length === 1;
    return {
      record,
      parts: parts.map((p) => {
        const fileName = single ? record.fileName : `${record.fileName}.part-${pad(p.index, 6)}`;
        let presignedUrl: string | null = null;
        try {
          presignedUrl = objects.presignGet(p.s3Key, expiresInSeconds, fileName);
        } catch {
          presignedUrl = null;
        }
        return { ...p, presignedUrl, fileName };
      }),
    };
  }

  /** Streams one stored part (the signed console download). */
  async openPart(id: string, index: number): Promise<{ stream: ReadableStream<Uint8Array>; part: BackupPart; fileName: string }> {
    const record = await this.get(id);
    if (record.status !== "completed") throw new DbBackupError("backup_not_completed", 409, "Only completed backups can be downloaded");
    const parts = orderedParts(record);
    const part = parts.find((p) => p.index === index);
    if (!part) throw new DbBackupError("backup_not_found", 404, "No such part");
    const { objects } = await this.objectStore();
    try {
      const stream = await objects.download(part.s3Key);
      return { stream, part, fileName: parts.length === 1 ? record.fileName : `${record.fileName}.part-${pad(index, 6)}` };
    } catch (err) {
      throw new DbBackupError("backup_s3_error", 502, cleanErrorMessage(err));
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Restore                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  /** Starts replacing the database with backup `id` (202); the caller re-checked the admin already. */
  async startRestore(id: string, actorId: string): Promise<BackupRecord> {
    this.assertNotRestoring();
    const runner = await this.requireRunner();
    const record = await this.get(id);
    if (record.status !== "completed") throw new DbBackupError("backup_not_completed", 409, "Only completed backups can be restored");
    if (record.restoreStatus === "running") throw new DbBackupError("restore_in_progress", 409, "This backup is already being restored");
    orderedParts(record);
    const { objects } = await this.objectStore();
    const release = await this.claim("restore", id);
    let marked = false;
    try {
      const begun = await this.store.beginRestore(id, this.nowIso(), actorId);
      if (!begun.ok) {
        if (begun.reason === "not_found") throw new DbBackupError("backup_not_found", 404, "Backup not found");
        if (begun.reason === "not_completed") throw new DbBackupError("backup_not_completed", 409, "Only completed backups can be restored");
        throw new DbBackupError("restore_in_progress", 409, "This backup is already being restored");
      }
      marked = true;
      // The live catalogue describes what is in the bucket; it is put back after the dump's own.
      const snapshot = await this.store.snapshotCatalogue();
      this.restoreView = snapshot;
      const done = this.executeRestore(begun.record, runner, objects, snapshot).finally(async () => {
        this.restoreView = null;
        await release();
      });
      this.running = done;
      return begun.record;
    } catch (err) {
      this.restoreView = null;
      // Never leave a restore marked running that will not run.
      if (marked) await this.store.updateRecord(id, { restoreStatus: "failed", restoreError: cleanErrorMessage(err) }).catch(() => undefined);
      await release();
      throw err;
    }
  }

  /** Downloads every part, verifying size and SHA-256, and gunzips them into `outPath`. */
  private async downloadDump(parts: BackupPart[], objects: BackupObjectStore, outPath: string): Promise<void> {
    const gunzip = createGunzip();
    const writing = pipeline(gunzip, createWriteStream(outPath));
    // A decompression error surfaces through `writing`; keep it from going unhandled meanwhile.
    writing.catch(() => undefined);
    const feed = async (chunk: Uint8Array) => {
      if (gunzip.destroyed) throw new Error("The backup archive is not valid gzip");
      if (!gunzip.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          gunzip.once("drain", resolve);
          gunzip.once("error", reject);
        });
      }
    };
    try {
      for (const p of parts) {
        const stream = await objects.download(p.s3Key);
        const hasher = new Bun.CryptoHasher("sha256");
        let read = 0;
        for await (const chunk of stream) {
          read += chunk.byteLength;
          if (read > p.sizeBytes) throw new Error(`Part ${p.index} is larger than recorded`);
          hasher.update(chunk);
          await feed(chunk);
        }
        if (read !== p.sizeBytes) throw new Error(`Part ${p.index} size mismatch: got ${read}, want ${p.sizeBytes}`);
        if (p.sha256 && hasher.digest("hex") !== p.sha256.toLowerCase()) throw new Error(`Part ${p.index} checksum mismatch`);
      }
      gunzip.end();
      await writing;
    } catch (err) {
      gunzip.destroy();
      await writing.catch(() => undefined);
      throw err;
    }
  }

  private async executeRestore(record: BackupRecord, runner: DbDumpRunner, objects: BackupObjectStore, snapshot: BackupCatalogue): Promise<void> {
    const abort = new AbortController();
    let dir: string | null = null;
    let replaced = false;
    try {
      const root = this.opts.tmpDir ?? process.env.SLIPGATE_BACKUP_TMP_DIR?.trim() ?? tmpdir();
      await mkdir(root, { recursive: true });
      dir = await mkdtemp(join(root, `slipgate-restore-${record.id}-`));
      const dumpPath = join(dir, "restore.sql");
      await this.setStage(record.id, "downloading");
      await this.downloadDump(orderedParts(record), objects, dumpPath);
      await this.setStage(record.id, "restoring");
      await runner.restore(dumpPath, abort.signal);
      replaced = true;
      // The database now holds the dump's (older) catalogue and configuration: put the live one back.
      await this.store.ensureSchema();
      const restoredAtIso = this.nowIso();
      const records = snapshot.records.map((r) =>
        r.id === record.id ? { ...r, restoreStatus: "completed" as const, restoredAtIso, restoreError: "", restoredBy: record.restoredBy } : r,
      );
      await this.store.replaceCatalogue({ config: snapshot.config, records });
      if (this.opts.afterRestore) {
        await this.opts.afterRestore().catch((err) => this.log(`post-restore refresh failed: ${cleanErrorMessage(err)}`));
      }
      this.log(`restored the database from ${record.id}`);
    } catch (err) {
      abort.abort();
      const message = cleanErrorMessage(err);
      this.log(`restore of ${record.id} failed: ${message}`);
      if (replaced) {
        // The dump is in place but the catalogue could not be rewritten: put back what we can.
        await this.store.replaceCatalogue(snapshot).catch(() => undefined);
      }
      await this.store.updateRecord(record.id, { restoreStatus: "failed", restoreError: message }).catch(() => undefined);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Scheduler and maintenance                                                                */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Interrupted operations: only when nobody (here or on another instance) holds the lock are
   * unfinished records orphans; they become failed. Their objects stay until an admin deletes the
   * record (a restore may have brought back a record of a backup that did complete).
   * Hourly it also applies manual-backup expiry and drops old failed records.
   */
  async maintenance(): Promise<void> {
    if (this.active) return;
    let release: (() => Promise<void>) | null = null;
    try {
      release = await this.claim("maintenance", "");
    } catch {
      return;
    }
    try {
      const failed = await this.store.failInterrupted(this.nowIso(), INTERRUPTED_BACKUP, INTERRUPTED_RESTORE);
      if (failed.backups.length || failed.restores.length) {
        this.log(`marked interrupted: backups [${failed.backups.join(", ")}], restores [${failed.restores.join(", ")}]`);
      }
      if (this.now() - this.lastPruneAt >= PRUNE_INTERVAL_MS) {
        this.lastPruneAt = this.now();
        await this.applyRetention(null);
      }
    } catch (err) {
      this.log(`maintenance failed: ${cleanErrorMessage(err)}`);
    } finally {
      await release();
    }
  }

  /** Re-reads the schedule and sets the timer for its next slot. */
  async arm(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    let schedule: BackupSchedule;
    try {
      schedule = await this.loadSchedule();
    } catch {
      return;
    }
    const nextIso = this.nextRun(schedule);
    if (!this.started) return;
    const next = nextIso ? Date.parse(nextIso) : null;
    const wait = next === null ? MAX_TIMER_MS : Math.max(0, Math.min(next - this.now(), MAX_TIMER_MS));
    this.timer = setTimeout(() => {
      this.timer = null;
      void (async () => {
        if (next !== null && this.now() >= next - 1000) await this.runScheduledBackup(new Date(next));
        await this.arm();
      })();
    }, wait);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Starts the scheduler and the maintenance pass (server entrypoint only). */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.maintenance();
    void this.arm();
    this.maintenanceTimer = setInterval(() => void this.maintenance(), MAINTENANCE_INTERVAL_MS);
    (this.maintenanceTimer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.timer = null;
    this.maintenanceTimer = null;
  }
}
