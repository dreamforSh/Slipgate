import { afterAll, describe, expect, it } from "bun:test";
import { gunzipSync } from "node:zlib";
import {
  DB_BACKUP_CRON_PREVIEW_MAX,
  type AuditLogItem,
  type BackupCronPreviewResponse,
  type BackupDownloadResponse,
  type BackupRecord,
  type BackupS3ConfigView,
  type BackupScheduleView,
  type BackupSystemStatus,
  type TestBackupS3Response,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { isValidTimeZone, nextCronRun, parseCron } from "../db_backup/cron.ts";
import { dumpSchemas, restorePreamble, toolConnection, type DbDumpRunner } from "../db_backup/dump_runner.ts";
import { s3ClientOptions } from "../db_backup/s3.ts";
import { assignMonthlyArchive, monthlyArchiveDates, type DbBackupService } from "../db_backup/service.ts";
import { verifyDownloadTicket } from "../routes/db_backups.ts";
import { totpAt, TOTP_STEP_SECONDS } from "../security/totp.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";
import { allowPrivateUpstreamsInSuite, withPrivateUpstreams } from "./private_upstreams.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "AdminPassword123!";
const BUCKET = "slipgate-test";
const ACCESS_KEY = "AKIDTESTKEY";
const SECRET_KEY = "fake-s3-secret-value-123456";

/** Set by an optional `bun test --preload` to run against Postgres (PGlite); see ops.test.ts. */
type StoreFactory = () => Promise<ControlStore>;
const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;

/* ------------------------------------------------------------------------------------------ */
/* Fake S3 (path-style, presigned or header-signed requests)                                  */
/* ------------------------------------------------------------------------------------------ */

function xmlError(status: number, code: string, message: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

function fakeS3() {
  const objects = new Map<string, Uint8Array>();
  const log: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const credential = url.searchParams.get("X-Amz-Credential") ?? /Credential=([^,\s]+)/.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
      if (!credential.startsWith(`${ACCESS_KEY}/`) || !url.searchParams.get("X-Amz-Signature")) {
        return xmlError(403, "InvalidAccessKeyId", "The AWS Access Key Id you provided does not exist in our records.");
      }
      const path = decodeURIComponent(url.pathname);
      if (!path.startsWith(`/${BUCKET}/`)) return xmlError(404, "NoSuchBucket", "The specified bucket does not exist");
      const key = path.slice(BUCKET.length + 2);
      log.push(`${req.method} ${key}`);
      if (req.method === "PUT") {
        objects.set(key, new Uint8Array(await req.arrayBuffer()));
        return new Response("", { headers: { ETag: '"etag"' } });
      }
      if (req.method === "GET") {
        const obj = objects.get(key);
        return obj ? new Response(obj, { headers: { "Content-Type": "application/octet-stream" } }) : xmlError(404, "NoSuchKey", "The specified key does not exist.");
      }
      if (req.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return xmlError(405, "MethodNotAllowed", "Method not allowed");
    },
  });
  return { objects, log, endpoint: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const s3Servers: ReturnType<typeof fakeS3>[] = [];
afterAll(() => {
  for (const s of s3Servers) s.stop();
});

/* ------------------------------------------------------------------------------------------ */
/* Stub dump runner                                                                           */
/* ------------------------------------------------------------------------------------------ */

class StubRunner implements DbDumpRunner {
  content: string;
  restored: string[] = [];
  gate: Promise<void> | null = null;
  failRestore = false;
  onRestore: (() => Promise<void>) | null = null;

  constructor(content = "-- stub dump\nCREATE SCHEMA commerce;\nCOPY commerce.users FROM stdin;\n\\.\n") {
    this.content = content;
    let mark: () => void = () => undefined;
    this.dumpStarted = new Promise<void>((resolve) => (mark = resolve));
    this.markStarted = mark;
  }

  async check() {
    return { ok: true as const, detail: "pg_dump (PostgreSQL) 17.2 (stub)" };
  }

  /** Resolves when a dump begins (the backup is then idle on the database until `gate` opens). */
  readonly dumpStarted: Promise<void>;
  private readonly markStarted: () => void;

  async dump(outPath: string): Promise<void> {
    this.markStarted();
    if (this.gate) await this.gate;
    await Bun.write(outPath, this.content);
  }

  async restore(dumpPath: string): Promise<void> {
    this.restored.push(await Bun.file(dumpPath).text());
    if (this.onRestore) await this.onRestore();
    if (this.failRestore) throw new Error("psql exited with code 3: ERROR:  relation already exists");
  }
}

/* ------------------------------------------------------------------------------------------ */
/* App bootstrap                                                                              */
/* ------------------------------------------------------------------------------------------ */

async function bootstrap(opts: { runner?: DbDumpRunner | null; splitPartSizeBytes?: number; memoryOnly?: boolean } = {}) {
  const store: ControlStore = !opts.memoryOnly && factory ? await factory() : new MemoryControlStore();
  // Postgres: let the startup index maintenance finish first, so no background statements overlap the test.
  await (store as { whenMaintenanceIdle?: () => Promise<void> }).whenMaintenanceIdle?.();
  const s3 = fakeS3();
  s3Servers.push(s3);
  const clock = { now: Date.parse("2026-03-01T03:00:00.000Z") };
  let service: DbBackupService | null = null;
  const runner = opts.runner === undefined ? new StubRunner() : opts.runner;
  const app = createBffApp({
    store,
    jwtSecret: "db-backup-test-jwt-secret-32-bytes-min",
    vaultSecret: "db-backup-test-vault-secret-32-bytes-min",
    internalToken: "db-backup-internal",
    dbBackup: {
      ...(opts.runner === undefined || opts.runner !== null ? { runner } : opts.memoryOnly ? {} : { runner: null }),
      splitPartSizeBytes: opts.splitPartSizeBytes,
      now: () => clock.now,
      onService: (s) => {
        service = s;
      },
    },
  });
  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  };
  const init = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Backup Test",
    adminEmail: "admin@backup.test",
    adminPassword: PASSWORD,
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  if (store !== undefined && !(store instanceof MemoryControlStore)) {
    // PGlite serves every pooled connection from one session and interleaves their protocol
    // messages; the request-log sink's timed background inserts would race the test's queries.
    await call("PUT", "/api/v1/admin/ops/runtime/logging", admin, { persistAccessLogs: false });
    await Bun.sleep(1_200);
  }
  const configureS3 = () =>
    call<BackupS3ConfigView>("PUT", "/api/v1/admin/db-backups/s3-config", admin, {
      endpoint: s3.endpoint,
      region: "us-east-1",
      bucket: BUCKET,
      accessKeyId: ACCESS_KEY,
      secretAccessKey: SECRET_KEY,
      prefix: "/nightly/",
      forcePathStyle: true,
      confirm: { password: PASSWORD },
    });
  const svc = () => {
    if (!service) throw new Error("service not exposed");
    return service as DbBackupService;
  };
  /** A request without credentials (the signed download route). */
  const raw = (path: string) => app.request(path, { method: "GET" });
  return { app, store, s3, clock, runner: runner as StubRunner, call, raw, admin, adminId: init.body.user.id, configureS3, svc };
}

const BASE = "/api/v1/admin/db-backups";

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers                                                                               */
/* ------------------------------------------------------------------------------------------ */

describe("cron expressions", () => {
  it("parses fields, names, steps and shorthands and rejects malformed input", () => {
    expect(parseCron("*/15 2-4 1,15 JAN-mar MON-fri").minute.values).toEqual([0, 15, 30, 45]);
    expect(parseCron("0 3 * * 7").dow.values).toEqual([0]);
    expect(parseCron("5/20 * * * *").minute.values).toEqual([5, 25, 45]);
    expect(parseCron("@daily").source).toBe("@daily");
    for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "a b c d e", "@every 5m", "5-1 * * * *"]) {
      expect(() => parseCron(bad)).toThrow();
    }
  });

  it("finds the next run in a time zone, across month ends, with day-of-month OR day-of-week", () => {
    const after = new Date("2026-03-01T03:00:00Z");
    expect(nextCronRun(parseCron("0 3 * * *"), after, "UTC")!.toISOString()).toBe("2026-03-02T03:00:00.000Z");
    // 02:00 in Shanghai (UTC+8) is 18:00 UTC the day before.
    expect(nextCronRun(parseCron("0 2 * * *"), after, "Asia/Shanghai")!.toISOString()).toBe("2026-03-01T18:00:00.000Z");
    expect(nextCronRun(parseCron("30 4 31 * *"), new Date("2026-04-01T00:00:00Z"), "UTC")!.toISOString()).toBe("2026-05-31T04:30:00.000Z");
    // Both restricted: the 15th OR any Monday (2026-03-02 is a Monday).
    expect(nextCronRun(parseCron("0 0 15 * 1"), after, "UTC")!.toISOString()).toBe("2026-03-02T00:00:00.000Z");
    // A day-of-week step clears "*": still AND with the unrestricted day-of-month.
    expect(nextCronRun(parseCron("0 0 * * */7"), after, "UTC")!.toISOString()).toBe("2026-03-08T00:00:00.000Z");
    // Leap day only.
    expect(nextCronRun(parseCron("0 0 29 2 *"), after, "UTC")!.toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(nextCronRun(parseCron("0 0 31 2 *"), after, "UTC")).toBeNull();
  });

  it("skips wall-clock times that do not exist on DST day", () => {
    // 2026-03-08 02:30 does not exist in New York (clocks jump 02:00 -> 03:00).
    const next = nextCronRun(parseCron("30 2 * * *"), new Date("2026-03-07T12:00:00Z"), "America/New_York")!;
    expect(next.toISOString()).toBe("2026-03-09T06:30:00.000Z");
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
  });
});

describe("monthly archive rule", () => {
  const schedule = {
    enabled: true,
    cronExpr: "0 3 * * *",
    timezone: "UTC",
    retainDays: 14,
    retainCount: 10,
    monthlyArchive: { enabled: true, days: [1, 31], includeMonthEnd: false, retainCount: 0 },
  };

  it("clamps days to the month length and adds the month end", () => {
    expect(monthlyArchiveDates(2026, 2, { enabled: true, days: [1, 31], includeMonthEnd: false, retainCount: 0 })).toEqual(["2026-02-01", "2026-02-28"]);
    expect(monthlyArchiveDates(2028, 2, { enabled: true, days: [15], includeMonthEnd: true, retainCount: 0 })).toEqual(["2028-02-15", "2028-02-29"]);
  });

  it("advances the checkpoint and archives only due dates once", () => {
    expect(assignMonthlyArchive("2026-03-01T03:00:00.000Z", schedule, "")).toEqual({
      checkpoint: "2026-03-01",
      archive: { dates: ["2026-03-01"], retainCount: 0 },
    });
    expect(assignMonthlyArchive("2026-03-01T09:00:00.000Z", schedule, "2026-03-01")).toBeNull();
    expect(assignMonthlyArchive("2026-03-02T03:00:00.000Z", schedule, "2026-03-01")).toEqual({ checkpoint: "2026-03-02", archive: null });
    // Only the backup's own month is considered: a missed 31st is not carried into April.
    expect(assignMonthlyArchive("2026-04-01T03:00:00.000Z", schedule, "2026-03-30")!.archive).toEqual({ dates: ["2026-04-01"], retainCount: 0 });
    // Dates already passed this month but after the checkpoint are covered by the next run.
    expect(assignMonthlyArchive("2026-03-02T03:00:00.000Z", schedule, "2026-02-27")!.archive).toEqual({ dates: ["2026-03-01"], retainCount: 0 });
    expect(assignMonthlyArchive("2026-03-31T23:00:00.000Z", { ...schedule, timezone: "Asia/Shanghai" }, "2026-03-30")!.archive).toEqual({
      dates: ["2026-04-01"],
      retainCount: 0,
    });
    expect(assignMonthlyArchive("2026-03-01T03:00:00.000Z", { ...schedule, monthlyArchive: { ...schedule.monthlyArchive, enabled: false } }, "")).toBeNull();
  });
});

describe("pg tool helpers", () => {
  it("keeps the password out of the tool URL and drops postgres.js-only parameters", () => {
    const conn = toolConnection("postgres://slip:p%40ss%3Aword@db:5432/slipgate?sslmode=disable&max=10");
    expect(conn.password).toBe("p@ss:word");
    expect(conn.url).toBe("postgres://slip@db:5432/slipgate?sslmode=disable");
  });

  it("reads the schemas a plain dump creates and drops them in the restore preamble", async () => {
    const dir = `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/slipgate-dump-scan-${crypto.randomUUID()}.sql`;
    await Bun.write(
      dir,
      'SET statement_timeout = 0;\nCREATE SCHEMA commerce;\nCREATE SCHEMA core;\nCREATE SCHEMA "Odd""Name";\nCREATE SCHEMA public;\nCREATE TABLE core.x (id int);\nCREATE SCHEMA late;\n',
    );
    const schemas = await dumpSchemas(dir);
    expect(schemas).toEqual(["commerce", "core", '"Odd""Name"']);
    expect(restorePreamble(schemas)).toContain('DROP SCHEMA IF EXISTS "Odd""Name" CASCADE;');
    expect(restorePreamble(schemas)).toContain("DROP SCHEMA IF EXISTS commerce CASCADE;");
  });

  it("builds path-style and virtual-hosted S3 client options", () => {
    const base = { region: "", bucket: "bkt", accessKeyId: "a", secretAccessKey: "s", prefix: "", endpoint: "" };
    expect(s3ClientOptions({ ...base, forcePathStyle: true })).toMatchObject({ region: "us-east-1", virtualHostedStyle: false });
    expect(s3ClientOptions({ ...base, forcePathStyle: false })).toMatchObject({ endpoint: "https://bkt.s3.us-east-1.amazonaws.com", virtualHostedStyle: true });
    expect(s3ClientOptions({ ...base, endpoint: "https://acc.r2.cloudflarestorage.com/", region: "auto", forcePathStyle: false })).toMatchObject({
      endpoint: "https://bkt.acc.r2.cloudflarestorage.com",
      virtualHostedStyle: true,
    });
    // A private endpoint (a MinIO on the LAN) is refused unless the operator opts in...
    expect(() => s3ClientOptions({ ...base, endpoint: "http://10.0.0.5:9000", forcePathStyle: false })).toThrow(/restricted/);
    // ...and IP endpoints can only be addressed path-style.
    expect(withPrivateUpstreams(() => s3ClientOptions({ ...base, endpoint: "http://10.0.0.5:9000", forcePathStyle: false }))).toMatchObject({
      endpoint: "http://10.0.0.5:9000",
      virtualHostedStyle: false,
    });
  });
});

/* ------------------------------------------------------------------------------------------ */
/* HTTP flows (memory, or Postgres via the preload)                                           */
/* ------------------------------------------------------------------------------------------ */

describe("database backups API", () => {
  allowPrivateUpstreamsInSuite();

  it("reports the in-memory store as unsupported", async () => {
    const { call, admin } = await bootstrap({ runner: null, memoryOnly: true });
    const status = await call<BackupSystemStatus>("GET", `${BASE}/status`, admin);
    expect(status.status).toBe(200);
    expect(status.body.supported).toBe(false);
    expect(status.body.reason).toBe("memory_store");
    const run = await call<{ error: string }>("POST", BASE, admin, {});
    expect(run.status).toBe(501);
    expect(run.body.error).toBe("backup_unsupported");
  });

  it("keeps the S3 secret encrypted, redacted and optional on update; tests the connection", async () => {
    const { call, admin, store, configureS3, s3 } = await bootstrap();
    const anon = await call("GET", `${BASE}/s3-config`, JSON_HEADERS);
    expect(anon.status).toBe(401);
    const user = await call<{ accessToken: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, { email: "u@backup.test", password: "UserPassword123!" });
    const userHeaders = { ...JSON_HEADERS, Authorization: `Bearer ${user.body.accessToken}` };
    expect((await call("GET", `${BASE}/s3-config`, userHeaders)).status).toBe(403);
    expect((await call("GET", `${BASE}/download/x`, userHeaders)).status).toBe(403);

    const empty = await call<BackupS3ConfigView>("GET", `${BASE}/s3-config`, admin);
    expect(empty.body).toMatchObject({ configured: false, secretAccessKeySet: false, bucket: "" });

    // Every future dump goes to this target: an admin session alone cannot repoint it.
    const target = { endpoint: s3.endpoint, region: "us-east-1", bucket: BUCKET, accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, prefix: "nightly", forcePathStyle: true };
    const unconfirmed = await call<{ error: string }>("PUT", `${BASE}/s3-config`, admin, target);
    expect(unconfirmed.status).toBe(403);
    expect(unconfirmed.body.error).toBe("step_up_required");
    const wrongPassword = await call<{ error: string }>("PUT", `${BASE}/s3-config`, admin, { ...target, confirm: { password: "not-it" } });
    expect(wrongPassword.body.error).toBe("invalid_password");
    expect((await call<BackupS3ConfigView>("GET", `${BASE}/s3-config`, admin)).body.configured).toBe(false);

    const saved = await configureS3();
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ configured: true, secretAccessKeySet: true, prefix: "nightly", bucket: BUCKET });
    expect(JSON.stringify(saved.body)).not.toContain(SECRET_KEY);
    const stored = await store.dbBackups.getConfig();
    expect(stored.s3?.secretEnc?.byteLength).toBeGreaterThan(12);
    expect(Buffer.from(stored.s3!.secretEnc!).toString("latin1")).not.toContain(SECRET_KEY);

    // Omitted secret: kept (same ciphertext); "" clears it.
    const renamed = await call<BackupS3ConfigView>("PUT", `${BASE}/s3-config`, admin, { ...saved.body, region: "auto", confirm: { password: PASSWORD } });
    expect(renamed.body.secretAccessKeySet).toBe(true);
    expect(Buffer.from((await store.dbBackups.getConfig()).s3!.secretEnc!).equals(Buffer.from(stored.s3!.secretEnc!))).toBe(true);

    const audit = await call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs?limit=20", admin);
    const bodies = audit.body.items.map((i) => i.requestBody ?? "").join("\n");
    expect(bodies).toContain('"secretAccessKey":"[redacted]"');
    expect(bodies).not.toContain(SECRET_KEY);
    expect(bodies).toContain('"confirm":{"password":"[redacted]"}');
    expect(bodies).not.toContain(PASSWORD);

    const ok = await call<TestBackupS3Response>("POST", `${BASE}/s3-config/test`, admin, { ...saved.body });
    expect(ok.body).toEqual({ ok: true, message: "Connection successful" });
    expect(s3.log.some((l) => l.startsWith("PUT nightly/.slipgate-write-test-"))).toBe(true);
    expect(s3.objects.size).toBe(0);
    const wrong = await call<TestBackupS3Response>("POST", `${BASE}/s3-config/test`, admin, { ...saved.body, accessKeyId: "WRONG" });
    expect(wrong.body.ok).toBe(false);
    expect(wrong.body.code).toBe("backup_s3_error");
    expect(wrong.body.message).toContain("InvalidAccessKeyId");
    expect(wrong.body.message).not.toContain("X-Amz-Signature");
    const incomplete = await call<TestBackupS3Response>("POST", `${BASE}/s3-config/test`, admin, { ...saved.body, secretAccessKey: "" });
    expect(incomplete.body.code).toBe("backup_s3_incomplete");

    const bad = await call<{ error: string }>("PUT", `${BASE}/s3-config`, admin, { ...saved.body, endpoint: "ftp://x", prefix: "../up" });
    expect(bad.status).toBe(400);

    const cleared = await call<BackupS3ConfigView>("PUT", `${BASE}/s3-config`, admin, { ...saved.body, secretAccessKey: "", confirm: { password: PASSWORD } });
    expect(cleared.body).toMatchObject({ secretAccessKeySet: false, configured: false });
    const refused = await call<{ error: string }>("POST", BASE, admin, {});
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("backup_s3_not_configured");
  });

  it("validates and stores the schedule", async () => {
    const { call, admin } = await bootstrap();
    const initial = await call<BackupScheduleView>("GET", `${BASE}/schedule`, admin);
    expect(initial.body).toMatchObject({ enabled: false, retainDays: 14, retainCount: 10, timezone: "UTC", nextRunAtIso: null });
    const schedule = {
      enabled: true,
      cronExpr: "0 3 * * *",
      timezone: "Asia/Shanghai",
      retainDays: 7,
      retainCount: 3,
      monthlyArchive: { enabled: true, days: [15, 1, 1], includeMonthEnd: true, retainCount: 6 },
    };
    expect((await call<{ error: string }>("PUT", `${BASE}/schedule`, admin, { ...schedule, cronExpr: "61 * * * *" })).body.error).toBe("backup_invalid_cron");
    expect((await call<{ error: string }>("PUT", `${BASE}/schedule`, admin, { ...schedule, cronExpr: "0 0 31 2 *" })).body.error).toBe("backup_invalid_cron");
    expect((await call<{ error: string }>("PUT", `${BASE}/schedule`, admin, { ...schedule, timezone: "Mars/Base" })).body.error).toBe("backup_invalid_timezone");
    const noDays = await call<{ error: string }>("PUT", `${BASE}/schedule`, admin, {
      ...schedule,
      monthlyArchive: { enabled: true, days: [], includeMonthEnd: false, retainCount: 0 },
    });
    expect(noDays.status).toBe(400);
    expect(noDays.body.error).toBe("bad_request");
    const saved = await call<BackupScheduleView>("PUT", `${BASE}/schedule`, admin, schedule);
    expect(saved.status).toBe(200);
    expect(saved.body.monthlyArchive.days).toEqual([1, 15]);
    // 03:00 Shanghai = 19:00 UTC; the test clock is 2026-03-01T03:00Z.
    expect(saved.body.nextRunAtIso).toBe("2026-03-01T19:00:00.000Z");
    const again = await call<BackupScheduleView>("GET", `${BASE}/schedule`, admin);
    expect(again.body).toEqual(saved.body);
    const status = await call<BackupSystemStatus>("GET", `${BASE}/status`, admin);
    expect(status.body.schedule).toEqual({ enabled: true, nextRunAtIso: "2026-03-01T19:00:00.000Z" });
  });

  it("previews unsaved cron expressions without saving or auditing them", async () => {
    const { call, admin } = await bootstrap();
    const preview = (cronExpr: string, timezone: string, count?: number) =>
      call<BackupCronPreviewResponse>(
        "GET",
        `${BASE}/schedule/preview?${new URLSearchParams({ cronExpr, timezone, ...(count === undefined ? {} : { count: String(count) }) })}`,
        admin,
      );
    expect((await call("GET", `${BASE}/schedule/preview?cronExpr=@daily&timezone=UTC`, JSON_HEADERS)).status).toBe(401);

    // The test clock is 2026-03-01T03:00Z; 03:00 Shanghai = 19:00 UTC the day before.
    const ok = await preview("0 3 * * *", "Asia/Shanghai", 3);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({
      valid: true,
      error: null,
      message: "",
      runsIso: ["2026-03-01T19:00:00.000Z", "2026-03-02T19:00:00.000Z", "2026-03-03T19:00:00.000Z"],
    });
    expect((await preview("@hourly", "UTC")).body.runsIso).toHaveLength(5);
    expect((await preview("@hourly", "UTC", 500)).body.runsIso).toHaveLength(DB_BACKUP_CRON_PREVIEW_MAX);

    const badCron = await preview("61 * * * *", "UTC");
    expect(badCron.body).toMatchObject({ valid: false, error: "backup_invalid_cron", runsIso: [] });
    expect(badCron.body.message).not.toBe("");
    expect((await preview("0 0 31 2 *", "UTC")).body).toMatchObject({ valid: false, error: "backup_invalid_cron", message: "The cron expression never fires" });
    expect((await preview("", "UTC")).body.error).toBe("backup_invalid_cron");
    expect((await preview("0 3 * * *", "Mars/Base")).body).toMatchObject({ valid: false, error: "backup_invalid_timezone" });

    // Nothing was saved, and GET requests stay out of the audit log.
    expect((await call<BackupScheduleView>("GET", `${BASE}/schedule`, admin)).body.cronExpr).toBe("0 3 * * *");
    expect((await call<BackupScheduleView>("GET", `${BASE}/schedule`, admin)).body.enabled).toBe(false);
    const audit = await call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs?limit=50", admin);
    expect(audit.body.items.some((i) => i.path.includes("/schedule/preview"))).toBe(false);
  });

  it("runs a manual backup, refuses a second one meanwhile, downloads it with a signed link and deletes it", async () => {
    const { call, raw, admin, configureS3, runner, s3, svc, store } = await bootstrap();
    await configureS3();
    let open!: () => void;
    runner.gate = new Promise<void>((resolve) => (open = resolve));
    const started = await call<BackupRecord>("POST", BASE, admin, { expireDays: 3 });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ status: "running", triggeredBy: "manual", backupType: "postgres" });
    expect(started.body.id).toMatch(/^bk_[0-9a-f]{10}$/);
    expect(started.body.expiresAtIso).toBe("2026-03-04T03:00:00.000Z");
    expect(started.body.s3Key).toBe(`nightly/2026/03/01/${started.body.fileName}`);
    await runner.dumpStarted;

    const busy = await call<{ error: string }>("POST", BASE, admin, {});
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe("backup_in_progress");
    const status = await call<BackupSystemStatus>("GET", `${BASE}/status`, admin);
    expect(status.body.activeOperation).toMatchObject({ kind: "backup", backupId: started.body.id });
    expect(status.body.supported).toBe(true);
    const runningDelete = await call<{ error: string }>("DELETE", `${BASE}/${started.body.id}`, admin);
    expect(runningDelete.body.error).toBe("backup_in_progress");

    open();
    await svc().whenIdle();
    const done = await call<BackupRecord>("GET", `${BASE}/${started.body.id}`, admin);
    expect(done.body).toMatchObject({ status: "completed", progress: "", errorMessage: "" });
    expect(done.body.parts).toHaveLength(1);
    const object = s3.objects.get(done.body.s3Key)!;
    expect(new TextDecoder().decode(gunzipSync(object))).toBe(runner.content);
    expect(done.body.parts[0]).toMatchObject({ index: 1, s3Key: done.body.s3Key, sizeBytes: object.byteLength });
    expect(done.body.parts[0]!.sha256).toBe(new Bun.CryptoHasher("sha256").update(object).digest("hex"));
    expect((await call<{ items: BackupRecord[] }>("GET", BASE, admin)).body.items.map((r) => r.id)).toEqual([started.body.id]);

    // Download: password re-check, then a signed console link (no auth header) and a presigned one.
    const denied = await call<{ error: string }>("POST", `${BASE}/${started.body.id}/download`, admin, { password: "nope" });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("invalid_password");
    const dl = await call<BackupDownloadResponse>("POST", `${BASE}/${started.body.id}/download`, admin, { password: PASSWORD });
    expect(dl.status).toBe(200);
    expect(dl.body.parts).toHaveLength(1);
    const part = dl.body.parts[0]!;
    expect(part.fileName).toBe(done.body.fileName);
    const fetched = await raw(part.url);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-disposition")).toContain(done.body.fileName);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(Buffer.from(object))).toBe(true);
    const presigned = await fetch(part.presignedUrl!);
    expect(Buffer.from(await presigned.arrayBuffer()).equals(Buffer.from(object))).toBe(true);
    const ticket = part.url.split("/").pop()!;
    expect(await verifyDownloadTicket(ticket, "db-backup-test-jwt-secret-32-bytes-min")).toMatchObject({ b: started.body.id, p: 1 });
    expect((await raw(`${part.url.slice(0, -2)}xx`)).status).toBe(403);
    expect((await raw(part.url.replace(/\.[^.]+$/, ".AAAA"))).status).toBe(403);

    // Signing out everywhere ends outstanding links.
    const revoke = await call<{ session?: { accessToken: string } }>("POST", "/api/v1/user/sessions/revoke-all", admin, { keepCurrent: true });
    expect(revoke.status).toBe(200);
    expect((await raw(part.url)).status).toBe(403);
    const fresh = { ...JSON_HEADERS, Authorization: `Bearer ${revoke.body.session!.accessToken}` };

    const removed = await call<{ deleted: boolean }>("DELETE", `${BASE}/${started.body.id}`, fresh);
    expect(removed.body.deleted).toBe(true);
    expect(s3.objects.has(done.body.s3Key)).toBe(false);
    expect(await store.dbBackups.getRecord(started.body.id)).toBeNull();
    expect((await call<{ error: string }>("GET", `${BASE}/${started.body.id}`, fresh)).status).toBe(404);
    expect((await call<{ error: string }>("GET", `${BASE}/not-an-id`, fresh)).body.error).toBe("backup_not_found");
  });

  it("splits large archives into verified parts and restores them, keeping the live catalogue", async () => {
    const runner = new StubRunner(`CREATE SCHEMA commerce;\n${Buffer.from(crypto.getRandomValues(new Uint8Array(150_000))).toString("base64")}\n`);
    const { call, raw, admin, configureS3, s3, svc, store, clock } = await bootstrap({ runner, splitPartSizeBytes: 32 * 1024 });
    await configureS3();
    const first = await call<BackupRecord>("POST", BASE, admin, { expireDays: 0 });
    expect(first.body.expiresAtIso).toBeNull();
    await svc().whenIdle();
    const rec = (await call<BackupRecord>("GET", `${BASE}/${first.body.id}`, admin)).body;
    expect(rec.status).toBe("completed");
    expect(rec.s3Key).toBe("");
    expect(rec.parts.length).toBeGreaterThan(2);
    expect(rec.parts.map((p) => p.index)).toEqual(rec.parts.map((_, i) => i + 1));
    expect(rec.parts[0]!.s3Key).toBe(`nightly/2026/03/01/${rec.id}/payload.part-000001`);
    const joined = Buffer.concat(rec.parts.map((p) => Buffer.from(s3.objects.get(p.s3Key)!)));
    expect(joined.byteLength).toBe(rec.sizeBytes);
    expect(gunzipSync(joined).toString()).toBe(runner.content);

    const dl = await call<BackupDownloadResponse>("POST", `${BASE}/${rec.id}/download`, admin, { password: PASSWORD });
    expect(dl.body.parts.map((p) => p.fileName)).toEqual(rec.parts.map((p) => `${rec.fileName}.part-${String(p.index).padStart(6, "0")}`));
    const second = await raw(dl.body.parts[1]!.url);
    expect(Buffer.from(await second.arrayBuffer()).equals(Buffer.from(s3.objects.get(rec.parts[1]!.s3Key)!))).toBe(true);

    // A later backup exists only in the live catalogue; the "dump" holds an older one.
    clock.now += 60_000;
    runner.content = "CREATE SCHEMA commerce;\n-- newer\n";
    const later = await call<BackupRecord>("POST", BASE, admin, {});
    await svc().whenIdle();
    runner.onRestore = async () => {
      await store.dbBackups.replaceCatalogue({ config: { s3: null, schedule: null, archiveCheckpoint: "" }, records: [] });
    };

    expect((await call<{ error: string }>("POST", `${BASE}/${rec.id}/restore`, admin, { password: PASSWORD, confirm: "yes" })).body.error).toBe("confirm_mismatch");
    expect((await call<{ error: string }>("POST", `${BASE}/${rec.id}/restore`, admin, { password: "bad", confirm: rec.id })).body.error).toBe("invalid_password");
    const restoring = await call<BackupRecord>("POST", `${BASE}/${rec.id}/restore`, admin, { password: PASSWORD, confirm: rec.id });
    expect(restoring.status).toBe(202);
    expect(restoring.body.restoreStatus).toBe("running");
    await svc().whenIdle();
    expect(runner.restored).toHaveLength(1);
    expect(runner.restored[0]).toBe(`CREATE SCHEMA commerce;\n${runner.restored[0]!.split("\n")[1]}\n`);
    expect(runner.restored[0]!.length).toBeGreaterThan(150_000);

    const items = (await call<{ items: BackupRecord[] }>("GET", BASE, admin)).body.items;
    expect(items.map((r) => r.id)).toEqual([later.body.id, rec.id]);
    const restored = items.find((r) => r.id === rec.id)!;
    expect(restored).toMatchObject({ restoreStatus: "completed", restoreError: "" });
    expect(restored.restoredAtIso).not.toBeNull();
    expect((await call<BackupS3ConfigView>("GET", `${BASE}/s3-config`, admin)).body).toMatchObject({ configured: true, bucket: BUCKET });
  });

  it("verifies checksums before restoring, reports restore failures and requires 2FA when it is on", async () => {
    const { call, admin, configureS3, s3, svc, runner } = await bootstrap();
    await configureS3();
    const created = await call<BackupRecord>("POST", BASE, admin, {});
    await svc().whenIdle();
    const rec = (await call<BackupRecord>("GET", `${BASE}/${created.body.id}`, admin)).body;

    // Tampered object: the restore stops before touching the database.
    const original = s3.objects.get(rec.s3Key)!;
    s3.objects.set(rec.s3Key, Uint8Array.from(original, (b, i) => (i === original.byteLength - 1 ? b ^ 0xff : b)));
    const tampered = await call<BackupRecord>("POST", `${BASE}/${rec.id}/restore`, admin, { password: PASSWORD, confirm: rec.id });
    expect(tampered.status).toBe(202);
    await svc().whenIdle();
    expect(runner.restored).toHaveLength(0);
    const afterTamper = (await call<BackupRecord>("GET", `${BASE}/${rec.id}`, admin)).body;
    expect(afterTamper.restoreStatus).toBe("failed");
    expect(afterTamper.restoreError).toContain("checksum mismatch");

    // Intact object but the database refuses the dump (psql ran in one transaction: nothing changed).
    s3.objects.set(rec.s3Key, original);
    runner.failRestore = true;
    const failing = await call<BackupRecord>("POST", `${BASE}/${rec.id}/restore`, admin, { password: PASSWORD, confirm: rec.id });
    expect(failing.status).toBe(202);
    await svc().whenIdle();
    expect(runner.restored).toHaveLength(1);
    const afterFail = (await call<BackupRecord>("GET", `${BASE}/${rec.id}`, admin)).body;
    expect(afterFail.restoreStatus).toBe("failed");
    expect(afterFail.restoreError).toContain("relation already exists");

    // Two-factor on: download and restore need the code too.
    runner.failRestore = false;
    const setup = await call<{ secret: string }>("POST", "/api/v1/user/totp/setup", admin, { password: PASSWORD });
    const step = () => Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    expect((await call("POST", "/api/v1/user/totp/enable", admin, { code: await totpAt(setup.body.secret, step() - 1) })).status).toBe(200);
    const noCode = await call<{ error: string }>("POST", `${BASE}/${rec.id}/download`, admin, { password: PASSWORD });
    expect(noCode.body.error).toBe("totp_required");
    const badCode = await call<{ error: string }>("POST", `${BASE}/${rec.id}/download`, admin, { password: PASSWORD, totpCode: "000000" });
    expect(badCode.body.error).toBe("invalid_totp");
    const withCode = await call<BackupDownloadResponse>("POST", `${BASE}/${rec.id}/download`, admin, {
      password: PASSWORD,
      totpCode: await totpAt(setup.body.secret, step()),
    });
    expect(withCode.status).toBe(200);
    const restoreNoCode = await call<{ error: string }>("POST", `${BASE}/${rec.id}/restore`, admin, { password: PASSWORD, confirm: rec.id });
    expect(restoreNoCode.body.error).toBe("totp_required");
    const restored = await call<BackupRecord>("POST", `${BASE}/${rec.id}/restore`, admin, {
      password: PASSWORD,
      totpCode: await totpAt(setup.body.secret, step() + 1),
      confirm: rec.id,
    });
    expect(restored.status).toBe(202);
    await svc().whenIdle();
    expect((await call<BackupRecord>("GET", `${BASE}/${rec.id}`, admin)).body).toMatchObject({ restoreStatus: "completed", restoreError: "" });
  });

  it("applies scheduled retention, monthly archive copies and one backup per cron slot", async () => {
    const { call, admin, configureS3, s3, svc, clock } = await bootstrap();
    await configureS3();
    await call("PUT", `${BASE}/schedule`, admin, {
      enabled: true,
      cronExpr: "0 3 * * *",
      timezone: "UTC",
      retainDays: 0,
      retainCount: 2,
      monthlyArchive: { enabled: true, days: [1], includeMonthEnd: false, retainCount: 1 },
    });
    const manual = await call<BackupRecord>("POST", BASE, admin, { expireDays: 0 });
    await svc().whenIdle();

    const run = async (iso: string) => {
      clock.now = Date.parse(iso);
      return svc().runScheduledBackup(new Date(iso));
    };
    const mar1 = (await run("2026-03-01T03:00:00.000Z"))!;
    expect(mar1.monthlyArchive).toEqual({ dates: ["2026-03-01"], retainCount: 1 });
    expect(mar1.expiresAtIso).toBeNull();
    expect(await run("2026-03-01T03:00:00.000Z")).toBeNull();
    const mar2 = (await run("2026-03-02T03:00:00.000Z"))!;
    expect(mar2.monthlyArchive).toBeNull();
    expect(mar2.expiresAtIso).toBeNull();
    const mar3 = (await run("2026-03-03T03:00:00.000Z"))!;
    const mar4 = (await run("2026-03-04T03:00:00.000Z"))!;

    let ids = (await call<{ items: BackupRecord[] }>("GET", BASE, admin)).body.items.map((r) => r.id);
    // retainCount 2 among ordinary scheduled backups; the archive copy and the manual one are kept.
    expect(new Set(ids)).toEqual(new Set([mar4.id, mar3.id, mar1.id, manual.body.id]));
    expect(ids).not.toContain(mar2.id);
    expect(s3.objects.has(mar2.s3Key)).toBe(false);
    expect(ids).toContain(mar1.id);

    // An archived copy needs explicit confirmation to delete.
    const protectedDelete = await call<{ error: string }>("DELETE", `${BASE}/${mar1.id}`, admin);
    expect(protectedDelete.status).toBe(409);
    expect(protectedDelete.body.error).toBe("backup_archive_protected");

    // The next month's archive copy pushes the older one out of the pool of 1.
    const apr1 = (await run("2026-04-01T03:00:00.000Z"))!;
    expect(apr1.monthlyArchive).toEqual({ dates: ["2026-04-01"], retainCount: 1 });
    ids = (await call<{ items: BackupRecord[] }>("GET", BASE, admin)).body.items.map((r) => r.id);
    expect(ids).toContain(apr1.id);
    expect(ids).not.toContain(mar1.id);
    expect(s3.objects.has(mar1.s3Key)).toBe(false);
    const archivedDelete = await call<{ deleted: boolean }>("DELETE", `${BASE}/${apr1.id}?deleteArchived=true`, admin);
    expect(archivedDelete.body.deleted).toBe(true);
  });

  it("fails interrupted operations and prunes expired manual backups in the maintenance pass", async () => {
    const { call, admin, configureS3, s3, svc, clock, store } = await bootstrap();
    await configureS3();
    const short = await call<BackupRecord>("POST", BASE, admin, { expireDays: 1 });
    await svc().whenIdle();
    const keep = await call<BackupRecord>("POST", BASE, admin, { expireDays: 30 });
    await svc().whenIdle();
    const orphan: BackupRecord = {
      ...keep.body,
      id: "bk_00000000aa",
      status: "running",
      progress: "uploading",
      startedAtIso: new Date(clock.now).toISOString(),
      parts: [],
      monthlyArchive: null,
      expiresAtIso: null,
    };
    expect(await store.dbBackups.insertRecord(orphan)).toBe(true);
    const restoring = await store.dbBackups.updateRecord(keep.body.id, { restoreStatus: "running", restoreStartedAtIso: new Date(clock.now).toISOString() });
    expect(restoring?.restoreStatus).toBe("running");

    clock.now += 2 * 86_400_000;
    await svc().maintenance();
    const items = (await call<{ items: BackupRecord[] }>("GET", BASE, admin)).body.items;
    expect(items.find((r) => r.id === short.body.id)).toBeUndefined();
    expect(s3.objects.has(short.body.s3Key)).toBe(false);
    expect(items.find((r) => r.id === orphan.id)).toMatchObject({ status: "failed", progress: "" });
    expect(items.find((r) => r.id === orphan.id)!.errorMessage).toContain("Interrupted");
    expect(items.find((r) => r.id === keep.body.id)).toMatchObject({ status: "completed", restoreStatus: "failed" });
  });
});

