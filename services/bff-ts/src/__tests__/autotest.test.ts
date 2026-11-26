import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { UpstreamAccount } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import type { ControlStore } from "../store/types.ts";

/** Postgres-backed runs inject a store factory through a test preload; default is in-memory. */
const storeFactory = (globalThis as { __slipgateTestStoreFactory?: () => Promise<ControlStore> }).__slipgateTestStoreFactory;

const JSON_HEADERS = { "Content-Type": "application/json" };
const TOKEN = "autotest-internal-token";

let mock: ReturnType<typeof Bun.serve>;
const probed: string[] = [];
const failing = new Set<string>();
const prevUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
const prevToken = process.env.SLIPGATE_INTERNAL_TOKEN;

beforeAll(() => {
  mock = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const m = /^\/internal\/net\/accounts\/([^/]+)\/test$/.exec(url.pathname);
      if (m && req.headers.get("x-slipgate-internal-token") === TOKEN) {
        const id = decodeURIComponent(m[1]!);
        probed.push(id);
        const body = failing.has(id)
          ? `data: ${JSON.stringify({ type: "start", model: "claude-sonnet-5-5" })}\n\ndata: ${JSON.stringify({ type: "error", message: "upstream 401" })}\n\n`
          : `data: ${JSON.stringify({ type: "start", model: "claude-sonnet-5-5" })}\n\ndata: ${JSON.stringify({ type: "done", success: true, durationMs: 420 })}\n\n`;
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      // Snapshot pushes and anything else.
      return Response.json({ ok: true });
    },
  });
  process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SLIPGATE_INTERNAL_TOKEN = TOKEN;
});

afterAll(() => {
  mock.stop(true);
  if (prevUrl === undefined) delete process.env.SLIPGATE_NET_INTERNAL_URL;
  else process.env.SLIPGATE_NET_INTERNAL_URL = prevUrl;
  if (prevToken === undefined) delete process.env.SLIPGATE_INTERNAL_TOKEN;
  else process.env.SLIPGATE_INTERNAL_TOKEN = prevToken;
});

describe("account auto-test", () => {
  it("probes active non-VM accounts, records outcomes and reports status", async () => {
    const app = createBffApp({
      store: storeFactory ? await storeFactory() : undefined,
      jwtSecret: "autotest-jwt-secret-32-bytes-minimum",
      vaultSecret: "autotest-vault-secret-32-bytes-minimum",
      internalToken: TOKEN,
    });
    const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
      const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as T };
    };
    const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
      siteName: "Auto",
      adminEmail: "admin@auto.test",
      adminPassword: "AdminPassword123!",
      allowRegistration: true,
    });
    const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
    const make = async (name: string, extra: Record<string, unknown> = {}) =>
      (
        await call<{ account: UpstreamAccount }>("POST", "/api/v1/admin/accounts", admin, {
          name,
          groupId: "grp_default",
          platform: "anthropic",
          executionMode: "direct_api",
          authKind: "api_key",
          credentialSecret: `sk-ant-${name}-0123456789`,
          ...extra,
        })
      ).body.account;
    const good = await make("acc-good");
    const bad = await make("acc-bad");
    const paused = await make("acc-paused", { status: "paused" });
    failing.add(bad.id);

    const cfg = await call<{ config: { enabled: boolean; intervalMinutes: number } }>("PATCH", "/api/v1/admin/account-autotest", admin, {
      enabled: true,
      intervalMinutes: 30,
    });
    expect(cfg.body.config.intervalMinutes).toBe(30);
    expect((await call("PATCH", "/api/v1/admin/account-autotest", admin, { intervalMinutes: 1 })).status).toBe(400);

    const started = await call<{ status: { running: boolean } }>("POST", "/api/v1/admin/account-autotest/run", admin);
    expect(started.status).toBe(202);
    let status = started.body.status;
    for (let i = 0; i < 50 && (status.running || probed.length < 2); i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = (await call<{ status: typeof status }>("GET", "/api/v1/admin/account-autotest", admin)).body.status;
    }
    const final = (await call<{ status: { lastRunTested: number; lastRunFailed: number; nextRunAtIso: string | null } }>(
      "GET",
      "/api/v1/admin/account-autotest",
      admin,
    )).body.status;
    expect(final.lastRunTested).toBe(2);
    expect(final.lastRunFailed).toBe(1);
    expect(final.nextRunAtIso).not.toBeNull();
    expect(probed).not.toContain(paused.id);

    const accounts = (await call<{ accounts: UpstreamAccount[] }>("GET", "/api/v1/admin/accounts", admin)).body.accounts;
    const byId = new Map(accounts.map((a) => [a.id, a]));
    expect(byId.get(good.id)?.lastTest?.ok).toBe(true);
    expect(byId.get(good.id)?.lastTest?.model).toBe("claude-sonnet-5-5");
    expect(byId.get(bad.id)?.lastTest?.ok).toBe(false);
    expect(byId.get(bad.id)?.lastTest?.message).toContain("upstream 401");
  });
});

describe("per-account test plans", () => {
  it("creates several cron plans per account, previews, runs one now and ends a cooldown when auto-recover is on", async () => {
    const app = createBffApp({
      store: storeFactory ? await storeFactory() : undefined,
      jwtSecret: "autotest-jwt-secret-32-bytes-minimum",
      vaultSecret: "autotest-vault-secret-32-bytes-minimum",
      internalToken: TOKEN,
    });
    const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
      const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as T };
    };
    const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
      siteName: "Sched",
      adminEmail: "admin@sched.test",
      adminPassword: "AdminPassword123!",
      allowRegistration: true,
    });
    const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
    const make = async (name: string, extra: Record<string, unknown> = {}) =>
      (
        await call<{ account: UpstreamAccount }>("POST", "/api/v1/admin/accounts", admin, {
          name,
          platform: "anthropic",
          executionMode: "direct_api",
          authKind: "api_key",
          credentialSecret: `sk-ant-${name}-0123456789`,
          ...extra,
        })
      ).body.account;
    const cooled = await make("plan-cooled");
    const broken = await make("plan-broken");
    const vm = await make("plan-vm", { executionMode: "vm_slot", authKind: "vm_cli_seed", credentialSecret: "mock://seed" });
    failing.add(broken.id);
    const until = new Date(Date.now() + 3_600_000).toISOString();
    for (const id of [cooled.id, broken.id]) {
      expect((await call("PATCH", `/api/v1/admin/accounts/${id}`, admin, { cooldownUntilIso: until, cooldownReason: "upstream_http_429" })).status).toBe(200);
    }

    // Validation: cron, time zone, retention bounds, VM accounts, unknown accounts.
    const plans = (id: string) => `/api/v1/admin/accounts/${id}/test-plans`;
    expect((await call("POST", plans(cooled.id), admin, { cronExpr: "every minute" })).status).toBe(400);
    expect((await call("POST", plans(cooled.id), admin, { cronExpr: "*/5 * * * *", timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await call("POST", plans(cooled.id), admin, { cronExpr: "*/5 * * * *", maxResults: 0 })).status).toBe(400);
    expect((await call("POST", plans(vm.id), admin, { cronExpr: "*/5 * * * *" })).status).toBe(400);
    expect((await call("POST", plans("acc_missing"), admin, { cronExpr: "*/5 * * * *" })).status).toBe(404);
    expect((await call("GET", plans("acc_missing"), admin)).status).toBe(404);

    // Live preview of an unsaved expression.
    const preview = await call<{ valid: boolean; runsIso: string[]; error: string | null }>(
      "GET",
      "/api/v1/admin/account-test-plans/cron-preview?cronExpr=" + encodeURIComponent("0 9 * * 1") + "&timezone=Asia/Shanghai&count=3",
      admin,
    );
    expect(preview.body.valid).toBe(true);
    expect(preview.body.runsIso).toHaveLength(3);
    // 09:00 in Shanghai is 01:00 UTC, on Mondays.
    for (const iso of preview.body.runsIso) {
      expect(new Date(iso).getUTCHours()).toBe(1);
      expect(new Date(iso).getUTCDay()).toBe(1);
    }
    expect(
      (await call<{ valid: boolean; error: string }>("GET", "/api/v1/admin/account-test-plans/cron-preview?cronExpr=61+*+*+*+*", admin)).body,
    ).toMatchObject({ valid: false, error: "invalid_cron" });

    // Two plans on one account, one on another.
    type Plan = {
      id: string;
      accountId: string;
      cronExpr: string;
      timezone: string;
      enabled: boolean;
      maxResults: number;
      autoRecover: boolean;
      model: string;
      nextRunAtIso: string | null;
      lastRunAtIso: string | null;
      lastOk: boolean | null;
      lastMessage: string;
    };
    const hourly = await call<{ item: Plan }>("POST", plans(cooled.id), admin, {
      cronExpr: "0 * * * *",
      model: "claude-sonnet-5-5",
      autoRecover: true,
      timezone: "Asia/Shanghai",
    });
    expect(hourly.status).toBe(201);
    expect(hourly.body.item).toMatchObject({
      accountId: cooled.id,
      cronExpr: "0 * * * *",
      timezone: "Asia/Shanghai",
      enabled: true,
      maxResults: 50,
      autoRecover: true,
      lastOk: null,
    });
    expect(new Date(hourly.body.item.nextRunAtIso!).getUTCMinutes()).toBe(0);
    const nightly = await call<{ item: Plan }>("POST", plans(cooled.id), admin, { cronExpr: "@daily", maxResults: 7, enabled: false });
    expect(nightly.body.item).toMatchObject({ enabled: false, maxResults: 7, nextRunAtIso: null, timezone: "UTC", model: "" });
    await call("POST", plans(broken.id), admin, { cronExpr: "*/30 * * * *", autoRecover: true });
    expect((await call<{ items: Plan[] }>("GET", plans(cooled.id), admin)).body.items.map((p) => p.cronExpr)).toEqual(["0 * * * *", "@daily"]);
    expect((await call<{ items: Plan[] }>("GET", "/api/v1/admin/account-test-plans", admin)).body.items).toHaveLength(3);

    // Editing: enabling computes a next run, a bad expression is refused, unknown plans 404.
    const edited = await call<{ item: Plan }>("PATCH", `/api/v1/admin/account-test-plans/${nightly.body.item.id}`, admin, { enabled: true });
    expect(edited.body.item).toMatchObject({ enabled: true, cronExpr: "@daily", maxResults: 7 });
    expect(new Date(edited.body.item.nextRunAtIso!).getUTCHours()).toBe(0);
    expect((await call("PATCH", `/api/v1/admin/account-test-plans/${nightly.body.item.id}`, admin, { cronExpr: "* * *" })).status).toBe(400);
    expect((await call("PATCH", "/api/v1/admin/account-test-plans/atp_missing", admin, { enabled: false })).status).toBe(404);

    // Run now: the passing account leaves its cooldown, the failing one stays in it.
    const ran = await call<{ result: { ok: boolean }; recovered: boolean; item: Plan }>(
      "POST",
      `/api/v1/admin/account-test-plans/${hourly.body.item.id}/run`,
      admin,
    );
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ result: { ok: true }, recovered: true, item: { lastOk: true } });
    expect(ran.body.item.lastRunAtIso).not.toBeNull();
    expect(ran.body.item.nextRunAtIso).toBe(hourly.body.item.nextRunAtIso);
    const brokenPlan = (await call<{ items: Plan[] }>("GET", plans(broken.id), admin)).body.items[0]!;
    const ranBad = await call<{ result: { ok: boolean }; recovered: boolean; item: Plan }>(
      "POST",
      `/api/v1/admin/account-test-plans/${brokenPlan.id}/run`,
      admin,
    );
    expect(ranBad.body).toMatchObject({ result: { ok: false }, recovered: false, item: { lastOk: false, lastMessage: "upstream 401" } });
    const accounts = (await call<{ accounts: UpstreamAccount[] }>("GET", "/api/v1/admin/accounts", admin)).body.accounts;
    const byId = new Map(accounts.map((a) => [a.id, a]));
    expect(byId.get(cooled.id)?.effectiveStatus).toBe("active");
    expect(byId.get(broken.id)?.effectiveStatus).toBe("cooldown");
    expect(byId.get(broken.id)?.lastTest?.ok).toBe(false);

    // The run is in the plan's results and the account's history, with its plan id.
    const runs = await call<{ items: { planId: string | null; source: string; ok: boolean }[] }>(
      "GET",
      `/api/v1/admin/account-test-plans/${hourly.body.item.id}/runs`,
      admin,
    );
    expect(runs.body.items).toEqual([expect.objectContaining({ planId: hourly.body.item.id, source: "scheduled", ok: true })]);
    const history = await call<{ items: { planId: string | null }[] }>("GET", `/api/v1/admin/accounts/${cooled.id}/test-runs`, admin);
    expect(history.body.items[0]?.planId).toBe(hourly.body.item.id);

    // At most ten plans per account.
    for (let i = 0; i < 8; i++) expect((await call("POST", plans(cooled.id), admin, { cronExpr: `${i} 3 * * *` })).status).toBe(201);
    expect((await call("POST", plans(cooled.id), admin, { cronExpr: "0 4 * * *" })).status).toBe(409);

    // Delete takes the plan's results with it; a second delete is a 404.
    expect((await call("DELETE", `/api/v1/admin/account-test-plans/${hourly.body.item.id}`, admin)).status).toBe(200);
    expect((await call("DELETE", `/api/v1/admin/account-test-plans/${hourly.body.item.id}`, admin)).status).toBe(404);
    expect((await call("GET", `/api/v1/admin/account-test-plans/${hourly.body.item.id}/runs`, admin)).status).toBe(404);
    expect((await call<{ items: unknown[] }>("GET", `/api/v1/admin/accounts/${cooled.id}/test-runs`, admin)).body.items).toHaveLength(0);
  });
});
