import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  BackupDownloadRequestSchema,
  CreateBackupRequestSchema,
  DB_BACKUP_ID_RE,
  RestoreBackupRequestSchema,
  TestBackupS3RequestSchema,
  UpdateBackupS3ConfigRequestSchema,
  UpdateBackupScheduleRequestSchema,
  type BackupDownloadResponse,
  type BackupStepUpRequest,
} from "@slipgate/contracts";
import type { DbDumpRunner } from "../db_backup/dump_runner.ts";
import type { BackupObjectStoreFactory } from "../db_backup/s3.ts";
import { DbBackupError, DbBackupService } from "../db_backup/service.ts";
import { WindowLimiter } from "../insights.ts";
import type { AuthEnv, SessionManager } from "../middleware/auth.ts";
import { clientIp } from "../security/client_ip.ts";
import { decryptSecret } from "../security/crypto.ts";
import { verifyTotp } from "../security/totp.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

export interface DbBackupRouteContext {
  service: DbBackupService;
  store: ControlStore;
  sessions: SessionManager;
  vaultSecret: string;
  /** Keys the download links (HMAC); never leaves the BFF. */
  jwtSecret: string;
}

/** BffAppOptions.dbBackup: test hooks for the backup service. */
export interface DbBackupAppOptions {
  /** Replaces pg_dump/psql (null = report backups as unsupported). */
  runner?: DbDumpRunner | null;
  objectStoreFactory?: BackupObjectStoreFactory;
  splitPartSizeBytes?: number;
  tmpDir?: string;
  now?: () => number;
  /** Receives the service (tests drive scheduled runs and wait for background work). */
  onService?: (service: DbBackupService) => void;
}

/** Builds the service, registers the routes and (server only) starts the scheduler. */
export function mountDbBackups(
  app: Hono<AuthEnv>,
  ctx: Omit<DbBackupRouteContext, "service"> & {
    options?: DbBackupAppOptions;
    afterRestore: () => Promise<void>;
    startScheduler: boolean;
  },
): DbBackupService {
  const { onService, ...hooks } = ctx.options ?? {};
  const service = new DbBackupService({ ...hooks, store: ctx.store.dbBackups, vaultSecret: ctx.vaultSecret, afterRestore: ctx.afterRestore });
  registerDbBackupRoutes(app, { service, store: ctx.store, sessions: ctx.sessions, vaultSecret: ctx.vaultSecret, jwtSecret: ctx.jwtSecret });
  onService?.(service);
  if (ctx.startScheduler) service.start();
  return service;
}

/** Download links (console stream and presigned) stay valid this long. */
export const DOWNLOAD_LINK_TTL_SECONDS = 30 * 60;

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  return new Uint8Array(Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

interface TicketClaims {
  /** backup id */
  b: string;
  /** part index */
  p: number;
  /** admin user id */
  u: string;
  /** that admin's token version when the link was made (sign-out-everywhere ends the link) */
  v: number;
  /** expiry, unix seconds */
  e: number;
}

async function hmacKey(jwtSecret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(`slipgate-db-backup-download:${jwtSecret}`), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signDownloadTicket(claims: TicketClaims, jwtSecret: string): Promise<string> {
  const payload = b64url(encoder.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(jwtSecret), encoder.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

export async function verifyDownloadTicket(ticket: string, jwtSecret: string, nowMs = Date.now()): Promise<TicketClaims | null> {
  if (ticket.length > 1024) return null;
  const [payload, sigText, extra] = ticket.split(".");
  if (!payload || !sigText || extra !== undefined) return null;
  const sig = fromB64url(sigText);
  if (!sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(jwtSecret), sig, encoder.encode(payload));
  if (!ok) return null;
  try {
    const raw = fromB64url(payload);
    if (!raw) return null;
    const c = JSON.parse(new TextDecoder().decode(raw)) as TicketClaims;
    if (typeof c.b !== "string" || !DB_BACKUP_ID_RE.test(c.b)) return null;
    if (!Number.isSafeInteger(c.p) || c.p < 1 || typeof c.u !== "string" || !c.u) return null;
    if (!Number.isSafeInteger(c.v) || !Number.isSafeInteger(c.e) || c.e * 1000 <= nowMs) return null;
    return c;
  } catch {
    return null;
  }
}

function fail(c: Context, err: DbBackupError) {
  return c.json({ error: err.code, message: err.message }, err.status);
}

function bad(issues: z.ZodIssue[]): never {
  const message = issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
  throw new StoreError("bad_request", message || "Invalid request");
}

async function body<T extends z.ZodTypeAny>(c: Context, schema: T, allowEmpty = false): Promise<z.infer<T>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim() || !allowEmpty) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new StoreError("bad_request", "Malformed JSON request body");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) bad(parsed.error.issues);
  return parsed.data;
}

function backupId(c: Context): string {
  const id = c.req.param("id") ?? "";
  if (!DB_BACKUP_ID_RE.test(id)) throw new DbBackupError("backup_not_found", 404, "Backup not found");
  return id;
}

/**
 * Full database backups (admin only; requireAdmin + audit are mounted on /api/v1/admin/* by
 * createBffApp, and the audit log redacts password / secret / totp fields). Download and restore
 * re-check the admin's password and, when on, the two-factor code.
 */
export function registerDbBackupRoutes(app: Hono<AuthEnv>, ctx: DbBackupRouteContext): void {
  const { service, store, sessions, vaultSecret, jwtSecret } = ctx;
  const totpLimiter = new WindowLimiter(8, 5 * 60_000);

  type Handler = (c: Context<AuthEnv>) => Promise<Response>;
  const guarded =
    (fn: Handler): Handler =>
    async (c) => {
      try {
        return await fn(c);
      } catch (err) {
        if (err instanceof DbBackupError) return fail(c, err);
        throw err;
      }
    };

  /** null when the admin passed; otherwise the refusal to send. */
  async function stepUp(c: Context<AuthEnv>, req: BackupStepUpRequest): Promise<Response | null> {
    const claims = c.get("authUser");
    const check = await sessions.confirmPassword(claims.sub, clientIp(c), req.password);
    if (!check.ok) {
      if (check.retryAfterSeconds !== null) {
        c.header("Retry-After", String(check.retryAfterSeconds));
        return c.json({ error: "too_many_attempts", message: "Too many wrong passwords, try again later" }, 429);
      }
      return c.json({ error: "invalid_password", message: "Password confirmation failed" }, 403);
    }
    const totp = await store.ops.getTotp(claims.sub);
    if (totp?.enabled) {
      if (!req.totpCode) return c.json({ error: "totp_required", message: "Enter the code from your authenticator app" }, 403);
      if (!totpLimiter.allow(claims.sub)) return c.json({ error: "too_many_attempts", message: "Too many attempts, try again later" }, 429);
      let secret: string | null = null;
      try {
        secret = totp.secretEnc ? await decryptSecret(totp.secretEnc, vaultSecret) : null;
      } catch {
        secret = null;
      }
      if (!secret || !(await verifyTotp(secret, req.totpCode, claims.sub))) {
        return c.json({ error: "invalid_totp", message: "The two-factor code is not valid" }, 403);
      }
    }
    return null;
  }

  app.get("/api/v1/admin/db-backups/status", guarded(async (c) => c.json(await service.status())));

  app.get("/api/v1/admin/db-backups/s3-config", guarded(async (c) => c.json(await service.getS3Config())));

  app.put(
    "/api/v1/admin/db-backups/s3-config",
    guarded(async (c) => {
      const { confirm, ...cfg } = await body(c, UpdateBackupS3ConfigRequestSchema);
      // The target receives every future full-database dump: a stolen session must not repoint it.
      if (!confirm) return c.json({ error: "step_up_required", message: "Confirm this change with your password" }, 403);
      const refused = await stepUp(c, confirm);
      if (refused) return refused;
      return c.json(await service.updateS3Config(cfg));
    }),
  );

  app.post(
    "/api/v1/admin/db-backups/s3-config/test",
    guarded(async (c) => {
      const { confirm: _confirm, ...cfg } = await body(c, TestBackupS3RequestSchema);
      return c.json(await service.testS3(cfg));
    }),
  );

  app.get("/api/v1/admin/db-backups/schedule", guarded(async (c) => c.json(await service.getSchedule())));

  app.put(
    "/api/v1/admin/db-backups/schedule",
    guarded(async (c) => c.json(await service.updateSchedule(await body(c, UpdateBackupScheduleRequestSchema)))),
  );

  // Read-only check of an unsaved expression for the schedule form (GET: not written to the audit log).
  app.get("/api/v1/admin/db-backups/schedule/preview", (c) => {
    const cronExpr = (c.req.query("cronExpr") ?? "").slice(0, 120);
    const timezone = (c.req.query("timezone") ?? "").slice(0, 64);
    const count = Number(c.req.query("count") ?? "5");
    c.header("Cache-Control", "no-store");
    return c.json(service.previewCron(cronExpr, timezone, Number.isFinite(count) ? count : 5));
  });

  app.get(
    "/api/v1/admin/db-backups",
    guarded(async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json({ items: await service.list() });
    }),
  );

  app.post(
    "/api/v1/admin/db-backups",
    guarded(async (c) => {
      const req = await body(c, CreateBackupRequestSchema, true);
      return c.json(await service.startManualBackup(c.get("authUser").sub, req.expireDays), 202);
    }),
  );

  app.get("/api/v1/admin/db-backups/:id", guarded(async (c) => c.json(await service.get(backupId(c)))));

  app.delete(
    "/api/v1/admin/db-backups/:id",
    guarded(async (c) => {
      const id = backupId(c);
      await service.deleteBackup(id, c.req.query("deleteArchived") === "true");
      return c.json({ deleted: true });
    }),
  );

  app.post(
    "/api/v1/admin/db-backups/:id/download",
    guarded(async (c) => {
      const id = backupId(c);
      const req = await body(c, BackupDownloadRequestSchema);
      const refused = await stepUp(c, req);
      if (refused) return refused;
      const claims = c.get("authUser");
      const state = await store.ops.getSessionState(claims.sub);
      if (!state.user) return c.json({ error: "unauthorized", message: "User no longer exists" }, 401);
      const plan = await service.downloadPlan(id, DOWNLOAD_LINK_TTL_SECONDS);
      const exp = Math.floor(Date.now() / 1000) + DOWNLOAD_LINK_TTL_SECONDS;
      const parts = await Promise.all(
        plan.parts.map(async (p) => ({
          index: p.index,
          sizeBytes: p.sizeBytes,
          sha256: p.sha256,
          fileName: p.fileName,
          presignedUrl: p.presignedUrl,
          url: `/api/v1/db-backups/download/${await signDownloadTicket({ b: id, p: p.index, u: claims.sub, v: state.user!.tokenVersion, e: exp }, jwtSecret)}`,
        })),
      );
      const response: BackupDownloadResponse = {
        backupId: id,
        fileName: plan.record.fileName,
        sizeBytes: plan.record.sizeBytes,
        expiresAtIso: new Date(exp * 1000).toISOString(),
        parts,
      };
      c.header("Cache-Control", "no-store");
      return c.json(response);
    }),
  );

  app.post(
    "/api/v1/admin/db-backups/:id/restore",
    guarded(async (c) => {
      const id = backupId(c);
      const req = await body(c, RestoreBackupRequestSchema);
      if (req.confirm !== id) {
        return c.json({ error: "confirm_mismatch", message: `Type the backup id (${id}) to confirm the restore` }, 400);
      }
      const refused = await stepUp(c, req);
      if (refused) return refused;
      return c.json(await service.startRestore(id, c.get("authUser").sub), 202);
    }),
  );

  /**
   * Signed download link: no Authorization header (a plain browser download), but only links minted
   * by POST …/download after the password (and 2FA) re-check, for 30 minutes, for one part, and only
   * while their admin is still an active admin at the same token version.
   */
  app.get(
    "/api/v1/db-backups/download/:ticket",
    guarded(async (c) => {
      const claims = await verifyDownloadTicket(c.req.param("ticket") ?? "", jwtSecret);
      const refuse = () => c.json({ error: "download_link_invalid", message: "This download link is invalid or has expired" }, 403);
      if (!claims) return refuse();
      const state = await store.ops.getSessionState(claims.u);
      if (!state.user || state.user.role !== "admin" || state.user.status !== "active" || state.user.tokenVersion !== claims.v) return refuse();
      const { stream, part, fileName } = await service.openPart(claims.b, claims.p);
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(part.sizeBytes),
          "Content-Disposition": `attachment; filename="${fileName.replace(/["\\\r\n]/g, "_")}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }),
  );
}
