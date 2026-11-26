import type { Hono } from "hono";
import { z } from "zod";
import {
  ACCOUNT_TEST_PLAN_PREVIEW_MAX,
  ACCOUNT_TEST_PLAN_RESULTS_DEFAULT,
  ACCOUNT_TEST_PLAN_RESULTS_MAX,
  CreateAccountTestPlanRequestSchema,
  UpdateAccountTestPlanRequestSchema,
  type AccountTestPlan,
  type AccountTestPlanCronPreview,
  type AccountTestResult,
  type AccountTestSource,
  type CreateAccountTestPlanRequest,
  type UpdateAccountTestPlanRequest,
} from "@slipgate/contracts";
import { AccountTestTally, failedTestRun, type NewAccountTestRun } from "./account_test_runs.ts";
import { CronError, isValidTimeZone, nextCronRun, parseCron } from "./db_backup/cron.ts";
import type { AuthEnv } from "./middleware/auth.ts";
import { StoreError, type ControlStore } from "./store/types.ts";

/**
 * Scheduled account probes ("定时测试"): the global auto test (every `intervalMinutes`, every
 * active non-VM account, optionally limited to some groups) and per-account test plans (several
 * per account, each a cron expression in a time zone; sub2api "定时测试计划"). Both run the same
 * streamed test the console uses and record the outcome as the account's last test and in its test
 * history. Runs only where a network service is configured; the scheduler loop is started by the
 * server entrypoint, never by tests.
 */

export const AutoTestConfigSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(5).max(1440),
  concurrency: z.number().int().min(1).max(5),
  groupIds: z.array(z.string()).max(200),
  model: z.string().trim().max(128),
});
export type AutoTestConfig = z.infer<typeof AutoTestConfigSchema>;

const DEFAULT_CONFIG: AutoTestConfig = { enabled: false, intervalMinutes: 60, concurrency: 2, groupIds: [], model: "" };
const BLOB_KEY = "account_autotest";
/** Pre-plan per-account schedules ({ [accountId]: { enabled, intervalMinutes, model, autoRecover } }), migrated once. */
const LEGACY_SCHEDULES_BLOB_KEY = "account_test_schedules";
const PLAN_CONCURRENCY = 2;
/** Due plans one scheduler tick takes on (the rest wait for the next minute). */
const PLAN_BATCH = 50;

/** First run of a plan's cron expression after `after` (ISO), or null when it never fires. */
export function nextPlanRun(cronExpr: string, timezone: string, after: Date = new Date()): string | null {
  return nextCronRun(parseCron(cronExpr), after, timezone)?.toISOString() ?? null;
}

/** Checks a plan's cron expression and time zone as saving does; null when both are fine. */
function planScheduleError(cronExpr: string, timezone: string): { error: "invalid_cron" | "invalid_timezone"; message: string } | null {
  if (!isValidTimeZone(timezone)) return { error: "invalid_timezone", message: `Unknown time zone "${timezone}"` };
  try {
    parseCron(cronExpr);
  } catch (err) {
    return { error: "invalid_cron", message: err instanceof CronError ? err.message : String(err) };
  }
  return null;
}

/**
 * The cron expression closest to a legacy "every N minutes" schedule: a step that divides the hour
 * (or, from an hour up, the day), so the plan keeps a regular rhythm.
 */
export function intervalToCron(minutes: number): string {
  const nearest = (n: number, options: number[]) =>
    options.reduce((best, o) => {
      const d = Math.abs(o - n) - Math.abs(best - n);
      return d < 0 || (d === 0 && o > best) ? o : best;
    });
  if (minutes < 60) {
    const n = nearest(minutes, [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]);
    return n === 60 ? "0 * * * *" : `*/${n} * * * *`;
  }
  const h = nearest(minutes / 60, [1, 2, 3, 4, 6, 8, 12, 24]);
  return h === 24 ? "0 0 * * *" : h === 1 ? "0 * * * *" : `0 */${h} * * *`;
}

const LegacyScheduleSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().min(1).max(1440),
  model: z.string().trim().max(128).default(""),
  autoRecover: z.boolean().default(false),
});

export interface AutoTestStatus {
  running: boolean;
  lastRunAtIso: string | null;
  lastRunTested: number;
  lastRunFailed: number;
  lastError: string | null;
  nextRunAtIso: string | null;
}

export interface ProbeTarget {
  url: string;
  token: string;
}

/** Outcome of one test: the account's last test and its history entry. */
export interface ProbeOutcome {
  result: AccountTestResult;
  run: NewAccountTestRun;
}

/** Runs one streamed (text) account test to completion and returns its outcome. */
export async function probeAccount(
  target: ProbeTarget,
  accountId: string,
  model: string,
  source: AccountTestSource,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeOutcome> {
  const started = Date.now();
  const fail = (message: string): ProbeOutcome => {
    const run = failedTestRun(accountId, source, "text", model, message);
    return {
      result: { ok: false, atIso: run.atIso, model, durationMs: Date.now() - started, message: run.message },
      run: { ...run, durationMs: Date.now() - started },
    };
  };
  let res: Response;
  try {
    res = await fetchImpl(`${target.url}/internal/net/accounts/${encodeURIComponent(accountId)}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Slipgate-Internal-Token": target.token },
      body: JSON.stringify(model ? { model } : {}),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const payload = (await res.json().catch(() => ({}))) as { message?: string };
    return fail(payload.message ?? `HTTP ${res.status}`);
  }
  const tally = new AccountTestTally("text", model);
  tally.feed(await res.text());
  tally.flush();
  return { result: tally.result(), run: tally.run(accountId, source) };
}

export class AccountAutoTester {
  private status: AutoTestStatus = {
    running: false,
    lastRunAtIso: null,
    lastRunTested: 0,
    lastRunFailed: 0,
    lastError: null,
    nextRunAtIso: null,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private plansRunning = false;

  constructor(
    private readonly store: ControlStore,
    private readonly target: () => ProbeTarget | null,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Called after a scheduled test ended a cooldown (the data plane needs the new state). */
    private readonly onRecovered: () => void = () => {},
  ) {}

  /* ---------------- Per-account test plans ---------------- */

  private legacyMigration: Promise<void> | null = null;

  /** Turns pre-plan interval schedules into cron plans (once; the old blob is emptied after). */
  private migrateLegacySchedules(): Promise<void> {
    this.legacyMigration ??= (async () => {
      const raw = ((await this.store.ops.getBlob(LEGACY_SCHEDULES_BLOB_KEY)) ?? {}) as Record<string, unknown>;
      const entries = Object.entries(raw);
      if (entries.length === 0) return;
      for (const [accountId, value] of entries) {
        const legacy = LegacyScheduleSchema.safeParse(value);
        if (!legacy.success) continue;
        const account = await this.store.getAccount(accountId);
        if (!account || account.executionMode === "vm_slot") continue;
        const cronExpr = intervalToCron(legacy.data.intervalMinutes);
        await this.store
          .createAccountTestPlan(
            accountId,
            {
              model: legacy.data.model,
              cronExpr,
              timezone: "UTC",
              enabled: legacy.data.enabled,
              maxResults: ACCOUNT_TEST_PLAN_RESULTS_DEFAULT,
              autoRecover: legacy.data.autoRecover,
            },
            legacy.data.enabled ? nextPlanRun(cronExpr, "UTC") : null,
          )
          .catch(() => undefined);
      }
      await this.store.ops.setBlob(LEGACY_SCHEDULES_BLOB_KEY, {});
    })().catch((err) => {
      this.legacyMigration = null;
      throw err;
    });
    return this.legacyMigration;
  }

  /** All plans, or one account's (not_found for an unknown account). */
  async listPlans(accountId?: string): Promise<AccountTestPlan[]> {
    await this.migrateLegacySchedules();
    if (accountId !== undefined && !(await this.store.getAccount(accountId))) {
      throw new StoreError("not_found", `Account ${accountId} not found`);
    }
    return this.store.listAccountTestPlans(accountId);
  }

  /** Checks an unsaved cron expression and lists its next runs (the plan form's live preview). */
  previewPlan(cronExpr: string, timezone: string, count: number): AccountTestPlanCronPreview {
    const bad = planScheduleError(cronExpr, timezone);
    if (bad) return { valid: false, ...bad, runsIso: [] };
    const spec = parseCron(cronExpr);
    const runsIso: string[] = [];
    let after = new Date();
    for (let i = 0; i < Math.max(1, Math.min(ACCOUNT_TEST_PLAN_PREVIEW_MAX, count)); i++) {
      const next = nextCronRun(spec, after, timezone);
      if (!next) break;
      runsIso.push(next.toISOString());
      after = next;
    }
    return { valid: true, error: null, message: runsIso.length ? "" : "The expression never fires", runsIso };
  }

  private static requireSchedule(cronExpr: string, timezone: string) {
    const bad = planScheduleError(cronExpr, timezone);
    if (bad) throw new StoreError("bad_request", `${bad.error}: ${bad.message}`);
  }

  async createPlan(accountId: string, req: CreateAccountTestPlanRequest): Promise<AccountTestPlan> {
    await this.migrateLegacySchedules();
    const account = await this.store.getAccount(accountId);
    if (!account) throw new StoreError("not_found", `Account ${accountId} not found`);
    if (account.executionMode === "vm_slot") {
      throw new StoreError("bad_request", "VM slot accounts are tested from their slot");
    }
    AccountAutoTester.requireSchedule(req.cronExpr, req.timezone);
    return this.store.createAccountTestPlan(accountId, req, req.enabled ? nextPlanRun(req.cronExpr, req.timezone) : null);
  }

  /** Applies the sent fields; the next run is recomputed from now (null while disabled). */
  async updatePlan(planId: string, req: UpdateAccountTestPlanRequest): Promise<AccountTestPlan> {
    const plan = await this.store.getAccountTestPlan(planId);
    if (!plan) throw new StoreError("not_found", `Test plan ${planId} not found`);
    const cronExpr = req.cronExpr ?? plan.cronExpr;
    const timezone = req.timezone ?? plan.timezone;
    AccountAutoTester.requireSchedule(cronExpr, timezone);
    const enabled = req.enabled ?? plan.enabled;
    return this.store.updateAccountTestPlan(planId, req, enabled ? nextPlanRun(cronExpr, timezone) : null);
  }

  async deletePlan(planId: string): Promise<boolean> {
    return this.store.deleteAccountTestPlan(planId);
  }

  async planRuns(planId: string, limit: number) {
    if (!(await this.store.getAccountTestPlan(planId))) throw new StoreError("not_found", `Test plan ${planId} not found`);
    return this.store.listAccountTestPlanRuns(planId, limit);
  }

  /** Runs one plan now (enabled or not; its next scheduled run is unchanged) and applies auto-recover. */
  async runPlan(planId: string): Promise<{ item: AccountTestPlan; result: AccountTestResult; recovered: boolean }> {
    const target = this.target();
    if (!target) throw new StoreError("bad_request", "Account tests need the network service, which is not configured");
    const plan = await this.store.getAccountTestPlan(planId);
    if (!plan) throw new StoreError("not_found", `Test plan ${planId} not found`);
    const out = await this.executePlan(target, plan);
    if (!out) throw new StoreError("not_found", `Account ${plan.accountId} not found`);
    const item = (await this.store.getAccountTestPlan(planId)) ?? plan;
    return { item, ...out };
  }

  private async executePlan(target: ProbeTarget, plan: AccountTestPlan): Promise<{ result: AccountTestResult; recovered: boolean } | null> {
    const account = await this.store.getAccount(plan.accountId);
    if (!account || account.executionMode === "vm_slot") return null;
    const { result, run } = await probeAccount(target, plan.accountId, plan.model, "scheduled", this.fetchImpl);
    await this.store.recordAccountTestResult(plan.accountId, result).catch(() => undefined);
    await this.store.recordAccountTestRun({ ...run, planId: plan.id }).catch(() => undefined);
    await this.store.recordAccountTestPlanResult(plan.id, result.atIso, result.ok, result.message).catch(() => undefined);
    let recovered = false;
    if (plan.autoRecover && result.ok && account.effectiveStatus === "cooldown") {
      // A stored "cooldown" status goes back to active (that also clears the deadline); an active
      // account with a cooldown deadline only loses the deadline. Paused accounts are left alone.
      await this.store
        .updateAccount(
          plan.accountId,
          account.status === "cooldown" ? { status: "active" } : { cooldownUntilIso: null, cooldownReason: "" },
        )
        .then(() => {
          recovered = true;
        })
        .catch(() => undefined);
      if (recovered) this.onRecovered();
    }
    return { result, recovered };
  }

  /**
   * Runs every enabled plan whose next run has come: each is first claimed (moved to its next
   * cron time, so a slow run or a second scheduler never runs it twice), then tested, at most
   * PLAN_CONCURRENCY at once. Returns how many ran.
   */
  async runDuePlans(nowMs = Date.now()): Promise<number> {
    if (this.plansRunning) return 0;
    const target = this.target();
    if (!target) return 0;
    this.plansRunning = true;
    try {
      await this.migrateLegacySchedules();
      const now = new Date(nowMs);
      const due = await this.store.listDueAccountTestPlans(now.toISOString(), PLAN_BATCH);
      const claimed: AccountTestPlan[] = [];
      for (const plan of due) {
        let next: string | null = null;
        try {
          next = nextPlanRun(plan.cronExpr, plan.timezone, now);
        } catch {
          next = null; // an expression that no longer parses stops until it is edited
        }
        if (plan.nextRunAtIso && (await this.store.claimAccountTestPlan(plan.id, plan.nextRunAtIso, next))) claimed.push(plan);
      }
      const queue = [...claimed];
      const worker = async () => {
        for (let plan = queue.shift(); plan; plan = queue.shift()) {
          await this.executePlan(target, plan).catch(() => undefined);
        }
      };
      await Promise.all(Array.from({ length: Math.min(PLAN_CONCURRENCY, Math.max(1, claimed.length)) }, worker));
      return claimed.length;
    } finally {
      this.plansRunning = false;
    }
  }

  async config(): Promise<AutoTestConfig> {
    const parsed = AutoTestConfigSchema.safeParse({ ...DEFAULT_CONFIG, ...((await this.store.ops.getBlob(BLOB_KEY)) ?? {}) });
    return parsed.success ? parsed.data : DEFAULT_CONFIG;
  }

  async saveConfig(patch: Partial<AutoTestConfig>): Promise<AutoTestConfig> {
    const next = AutoTestConfigSchema.parse({ ...(await this.config()), ...patch });
    await this.store.ops.setBlob(BLOB_KEY, next);
    await this.refreshNextRun();
    return next;
  }

  snapshot(): AutoTestStatus {
    return { ...this.status };
  }

  private async refreshNextRun() {
    const cfg = await this.config();
    if (!cfg.enabled) {
      this.status.nextRunAtIso = null;
      return;
    }
    const last = this.status.lastRunAtIso ? Date.parse(this.status.lastRunAtIso) : Date.now();
    this.status.nextRunAtIso = new Date(last + cfg.intervalMinutes * 60_000).toISOString();
  }

  /** Tests every eligible account once; no-op when a run is already in progress. */
  async runOnce(): Promise<AutoTestStatus> {
    if (this.status.running) return this.snapshot();
    const target = this.target();
    if (!target) throw new StoreError("bad_request", "Account tests need the network service, which is not configured");
    const cfg = await this.config();
    this.status.running = true;
    this.status.lastError = null;
    try {
      const accounts = (await this.store.listAccounts()).filter(
        (a) =>
          a.executionMode !== "vm_slot" &&
          a.effectiveStatus === "active" &&
          (cfg.groupIds.length === 0 || cfg.groupIds.includes(a.groupId)),
      );
      let tested = 0;
      let failed = 0;
      const queue = [...accounts];
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          const { result, run } = await probeAccount(target, a.id, cfg.model, "auto", this.fetchImpl);
          tested++;
          if (!result.ok) failed++;
          await this.store.recordAccountTestResult(a.id, result).catch(() => undefined);
          await this.store.recordAccountTestRun(run).catch(() => undefined);
        }
      };
      await Promise.all(Array.from({ length: Math.min(cfg.concurrency, Math.max(1, accounts.length)) }, worker));
      this.status.lastRunTested = tested;
      this.status.lastRunFailed = failed;
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.status.running = false;
      this.status.lastRunAtIso = new Date().toISOString();
      await this.refreshNextRun();
    }
    return this.snapshot();
  }

  /** Checks once a minute whether a run is due. */
  start() {
    if (this.timer) return;
    void this.refreshNextRun();
    this.timer = setInterval(() => {
      void (async () => {
        // Per-account test plans run on their own clock, whether or not the global run is on.
        void this.runDuePlans().catch(() => undefined);
        const cfg = await this.config();
        if (!cfg.enabled || this.status.running || !this.target()) return;
        const last = this.status.lastRunAtIso ? Date.parse(this.status.lastRunAtIso) : 0;
        if (Date.now() - last >= cfg.intervalMinutes * 60_000) await this.runOnce().catch(() => undefined);
      })();
    }, 60_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function registerAutoTestRoutes(app: Hono<AuthEnv>, tester: AccountAutoTester) {
  app.get("/api/v1/admin/account-autotest", async (c) => c.json({ config: await tester.config(), status: tester.snapshot() }));

  app.patch("/api/v1/admin/account-autotest", async (c) => {
    const raw = (await c.req.json().catch(() => null)) as unknown;
    const parsed = AutoTestConfigSchema.partial().safeParse(raw);
    if (!parsed.success) throw new StoreError("bad_request", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return c.json({ config: await tester.saveConfig(parsed.data), status: tester.snapshot() });
  });

  const issues = (error: z.ZodError) => error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");

  /* Per-account scheduled test plans (sub2api "定时测试计划"). */
  app.get("/api/v1/admin/account-test-plans", async (c) => c.json({ items: await tester.listPlans() }));

  app.get("/api/v1/admin/account-test-plans/cron-preview", (c) => {
    const count = Number(c.req.query("count") ?? 3);
    return c.json(
      tester.previewPlan(
        (c.req.query("cronExpr") ?? "").trim(),
        (c.req.query("timezone") ?? "UTC").trim() || "UTC",
        Number.isFinite(count) ? count : 3,
      ),
    );
  });

  app.get("/api/v1/admin/accounts/:accountId/test-plans", async (c) =>
    c.json({ items: await tester.listPlans(c.req.param("accountId")) }),
  );

  app.post("/api/v1/admin/accounts/:accountId/test-plans", async (c) => {
    const parsed = CreateAccountTestPlanRequestSchema.safeParse((await c.req.json().catch(() => null)) as unknown);
    if (!parsed.success) throw new StoreError("bad_request", issues(parsed.error));
    return c.json({ item: await tester.createPlan(c.req.param("accountId"), parsed.data) }, 201);
  });

  app.patch("/api/v1/admin/account-test-plans/:planId", async (c) => {
    const parsed = UpdateAccountTestPlanRequestSchema.safeParse((await c.req.json().catch(() => null)) as unknown);
    if (!parsed.success) throw new StoreError("bad_request", issues(parsed.error));
    return c.json({ item: await tester.updatePlan(c.req.param("planId"), parsed.data) });
  });

  app.delete("/api/v1/admin/account-test-plans/:planId", async (c) => {
    if (!(await tester.deletePlan(c.req.param("planId")))) throw new StoreError("not_found", "Test plan not found");
    return c.json({ deleted: true });
  });

  app.post("/api/v1/admin/account-test-plans/:planId/run", async (c) => c.json(await tester.runPlan(c.req.param("planId"))));

  app.get("/api/v1/admin/account-test-plans/:planId/runs", async (c) => {
    const limit = Number(c.req.query("limit") ?? ACCOUNT_TEST_PLAN_RESULTS_MAX);
    return c.json({ items: await tester.planRuns(c.req.param("planId"), Number.isFinite(limit) ? limit : ACCOUNT_TEST_PLAN_RESULTS_MAX) });
  });

  app.post("/api/v1/admin/account-autotest/run", async (c) => {
    void tester.runOnce().catch(() => undefined);
    // Let the run flip to `running` before answering.
    await new Promise((r) => setTimeout(r, 0));
    return c.json({ status: tester.snapshot() }, 202);
  });
}
