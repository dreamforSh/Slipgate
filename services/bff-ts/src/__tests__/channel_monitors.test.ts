import { describe, expect, it } from "bun:test";
import type {
  ChannelMonitor,
  ChannelMonitorRun,
  ChannelMonitorRunsResponse,
  PublicChannelMonitorsStatusResponse,
  UpstreamAccount,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import type { ChannelMonitorProbeOutcome } from "../store/channel_monitors_types.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  let nextProbe: ChannelMonitorProbeOutcome = { ok: true, latencyMs: 120, model: "gpt-5.2", message: "" };
  const app = createBffApp({
    store: factory ? await factory() : undefined,
    jwtSecret: "mon-test-jwt-secret-32-bytes-minimum",
    vaultSecret: "mon-test-vault-secret-32-bytes-minimum",
    probeMonitor: async () => nextProbe,
  });

  const call = async <T>(
    method: string,
    path: string,
    headers: Record<string, string> = JSON_HEADERS,
    body?: unknown,
  ) => {
    const res = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T };
  };

  const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Monitors Test",
    adminEmail: "admin@mon.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };

  const reg = await call<{ accessToken: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
    email: "user@mon.test",
    password: "UserPassword123!",
  });
  expect(reg.status).toBe(201);
  const user = { ...JSON_HEADERS, Authorization: `Bearer ${reg.body.accessToken}` };

  const accRes = await call<{ account: UpstreamAccount }>("POST", "/api/v1/admin/accounts", admin, {
    name: "Direct Probe Account",
    groupId: "grp_default",
    platform: "openai",
    authKind: "api_key",
    executionMode: "direct_api",
    credentialSecret: "sk-probe-secret-abcdef123456",
    priority: 1,
  });
  expect(accRes.status).toBe(201);

  return {
    call,
    admin,
    user,
    account: accRes.body.account,
    setProbe: (p: ChannelMonitorProbeOutcome) => {
      nextProbe = p;
    },
  };
}

describe("Channel Monitors, Probe History & Public Matrix (Lane O3)", () => {
  it("supports monitor CRUD, rejects vm_slot accounts, and runs up/degraded/down probes", async () => {
    const { call, admin, user, account, setProbe } = await bootstrap();

    expect((await call("GET", "/api/v1/admin/channel-monitors", user)).status).toBe(403);

    const vmAcc = await call<{ account: UpstreamAccount }>("POST", "/api/v1/admin/accounts", admin, {
      name: "VM Account",
      groupId: "grp_default",
      platform: "anthropic",
      authKind: "oauth",
      executionMode: "vm_slot",
      credentialSecret: "sk-vm-token-secret",
      priority: 1,
    });
    expect(vmAcc.status).toBe(201);

    const rejectedVm = await call("POST", "/api/v1/admin/channel-monitors", admin, {
      name: "Bad VM Monitor",
      accountId: vmAcc.body.account.id,
    });
    expect(rejectedVm.status).toBe(400);

    const created = await call<{ item: ChannelMonitor }>("POST", "/api/v1/admin/channel-monitors", admin, {
      name: "OpenAI Primary Probe",
      description: "Checks gpt-5.2 direct upstream",
      accountId: account.id,
      model: "gpt-5.2",
      intervalSeconds: 120,
      degradedLatencyMs: 500,
      isPublic: true,
      enabled: true,
    });
    expect(created.status).toBe(201);
    const monId = created.body.item.id;

    // 1) Up probe
    setProbe({ ok: true, latencyMs: 180, model: "gpt-5.2", message: "" });
    const r1 = await call<{ monitor: ChannelMonitor; run: ChannelMonitorRun }>(
      "POST",
      `/api/v1/admin/channel-monitors/${monId}/run`,
      admin,
    );
    expect(r1.status).toBe(200);
    expect(r1.body.run.status).toBe("up");
    expect(r1.body.monitor.lastStatus).toBe("up");

    // 2) Slow probe -> degraded (>= 500ms)
    setProbe({ ok: true, latencyMs: 750, model: "gpt-5.2", message: "" });
    const r2 = await call<{ monitor: ChannelMonitor; run: ChannelMonitorRun }>(
      "POST",
      `/api/v1/admin/channel-monitors/${monId}/run`,
      admin,
    );
    expect(r2.body.run.status).toBe("degraded");

    // 3) Failing probe -> down
    setProbe({ ok: false, latencyMs: 90, model: "gpt-5.2", message: "upstream 502 bad gateway" });
    const r3 = await call<{ monitor: ChannelMonitor; run: ChannelMonitorRun }>(
      "POST",
      `/api/v1/admin/channel-monitors/${monId}/run`,
      admin,
    );
    expect(r3.body.run.status).toBe("down");
    expect(r3.body.monitor.lastError).toContain("502");
    expect(r3.body.monitor.uptime24hPct).toBeCloseTo(66.67, 1);

    const runs = await call<ChannelMonitorRunsResponse>("GET", `/api/v1/admin/channel-monitors/${monId}/runs?limit=10`, admin);
    expect(runs.status).toBe(200);
    expect(runs.body.items.length).toBe(3);
  });

  it("exposes scrubbed public probe matrix and respects statusPageEnabled and backendModeEnabled", async () => {
    const { call, admin, account } = await bootstrap();

    const pubMon = await call<{ item: ChannelMonitor }>("POST", "/api/v1/admin/channel-monitors", admin, {
      name: "Public Probe",
      accountId: account.id,
      model: "gpt-5.2",
      isPublic: true,
      enabled: true,
    });
    const privMon = await call<{ item: ChannelMonitor }>("POST", "/api/v1/admin/channel-monitors", admin, {
      name: "Private Probe",
      accountId: account.id,
      model: "gpt-5.2",
      isPublic: false,
      enabled: true,
    });
    await call("POST", `/api/v1/admin/channel-monitors/${pubMon.body.item.id}/run`, admin);
    await call("POST", `/api/v1/admin/channel-monitors/${privMon.body.item.id}/run`, admin);

    const pubRes = await call<PublicChannelMonitorsStatusResponse>("GET", "/api/v1/public/channel-monitors/status");
    expect(pubRes.status).toBe(200);
    expect(pubRes.body.items.length).toBe(1);
    expect(pubRes.body.items[0]!.name).toBe("Public Probe");
    // Must never leak internal accountId or lastError on public matrix.
    const serialized = JSON.stringify(pubRes.body);
    expect(serialized).not.toContain(account.id);
    expect(serialized).not.toContain("lastError");

    // Disable status page -> 404.
    await call("PATCH", "/api/v1/admin/settings", admin, { statusPageEnabled: false });
    expect((await call("GET", "/api/v1/public/channel-monitors/status")).status).toBe(404);

    // Enable backend mode -> 403 for anonymous visitors.
    await call("PATCH", "/api/v1/admin/settings", admin, { statusPageEnabled: true, backendModeEnabled: true });
    expect((await call("GET", "/api/v1/public/channel-monitors/status")).status).toBe(403);
  });
});
