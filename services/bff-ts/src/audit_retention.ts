import type { Context, Hono } from "hono";
import {
  auditRetentionShortens,
  AuditRetentionRunRequestSchema,
  PortalSettingsSchema,
  UpdateAuditRetentionRequestSchema,
  type AuditRetentionRun,
  type AuditRetentionRunResponse,
  type AuditRetentionStatus,
} from "@slipgate/contracts";
import type { AuthEnv } from "./middleware/auth.ts";
import { noteAudit } from "./routes/ops.ts";
import { totpStepUp, type TotpStepUp } from "./security/step_up.ts";
import { AUDIT_DELETE_BATCH } from "./store/ops_types.ts";
import { StoreError, type ControlStore } from "./store/types.ts";

/**
 * Audit-log retention (Linksyncx runRetentionLoop): after a short startup delay, then once a day,
 * deletes audit rows older than the portal setting `auditLogRetentionDays` in bounded batches.
 * 0 keeps everything (only the guarded manual clear removes rows).
 *
 * Every instance runs its own sweeper: deletes are idempotent and the Postgres batch skips rows
 * another instance has locked, so no leader election is needed. Within one instance runs never
 * overlap (a second request joins the one in flight).
 */

export const AUDIT_RETENTION_STARTUP_DELAY_MS = 5 * 60_000;
export const AUDIT_RETENTION_INTERVAL_MS = 24 * 60 * 60_000;
/** Batches one sweep deletes at most (AUDIT_DELETE_BATCH rows each); anything left waits a day. */
export const AUDIT_RETENTION_MAX_BATCHES = 200;
const DAY_MS = 86_400_000;

export interface AuditRetentionOptions {
  startupDelayMs?: number;
  intervalMs?: number;
  batchSize?: number;
  maxBatches?: number;
  /** Clock (tests move it forward instead of back-dating rows). */
  now?: () => number;
}

export type { AuditRetentionRun };

type TimerHandle = ReturnType<typeof setTimeout>;

function unref(timer: TimerHandle): TimerHandle {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

const started = new Set<AuditRetentionSweeper>();

/** Stops every started sweeper's timers (process shutdown, before the store closes). */
export function stopAuditRetentionSweepers(): void {
  for (const s of [...started]) s.stop();
}

export class AuditRetentionSweeper {
  private readonly startupDelayMs: number;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxBatches: number;
  private readonly now: () => number;
  private startTimer: TimerHandle | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<AuditRetentionRun> | null = null;
  private lastRunAtIso: string | null = null;
  private lastDeleted = 0;
  private lastError: string | null = null;
  private nextRunAtMs: number | null = null;

  constructor(
    private readonly store: ControlStore,
    options: AuditRetentionOptions = {},
  ) {
    this.startupDelayMs = Math.max(0, options.startupDelayMs ?? AUDIT_RETENTION_STARTUP_DELAY_MS);
    this.intervalMs = Math.max(60_000, options.intervalMs ?? AUDIT_RETENTION_INTERVAL_MS);
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? AUDIT_DELETE_BATCH));
    this.maxBatches = Math.max(1, Math.floor(options.maxBatches ?? AUDIT_RETENTION_MAX_BATCHES));
    this.now = options.now ?? Date.now;
  }

  async retentionDays(): Promise<number> {
    return (await this.store.ops.getSettings()).auditLogRetentionDays;
  }

  async status(): Promise<AuditRetentionStatus> {
    return {
      retentionDays: await this.retentionDays(),
      running: this.inFlight !== null,
      lastRunAtIso: this.lastRunAtIso,
      lastDeleted: this.lastDeleted,
      lastError: this.lastError,
      nextRunAtIso: this.nextRunAtMs === null ? null : new Date(this.nextRunAtMs).toISOString(),
    };
  }

  /** One sweep (joins the one already running in this instance). Never throws. */
  runOnce(): Promise<AuditRetentionRun> {
    this.inFlight ??= this.sweep().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async sweep(): Promise<AuditRetentionRun> {
    let deleted = 0;
    let retentionDays = 0;
    try {
      // Read on every run: a changed setting applies from the next sweep without a restart.
      retentionDays = await this.retentionDays();
      if (!(retentionDays > 0)) {
        this.lastError = null;
        return { retentionDays, skipped: true, deleted: 0 };
      }
      const cutoff = new Date(this.now() - retentionDays * DAY_MS);
      for (let batch = 0; batch < this.maxBatches; batch++) {
        const n = await this.store.ops.deleteAuditBefore(cutoff, this.batchSize);
        deleted += n;
        if (n < this.batchSize) break;
      }
      this.lastError = null;
      return { retentionDays, skipped: false, deleted };
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[slipgate-bff] audit retention sweep failed: ${this.lastError}`);
      return { retentionDays, skipped: false, deleted };
    } finally {
      this.lastRunAtIso = new Date(this.now()).toISOString();
      this.lastDeleted = deleted;
    }
  }

  /** Startup delay, then a sweep every interval. Timers never keep the process alive. */
  start(): void {
    if (this.startTimer || this.interval) return;
    started.add(this);
    this.nextRunAtMs = Date.now() + this.startupDelayMs;
    this.startTimer = unref(
      setTimeout(() => {
        this.startTimer = null;
        this.nextRunAtMs = Date.now() + this.intervalMs;
        void this.runOnce();
        this.interval = unref(
          setInterval(() => {
            this.nextRunAtMs = Date.now() + this.intervalMs;
            void this.runOnce();
          }, this.intervalMs),
        );
      }, this.startupDelayMs),
    );
  }

  stop(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.interval) clearInterval(this.interval);
    this.startTimer = null;
    this.interval = null;
    this.nextRunAtMs = null;
    started.delete(this);
  }
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
}

/** An empty body reads as `{}` (the run takes an optional one); anything else must be JSON. */
async function optionalJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
}

function badRequest(issues: { path: (string | number)[]; message: string }[], field: string): never {
  const issue = issues[0];
  throw new StoreError("bad_request", issue ? `${issue.path.join(".") || field}: ${issue.message}` : "Invalid request");
}

/**
 * Creates the sweeper, registers its admin routes and starts it when `start` (the server, not
 * tests). `vaultSecret` decrypts the two-factor secrets the guarded routes check.
 */
export function mountAuditRetention(
  app: Hono<AuthEnv>,
  store: ControlStore,
  start: boolean,
  vaultSecret: string,
  options?: AuditRetentionOptions,
): AuditRetentionSweeper {
  const sweeper = new AuditRetentionSweeper(store, options);
  registerAuditRetentionRoutes(app, store, sweeper, totpStepUp(store, vaultSecret));
  if (start) sweeper.start();
  return sweeper;
}

/**
 * Admin endpoints (requireAdmin + auditMiddleware are mounted on /api/v1/admin/* by createBffApp).
 * Anything that removes history sooner than the current setting would (shortening the period,
 * including from keep-forever, and an on-demand sweep) needs the same fresh two-factor code as the
 * clear, so a stolen session cannot erase its own trail by way of retention.
 */
export function registerAuditRetentionRoutes(app: Hono<AuthEnv>, store: ControlStore, sweeper: AuditRetentionSweeper, stepUp: TotpStepUp): void {
  app.get("/api/v1/admin/audit-logs/retention", async (c) => c.json(await sweeper.status()));

  app.put("/api/v1/admin/audit-logs/retention", async (c) => {
    const parsed = UpdateAuditRetentionRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) badRequest(parsed.error.issues, "retentionDays");
    const { retentionDays, totpCode } = parsed.data;
    const current = await store.ops.getSettings();
    const shortens = auditRetentionShortens(current.auditLogRetentionDays, retentionDays);
    if (shortens) {
      const refused = await stepUp.require(c, c.get("authUser").sub, totpCode);
      if (refused) return refused;
    }
    await store.ops.saveSettings(PortalSettingsSchema.parse({ ...current, auditLogRetentionDays: retentionDays }));
    noteAudit(c, { fromDays: current.auditLogRetentionDays, toDays: retentionDays, confirmedWith: shortens ? "totp" : null });
    return c.json(await sweeper.status());
  });

  /** Sweeps now (bounded like a scheduled run) and answers with the outcome. */
  app.post("/api/v1/admin/audit-logs/retention/run", async (c) => {
    const parsed = AuditRetentionRunRequestSchema.safeParse(await optionalJsonBody(c));
    if (!parsed.success) badRequest(parsed.error.issues, "totpCode");
    const refused = await stepUp.require(c, c.get("authUser").sub, parsed.data.totpCode);
    if (refused) return refused;
    const run = await sweeper.runOnce();
    noteAudit(c, { retentionDays: run.retentionDays, skipped: run.skipped, deleted: run.deleted, confirmedWith: "totp" });
    const response: AuditRetentionRunResponse = { ...(await sweeper.status()), run };
    return c.json(response);
  });
}
