import { describe, expect, it } from "bun:test";
import {
  parseAccountImportFile,
  type AccountBulkResult,
  type AccountExportFile,
  type AccountImportResult,
  type AccountUsageStats,
  type AccountUsageSummaryResponse,
  type DataPlaneSyncSnapshot,
  type GroupItem,
  type SetAccountPrivacyResponse,
  type UpstreamAccount,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { maskSecret } from "../security/crypto.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const HOUR = 3_600_000;
const ADMIN_PASSWORD = "AdminPassword123!";

async function bootstrap(internalToken = "", store?: ControlStore) {
  const app = createBffApp({
    store,
    jwtSecret: "account-ops-jwt-secret-32-bytes-min",
    vaultSecret: "account-ops-vault-secret-32-bytes-min",
    internalToken,
  });
  const initRes = await app.request("/api/v1/setup/initialize", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      siteName: "Account Ops Test",
      adminEmail: "admin@ops.test",
      adminPassword: ADMIN_PASSWORD,
      allowRegistration: true,
    }),
  });
  expect(initRes.status).toBe(201);
  const { accessToken } = (await initRes.json()) as { accessToken: string };
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` };

  const regRes = await app.request("/api/v1/auth/register", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: "user@ops.test", password: "UserPassword123!" }),
  });
  const regBody = (await regRes.json()) as { accessToken: string; user?: { id?: string } };
  const userToken = regBody.accessToken;
  const userId = regBody.user?.id ?? "usr_ops";
  const user = { ...JSON_HEADERS, Authorization: `Bearer ${userToken}` };

  const call = async <T>(method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  };

  const createGroup = async (name: string) => {
    const res = await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name, platform: "composite" });
    expect(res.status).toBe(201);
    return res.body.group;
  };

  const createAccount = async (body: Record<string, unknown>) => {
    const res = await call<{ account: UpstreamAccount }>("POST", "/api/v1/admin/accounts", admin, {
      platform: "anthropic",
      executionMode: "direct_api",
      authKind: "api_key",
      credentialSecret: `mock://${crypto.randomUUID()}`,
      ...body,
    });
    expect(res.status).toBe(201);
    return res.body.account;
  };

  const listAccounts = async () =>
    (await call<{ accounts: UpstreamAccount[] }>("GET", "/api/v1/admin/accounts", admin)).body.accounts;

  const snapshotStatuses = async () => {
    const res = await app.request("/api/v1/internal/dataplane/snapshot", {
      headers: { "X-Slipgate-Internal-Token": internalToken },
    });
    expect(res.status).toBe(200);
    const snap = (await res.json()) as DataPlaneSyncSnapshot;
    return new Map(snap.accounts.map((a) => [a.id, a.status]));
  };

  return { app, admin, user, userId, call, createGroup, createAccount, listAccounts, snapshotStatuses };
}

describe("account lifecycle", () => {
  it("resolves expiry and cooldown deadlines into the effective and exported status", async () => {
    const env = await bootstrap("lifecycle-internal-token");
    const { admin, call } = env;
    const g = await env.createGroup("g");

    const lapsed = await env.createAccount({
      name: "lapsed",
      groupId: g.id,
      expiresAtIso: new Date(Date.now() - HOUR).toISOString(),
    });
    expect(lapsed).toMatchObject({ status: "active", effectiveStatus: "expired", autoPauseOnExpired: true });

    const runner = await env.createAccount({
      name: "runner",
      groupId: g.id,
      expiresAtIso: new Date(Date.now() - HOUR).toISOString(),
      autoPauseOnExpired: false,
    });
    expect(runner.effectiveStatus).toBe("active");

    const paused = await env.createAccount({ name: "paused", groupId: g.id, status: "paused" });
    expect(paused.effectiveStatus).toBe("paused");

    const resting = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${runner.id}`, admin, {
      status: "cooldown",
      cooldownUntilIso: new Date(Date.now() + 5 * HOUR).toISOString(),
      cooldownReason: "5h window exhausted",
    });
    expect(resting.body.account).toMatchObject({ effectiveStatus: "cooldown", cooldownReason: "5h window exhausted" });
    expect(resting.body.account.cooldownUntilIso).not.toBeNull();

    let statuses = await env.snapshotStatuses();
    expect(statuses.get(lapsed.id)).toBe("expired");
    expect(statuses.get(runner.id)).toBe("cooldown");
    expect(statuses.get(paused.id)).toBe("paused");

    // An elapsed deadline resumes on its own.
    const elapsed = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${runner.id}`, admin, {
      cooldownUntilIso: new Date(Date.now() - 1000).toISOString(),
    });
    expect(elapsed.body.account).toMatchObject({ status: "cooldown", effectiveStatus: "active" });
    statuses = await env.snapshotStatuses();
    expect(statuses.get(runner.id)).toBe("active");

    // Resuming clears the deadline and reason.
    const resumed = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${runner.id}`, admin, {
      status: "active",
    });
    expect(resumed.body.account).toMatchObject({ cooldownUntilIso: null, cooldownReason: "", effectiveStatus: "active" });

    // Extending the expiry revives the lapsed account; null removes it.
    const extended = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${lapsed.id}`, admin, {
      expiresAtIso: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
    });
    expect(extended.body.account.effectiveStatus).toBe("active");
    const cleared = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${lapsed.id}`, admin, {
      expiresAtIso: null,
    });
    expect(cleared.body.account.expiresAtIso).toBeNull();

    // Cooldown without a deadline holds until resumed.
    const indefinite = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${lapsed.id}`, admin, {
      status: "cooldown",
    });
    expect(indefinite.body.account).toMatchObject({ effectiveStatus: "cooldown", cooldownUntilIso: null });

    const bad = await call("PATCH", `/api/v1/admin/accounts/${lapsed.id}`, admin, { expiresAtIso: "next tuesday" });
    expect(bad.status).toBe(400);
  });

  it("treats a cooldown as a deadline only, so paused accounts never wake up", async () => {
    const env = await bootstrap("cooldown-internal-token");
    const { admin, call } = env;
    const g = await env.createGroup("g");
    const active = await env.createAccount({ name: "active", groupId: g.id });
    const paused = await env.createAccount({ name: "paused", groupId: g.id, status: "paused" });
    const ids = [active.id, paused.id];

    const rest = await call<AccountBulkResult>("POST", "/api/v1/admin/accounts/bulk-update", admin, {
      accountIds: ids,
      patch: { cooldownUntilIso: new Date(Date.now() + HOUR).toISOString(), cooldownReason: "rest" },
    });
    expect(rest.body).toMatchObject({ success: 2, failed: 0 });
    let byId = new Map((await env.listAccounts()).map((a) => [a.id, a]));
    expect(byId.get(active.id)).toMatchObject({ status: "active", effectiveStatus: "cooldown", cooldownReason: "rest" });
    expect(byId.get(paused.id)).toMatchObject({ status: "paused", effectiveStatus: "paused" });

    // The deadline passes: the active account resumes, the paused one stays off.
    await call("POST", "/api/v1/admin/accounts/bulk-update", admin, {
      accountIds: ids,
      patch: { cooldownUntilIso: new Date(Date.now() - 1000).toISOString() },
    });
    byId = new Map((await env.listAccounts()).map((a) => [a.id, a]));
    expect(byId.get(active.id)?.effectiveStatus).toBe("active");
    expect(byId.get(paused.id)?.effectiveStatus).toBe("paused");
    const statuses = await env.snapshotStatuses();
    expect(statuses.get(active.id)).toBe("active");
    expect(statuses.get(paused.id)).toBe("paused");
  });

  it("bulk-edits lifecycle fields and reports per-account tier rejections", async () => {
    const env = await bootstrap();
    const { admin, call } = env;
    const g = await env.createGroup("g");
    // Subscription accounts: API keys never take a tier (see "API keys carry no plan").
    const claude = await env.createAccount({ name: "claude", groupId: g.id, authKind: "oauth" });
    const codex = await env.createAccount({ name: "codex", groupId: g.id, platform: "codex", authKind: "oauth" });
    const until = new Date(Date.now() + HOUR).toISOString();

    const bulk = await call<AccountBulkResult>("POST", "/api/v1/admin/accounts/bulk-update", admin, {
      accountIds: [claude.id, codex.id],
      patch: { subscriptionTier: "max", executionMode: "stealth_http", status: "cooldown", cooldownUntilIso: until },
    });
    expect(bulk.status).toBe(200);
    // "max" is a Claude tier: the Codex account is rejected and left untouched.
    expect(bulk.body).toMatchObject({ success: 1, failed: 1 });
    expect(bulk.body.results.find((r) => r.id === codex.id)?.ok).toBe(false);

    const byId = new Map((await env.listAccounts()).map((a) => [a.id, a]));
    expect(byId.get(claude.id)).toMatchObject({
      subscriptionTier: "max",
      tierMultiplier: 5,
      executionMode: "stealth_http",
      effectiveStatus: "cooldown",
    });
    expect(byId.get(codex.id)).toMatchObject({ subscriptionTier: "standard", status: "active", executionMode: "direct_api" });

    const expiry = await call<AccountBulkResult>("POST", "/api/v1/admin/accounts/bulk-update", admin, {
      accountIds: [claude.id, codex.id],
      patch: { status: "active", expiresAtIso: until, autoPauseOnExpired: false },
    });
    expect(expiry.body).toMatchObject({ success: 2, failed: 0 });
    for (const acc of await env.listAccounts()) {
      expect(acc).toMatchObject({ effectiveStatus: "active", autoPauseOnExpired: false, cooldownUntilIso: null });
      expect(acc.expiresAtIso).toBe(until);
    }
  });
});

describe("account import and export", () => {
  it("imports item by item, skipping stored and repeated credentials", async () => {
    const env = await bootstrap();
    const { admin, call } = env;
    const g = await env.createGroup("pool");
    const existing = await env.createAccount({ name: "existing", groupId: g.id, credentialSecret: "sk-existing-0001" });
    const base = { groupId: g.id, platform: "openai", authKind: "api_key", executionMode: "direct_api" };

    const res = await call<AccountImportResult>("POST", "/api/v1/admin/accounts/import", admin, {
      accounts: [
        { ...base, name: "fresh-1", credentialSecret: "sk-fresh-0001", status: "paused" },
        // Same credential as an existing account, modulo surrounding whitespace.
        { ...base, name: "dup-stored", credentialSecret: "  sk-existing-0001  " },
        // JSON credentials compare by content, not key order.
        { ...base, name: "json-a", credentialSecret: JSON.stringify({ api_key: "sk-json", base_url: "https://x.test" }) },
        { ...base, name: "json-b", credentialSecret: JSON.stringify({ base_url: "https://x.test", api_key: "sk-json" }) },
        { ...base, name: "bad-tier", credentialSecret: "sk-bad-tier", subscriptionTier: "max" },
        { ...base, name: "", credentialSecret: "sk-no-name" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, skipped: 2, failed: 2 });
    const outcome = (name: string) => res.body.results.find((r) => r.name === name);
    expect(outcome("fresh-1")?.outcome).toBe("created");
    expect(outcome("dup-stored")).toMatchObject({ outcome: "skipped", duplicateOf: existing.id });
    expect(outcome("json-a")?.outcome).toBe("created");
    expect(outcome("json-b")).toMatchObject({ outcome: "skipped", duplicateOfIndex: 2, message: "duplicate of item #3" });
    // Tier validation happens in the store; the item fails alone.
    expect(outcome("bad-tier")?.outcome).toBe("failed");
    expect(res.body.results[5]).toMatchObject({ index: 5, outcome: "failed" });

    const accounts = await env.listAccounts();
    expect(accounts.find((a) => a.name === "fresh-1")).toMatchObject({ status: "paused", effectiveStatus: "paused" });

    const forced = await call<AccountImportResult>("POST", "/api/v1/admin/accounts/import", admin, {
      accounts: [{ ...base, name: "forced", credentialSecret: "sk-existing-0001" }],
      skipExisting: false,
    });
    expect(forced.body).toMatchObject({ created: 1, skipped: 0 });

    const empty = await call("POST", "/api/v1/admin/accounts/import", admin, { accounts: [] });
    expect(empty.status).toBe(400);
  });

  it("exports plaintext credentials only after password confirmation and round-trips them", async () => {
    const env = await bootstrap();
    const { admin, user, call } = env;
    const g = await env.createGroup("backup");
    const secret = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-abc", refreshToken: "sk-ant-ort01-def" },
    });
    const a = await env.createAccount({
      name: "claude-1",
      groupId: g.id,
      authKind: "oauth",
      executionMode: "stealth_http",
      subscriptionTier: "max",
      credentialSecret: secret,
      notes: "primary",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
    });
    const b = await env.createAccount({ name: "key-1", groupId: g.id, credentialSecret: "sk-plain-key-0001" });

    expect((await call("POST", "/api/v1/admin/accounts/export", admin, { password: "wrong" })).status).toBe(403);
    expect((await call("POST", "/api/v1/admin/accounts/export", user, { password: "UserPassword123!" })).status).toBe(403);
    expect((await call("POST", "/api/v1/admin/accounts/export", admin, {})).status).toBe(400);

    const all = await call<AccountExportFile>("POST", "/api/v1/admin/accounts/export", admin, { password: ADMIN_PASSWORD });
    expect(all.status).toBe(200);
    expect(all.body).toMatchObject({ type: "slipgate-accounts", version: 1, skipped: [] });
    expect(all.body.accounts).toHaveLength(2);
    expect(all.body.accounts.find((x) => x.name === "claude-1")).toMatchObject({
      credentialSecret: secret,
      groupName: "backup",
      subscriptionTier: "max",
      notes: "primary",
      expiresAtIso: "2030-01-01T00:00:00.000Z",
    });

    const one = await call<AccountExportFile>("POST", "/api/v1/admin/accounts/export", admin, {
      password: ADMIN_PASSWORD,
      accountIds: [b.id],
    });
    expect(one.body.accounts.map((x) => x.name)).toEqual(["key-1"]);

    // Re-importing the backup is idempotent: every credential is already stored.
    const parsed = parseAccountImportFile(all.body);
    expect(parsed.formats).toEqual(["slipgate"]);
    const again = await call<AccountImportResult>("POST", "/api/v1/admin/accounts/import", admin, {
      accounts: parsed.drafts.map((d) => ({ ...d, groupId: g.id })),
    });
    expect(again.body).toMatchObject({ created: 0, skipped: 2, failed: 0 });
    expect(again.body.results.find((r) => r.name === "claude-1")?.duplicateOf).toBe(a.id);
  });
});

describe("ungrouped accounts", () => {
  it("creates, moves, imports and exports accounts without a group", async () => {
    // Runs against Postgres when a test preload provides a store factory (nullable group_id path).
    const factory = (globalThis as { __slipgateTestStoreFactory?: () => Promise<ControlStore> }).__slipgateTestStoreFactory;
    const env = await bootstrap("ungrouped-internal-token", factory ? await factory() : undefined);
    const { app, admin, call } = env;
    const g = await env.createGroup("team");

    // No groupId at all, and an explicit empty one, both create an ungrouped account.
    const loose = await env.createAccount({ name: "loose" });
    expect(loose).toMatchObject({ groupId: "", groupName: "" });
    const blank = await env.createAccount({ name: "blank", groupId: "" });
    expect(blank).toMatchObject({ groupId: "", groupName: "" });

    const missing = await call("POST", "/api/v1/admin/accounts", admin, {
      name: "ghost",
      groupId: "grp_missing",
      platform: "anthropic",
      executionMode: "direct_api",
      authKind: "api_key",
      credentialSecret: "sk-ghost-0001",
    });
    // Memory store: 404; Postgres: the group_id FK violation maps to 409.
    expect([404, 409]).toContain(missing.status);

    // Assigning and clearing the group through PATCH.
    const moved = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${loose.id}`, admin, {
      groupId: g.id,
    });
    expect(moved.body.account).toMatchObject({ groupId: g.id, groupName: "team" });
    const cleared = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${loose.id}`, admin, {
      groupId: "",
    });
    expect(cleared.body.account).toMatchObject({ groupId: "", groupName: "" });

    // Bulk edit can move accounts out of a group too.
    await call("PATCH", `/api/v1/admin/accounts/${blank.id}`, admin, { groupId: g.id });
    const bulk = await call<AccountBulkResult>("POST", "/api/v1/admin/accounts/bulk-update", admin, {
      accountIds: [blank.id],
      patch: { groupId: "" },
    });
    expect(bulk.body).toMatchObject({ success: 1, failed: 0 });

    const groups = (await call<{ groups: GroupItem[] }>("GET", "/api/v1/admin/groups", admin)).body.groups;
    expect(groups.find((x) => x.id === g.id)?.accountCount).toBe(0);

    // Import items may leave the group out as well.
    const imported = await call<AccountImportResult>("POST", "/api/v1/admin/accounts/import", admin, {
      accounts: [{ name: "imp", platform: "openai", authKind: "api_key", executionMode: "direct_api", credentialSecret: "sk-imp-0001" }],
    });
    expect(imported.body).toMatchObject({ created: 1, failed: 0 });
    const accounts = await env.listAccounts();
    expect(accounts.find((a) => a.name === "imp")).toMatchObject({ groupId: "", groupName: "" });

    // The data plane receives them with an empty group (only composite groups reach them).
    const snapRes = await app.request("/api/v1/internal/dataplane/snapshot", {
      headers: { "X-Slipgate-Internal-Token": "ungrouped-internal-token" },
    });
    const snap = (await snapRes.json()) as DataPlaneSyncSnapshot;
    expect(snap.accounts.find((a) => a.id === loose.id)?.groupId).toBe("");

    const exported = await call<AccountExportFile>("POST", "/api/v1/admin/accounts/export", admin, {
      password: ADMIN_PASSWORD,
      accountIds: [loose.id],
    });
    expect(exported.body.accounts[0]).toMatchObject({ name: "loose", groupName: "" });
    expect(parseAccountImportFile(exported.body).drafts[0]?.groupName).toBeNull();

    // Deleting a group ungroups its accounts instead of deleting them.
    const doomed = await env.createGroup("doomed");
    const member = await env.createAccount({ name: "member", groupId: doomed.id });
    const dropped = await call<{ ungroupedAccounts: number }>("DELETE", `/api/v1/admin/groups/${doomed.id}`, admin);
    expect(dropped.status).toBe(200);
    expect(dropped.body.ungroupedAccounts).toBe(1);
    expect((await env.listAccounts()).find((a) => a.id === member.id)).toMatchObject({ groupId: "", groupName: "" });
  });
});

describe("temporary-unschedulable rules", () => {
  it("stores, replaces and clears rules and ships them to the data plane", async () => {
    // Runs against Postgres when a test preload provides a store factory (temp_unsched_rules JSONB).
    const factory = (globalThis as { __slipgateTestStoreFactory?: () => Promise<ControlStore> }).__slipgateTestStoreFactory;
    const env = await bootstrap("rules-internal-token", factory ? await factory() : undefined);
    const { app, admin, call } = env;
    const snapshotRules = async (id: string) => {
      const res = await app.request("/api/v1/internal/dataplane/snapshot", {
        headers: { "X-Slipgate-Internal-Token": "rules-internal-token" },
      });
      const snap = (await res.json()) as DataPlaneSyncSnapshot;
      return snap.accounts.find((a) => a.id === id)?.tempUnschedRules;
    };

    const rule = { statusCode: 400, keywords: ["organization has been disabled"], durationMinutes: 1440, description: "org disabled" };
    const acc = await env.createAccount({ name: "ruled", tempUnschedRules: [rule] });
    expect(acc.tempUnschedRules).toEqual([rule]);
    expect(await snapshotRules(acc.id)).toEqual([rule]);

    // Defaults fill in; a non-error status is refused.
    const plain = await env.createAccount({ name: "plain" });
    expect(plain.tempUnschedRules).toEqual([]);
    expect(await snapshotRules(plain.id)).toBeUndefined();
    const bad = await call("POST", "/api/v1/admin/accounts", admin, {
      name: "bad",
      platform: "anthropic",
      executionMode: "direct_api",
      authKind: "api_key",
      credentialSecret: "sk-bad-rule-0001",
      tempUnschedRules: [{ statusCode: 200, durationMinutes: 5 }],
    });
    expect(bad.status).toBe(400);

    // PATCH replaces the whole list; [] clears it; leaving it out keeps it.
    const replaced = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${acc.id}`, admin, {
      tempUnschedRules: [{ statusCode: 0, keywords: ["overloaded"], durationMinutes: 10 }],
    });
    expect(replaced.body.account.tempUnschedRules).toEqual([
      { statusCode: 0, keywords: ["overloaded"], durationMinutes: 10, description: "" },
    ]);
    const kept = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${acc.id}`, admin, { priority: 7 });
    expect(kept.body.account.tempUnschedRules).toHaveLength(1);
    const cleared = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${acc.id}`, admin, {
      tempUnschedRules: [],
    });
    expect(cleared.body.account.tempUnschedRules).toEqual([]);
    expect(await snapshotRules(acc.id)).toBeUndefined();
  });
});

describe("manual OAuth token refresh", () => {
  it("refuses non-OAuth and standalone, and relays slipgate-net's refresh", async () => {
    const savedUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    const seen: { path: string; token: string | null }[] = [];
    const netServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/internal/net/dataplane/sync") return Response.json({ ok: true });
        seen.push({ path: url.pathname, token: req.headers.get("X-Slipgate-Internal-Token") });
        if (url.pathname.endsWith("/acc_broken/oauth/refresh")) {
          return Response.json({ error: "oauth_refresh_failed", message: "invalid_grant" }, { status: 502 });
        }
        return Response.json({ ok: true, subscriptionTier: "max", expiresAtUnixMs: 1_900_000_000_000 });
      },
    });
    try {
      delete process.env.SLIPGATE_NET_INTERNAL_URL;
      const env = await bootstrap("refresh-internal-token");
      const { admin, call } = env;
      const oauth = await env.createAccount({
        name: "oauth",
        authKind: "oauth",
        executionMode: "stealth_http",
        subscriptionTier: "max",
        credentialSecret: JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", refreshToken: "sk-ant-ort01-y" } }),
      });
      const key = await env.createAccount({ name: "key" });

      expect((await call("POST", "/api/v1/admin/accounts/acc_missing/oauth/refresh", admin)).status).toBe(404);
      expect((await call("POST", `/api/v1/admin/accounts/${key.id}/oauth/refresh`, admin)).status).toBe(400);
      const standalone = await call<{ error: string }>("POST", `/api/v1/admin/accounts/${oauth.id}/oauth/refresh`, admin);
      expect(standalone.status).toBe(503);
      expect(standalone.body.error).toBe("net_supervisor_unconfigured");

      process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${netServer.port}`;
      const ok = await call<{ ok: boolean; subscriptionTier: string; expiresAtUnixMs: number }>(
        "POST",
        `/api/v1/admin/accounts/${oauth.id}/oauth/refresh`,
        admin,
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true, subscriptionTier: "max", expiresAtUnixMs: 1_900_000_000_000 });
      expect(seen.at(-1)).toEqual({ path: `/internal/net/accounts/${oauth.id}/oauth/refresh`, token: "refresh-internal-token" });

      // Users without admin rights never reach the data plane.
      expect((await call("POST", `/api/v1/admin/accounts/${oauth.id}/oauth/refresh`, env.user)).status).toBe(403);
    } finally {
      netServer.stop(true);
      if (savedUrl === undefined) delete process.env.SLIPGATE_NET_INTERNAL_URL;
      else process.env.SLIPGATE_NET_INTERNAL_URL = savedUrl;
    }
  });
});

describe("account privacy", () => {
  it("applies only to ChatGPT/Codex and Antigravity OAuth accounts and stores slipgate-net's outcome", async () => {
    const savedUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    const seen: { path: string; token: string | null }[] = [];
    const netServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/internal/net/dataplane/sync") return Response.json({ ok: true });
        seen.push({ path: url.pathname, token: req.headers.get("X-Slipgate-Internal-Token") });
        if (url.pathname.includes("/acc_gone/")) {
          return Response.json({ error: "account_not_synced", message: "not synced" }, { status: 404 });
        }
        const antigravity = seen.length > 1;
        return Response.json(
          antigravity
            ? { ok: true, mode: "privacy_set_failed", status: 200, message: "fetchUserInfo still reports telemetry" }
            : { ok: true, mode: "training_off", status: 200, message: "" },
        );
      },
    });
    try {
      delete process.env.SLIPGATE_NET_INTERNAL_URL;
      // Runs against Postgres when a test preload provides a store factory (privacy_mode columns).
      const factory = (globalThis as { __slipgateTestStoreFactory?: () => Promise<ControlStore> }).__slipgateTestStoreFactory;
      const env = await bootstrap("privacy-internal-token", factory ? await factory() : undefined);
      const { admin, call } = env;
      const codex = await env.createAccount({
        name: "codex",
        platform: "codex",
        authKind: "oauth",
        executionMode: "stealth_http",
        subscriptionTier: "plus",
        credentialSecret: JSON.stringify({ access_token: "eyJ-codex", refresh_token: "rt" }),
      });
      const ag = await env.createAccount({
        name: "ag",
        platform: "antigravity",
        authKind: "oauth",
        executionMode: "direct_api",
        subscriptionTier: "pro",
        credentialSecret: JSON.stringify({ access_token: "ya29.x", refresh_token: "rt", project_id: "p" }),
      });
      const claude = await env.createAccount({
        name: "claude",
        authKind: "oauth",
        executionMode: "stealth_http",
        credentialSecret: JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", refreshToken: "sk-ant-ort01-y" } }),
      });
      const key = await env.createAccount({ name: "key", platform: "openai" });
      expect(codex.privacyMode).toBeNull();
      expect(codex.privacyCheckedAtIso).toBeNull();

      expect((await call("POST", "/api/v1/admin/accounts/acc_missing/privacy", admin)).status).toBe(404);
      for (const acc of [claude, key]) {
        const res = await call<{ error: string }>("POST", `/api/v1/admin/accounts/${acc.id}/privacy`, admin);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("privacy_unsupported");
      }
      const standalone = await call<{ error: string }>("POST", `/api/v1/admin/accounts/${codex.id}/privacy`, admin);
      expect(standalone.status).toBe(503);
      expect(standalone.body.error).toBe("net_supervisor_unconfigured");
      expect(seen).toEqual([]);

      process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${netServer.port}`;
      const ok = await call<SetAccountPrivacyResponse>("POST", `/api/v1/admin/accounts/${codex.id}/privacy`, admin);
      expect(ok.status).toBe(200);
      expect(ok.body.mode).toBe("training_off");
      expect(ok.body.account.privacyMode).toBe("training_off");
      expect(ok.body.account.privacyCheckedAtIso).not.toBeNull();
      expect(seen.at(-1)).toEqual({ path: `/internal/net/accounts/${codex.id}/privacy`, token: "privacy-internal-token" });

      // A provider refusal is still a stored outcome, not an HTTP error.
      const failed = await call<SetAccountPrivacyResponse>("POST", `/api/v1/admin/accounts/${ag.id}/privacy`, admin);
      expect(failed.status).toBe(200);
      expect(failed.body.mode).toBe("privacy_set_failed");
      expect(failed.body.message).toContain("telemetry");
      const listed = await env.listAccounts();
      expect(listed.find((a) => a.id === codex.id)?.privacyMode).toBe("training_off");
      expect(listed.find((a) => a.id === ag.id)?.privacyMode).toBe("privacy_set_failed");

      expect((await call("POST", `/api/v1/admin/accounts/${codex.id}/privacy`, env.user)).status).toBe(403);
    } finally {
      netServer.stop(true);
      if (savedUrl === undefined) delete process.env.SLIPGATE_NET_INTERNAL_URL;
      else process.env.SLIPGATE_NET_INTERNAL_URL = savedUrl;
    }
  });
});

describe("plan tiers", () => {
  it("offers sub2api plan tiers per platform and maps slipgate-net plan reports per platform", async () => {
    const env = await bootstrap("tiers-internal-token");
    const { app } = env;
    const internal = { ...JSON_HEADERS, "X-Slipgate-Internal-Token": "tiers-internal-token" };
    const report = (id: string, subscriptionTier: string) =>
      app.request(`/api/v1/internal/dataplane/accounts/${id}/credentials`, {
        method: "POST",
        headers: internal,
        body: JSON.stringify({ credentialSecret: '{"access_token":"at","refresh_token":"rt"}', subscriptionTier }),
      });
    const tierOf = async (id: string) => (await env.listAccounts()).find((a) => a.id === id);

    const team = await env.createAccount({ name: "chatgpt-team", platform: "codex", authKind: "oauth", subscriptionTier: "team" });
    expect(team).toMatchObject({ subscriptionTier: "team", tierMultiplier: 1 });

    // Raw ChatGPT plan names from refreshed id_tokens land on the matching tier.
    const codex = await env.createAccount({ name: "chatgpt", platform: "codex", authKind: "oauth", subscriptionTier: "plus" });
    expect((await report(codex.id, "promax")).status).toBe(200);
    expect(await tierOf(codex.id)).toMatchObject({ subscriptionTier: "pro_25x", tierMultiplier: 25 });
    // An unrecognized plan keeps the stored tier.
    expect((await report(codex.id, "mystery-plan")).status).toBe(200);
    expect((await tierOf(codex.id))?.subscriptionTier).toBe("pro_25x");

    const claude = await env.createAccount({ name: "claude", platform: "anthropic", authKind: "oauth", subscriptionTier: "max" });
    expect((await report(claude.id, "default_claude_max_20x")).status).toBe(200);
    expect(await tierOf(claude.id)).toMatchObject({ subscriptionTier: "ultra", tierMultiplier: 20 });

    // Tiers outside a platform's list are refused.
    const bad = await env.call("POST", "/api/v1/admin/accounts", env.admin, {
      name: "claude-go",
      platform: "anthropic",
      executionMode: "stealth_http",
      authKind: "oauth",
      subscriptionTier: "go",
      credentialSecret: "mock://claude-go",
    });
    expect(bad.status).toBe(400);
  });
});

describe("API keys carry no plan", () => {
  it("stores and schedules API-key accounts as standard on every write path", async () => {
    const env = await bootstrap("tier-internal-token");
    const { app, admin, call } = env;
    const g = await env.createGroup("g");

    // Create: a tier sent with an API key is dropped.
    const key = await env.createAccount({ name: "key", groupId: g.id, subscriptionTier: "max" });
    expect(key).toMatchObject({ authKind: "api_key", subscriptionTier: "standard", tierMultiplier: 1 });

    // PATCH: still standard when only the tier is sent.
    const patched = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${key.id}`, admin, {
      subscriptionTier: "ultra",
    });
    expect(patched.status).toBe(200);
    expect(patched.body.account).toMatchObject({ subscriptionTier: "standard", tierMultiplier: 1 });

    // Switching a subscription to an API key drops its plan without a tier in the patch.
    const oauth = await env.createAccount({ name: "oauth", groupId: g.id, authKind: "oauth", subscriptionTier: "ultra" });
    expect(oauth).toMatchObject({ subscriptionTier: "ultra", tierMultiplier: 20 });
    const switched = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${oauth.id}`, admin, {
      authKind: "api_key",
    });
    expect(switched.body.account).toMatchObject({ authKind: "api_key", subscriptionTier: "standard", tierMultiplier: 1 });

    // Bulk: subscriptions take the tier, API keys keep standard and still count as updated.
    const sub = await env.createAccount({ name: "sub", groupId: g.id, authKind: "oauth", subscriptionTier: "pro" });
    const bulk = await call<AccountBulkResult>("POST", "/api/v1/admin/accounts/bulk-update", admin, {
      accountIds: [key.id, sub.id],
      patch: { subscriptionTier: "max" },
    });
    expect(bulk.body).toMatchObject({ success: 2, failed: 0 });
    const byId = new Map((await env.listAccounts()).map((a) => [a.id, a]));
    expect(byId.get(key.id)?.subscriptionTier).toBe("standard");
    expect(byId.get(sub.id)?.subscriptionTier).toBe("max");

    // Import goes through the same path.
    const imported = await call<AccountImportResult>("POST", "/api/v1/admin/accounts/import", admin, {
      accounts: [
        {
          name: "imported-key",
          groupId: g.id,
          platform: "anthropic",
          executionMode: "direct_api",
          authKind: "api_key",
          subscriptionTier: "ultra",
          credentialSecret: "sk-ant-imported-key-123",
        },
      ],
    });
    expect(imported.body.created).toBe(1);
    expect((await env.listAccounts()).find((a) => a.name === "imported-key")?.subscriptionTier).toBe("standard");

    // The data plane snapshot schedules them at 1x.
    const res = await app.request("/api/v1/internal/dataplane/snapshot", {
      headers: { "X-Slipgate-Internal-Token": "tier-internal-token" },
    });
    const snap = (await res.json()) as DataPlaneSyncSnapshot;
    expect(snap.accounts.find((a) => a.id === key.id)?.subscriptionTier).toBe("standard");
    expect(snap.accounts.find((a) => a.id === oauth.id)?.subscriptionTier).toBe("standard");
  });
});

describe("account spend quota", () => {
  it("counts usage against daily / total limits, pauses the account in the snapshot and resets", async () => {
    const token = "quota-internal-token";
    // Runs against Postgres when a test preload provides a store factory (quota columns + usage sums).
    const factory = (globalThis as { __slipgateTestStoreFactory?: () => Promise<ControlStore> }).__slipgateTestStoreFactory;
    const env = await bootstrap(token, factory ? await factory() : undefined);
    const { app, admin, call } = env;
    const g = await env.createGroup("quota-g");
    const limited = await env.createAccount({
      name: "limited",
      groupId: g.id,
      quotaDailyLimitUsd: "0.000002",
      quotaTotalLimitUsd: "$0.000005",
    });
    const free = await env.createAccount({ name: "free", groupId: g.id });
    expect(limited.quota).toEqual({
      dailyLimitNanoUsd: "2000",
      weeklyLimitNanoUsd: "0",
      totalLimitNanoUsd: "5000",
      dailyUsedNanoUsd: "0",
      weeklyUsedNanoUsd: "0",
      totalUsedNanoUsd: "0",
      resetAtIso: null,
      state: "ok",
    });
    expect(free.quota.state).toBe("ok");

    let n = 0;
    const settle = async (accountId: string) => {
      n += 1;
      const res = await app.request("/api/v1/internal/dataplane/settlement", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Slipgate-Internal-Token": token },
        body: JSON.stringify({
          requestId: `req_quota_${n}`,
          userId: env.userId,
          apiKeyId: "key_quota",
          accountId,
          groupId: g.id,
          platform: "anthropic",
          publicModel: "claude-sonnet-4-5",
          upstreamModel: "claude-sonnet-4-5",
          ingressCodec: "anthropic_messages",
          egressCodec: "anthropic_messages",
          inputTokens: 10,
          outputTokens: 5,
          costNanoUsd: "1000",
          ttftMs: 10,
          durationMs: 100,
          statusCode: 200,
        }),
      });
      expect(res.status).toBe(200);
    };
    const snapshotStatus = async (id: string) => {
      const res = await app.request("/api/v1/internal/dataplane/snapshot", { headers: { "X-Slipgate-Internal-Token": token } });
      return ((await res.json()) as DataPlaneSyncSnapshot).accounts.find((a) => a.id === id)?.status;
    };
    const quotaOf = async (id: string) => (await env.listAccounts()).find((a) => a.id === id)!;

    await settle(limited.id);
    await settle(free.id);
    expect((await quotaOf(limited.id)).quota).toMatchObject({ dailyUsedNanoUsd: "1000", totalUsedNanoUsd: "1000", state: "ok" });
    // Unlimited accounts do not sum usage.
    expect((await quotaOf(free.id)).quota.totalUsedNanoUsd).toBe("0");
    expect(await snapshotStatus(limited.id)).toBe("active");

    await settle(limited.id);
    const over = await quotaOf(limited.id);
    expect(over.quota).toMatchObject({ dailyUsedNanoUsd: "2000", weeklyUsedNanoUsd: "2000", state: "daily_exceeded" });
    // The stored status is untouched; only the data plane stops scheduling it.
    expect(over.effectiveStatus).toBe("active");
    expect(await snapshotStatus(limited.id)).toBe("paused");
    expect(await snapshotStatus(free.id)).toBe("active");

    // Reset: usage so far stops counting.
    const reset = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${limited.id}`, admin, { resetQuota: true });
    expect(reset.status).toBe(200);
    expect(reset.body.account.quota).toMatchObject({ dailyUsedNanoUsd: "0", totalUsedNanoUsd: "0", state: "ok" });
    expect(reset.body.account.quota.resetAtIso).not.toBeNull();
    expect(await snapshotStatus(limited.id)).toBe("active");

    // Bulk edit can set a weekly limit; "0" removes limits; malformed amounts are refused.
    const bulk = await call<{ success: number }>("POST", "/api/v1/admin/accounts/bulk-update", admin, {
      accountIds: [limited.id, free.id],
      patch: { quotaWeeklyLimitUsd: "12.5" },
    });
    expect(bulk.status).toBe(200);
    expect((await quotaOf(free.id)).quota.weeklyLimitNanoUsd).toBe("12500000000");
    const cleared = await call<{ account: UpstreamAccount }>("PATCH", `/api/v1/admin/accounts/${limited.id}`, admin, {
      quotaDailyLimitUsd: "0",
      quotaWeeklyLimitUsd: "0",
      quotaTotalLimitUsd: "0",
    });
    expect(cleared.body.account.quota).toMatchObject({ dailyLimitNanoUsd: "0", weeklyLimitNanoUsd: "0", totalLimitNanoUsd: "0", state: "ok" });
    expect((await call("PATCH", `/api/v1/admin/accounts/${limited.id}`, admin, { quotaDailyLimitUsd: "-1" })).status).toBe(400);
    expect((await call("PATCH", `/api/v1/admin/accounts/${limited.id}`, admin, { quotaDailyLimitUsd: "abc" })).status).toBe(400);
  });
});

describe("account usage", () => {
  it("summarizes today's traffic per account and builds per-account stats", async () => {
    const token = "usage-internal-token";
    const env = await bootstrap(token);
    const { app, admin, call } = env;
    const g = await env.createGroup("g");
    const busy = await env.createAccount({ name: "busy", groupId: g.id });
    const idle = await env.createAccount({ name: "idle", groupId: g.id });
    expect(busy.lastUsedAtIso).toBeNull();

    const settle = async (n: number, statusCode: number, model: string) => {
      const res = await app.request("/api/v1/internal/dataplane/settlement", {
        method: "POST",
        headers: { ...JSON_HEADERS, "X-Slipgate-Internal-Token": token },
        body: JSON.stringify({
          requestId: `req_usage_${n}`,
          userId: "usr_usage",
          apiKeyId: "key_usage",
          accountId: busy.id,
          groupId: g.id,
          platform: "anthropic",
          publicModel: model,
          upstreamModel: model,
          ingressCodec: "anthropic_messages",
          egressCodec: "anthropic_messages",
          inputTokens: 100,
          outputTokens: 50,
          costNanoUsd: "1000",
          ttftMs: 40,
          durationMs: 400,
          statusCode,
        }),
      });
      expect(res.status).toBe(200);
    };
    await settle(1, 200, "claude-sonnet-4-5");
    await settle(2, 200, "claude-sonnet-4-5");
    await settle(3, 429, "claude-haiku-4-5");

    const today = await call<AccountUsageSummaryResponse>("GET", "/api/v1/admin/accounts/usage-today?tz=-480", admin);
    expect(today.status).toBe(200);
    expect(today.body.items).toEqual([
      { accountId: busy.id, requests: 3, errors: 1, inputTokens: 300, outputTokens: 150, costNanoUsd: "3000" },
    ]);

    const accounts = await env.listAccounts();
    expect(accounts.find((a) => a.id === busy.id)?.lastUsedAtIso).not.toBeNull();
    expect(accounts.find((a) => a.id === idle.id)?.lastUsedAtIso).toBeNull();

    const stats = await call<AccountUsageStats>("GET", `/api/v1/admin/accounts/${busy.id}/stats?range=24h&tz=0`, admin);
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ accountId: busy.id, range: "24h", granularity: "hour", activeBuckets: 1 });
    expect(stats.body.series).toHaveLength(24);
    expect(stats.body.period).toMatchObject({ requests: 3, errors: 1, inputTokens: 300, costNanoUsd: "3000" });
    expect(stats.body.peak?.requests).toBe(3);
    expect(stats.body.models[0]).toMatchObject({ model: "claude-sonnet-4-5", requests: 2 });
    expect(stats.body.errorCodes).toEqual([{ statusCode: 429, count: 1 }]);

    const idleStats = await call<AccountUsageStats>("GET", `/api/v1/admin/accounts/${idle.id}/stats?range=30d`, admin);
    expect(idleStats.body).toMatchObject({ range: "30d", granularity: "day", activeBuckets: 0, peak: null });
    expect(idleStats.body.series).toHaveLength(30);

    expect((await call("GET", "/api/v1/admin/accounts/acc_missing/stats", admin)).status).toBe(404);
  });
});

describe("credential previews", () => {
  it("mask the token of JSON credentials instead of the JSON text", () => {
    expect(maskSecret("sk-ant-api03-0123456789")).toBe("sk-ant...6789");
    expect(maskSecret("https://relay.example.com|sk-ant-api03-0123456789")).toBe("sk-ant...6789");
    expect(maskSecret('{"email":"a@example.com","access_token":"sk-ant-oat01-abcdefgh","type":"claude"}')).toBe("sk-ant...efgh");
    // Gemini CLI auth files nest the token; Claude Code / Codex CLI files use their own wrappers.
    expect(maskSecret('{"email":"g@example.com","token":{"access_token":"ya29.a0AfH6SMBxyz9876"}}')).toBe("ya29.a...9876");
    expect(maskSecret('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-zzzz1234"}}')).toBe("sk-ant...1234");
    expect(maskSecret('{"tokens":{"access_token":"eyJhbGciOiJSUzI1NiJ9.x.sig9"}}')).toBe("eyJhbG...sig9");
    // Short tokens stay fully hidden; JSON without a known token falls back to the text.
    expect(maskSecret('{"api_key":"short"}')).toBe("****");
    expect(maskSecret('{"unknown_field":"value-value-value"}')).toBe('{"unkn...ue"}');
  });
});

describe("account models and CLI fingerprint", () => {
  it("lists upstream models, falls back to the built-in list with a reason, and proxies the CLI report", async () => {
    const savedUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    const behavior = new Map<string, "listed" | "refused">();
    const netServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/internal/net/dataplane/sync") return Response.json({ ok: true });
        if (req.headers.get("X-Slipgate-Internal-Token") !== "models-internal-token") return Response.json({}, { status: 401 });
        const m = /^\/internal\/net\/accounts\/([^/]+)\/models$/.exec(url.pathname);
        if (m) {
          const mode = behavior.get(decodeURIComponent(m[1]!));
          if (mode === "listed") return Response.json({ ok: true, source: "upstream", models: ["gpt-4.1", "gpt-4o-mini"] });
          if (mode === "refused") return Response.json({ ok: true, source: "default", models: [], message: "upstream HTTP 401" });
          return Response.json({ error: "account_not_synced", message: "not synced" }, { status: 404 });
        }
        if (url.pathname === "/internal/net/cli-fingerprint" || url.pathname === "/internal/net/cli-fingerprint/sync") {
          return Response.json({
            syncEnabled: true,
            lastSyncAtUnixMs: url.pathname.endsWith("/sync") ? 1_900_000_000_000 : 0,
            tools: [{ key: "claude", name: "Claude Code", effective: "2.1.332", builtin: "2.1.332", source: "builtin", userAgent: "claude-cli/2.1.332 (external, cli)", syncable: true }],
          });
        }
        return Response.json({ error: "nope" }, { status: 404 });
      },
    });
    try {
      delete process.env.SLIPGATE_NET_INTERNAL_URL;
      const env = await bootstrap("models-internal-token");
      const { admin, call } = env;
      const acc = await env.createAccount({ name: "models-openai", platform: "openai" });
      type Models = { models: string[]; source: string; message: string; fetchedAtIso: string };

      // Standalone: built-in list with the reason; CLI report unavailable.
      const standalone = await call<Models>("GET", `/api/v1/admin/accounts/${acc.id}/models`, admin);
      expect(standalone.status).toBe(200);
      expect(standalone.body.source).toBe("default");
      expect(standalone.body.models).toContain("gpt-4o-mini");
      expect(standalone.body.message).toContain("standalone");
      expect((await call("GET", "/api/v1/admin/cli-fingerprint", admin)).status).toBe(503);
      expect((await call("GET", "/api/v1/admin/accounts/acc_missing/models", admin)).status).toBe(404);

      process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${netServer.port}`;
      const refused = await env.createAccount({ name: "models-refused", platform: "openai" });
      behavior.set(acc.id, "listed");
      behavior.set(refused.id, "refused");
      const listed = await call<Models>("GET", `/api/v1/admin/accounts/${acc.id}/models`, admin);
      expect(listed.body).toMatchObject({ source: "upstream", models: ["gpt-4.1", "gpt-4o-mini"], message: "" });
      // A provider refusal: the built-in list with the provider's reason.
      const fallback = await call<Models>("GET", `/api/v1/admin/accounts/${refused.id}/models`, admin);
      expect(fallback.body.source).toBe("default");
      expect(fallback.body.message).toBe("upstream HTTP 401");
      expect(fallback.body.models).toContain("gpt-4o-mini");
      // Unknown to the network service (404 account_not_synced): falls back too.
      behavior.delete(acc.id);
      expect((await call<Models>("GET", `/api/v1/admin/accounts/${acc.id}/models`, admin)).body).toMatchObject({
        source: "default",
        message: "not synced",
      });

      const report = await call<{ tools: { key: string; effective: string }[]; syncEnabled: boolean }>("GET", "/api/v1/admin/cli-fingerprint", admin);
      expect(report.status).toBe(200);
      expect(report.body.tools[0]).toMatchObject({ key: "claude", effective: "2.1.332" });
      const synced = await call<{ lastSyncAtUnixMs: number }>("POST", "/api/v1/admin/cli-fingerprint/sync", admin);
      expect(synced.body.lastSyncAtUnixMs).toBe(1_900_000_000_000);
      expect((await call("GET", "/api/v1/admin/cli-fingerprint", env.user)).status).toBe(403);
    } finally {
      netServer.stop(true);
      if (savedUrl === undefined) delete process.env.SLIPGATE_NET_INTERNAL_URL;
      else process.env.SLIPGATE_NET_INTERNAL_URL = savedUrl;
    }
  });
});
