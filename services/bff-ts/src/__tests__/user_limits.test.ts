import { afterEach, describe, expect, it } from "bun:test";
import type {
  AdminBatchDeleteUsersResponse,
  AdminGroupApiKeysResponse,
  AdminUpdateApiKeyResponse,
  AdminUserGroupRatesResponse,
  AdminUserItem,
  AdminUserListResponse,
  AdminUserLiveStatsResponse,
  AdminUserRpmStatus,
  AdminUserUsageStatsResponse,
  ApiKeyItem,
  DataPlaneSyncSnapshot,
  GroupItem,
  GroupRateMultipliersResponse,
  ReplaceUserGroupResponse,
  TurnSettlementEvent,
  UsageLogItem,
  UserGroupRatesResponse,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { clampKeysToUserLimits, repriceForUser } from "../routes/user_limits.ts";
import type { ControlStore } from "../store/types.ts";
import { viewerDayStartMs } from "../store/user_limits_types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "user-limits-internal-token";

type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const app = createBffApp({
    store: factory ? await factory() : undefined,
    jwtSecret: "user-limits-test-jwt-secret-32-bytes-min",
    vaultSecret: "user-limits-test-vault-secret-32-bytes",
    internalToken: INTERNAL,
  });
  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T };
  };
  const init = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Limits Test",
    adminEmail: "admin@limits.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  const adminId = init.body.user.id;
  const register = async (email: string) => {
    const res = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email,
      password: "UserPassword123!",
    });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, headers: { ...JSON_HEADERS, Authorization: `Bearer ${res.body.accessToken}` } };
  };
  const snapshot = async () =>
    (await call<DataPlaneSyncSnapshot>("GET", "/api/v1/internal/dataplane/snapshot", { "X-Slipgate-Internal-Token": INTERNAL })).body;
  const group = async (name: string, extra: Record<string, unknown> = {}) => {
    const res = await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name, platform: "anthropic", ...extra });
    expect(res.status).toBe(201);
    return res.body.group;
  };
  const accounts = new Map<string, string>();
  const account = async (groupId: string) => {
    const known = accounts.get(groupId);
    if (known) return known;
    const res = await call<{ account: { id: string } }>("POST", "/api/v1/admin/accounts", admin, {
      groupId,
      name: `acc-${groupId}`,
      platform: "anthropic",
      executionMode: "direct_api",
      authKind: "api_key",
      credentialSecret: `sk-ant-test-${groupId}-${Math.random()}`,
    });
    expect(res.status).toBe(201);
    accounts.set(groupId, res.body.account.id);
    return res.body.account.id;
  };
  const settle = async (ev: Partial<TurnSettlementEvent> & { userId: string; apiKeyId: string; groupId: string }) => {
    const res = await call<{ item: UsageLogItem }>(
      "POST",
      "/api/v1/internal/dataplane/settlement",
      { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL },
      {
        requestId: `req_${crypto.randomUUID()}`,
        platform: "anthropic",
        accountId: await account(ev.groupId),
        publicModel: "claude-sonnet-5-5",
        upstreamModel: "claude-sonnet-5-5",
        ingressCodec: "anthropic_messages",
        egressCodec: "anthropic_messages",
        inputTokens: 1000,
        outputTokens: 500,
        costNanoUsd: "1000000",
        statusCode: 200,
        ...ev,
      },
    );
    expect(res.status).toBe(200);
    return res.body.item;
  };
  const key = async (headers: Record<string, string>, groupId: string, extra: Record<string, unknown> = {}) => {
    const res = await call<{ item: ApiKeyItem }>("POST", "/api/v1/user/api-keys", headers, { name: "k", groupId, ...extra });
    expect(res.status).toBe(201);
    return res.body.item;
  };
  return { app, call, admin, adminId, register, snapshot, group, settle, key };
}

const envBackup = { url: process.env.SLIPGATE_NET_INTERNAL_URL };
afterEach(() => {
  if (envBackup.url === undefined) delete process.env.SLIPGATE_NET_INTERNAL_URL;
  else process.env.SLIPGATE_NET_INTERNAL_URL = envBackup.url;
});

describe("user caps and group caps", () => {
  it("stores group caps and user caps, applies the portal default and exports them to the data plane", async () => {
    const { call, admin, register, snapshot, group, key } = await bootstrap();
    const g = await group("capped", { rpmLimit: 30, concurrencyLimit: 3 });
    expect(g.rpmLimit).toBe(30);
    const patched = await call<{ group: GroupItem }>("PATCH", `/api/v1/admin/groups/${g.id}`, admin, { rpmLimit: 20 });
    expect(patched.body.group.rpmLimit).toBe(20);
    expect(patched.body.group.concurrencyLimit).toBe(3);
    const dup = await call<{ group: GroupItem }>("POST", `/api/v1/admin/groups/${g.id}/duplicate`, admin);
    expect(dup.body.group.rpmLimit).toBe(20);
    expect((await call("PATCH", `/api/v1/admin/groups/${g.id}`, admin, { rpmLimit: -1 })).status).toBe(400);

    const created = await call<{ user: AdminUserItem }>("POST", "/api/v1/admin/users", admin, {
      email: "capped@limits.test",
      password: "UserPassword123!",
      rpmLimit: 12,
      concurrencyLimit: 2,
    });
    expect(created.status).toBe(201);
    expect(created.body.user.rpmLimit).toBe(12);
    expect(created.body.user.effectiveConcurrencyLimit).toBe(2);
    const capped = created.body.user;

    const bob = await register("bob@limits.test");
    await call("PATCH", "/api/v1/admin/settings", admin, { defaultUserRpm: 40, defaultUserConcurrency: 4 });
    const bobRow = await call<{ user: AdminUserItem }>("GET", `/api/v1/admin/users/${bob.id}`, admin);
    expect(bobRow.body.user.rpmLimit).toBeNull();
    expect(bobRow.body.user.effectiveRpmLimit).toBe(40);
    expect(bobRow.body.user.effectiveConcurrencyLimit).toBe(4);

    // PATCH: 0 = unlimited, null = back to the default; omitted fields stay.
    const p1 = await call<{ user: AdminUserItem }>("PATCH", `/api/v1/admin/users/${capped.id}`, admin, { rpmLimit: 0 });
    expect(p1.body.user.rpmLimit).toBe(0);
    expect(p1.body.user.effectiveRpmLimit).toBe(0);
    expect(p1.body.user.concurrencyLimit).toBe(2);
    const p2 = await call<{ user: AdminUserItem }>("PATCH", `/api/v1/admin/users/${capped.id}`, admin, { concurrencyLimit: null });
    expect(p2.body.user.concurrencyLimit).toBeNull();
    expect(p2.body.user.effectiveConcurrencyLimit).toBe(4);
    expect((await call("PATCH", `/api/v1/admin/users/${capped.id}`, admin, { rpmLimit: -5 })).status).toBe(400);

    // Keys get clamped to the caps covering them; userLimits travels in the snapshot.
    const bobKey = await key(bob.headers, g.id, { rpmLimit: 500, concurrencyLimit: 50 });
    const snap = await snapshot();
    expect(snap.userLimits?.defaultRpmLimit).toBe(40);
    expect(snap.userLimits?.users).toEqual([{ userId: capped.id, rpmLimit: 0, concurrencyLimit: null }]);
    expect(snap.userLimits?.groups.find((x) => x.groupId === g.id)).toEqual({ groupId: g.id, rpmLimit: 20, concurrencyLimit: 3 });
    const exported = snap.apiKeys.find((k) => k.id === bobKey.id)!;
    expect(exported.rpmLimit).toBe(20);
    expect(exported.concurrencyLimit).toBe(3);
  });

  it("applies batch limits and batch concurrency (set / add, floored at 0)", async () => {
    const { call, admin, register } = await bootstrap();
    const a = await register("a@limits.test");
    const b = await register("b@limits.test");
    const res = await call<{ updated: number }>("POST", "/api/v1/admin/users/batch-limits", admin, {
      userIds: [a.id, b.id, "usr_missing"],
      rpmLimit: 15,
    });
    expect(res.body.updated).toBe(2);
    await call("PATCH", "/api/v1/admin/settings", admin, { defaultUserConcurrency: 3 });
    const add = await call<{ updated: number }>("POST", "/api/v1/admin/users/batch-concurrency", admin, {
      userIds: [a.id],
      mode: "add",
      value: 2,
    });
    expect(add.body.updated).toBe(1);
    const aRow = (await call<{ user: AdminUserItem }>("GET", `/api/v1/admin/users/${a.id}`, admin)).body.user;
    expect(aRow.concurrencyLimit).toBe(5);
    expect(aRow.rpmLimit).toBe(15);
    await call("POST", "/api/v1/admin/users/batch-concurrency", admin, { userIds: [a.id], mode: "add", value: -9 });
    expect((await call<{ user: AdminUserItem }>("GET", `/api/v1/admin/users/${a.id}`, admin)).body.user.concurrencyLimit).toBe(0);
    const all = await call<{ updated: number }>("POST", "/api/v1/admin/users/batch-limits", admin, { all: true, concurrencyLimit: 7 });
    expect(all.body.updated).toBe(3);
    const list = await call<AdminUserListResponse>("GET", "/api/v1/admin/users?pageSize=50", admin);
    expect(list.body.items.every((u) => u.concurrencyLimit === 7)).toBe(true);
    expect(list.body.items.find((u) => u.id === b.id)!.rpmLimit).toBe(15);
    // Bad requests: no targets, no fields, negative set.
    expect((await call("POST", "/api/v1/admin/users/batch-limits", admin, { userIds: [], rpmLimit: 1 })).status).toBe(400);
    expect((await call("POST", "/api/v1/admin/users/batch-limits", admin, { userIds: [a.id] })).status).toBe(400);
    expect((await call("POST", "/api/v1/admin/users/batch-concurrency", admin, { userIds: [a.id], mode: "set", value: -1 })).status).toBe(400);
    // Users cannot reach any of it.
    expect((await call("POST", "/api/v1/admin/users/batch-limits", a.headers, { all: true, rpmLimit: 0 })).status).toBe(403);
  });
});

describe("per-user group rates and RPM overrides", () => {
  it("syncs, lists and clears a group's custom rates and overrides independently", async () => {
    const { call, admin, register, snapshot, group } = await bootstrap();
    const g = await group("rated", { rateMultiplier: 1.5, rpmLimit: 10 });
    const u1 = await register("u1@limits.test");
    const u2 = await register("u2@limits.test");
    const base = `/api/v1/admin/groups/${g.id}`;
    expect((await call("PUT", `${base}/rate-multipliers`, admin, { entries: [{ userId: u1.id, rateMultiplier: 0.5 }, { userId: u2.id, rateMultiplier: 2 }] })).status).toBe(200);
    expect((await call("PUT", `${base}/rpm-overrides`, admin, { entries: [{ userId: u1.id, rpmOverride: 0 }] })).status).toBe(200);
    let listed = (await call<GroupRateMultipliersResponse>("GET", `${base}/rate-multipliers`, admin)).body;
    expect(listed.groupRateMultiplier).toBe(1.5);
    expect(listed.groupRpmLimit).toBe(10);
    expect(listed.items.map((i) => [i.email, i.rateMultiplier, i.rpmOverride])).toEqual([
      ["u1@limits.test", 0.5, 0],
      ["u2@limits.test", 2, null],
    ]);
    // A PUT replaces the whole set: u2 loses its rate, u1's RPM override stays.
    await call("PUT", `${base}/rate-multipliers`, admin, { entries: [{ userId: u1.id, rateMultiplier: 0.75 }] });
    listed = (await call<GroupRateMultipliersResponse>("GET", `${base}/rate-multipliers`, admin)).body;
    expect(listed.items.map((i) => [i.userId, i.rateMultiplier, i.rpmOverride])).toEqual([[u1.id, 0.75, 0]]);
    const snap = await snapshot();
    expect(snap.userLimits?.overrides).toEqual([{ userId: u1.id, groupId: g.id, rpmOverride: 0, rateMultiplier: 0.75 }]);

    // Validation: unknown users, out-of-range rates, unknown group.
    expect((await call("PUT", `${base}/rate-multipliers`, admin, { entries: [{ userId: "usr_nope", rateMultiplier: 1 }] })).status).toBe(400);
    expect((await call("PUT", `${base}/rate-multipliers`, admin, { entries: [{ userId: u1.id, rateMultiplier: 101 }] })).status).toBe(400);
    expect((await call("PUT", `${base}/rate-multipliers`, admin, { entries: [{ userId: u1.id, rateMultiplier: 0 }] })).status).toBe(400);
    expect((await call("GET", "/api/v1/admin/groups/grp_nope/rate-multipliers", admin)).status).toBe(404);
    expect((await call("PUT", "/api/v1/admin/groups/grp_nope/rpm-overrides", admin, { entries: [] })).status).toBe(404);
    expect((await call("GET", `${base}/rate-multipliers`, u1.headers)).status).toBe(403);

    // DELETE clears one kind only; a row with nothing left disappears.
    expect((await call<{ cleared: number }>("DELETE", `${base}/rpm-overrides`, admin)).body.cleared).toBe(1);
    listed = (await call<GroupRateMultipliersResponse>("GET", `${base}/rate-multipliers`, admin)).body;
    expect(listed.items.map((i) => [i.userId, i.rateMultiplier, i.rpmOverride])).toEqual([[u1.id, 0.75, null]]);
    expect((await call<{ cleared: number }>("DELETE", `${base}/rate-multipliers`, admin)).body.cleared).toBe(1);
    expect((await call<GroupRateMultipliersResponse>("GET", `${base}/rate-multipliers`, admin)).body.items).toEqual([]);
  });

  it("edits one user's rates per group and shows the user their effective rates", async () => {
    const { call, admin, register, group } = await bootstrap();
    const open = await group("open", { rateMultiplier: 2, rpmLimit: 50, concurrencyLimit: 5 });
    const vip = await group("vip", { rateMultiplier: 3, isExclusive: true });
    const hidden = await group("hidden", { isExclusive: true });
    const u = await register("rates@limits.test");
    await call("PATCH", `/api/v1/admin/users/${u.id}`, admin, { allowedGroupIds: [vip.id] });
    const put = await call<AdminUserGroupRatesResponse>("PUT", `/api/v1/admin/users/${u.id}/group-rates`, admin, {
      rates: { [open.id]: 1.25, [vip.id]: 2 },
      rpmOverrides: { [open.id]: 80 },
    });
    expect(put.status).toBe(200);
    const openRow = put.body.items.find((i) => i.groupId === open.id)!;
    expect(openRow).toMatchObject({ rateMultiplier: 1.25, rpmOverride: 80, effectiveRateMultiplier: 1.25, groupRateMultiplier: 2 });
    // Patch semantics: null clears, absent groups stay.
    const cleared = await call<AdminUserGroupRatesResponse>("PUT", `/api/v1/admin/users/${u.id}/group-rates`, admin, { rates: { [vip.id]: null } });
    expect(cleared.body.items.find((i) => i.groupId === vip.id)!.effectiveRateMultiplier).toBe(3);
    expect(cleared.body.items.find((i) => i.groupId === open.id)!.rateMultiplier).toBe(1.25);
    expect((await call("PUT", `/api/v1/admin/users/${u.id}/group-rates`, admin, { rates: { grp_nope: 1 } })).status).toBe(400);
    expect((await call("PUT", `/api/v1/admin/users/usr_nope/group-rates`, admin, { rates: { [open.id]: 1 } })).status).toBe(404);
    expect((await call("PUT", `/api/v1/admin/users/${u.id}/group-rates`, admin, {})).status).toBe(400);
    // Linksyncx UpdateUserRequest.group_rates rides on the user PATCH; an unknown group saves nothing.
    const refused = await call("PATCH", `/api/v1/admin/users/${u.id}`, admin, { username: "renamed", groupRates: { grp_nope: 2 } });
    expect(refused.status).toBe(400);
    expect((await call<{ user: AdminUserItem }>("GET", `/api/v1/admin/users/${u.id}`, admin)).body.user.username).not.toBe("renamed");
    await call("PATCH", `/api/v1/admin/users/${u.id}`, admin, { groupRates: { [vip.id]: 2.5 } });
    const viaPatch = await call<AdminUserGroupRatesResponse>("GET", `/api/v1/admin/users/${u.id}/group-rates`, admin);
    expect(viaPatch.body.items.find((i) => i.groupId === vip.id)!.rateMultiplier).toBe(2.5);
    await call("PATCH", `/api/v1/admin/users/${u.id}`, admin, { groupRates: { [vip.id]: null } });

    await call("PATCH", "/api/v1/admin/settings", admin, { defaultUserRpm: 9 });
    const mine = await call<UserGroupRatesResponse>("GET", "/api/v1/user/groups/rates", u.headers);
    expect(mine.status).toBe(200);
    expect(mine.body.rates).toEqual({ [open.id]: 1.25 });
    expect(mine.body.userRpmLimit).toBe(9);
    const ids = mine.body.items.map((i) => i.groupId);
    expect(ids).toContain(vip.id);
    expect(ids).not.toContain(hidden.id);
    expect(mine.body.items.find((i) => i.groupId === open.id)).toMatchObject({
      customRateMultiplier: 1.25,
      effectiveRateMultiplier: 1.25,
      groupRateMultiplier: 2,
      rpmLimit: 80,
      concurrencyLimit: 5,
    });
    expect(mine.body.items.find((i) => i.groupId === vip.id)!.effectiveRateMultiplier).toBe(3);
    expect((await call("GET", "/api/v1/user/groups/rates")).status).toBe(401);
  });

  it("bills settled turns at the user's custom rate whatever slipgate-core charged", async () => {
    const { call, admin, register, group, settle, key } = await bootstrap();
    const g = await group("billing", { rateMultiplier: 1 });
    const payer = await register("payer@limits.test");
    const plain = await register("plain@limits.test");
    await call("POST", `/api/v1/admin/users/${payer.id}/credit`, admin, { amountUsd: "10" });
    await call("POST", `/api/v1/admin/users/${plain.id}/credit`, admin, { amountUsd: "10" });
    const payerKey = await key(payer.headers, g.id);
    const plainKey = await key(plain.headers, g.id);
    await call("PUT", `/api/v1/admin/groups/${g.id}/rate-multipliers`, admin, { entries: [{ userId: payer.id, rateMultiplier: 2.5 }] });

    // No price rule: a core that priced at the group rate (the custom rate had not synced yet) is
    // scaled to the user's rate; one that already used the user's rate is billed as it charged.
    expect(
      (await settle({ userId: payer.id, apiKeyId: payerKey.id, groupId: g.id, costNanoUsd: "1000000", coreRateMultiplierMicros: 1_000_000 }))
        .costNanoUsd,
    ).toBe("2500000");
    expect(
      (await settle({ userId: payer.id, apiKeyId: payerKey.id, groupId: g.id, costNanoUsd: "2500000", coreRateMultiplierMicros: 2_500_000 }))
        .costNanoUsd,
    ).toBe("2500000");
    expect((await settle({ userId: payer.id, apiKeyId: payerKey.id, groupId: g.id, costNanoUsd: "2500000" })).costNanoUsd).toBe("2500000");
    expect((await settle({ userId: plain.id, apiKeyId: plainKey.id, groupId: g.id, costNanoUsd: "1000000" })).costNanoUsd).toBe("1000000");
    // A failed or free turn stays free.
    expect((await settle({ userId: payer.id, apiKeyId: payerKey.id, groupId: g.id, costNanoUsd: "0", statusCode: 529 })).costNanoUsd).toBe("0");
    // A turn the core could not settle is priced here at the user's rate (built-in rates).
    const unsettled = await settle({ userId: payer.id, apiKeyId: payerKey.id, groupId: g.id, costNanoUsd: "0", coreSettled: false });
    expect(unsettled.costNanoUsd).toBe((((1000n * 3000n + 500n * 15000n) * 2_500_000n) / 1_000_000n).toString());

    // With a price rule the rule is applied at the user's rate.
    expect(
      (await call("POST", "/api/v1/admin/pricing", admin, { pattern: "claude-sonnet-5-5", inputPerMTokUsd: "1", outputPerMTokUsd: "2" })).status,
    ).toBe(201);
    const ruled = await settle({ userId: payer.id, apiKeyId: payerKey.id, groupId: g.id, costNanoUsd: "1" });
    // (1000 * 1e9 + 500 * 2e9) / 1e6 = 2_000_000 nano at 1x, times 2.5.
    expect(ruled.costNanoUsd).toBe("5000000");
    const ruledPlain = await settle({ userId: plain.id, apiKeyId: plainKey.id, groupId: g.id, costNanoUsd: "1" });
    expect(ruledPlain.costNanoUsd).toBe("2000000");
  });

  it("drops rate rows with their user or group", async () => {
    const { call, admin, register, group, snapshot } = await bootstrap();
    const g = await group("doomed");
    const keep = await group("kept");
    const u = await register("gone@limits.test");
    await call("PUT", `/api/v1/admin/users/${u.id}/group-rates`, admin, { rates: { [g.id]: 2, [keep.id]: 3 } });
    await call("POST", "/api/v1/admin/users/batch-limits", admin, { userIds: [u.id], rpmLimit: 5 });
    expect((await call("DELETE", `/api/v1/admin/groups/${g.id}`, admin)).status).toBe(200);
    expect((await snapshot()).userLimits?.overrides.map((o) => o.groupId)).toEqual([keep.id]);
    expect((await call("DELETE", `/api/v1/admin/users/${u.id}`, admin)).status).toBe(200);
    const snap = await snapshot();
    expect(snap.userLimits?.overrides).toEqual([]);
    expect(snap.userLimits?.users).toEqual([]);
  });
});

describe("admin user tooling", () => {
  it("filters by allowed group and key group, sorts by usage and activity, reports usage per platform", async () => {
    const { call, admin, register, group, settle, key } = await bootstrap();
    const ex = await group("exclusive-a", { isExclusive: true });
    const g = await group("shared");
    const a = await register("alpha@limits.test");
    const b = await register("beta@limits.test");
    await call("PATCH", `/api/v1/admin/users/${a.id}`, admin, { allowedGroupIds: [ex.id] });
    const bKey = await key(b.headers, g.id);
    const aKey = await key(a.headers, ex.id);

    const byGroup = await call<AdminUserListResponse>("GET", `/api/v1/admin/users?groupId=${ex.id}`, admin);
    expect(byGroup.body.items.map((u) => u.id)).toEqual([a.id]);
    const byKeyGroup = await call<AdminUserListResponse>("GET", `/api/v1/admin/users?apiKeyGroupId=${g.id}`, admin);
    expect(byKeyGroup.body.items.map((u) => u.id)).toEqual([b.id]);
    expect(byKeyGroup.body.total).toBe(1);

    await settle({ userId: b.id, apiKeyId: bKey.id, groupId: g.id, costNanoUsd: "7000" });
    await settle({ userId: b.id, apiKeyId: bKey.id, groupId: g.id, costNanoUsd: "3000", platform: "openai" });
    await settle({ userId: a.id, apiKeyId: aKey.id, groupId: ex.id, costNanoUsd: "500" });
    const today = await call<AdminUserListResponse>("GET", "/api/v1/admin/users?sort=today_cost_desc&tz=0", admin);
    expect(today.body.items.slice(0, 2).map((u) => u.id)).toEqual([b.id, a.id]);
    const lastUsed = await call<AdminUserListResponse>("GET", "/api/v1/admin/users?sort=last_used_desc", admin);
    expect(lastUsed.body.items.slice(0, 2).map((u) => u.id).sort()).toEqual([a.id, b.id].sort());
    const bRow = lastUsed.body.items.find((u) => u.id === b.id)!;
    expect(bRow.lastApiUsedAtIso).not.toBeNull();
    expect(bRow.lastActiveAtIso).not.toBeNull();
    expect((await call<AdminUserListResponse>("GET", "/api/v1/admin/users?sort=last_active_desc", admin)).status).toBe(200);
    expect((await call<AdminUserListResponse>("GET", "/api/v1/admin/users?sort=total_cost_desc", admin)).body.items[0]!.id).toBe(b.id);

    const usage = await call<AdminUserUsageStatsResponse>("GET", `/api/v1/admin/user-stats/usage?userIds=${b.id},${a.id},usr_none&tz=0`, admin);
    expect(usage.status).toBe(200);
    expect(usage.body.windowDays).toBe(30);
    const bUsage = usage.body.items.find((i) => i.userId === b.id)!;
    expect(bUsage.todayNanoUsd).toBe("10000");
    expect(bUsage.totalNanoUsd).toBe("10000");
    expect(bUsage.byPlatform).toEqual([
      { platform: "anthropic", todayNanoUsd: "7000", totalNanoUsd: "7000" },
      { platform: "openai", todayNanoUsd: "3000", totalNanoUsd: "3000" },
    ]);
    expect(usage.body.items.find((i) => i.userId === "usr_none")!.totalNanoUsd).toBe("0");

    // Without slipgate-net the live figures are unknown; RPM status estimates from usage logs.
    const live = await call<AdminUserLiveStatsResponse>("GET", `/api/v1/admin/user-stats/live?userIds=${a.id},${b.id}`, admin);
    expect(live.body.live).toBe(false);
    expect(live.body.items.find((i) => i.userId === b.id)).toMatchObject({ inFlight: null, rpmUsed: null });
    const status = await call<AdminUserRpmStatus>("GET", `/api/v1/admin/users/${b.id}/rpm-status`, admin);
    expect(status.body.live).toBe(false);
    expect(status.body.rpm.used).toBe(2);
    expect(status.body.concurrency.inFlight).toBeNull();
    expect(status.body.groups.find((x) => x.groupId === g.id)!.rpm.used).toBe(2);
    expect((await call("GET", "/api/v1/admin/users/usr_none/rpm-status", admin)).status).toBe(404);
    expect((await call("GET", `/api/v1/admin/user-stats/usage?userIds=${b.id}`, b.headers)).status).toBe(403);
  });

  it("reads live counters from slipgate-net when it is reachable", async () => {
    const { call, admin, register, group } = await bootstrap();
    const g = await group("live-g", { rpmLimit: 6 });
    const u = await register("live@limits.test");
    await call("PUT", `/api/v1/admin/groups/${g.id}/rpm-overrides`, admin, { entries: [{ userId: u.id, rpmOverride: 9 }] });
    await call("POST", "/api/v1/admin/users/batch-limits", admin, { userIds: [u.id], rpmLimit: 100, concurrencyLimit: 4 });
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/internal/net/dataplane/user-limits/stats") {
          seen.push(req.headers.get("X-Slipgate-Internal-Token") ?? "");
          const { userIds } = (await req.json()) as { userIds: string[] };
          return Response.json({
            live: true,
            items: userIds.map((userId) => ({ userId, rpmUsed: 3, inFlight: 2, groups: [{ groupId: g.id, rpmUsed: 3, inFlight: 2 }] })),
          });
        }
        return Response.json({ ok: true });
      },
    });
    try {
      process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${server.port}`;
      const status = await call<AdminUserRpmStatus>("GET", `/api/v1/admin/users/${u.id}/rpm-status`, admin);
      expect(status.body).toMatchObject({
        live: true,
        rpm: { used: 3, limit: 100 },
        concurrency: { inFlight: 2, limit: 4 },
      });
      expect(status.body.groups).toEqual([
        { groupId: g.id, groupName: "live-g", rpm: { used: 3, limit: 9, source: "override" }, concurrency: { inFlight: 2, limit: 0 } },
      ]);
      const live = await call<AdminUserLiveStatsResponse>("GET", `/api/v1/admin/user-stats/live?userIds=${u.id}`, admin);
      expect(live.body).toEqual({ live: true, items: [{ userId: u.id, inFlight: 2, rpmUsed: 3, concurrencyLimit: 4, rpmLimit: 100 }] });
      expect(seen.every((t) => t === INTERNAL)).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("bulk-deletes users, never the caller, and reports each failure", async () => {
    const { call, admin, adminId, register } = await bootstrap();
    const a = await register("del-a@limits.test");
    const b = await register("del-b@limits.test");
    const res = await call<AdminBatchDeleteUsersResponse>("POST", "/api/v1/admin/users/batch-delete", admin, {
      userIds: [a.id, adminId, "usr_missing", b.id, a.id],
    });
    expect(res.status).toBe(200);
    expect(res.body.deleted.sort()).toEqual([a.id, b.id].sort());
    expect(res.body.failed.map((f) => [f.userId, f.error])).toEqual([
      [adminId, "self"],
      ["usr_missing", "not_found"],
    ]);
    expect((await call("GET", `/api/v1/admin/users/${a.id}`, admin)).status).toBe(404);
    expect((await call("POST", "/api/v1/admin/users/batch-delete", admin, { userIds: [] })).status).toBe(400);
  });

  it("lets an admin rebind any key (auto-granting exclusive groups), list a group's keys and replace a user's group", async () => {
    const { call, admin, register, group, key, snapshot } = await bootstrap();
    const shared = await group("shared-keys");
    const exA = await group("ex-a", { isExclusive: true });
    const exB = await group("ex-b", { isExclusive: true });
    const sub = await group("ex-sub", { isExclusive: true, subscriptionType: "subscription" });
    const off = await group("ex-off", { isExclusive: true, enabled: false });
    const u = await register("owner@limits.test");
    const k1 = await key(u.headers, shared.id);
    const k2 = await key(u.headers, shared.id);

    // The owner cannot move a key into an exclusive group; an admin can, granting the group.
    expect((await call("PATCH", `/api/v1/user/api-keys/${k1.id}`, u.headers, { groupId: exA.id })).status).toBe(403);
    const moved = await call<AdminUpdateApiKeyResponse>("PATCH", `/api/v1/admin/api-keys/${k1.id}`, admin, {
      groupId: exA.id,
      resetWindows: true,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ autoGrantedGroupAccess: true, grantedGroupId: exA.id });
    expect(moved.body.item.groupId).toBe(exA.id);
    let userRow = (await call<{ user: AdminUserItem }>("GET", `/api/v1/admin/users/${u.id}`, admin)).body.user;
    expect(userRow.allowedGroupIds).toEqual([exA.id]);
    expect((await snapshot()).apiKeys.find((k) => k.id === k1.id)!.enabled).toBe(true);
    const again = await call<AdminUpdateApiKeyResponse>("PATCH", `/api/v1/admin/api-keys/${k1.id}`, admin, { enabled: false });
    expect(again.body).toMatchObject({ autoGrantedGroupAccess: false, grantedGroupId: null });
    expect(again.body.item.enabled).toBe(false);
    await call("PATCH", `/api/v1/admin/api-keys/${k1.id}`, admin, { enabled: true });
    expect((await call("PATCH", "/api/v1/admin/api-keys/key_missing", admin, { enabled: false })).status).toBe(404);
    expect((await call("PATCH", `/api/v1/admin/api-keys/${k2.id}`, admin, { groupId: off.id })).status).toBe(400);
    expect((await call("PATCH", `/api/v1/admin/api-keys/${k2.id}`, u.headers, { enabled: false })).status).toBe(403);

    const page = await call<AdminGroupApiKeysResponse>("GET", `/api/v1/admin/groups/${shared.id}/api-keys?page=1&pageSize=10`, admin);
    expect(page.body.total).toBe(1);
    expect(page.body.items[0]).toMatchObject({ id: k2.id, userId: u.id, userEmail: "owner@limits.test" });
    expect((await call("GET", "/api/v1/admin/groups/grp_nope/api-keys", admin)).status).toBe(404);

    // Replace exA by exB: keys move, the grant moves.
    const bad = async (body: unknown) => (await call("POST", `/api/v1/admin/users/${u.id}/replace-group`, admin, body)).status;
    expect(await bad({ fromGroupId: exA.id, toGroupId: exA.id })).toBe(400);
    expect(await bad({ fromGroupId: exA.id, toGroupId: shared.id })).toBe(400);
    expect(await bad({ fromGroupId: exA.id, toGroupId: sub.id })).toBe(400);
    expect(await bad({ fromGroupId: exA.id, toGroupId: off.id })).toBe(400);
    expect(await bad({ fromGroupId: exA.id, toGroupId: "grp_nope" })).toBe(404);
    const replaced = await call<ReplaceUserGroupResponse>("POST", `/api/v1/admin/users/${u.id}/replace-group`, admin, {
      fromGroupId: exA.id,
      toGroupId: exB.id,
    });
    expect(replaced.body).toEqual({ migratedKeys: 1, allowedGroupIds: [exB.id] });
    userRow = (await call<{ user: AdminUserItem }>("GET", `/api/v1/admin/users/${u.id}`, admin)).body.user;
    expect(userRow.allowedGroupIds).toEqual([exB.id]);
    const keys = (await call<{ items: ApiKeyItem[] }>("GET", `/api/v1/admin/users/${u.id}/api-keys`, admin)).body.items;
    expect(keys.find((k) => k.id === k1.id)!.groupId).toBe(exB.id);
    expect(keys.find((k) => k.id === k2.id)!.groupId).toBe(shared.id);
    expect((await snapshot()).apiKeys.find((k) => k.id === k1.id)!.enabled).toBe(true);
    expect((await call("POST", `/api/v1/admin/users/usr_nope/replace-group`, admin, { fromGroupId: exA.id, toGroupId: exB.id })).status).toBe(404);
  });

  it("creates keys with the portal's default RPM and concurrency", async () => {
    const { call, admin, register } = await bootstrap();
    await call("PATCH", "/api/v1/admin/settings", admin, { defaultApiKeyRpm: 77, defaultApiKeyConcurrency: 9 });
    const u = await register("defaults@limits.test");
    const created = await call<{ item: ApiKeyItem }>("POST", "/api/v1/user/api-keys", u.headers, { name: "d", groupId: "grp_default" });
    expect(created.body.item.rpmLimit).toBe(77);
    expect(created.body.item.concurrencyLimit).toBe(9);
    const explicit = await call<{ item: ApiKeyItem }>("POST", "/api/v1/user/api-keys", u.headers, {
      name: "e",
      groupId: "grp_default",
      rpmLimit: 5,
    });
    expect(explicit.body.item.rpmLimit).toBe(5);
    expect(explicit.body.item.concurrencyLimit).toBe(9);
  });
});

describe("pure helpers", () => {
  it("clamps key limits to the tightest cap and scales charged turns to the user's rate", () => {
    const keys = [
      { id: "k1", userId: "u1", groupId: "g1", keyHashHex: "0".repeat(64), rpmLimit: 100, concurrencyLimit: 10, ipAllowlist: [], ipDenylist: [], enabled: true, expiresAtIso: null },
      { id: "k2", userId: "u2", groupId: "g1", keyHashHex: "1".repeat(64), rpmLimit: 5, concurrencyLimit: 1, ipAllowlist: [], ipDenylist: [], enabled: true, expiresAtIso: null },
    ];
    const out = clampKeysToUserLimits(keys, {
      defaultRpmLimit: 50,
      defaultConcurrencyLimit: 0,
      users: [{ userId: "u1", rpmLimit: null, concurrencyLimit: 3 }],
      groups: [{ groupId: "g1", rpmLimit: 20, concurrencyLimit: 0 }],
      overrides: [{ userId: "u1", groupId: "g1", rpmOverride: 0, rateMultiplier: null }],
    });
    // u1: group cap exempted by override 0, user default 50 applies; concurrency 3.
    expect(out[0]).toMatchObject({ rpmLimit: 50, concurrencyLimit: 3 });
    // u2: own key limits are already tighter.
    expect(out[1]).toBe(keys[1]!);

    const ev = {
      requestId: "r",
      userId: "u1",
      apiKeyId: "k1",
      accountId: "a",
      groupId: "g1",
      platform: "anthropic",
      publicModel: "m",
      upstreamModel: "m",
      ingressCodec: "anthropic_messages",
      egressCodec: "anthropic_messages",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costNanoUsd: "1000",
      ttftMs: 0,
      durationMs: 0,
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      statusCode: 200,
    } as TurnSettlementEvent;
    expect(repriceForUser(ev, [], 2, null)).toBe(ev);
    // The core already applied the user's rate: billed as charged, never multiplied again.
    expect(repriceForUser(ev, [], 2, 0.5)).toBe(ev);
    expect(repriceForUser({ ...ev, coreRateMultiplierMicros: 500_000 }, [], 2, 0.5).costNanoUsd).toBe("1000");
    // The core priced at another rate (the custom one changed after the hold): only the difference.
    expect(repriceForUser({ ...ev, coreRateMultiplierMicros: 2_000_000 }, [], 2, 0.5).costNanoUsd).toBe("250");
    expect(repriceForUser({ ...ev, coreRateMultiplierMicros: 3_000_000 }, [], 3, 1).costNanoUsd).toBe("334"); // rounds up, never under-bills
    expect(repriceForUser({ ...ev, statusCode: 500, coreRateMultiplierMicros: 1_000_000 }, [], 1, 5).costNanoUsd).toBe("1000");
  });

  it("computes the viewer's local midnight", () => {
    const now = Date.UTC(2026, 10, 22, 3, 0, 0);
    expect(new Date(viewerDayStartMs(now, 0)).toISOString()).toBe("2026-11-22T00:00:00.000Z");
    // UTC+8 (offset -480): local 11:00 on the 22nd, midnight was 16:00 UTC on the 21st.
    expect(new Date(viewerDayStartMs(now, -480)).toISOString()).toBe("2026-11-21T16:00:00.000Z");
    // UTC-5 (offset 300): local 22:00 on the 21st.
    expect(new Date(viewerDayStartMs(now, 300)).toISOString()).toBe("2026-11-21T05:00:00.000Z");
  });
});
