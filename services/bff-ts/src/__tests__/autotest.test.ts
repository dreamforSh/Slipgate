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
