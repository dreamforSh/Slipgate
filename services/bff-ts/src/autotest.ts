import type { Hono } from "hono";
import { z } from "zod";
import { AccountTestEventSchema, type AccountTestResult } from "@slipgate/contracts";
import type { AuthEnv } from "./middleware/auth.ts";
import { StoreError, type ControlStore } from "./store/types.ts";

/**
 * Scheduled account probes ("定时测试"): every `intervalMinutes`, run the same streamed test the
 * console uses against each active, non-VM account (optionally limited to some groups) and
 * record the outcome as the account's last test. Runs only where a network service is
 * configured; the scheduler loop is started by the server entrypoint, never by tests.
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

/** Runs one streamed account test to completion and returns its outcome. */
export async function probeAccount(
  target: ProbeTarget,
  accountId: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountTestResult> {
  const started = Date.now();
  const fail = (message: string): AccountTestResult => ({
    ok: false,
    atIso: new Date().toISOString(),
    model,
    durationMs: Date.now() - started,
    message: message.slice(0, 500),
  });
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
  const text = await res.text();
  let usedModel = model;
  let outcome: AccountTestResult | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    let json: unknown;
    try {
      json = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    const ev = AccountTestEventSchema.safeParse(json);
    if (!ev.success) continue;
    const e = ev.data;
    if (e.type === "start" && e.model) usedModel = e.model;
    if (e.type === "done" || e.type === "error") {
      const ok = e.type === "done" && e.success === true;
      outcome = {
        ok,
        atIso: new Date().toISOString(),
        model: usedModel,
        durationMs: Math.max(0, Math.round(e.durationMs ?? Date.now() - started)),
        message: ok ? "" : (e.message ?? e.code ?? (e.status ? `HTTP ${e.status}` : "test failed")).slice(0, 500),
      };
    }
  }
  return outcome ?? fail("stream_interrupted");
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

  constructor(
    private readonly store: ControlStore,
    private readonly target: () => ProbeTarget | null,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

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
          const result = await probeAccount(target, a.id, cfg.model, this.fetchImpl);
          tested++;
          if (!result.ok) failed++;
          await this.store.recordAccountTestResult(a.id, result).catch(() => undefined);
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

  app.post("/api/v1/admin/account-autotest/run", async (c) => {
    void tester.runOnce().catch(() => undefined);
    // Let the run flip to `running` before answering.
    await new Promise((r) => setTimeout(r, 0));
    return c.json({ status: tester.snapshot() }, 202);
  });
}
