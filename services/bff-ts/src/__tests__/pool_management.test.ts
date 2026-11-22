import { afterEach, describe, expect, it } from "bun:test";
import type { AccountBulkResult, GroupItem, UpstreamAccount } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

async function bootstrap(internalToken = "") {
  const app = createBffApp({
    jwtSecret: "pool-mgmt-jwt-secret-32-bytes-min",
    vaultSecret: "pool-mgmt-vault-secret-32-bytes-min",
    internalToken,
  });
  const initRes = await app.request("/api/v1/setup/initialize", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      siteName: "Pool Test",
      adminEmail: "admin@pool.test",
      adminPassword: "AdminPassword123!",
      allowRegistration: true,
    }),
  });
  expect(initRes.status).toBe(201);
  const { accessToken } = (await initRes.json()) as { accessToken: string };
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` };

  const regRes = await app.request("/api/v1/auth/register", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: "user@pool.test", password: "UserPassword123!" }),
  });
  expect(regRes.status).toBe(201);
  const userToken = ((await regRes.json()) as { accessToken: string }).accessToken;
  const user = { ...JSON_HEADERS, Authorization: `Bearer ${userToken}` };

  const call = async <T>(method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  };
  return { app, admin, user, call };
}

async function createGroup(
  call: Awaited<ReturnType<typeof bootstrap>>["call"],
  admin: Record<string, string>,
  body: Record<string, unknown>,
) {
  const res = await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, body);
  expect(res.status).toBe(201);
  return res.body.group;
}

async function createAccount(
  call: Awaited<ReturnType<typeof bootstrap>>["call"],
  admin: Record<string, string>,
  body: Record<string, unknown>,
) {
  const res = await call<{ account: UpstreamAccount }>("POST", "/api/v1/admin/accounts", admin, {
    platform: "anthropic",
    executionMode: "direct_api",
    authKind: "api_key",
    credentialSecret: "mock://ok",
    ...body,
  });
  expect(res.status).toBe(201);
  return res.body.account;
}

describe("group management", () => {
  it("creates, edits, duplicates and guards deletion of groups", async () => {
    const { admin, call } = await bootstrap();

    const group = await createGroup(call, admin, {
      name: "claude-pro",
      description: "Claude subscription pool",
      platform: "anthropic",
      subscriptionType: "subscription",
      rateMultiplier: 1.5,
      modelAllowlist: ["claude-sonnet-4-5"],
      sortOrder: 5,
    });
    expect(group).toMatchObject({
      description: "Claude subscription pool",
      isExclusive: false,
      sortOrder: 5,
      accountCount: 0,
      activeAccountCount: 0,
      apiKeyCount: 0,
    });

    const updated = await call<{ group: GroupItem }>("PATCH", `/api/v1/admin/groups/${group.id}`, admin, {
      description: "updated",
      subscriptionType: "balance",
      isExclusive: true,
      sortOrder: -1,
      modelAllowlist: [],
    });
    expect(updated.status).toBe(200);
    expect(updated.body.group).toMatchObject({
      description: "updated",
      subscriptionType: "balance",
      isExclusive: true,
      sortOrder: -1,
      modelAllowlist: [],
      platform: "anthropic",
    });

    // Lower sortOrder lists first.
    const list = await call<{ groups: GroupItem[] }>("GET", "/api/v1/admin/groups", admin);
    expect(list.body.groups[0]?.id).toBe(group.id);

    const dup = await call<{ group: GroupItem }>("POST", `/api/v1/admin/groups/${group.id}/duplicate`, admin);
    expect(dup.status).toBe(201);
    expect(dup.body.group).toMatchObject({
      name: "claude-pro-copy",
      enabled: false,
      platform: "anthropic",
      isExclusive: true,
      rateMultiplier: 1.5,
    });
    const dup2 = await call<{ group: GroupItem }>("POST", `/api/v1/admin/groups/${group.id}/duplicate`, admin);
    expect(dup2.body.group.name).toBe("claude-pro-copy-2");

    await createAccount(call, admin, { name: "acc-in-group", groupId: group.id });
    const counted = (await call<{ groups: GroupItem[] }>("GET", "/api/v1/admin/groups", admin)).body.groups.find(
      (g) => g.id === group.id,
    );
    expect(counted).toMatchObject({ accountCount: 1, activeAccountCount: 1 });

    const blocked = await call<{ error: string }>("DELETE", `/api/v1/admin/groups/${group.id}`, admin);
    expect(blocked.status).toBe(409);

    const removed = await call("DELETE", `/api/v1/admin/groups/${dup2.body.group.id}`, admin);
    expect(removed.status).toBe(200);

    const missing = await call("POST", "/api/v1/admin/groups/grp_missing/duplicate", admin);
    expect(missing.status).toBe(404);
  });

  it("hides exclusive groups from regular users and blocks their key creation", async () => {
    const { admin, user, call } = await bootstrap();
    const exclusive = await createGroup(call, admin, { name: "vip", platform: "composite", isExclusive: true });

    const userGroups = await call<{ groups: GroupItem[] }>("GET", "/api/v1/user/groups", user);
    expect(userGroups.body.groups.some((g) => g.id === exclusive.id)).toBe(false);
    const adminGroups = await call<{ groups: GroupItem[] }>("GET", "/api/v1/user/groups", admin);
    expect(adminGroups.body.groups.some((g) => g.id === exclusive.id)).toBe(true);

    const denied = await call("POST", "/api/v1/user/api-keys", user, { name: "k", groupId: exclusive.id });
    expect(denied.status).toBe(403);
    const allowed = await call("POST", "/api/v1/user/api-keys", admin, { name: "k", groupId: exclusive.id });
    expect(allowed.status).toBe(201);

    const keyCount = (await call<{ groups: GroupItem[] }>("GET", "/api/v1/admin/groups", admin)).body.groups.find(
      (g) => g.id === exclusive.id,
    );
    expect(keyCount?.apiKeyCount).toBe(1);
  });
});

describe("account management", () => {
  it("edits notes, bulk-updates and batch-deletes accounts", async () => {
    const { admin, call } = await bootstrap();
    const g1 = await createGroup(call, admin, { name: "g1", platform: "composite" });
    const g2 = await createGroup(call, admin, { name: "g2", platform: "composite" });
    const a = await createAccount(call, admin, { name: "a", groupId: g1.id, notes: "primary" });
    const b = await createAccount(call, admin, { name: "b", groupId: g1.id });
    expect(a.notes).toBe("primary");
    expect(a.lastTest).toBeNull();

    const edited = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${b.id}`, admin, {
      notes: "backup",
      authKind: "setup_token",
    });
    expect(edited.body.account).toMatchObject({ notes: "backup", authKind: "setup_token" });

    const bulk = await call<AccountBulkResult>("POST", "/api/v1/admin/accounts/bulk-update", admin, {
      accountIds: [a.id, b.id, "acc_missing"],
      patch: { groupId: g2.id, status: "paused", priority: 7 },
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body.success).toBe(2);
    expect(bulk.body.failed).toBe(1);
    expect(bulk.body.results.find((r) => r.id === "acc_missing")?.ok).toBe(false);

    const accounts = (await call<{ accounts: UpstreamAccount[] }>("GET", "/api/v1/admin/accounts", admin)).body.accounts;
    for (const acc of accounts) {
      expect(acc).toMatchObject({ groupId: g2.id, groupName: "g2", status: "paused", priority: 7 });
    }

    const emptyPatch = await call("POST", "/api/v1/admin/accounts/bulk-update", admin, {
      accountIds: [a.id],
      patch: {},
    });
    expect(emptyPatch.status).toBe(400);

    const del = await call<AccountBulkResult>("POST", "/api/v1/admin/accounts/batch-delete", admin, {
      accountIds: [a.id, b.id],
    });
    expect(del.body).toMatchObject({ success: 2, failed: 0 });
    const after = (await call<{ accounts: UpstreamAccount[] }>("GET", "/api/v1/admin/accounts", admin)).body.accounts;
    expect(after).toHaveLength(0);
  });
});

describe("account connectivity test", () => {
  const savedUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
  let netServer: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    netServer?.stop(true);
    netServer = null;
    if (savedUrl === undefined) delete process.env.SLIPGATE_NET_INTERNAL_URL;
    else process.env.SLIPGATE_NET_INTERNAL_URL = savedUrl;
  });

  it("rejects VM accounts and reports standalone mode", async () => {
    delete process.env.SLIPGATE_NET_INTERNAL_URL;
    const { admin, call } = await bootstrap("internal-token");
    const g = await createGroup(call, admin, { name: "g", platform: "composite" });
    const direct = await createAccount(call, admin, { name: "direct", groupId: g.id });
    const vm = await createAccount(call, admin, { name: "vm", groupId: g.id, executionMode: "vm_slot" });

    expect((await call("POST", `/api/v1/admin/accounts/${vm.id}/test`, admin, {})).status).toBe(400);
    expect((await call("POST", "/api/v1/admin/accounts/acc_missing/test", admin, {})).status).toBe(404);
    const standalone = await call<{ error: string }>("POST", `/api/v1/admin/accounts/${direct.id}/test`, admin, {});
    expect(standalone.status).toBe(503);
    expect(standalone.body.error).toBe("net_supervisor_unconfigured");
  });

  it("relays the data plane SSE stream and records the outcome", async () => {
    const internalToken = "probe-internal-token";
    const seen: { path: string; token: string | null; body: unknown }[] = [];
    netServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/internal/net/dataplane/sync") {
          return Response.json({ ok: true });
        }
        seen.push({ path: url.pathname, token: req.headers.get("X-Slipgate-Internal-Token"), body: await req.json() });
        const events = [
          { type: "start", model: "claude-haiku-4-5" },
          { type: "delta", text: "Hel" },
          { type: "delta", text: "lo" },
          { type: "done", success: true, status: 200, durationMs: 321, ttftMs: 80 },
        ];
        const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${netServer.port}`;

    const { app, admin, call } = await bootstrap(internalToken);
    const g = await createGroup(call, admin, { name: "g", platform: "composite" });
    const acc = await createAccount(call, admin, { name: "ok", groupId: g.id });

    const res = await app.request(`/api/v1/admin/accounts/${acc.id}/test`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ model: "claude-haiku-4-5", prompt: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sse = await res.text();
    expect(sse).toContain('"type":"delta"');
    expect(sse).toContain('"type":"done"');

    expect(seen[0]).toMatchObject({
      path: `/internal/net/accounts/${acc.id}/test`,
      token: internalToken,
      body: { model: "claude-haiku-4-5", prompt: "hello" },
    });

    const recorded = (await call<{ accounts: UpstreamAccount[] }>("GET", "/api/v1/admin/accounts", admin)).body.accounts[0];
    expect(recorded?.lastTest).toMatchObject({ ok: true, model: "claude-haiku-4-5", durationMs: 321, message: "" });
  });

  it("records failed tests with the upstream message", async () => {
    netServer = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === "/internal/net/dataplane/sync") return Response.json({ ok: true });
        const events = [
          { type: "start", model: "gpt-4o-mini" },
          { type: "done", success: false, status: 401, message: "invalid api key", durationMs: 15 },
        ];
        return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${netServer.port}`;
    const { app, admin, call } = await bootstrap("probe-internal-token");
    const g = await createGroup(call, admin, { name: "g", platform: "composite" });
    const acc = await createAccount(call, admin, { name: "bad", groupId: g.id, platform: "openai" });

    const res = await app.request(`/api/v1/admin/accounts/${acc.id}/test`, { method: "POST", headers: admin });
    expect(res.status).toBe(200);
    await res.text();
    const recorded = (await call<{ accounts: UpstreamAccount[] }>("GET", "/api/v1/admin/accounts", admin)).body.accounts[0];
    expect(recorded?.lastTest).toMatchObject({ ok: false, model: "gpt-4o-mini", message: "invalid api key" });
  });
});
