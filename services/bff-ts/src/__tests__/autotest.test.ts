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

describe("per-account scheduled tests", () => {
  it("stores schedules, runs one now and ends a cooldown on success when auto-recover is on", async () => {
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
    const cooled = await make("sched-cooled");
    const broken = await make("sched-broken");
    const vm = await make("sched-vm", { executionMode: "vm_slot", authKind: "vm_cli_seed", credentialSecret: "mock://seed" });
    failing.add(broken.id);
    // Put both into a cooldown (a temporary unschedulable deadline).
    const until = new Date(Date.now() + 3_600_000).toISOString();
    for (const id of [cooled.id, broken.id]) {
      expect((await call("PATCH", `/api/v1/admin/accounts/${id}`, admin, { cooldownUntilIso: until, cooldownReason: "upstream_http_429" })).status).toBe(200);
    }

    // Validation and VM refusal.
    expect((await call("PUT", `/api/v1/admin/accounts/${cooled.id}/test-schedule`, admin, { enabled: true, intervalMinutes: 1 })).status).toBe(400);
    expect((await call("PUT", `/api/v1/admin/accounts/${vm.id}/test-schedule`, admin, { enabled: true, intervalMinutes: 30 })).status).toBe(400);
    expect((await call("PUT", "/api/v1/admin/accounts/acc_missing/test-schedule", admin, { enabled: true, intervalMinutes: 30 })).status).toBe(404);

    const saved = await call<{ item: { accountId: string; intervalMinutes: number; autoRecover: boolean; nextRunAtIso: string | null } }>(
      "PUT",
      `/api/v1/admin/accounts/${cooled.id}/test-schedule`,
      admin,
      { enabled: true, intervalMinutes: 30, model: "claude-sonnet-5-5", autoRecover: true },
    );
    expect(saved.status).toBe(200);
    expect(saved.body.item).toMatchObject({ accountId: cooled.id, intervalMinutes: 30, autoRecover: true });
    expect(saved.body.item.nextRunAtIso).not.toBeNull();
    await call("PUT", `/api/v1/admin/accounts/${broken.id}/test-schedule`, admin, { enabled: true, intervalMinutes: 60, autoRecover: true });
    const list = await call<{ items: { accountId: string }[] }>("GET", "/api/v1/admin/account-test-schedules", admin);
    expect(list.body.items.map((i) => i.accountId).sort()).toEqual([cooled.id, broken.id].sort());

    // Run now: the passing account leaves its cooldown, the failing one stays in it.
    const ran = await call<{ result: { ok: boolean }; recovered: boolean; item: { lastRunAtIso: string | null } }>(
      "POST",
      `/api/v1/admin/accounts/${cooled.id}/test-schedule/run`,
      admin,
    );
    expect(ran.status).toBe(200);
    expect(ran.body).toMatchObject({ result: { ok: true }, recovered: true });
    expect(ran.body.item.lastRunAtIso).not.toBeNull();
    const ranBad = await call<{ result: { ok: boolean }; recovered: boolean }>("POST", `/api/v1/admin/accounts/${broken.id}/test-schedule/run`, admin);
    expect(ranBad.body).toMatchObject({ result: { ok: false }, recovered: false });
    const accounts = (await call<{ accounts: UpstreamAccount[] }>("GET", "/api/v1/admin/accounts", admin)).body.accounts;
    const byId = new Map(accounts.map((a) => [a.id, a]));
    expect(byId.get(cooled.id)?.effectiveStatus).toBe("active");
    expect(byId.get(cooled.id)?.cooldownUntilIso).toBeNull();
    expect(byId.get(broken.id)?.effectiveStatus).toBe("cooldown");
    expect(byId.get(broken.id)?.lastTest?.ok).toBe(false);

    // Delete; a second delete is a 404.
    expect((await call("DELETE", `/api/v1/admin/accounts/${cooled.id}/test-schedule`, admin)).status).toBe(200);
    expect((await call("DELETE", `/api/v1/admin/accounts/${cooled.id}/test-schedule`, admin)).status).toBe(404);
    const after = await call<{ items: { accountId: string }[] }>("GET", "/api/v1/admin/account-test-schedules", admin);
    expect(after.body.items.map((i) => i.accountId)).toEqual([broken.id]);
  });
});
