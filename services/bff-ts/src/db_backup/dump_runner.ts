import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

export type DumpRunnerCheck =
  | { ok: true; detail: string }
  | { ok: false; reason: "tool_missing" | "version_mismatch" | "check_failed"; detail: string };

/**
 * Produces and applies full database dumps. The service gzips, splits, uploads and verifies; the
 * runner only turns the live database into an uncompressed dump file and back. Tests inject a stub.
 */
export interface DbDumpRunner {
  /** Whether dump and restore can run here (tools present, client not older than the server). Never throws. */
  check(): Promise<DumpRunnerCheck>;
  /** Writes a full, uncompressed dump of the database to `outPath`. */
  dump(outPath: string, signal: AbortSignal): Promise<void>;
  /** Replaces the database with the dump at `dumpPath`, all or nothing. */
  restore(dumpPath: string, signal: AbortSignal): Promise<void>;
}

/** libpq connection-URI parameters passed through to the tools (the rest are postgres.js options). */
const LIBPQ_PARAMS = new Set([
  "sslmode",
  "sslrootcert",
  "sslcert",
  "sslkey",
  "sslcrl",
  "sslpassword",
  "connect_timeout",
  "application_name",
  "options",
  "target_session_attrs",
  "channel_binding",
  "gssencmode",
  "host",
  "hostaddr",
  "port",
]);

/** The URL the tools connect with (no password in it: that travels in PGPASSWORD). */
export function toolConnection(databaseUrl: string): { url: string; password: string } {
  const u = new URL(databaseUrl);
  const password = decodeURIComponent(u.password);
  u.password = "";
  for (const key of [...u.searchParams.keys()]) if (!LIBPQ_PARAMS.has(key)) u.searchParams.delete(key);
  return { url: u.toString(), password };
}

const SCHEMA_LINE = /^CREATE SCHEMA ("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*);$/;
const SCHEMA_SCAN_LIMIT = 64 * 1024 * 1024;

/**
 * The schemas a plain pg_dump file creates (pg_dump writes them before any table), read from the
 * head of the file. `public` is left out: it always exists and holds no Slipgate objects.
 */
export async function dumpSchemas(dumpPath: string): Promise<string[]> {
  const found: string[] = [];
  const decoder = new TextDecoder();
  let carry = "";
  let read = 0;
  const reader = Bun.file(dumpPath).stream().getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      read += value.byteLength;
      const lines = (carry + decoder.decode(value, { stream: true })).split("\n");
      carry = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(/\r$/, "");
        if (line.startsWith("CREATE TABLE ") || line.startsWith("COPY ")) return found;
        const m = SCHEMA_LINE.exec(line);
        if (m && m[1] !== "public" && m[1] !== '"public"' && !found.includes(m[1]!)) found.push(m[1]!);
      }
      if (read > SCHEMA_SCAN_LIMIT) break;
    }
  } finally {
    reader.releaseLock();
  }
  return found;
}

/**
 * SQL run in the restore's transaction before the dump: every schema the dump recreates is dropped
 * with everything in it, so the restore replaces the database instead of merging into it (tables
 * added since the backup go too) and fails nothing on "already exists".
 */
export function restorePreamble(schemas: string[]): string {
  const lines = ["-- slipgate restore: drop what the dump recreates", "SET client_min_messages = warning;"];
  for (const s of schemas) lines.push(`DROP SCHEMA IF EXISTS ${s} CASCADE;`);
  return `${lines.join("\n")}\n`;
}

function toolPath(name: string, binDir: string | undefined): string | null {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  if (binDir) {
    const p = join(binDir, exe);
    return existsSync(p) ? p : null;
  }
  return Bun.which(name);
}

async function runTool(cmd: string[], env: Record<string, string | undefined>, signal: AbortSignal, what: string): Promise<string> {
  const proc = Bun.spawn({ cmd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const kill = () => proc.kill();
  signal.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (signal.aborted) throw new Error(`${what} was cancelled`);
    if (code !== 0) {
      const tail = stderr.trim().split("\n").slice(-6).join("\n").slice(-1500);
      throw new Error(`${what} exited with code ${code}${tail ? `: ${tail}` : ""}`);
    }
    return stdout;
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

/**
 * Verifies that a legacy plain-SQL dump contains no client-side psql backslash meta-commands
 * (`\!`, `\i`, `\o`, `\copy`, `\setenv`, etc.) outside COPY ... FROM stdin data blocks.
 * PostgreSQL 17.6+ `\restrict` / `\unrestrict` guards are permitted.
 */
export async function assertSafePlainSqlDump(dumpPath: string): Promise<void> {
  const decoder = new TextDecoder();
  let carry = "";
  let inCopyData = false;
  const reader = Bun.file(dumpPath).stream().getReader();
  const processLine = (raw: string) => {
    const line = raw.replace(/\r$/, "");
    if (inCopyData) {
      if (line === "\\.") inCopyData = false;
      return;
    }
    if (/^COPY\s+.+\s+FROM\s+stdin\b/i.test(line)) {
      inCopyData = true;
      return;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("\\")) {
      if (/^\\(?:restrict|unrestrict)\s+[A-Za-z0-9_-]+$/.test(trimmed)) return;
      throw new Error(`Refusing plain SQL dump with psql backslash meta-command: ${trimmed.slice(0, 32)}`);
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (carry + decoder.decode(value, { stream: true })).split("\n");
      carry = lines.pop() ?? "";
      for (const raw of lines) processLine(raw);
    }
    if (carry) processLine(carry);
  } finally {
    reader.releaseLock();
  }
}

async function isCustomArchive(dumpPath: string): Promise<boolean> {
  const head = new Uint8Array(await Bun.file(dumpPath).slice(0, 5).arrayBuffer());
  return head.byteLength === 5 && head[0] === 0x50 && head[1] === 0x47 && head[2] === 0x44 && head[3] === 0x4d && head[4] === 0x50;
}

const CHECK_TTL_MS = 60_000;

/**
 * Uses pg_dump custom archive format (`--format=custom --compress=0`) + `pg_restore` (`--clean
 * --if-exists --single-transaction --exit-on-error`) when `pg_restore` is installed, eliminating
 * psql backslash meta-command risk; retains backward-compatible plain-SQL restore (hardened with
 * `assertSafePlainSqlDump`) for archives written by earlier versions.
 */
export class PgToolRunner implements DbDumpRunner {
  private cached: { at: number; result: DumpRunnerCheck } | null = null;

  constructor(
    private readonly databaseUrl: string,
    private readonly serverVersionNum: () => Promise<number | null>,
    private readonly binDir: string | undefined = process.env.SLIPGATE_PG_BIN_DIR?.trim() || undefined,
  ) {}

  private env(): Record<string, string | undefined> {
    const { password } = toolConnection(this.databaseUrl);
    return { ...process.env, PGPASSWORD: password || process.env.PGPASSWORD, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? "15" };
  }

  async check(): Promise<DumpRunnerCheck> {
    if (this.cached && Date.now() - this.cached.at < CHECK_TTL_MS) return this.cached.result;
    const result = await this.checkNow();
    this.cached = { at: Date.now(), result };
    return result;
  }

  private async checkNow(): Promise<DumpRunnerCheck> {
    const pgDump = toolPath("pg_dump", this.binDir);
    const pgRestore = toolPath("pg_restore", this.binDir);
    const psql = toolPath("psql", this.binDir);
    if (!pgDump || (!pgRestore && !psql)) {
      const missing = [!pgDump && "pg_dump", !pgRestore && !psql && "pg_restore/psql"].filter(Boolean).join(", ");
      return { ok: false, reason: "tool_missing", detail: `${missing} not found (install the PostgreSQL client tools or set SLIPGATE_PG_BIN_DIR)` };
    }
    try {
      const version = (await runTool([pgDump, "--version"], this.env(), new AbortController().signal, "pg_dump --version")).trim();
      const clientMajor = Number.parseInt(/(\d+)(?:\.\d+)?/.exec(version)?.[1] ?? "", 10);
      const serverNum = await this.serverVersionNum();
      const serverMajor = serverNum ? Math.floor(serverNum / 10_000) : null;
      if (serverMajor !== null && Number.isFinite(clientMajor) && clientMajor < serverMajor) {
        return {
          ok: false,
          reason: "version_mismatch",
          detail: `${version} cannot dump a PostgreSQL ${serverMajor} server; install client tools ${serverMajor} or newer`,
        };
      }
      return { ok: true, detail: version };
    } catch (err) {
      return { ok: false, reason: "check_failed", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async dump(outPath: string, signal: AbortSignal): Promise<void> {
    const pgDump = toolPath("pg_dump", this.binDir);
    if (!pgDump) throw new Error("pg_dump not found");
    const pgRestore = toolPath("pg_restore", this.binDir);
    const { url } = toolConnection(this.databaseUrl);
    const formatArgs = pgRestore ? ["--format=custom", "--compress=0"] : ["--format=plain"];
    await runTool(
      [pgDump, ...formatArgs, "--no-owner", "--no-acl", "--encoding=UTF8", `--file=${outPath}`, `--dbname=${url}`],
      this.env(),
      signal,
      "pg_dump",
    );
  }

  async restore(dumpPath: string, signal: AbortSignal): Promise<void> {
    const { url } = toolConnection(this.databaseUrl);
    if (await isCustomArchive(dumpPath)) {
      const pgRestore = toolPath("pg_restore", this.binDir);
      if (!pgRestore) throw new Error("pg_restore not found for custom-format archive");
      await runTool(
        [
          pgRestore,
          "--clean",
          "--if-exists",
          "--no-owner",
          "--no-acl",
          "--single-transaction",
          "--exit-on-error",
          `--dbname=${url}`,
          dumpPath,
        ],
        this.env(),
        signal,
        "pg_restore",
      );
      return;
    }

    const psql = toolPath("psql", this.binDir);
    if (!psql) throw new Error("psql not found");
    await assertSafePlainSqlDump(dumpPath);
    const schemas = await dumpSchemas(dumpPath);
    if (schemas.length === 0) throw new Error("The backup does not contain any schema to restore");
    const preamblePath = `${dumpPath}.preamble.sql`;
    await Bun.write(preamblePath, restorePreamble(schemas));
    try {
      await runTool(
        [psql, "-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", `--dbname=${url}`, "-f", preamblePath, "-f", dumpPath],
        this.env(),
        signal,
        "psql",
      );
    } finally {
      await unlink(preamblePath).catch(() => undefined);
    }
  }
}
