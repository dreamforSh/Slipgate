import { describe, expect, it } from "bun:test";
import type {
  AdminUserItem,
  AdminUserListResponse,
  ApiKeyItem,
  AuditLogItem,
  BalanceLedgerItem,
  DataPlaneSyncSnapshot,
  GroupItem,
  PortalSettings,
  PublicSettings,
  RedeemCodeItem,
  UsagePageResponse,
  UsageStatsResponse,
  UserAnnouncementItem,
  UserSubscriptionItem,
  WalletSummary,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { totpAt, TOTP_STEP_SECONDS } from "../security/totp.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "ops-internal-token";
const NANO = 1_000_000_000n;

/**
 * An optional `bun test --preload` may install a factory returning a Postgres-backed store
 * (e.g. PGlite over a socket) so this suite also exercises PostgresOpsStore's SQL.
 */
type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const app = createBffApp({
    store: factory ? await factory() : undefined,
    jwtSecret: "ops-test-jwt-secret-32-bytes-minimum",
    vaultSecret: "ops-test-vault-secret-32-bytes-minimum",
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
    return { status: res.status, body: parsed as T, headers: res.headers };
  };
  const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Ops Test",
    adminEmail: "admin@ops.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  const register = async (email: string, extra: Record<string, unknown> = {}) => {
    const res = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email,
      password: "UserPassword123!",
      ...extra,
    });
    return {
      status: res.status,
      body: res.body,
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${res.body.accessToken}` },
      id: res.body.user?.id,
    };
  };
  const snapshot = async () =>
    (await call<DataPlaneSyncSnapshot>("GET", "/api/v1/internal/dataplane/snapshot", { "X-Slipgate-Internal-Token": INTERNAL })).body;
  /** Settlements must reference a real account (core.account_window_quotas has a foreign key). */
  const account = async (groupId: string) =>
    (
      await call<{ account: { id: string } }>("POST", "/api/v1/admin/accounts", admin, {
        groupId,
        name: `acc-${groupId}`,
        platform: "anthropic",
        executionMode: "direct_api",
        authKind: "api_key",
        credentialSecret: `sk-ant-test-${groupId}-${Math.random()}`,
      })
    ).body.account.id;
  const defaultAccountId = await account("grp_default");
  const settle = async (ev: Record<string, unknown>) => {
    const res = await call("POST", "/api/v1/internal/dataplane/settlement", { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL }, {
      platform: "anthropic",
      accountId: defaultAccountId,
      publicModel: "claude-sonnet-5-5",
      upstreamModel: "claude-sonnet-5-5",
      ingressCodec: "anthropic",
      egressCodec: "anthropic",
      inputTokens: 100,
      outputTokens: 50,
      statusCode: 200,
      ...ev,
    });
    expect(res.status).toBe(200);
    return res;
  };
  return { app, call, admin, register, snapshot, settle, account };
}

describe("portal settings", () => {
  it("persists settings, mirrors branding into setup status and exposes a public subset", async () => {
    const { call, admin } = await bootstrap();
    const initial = await call<PortalSettings>("GET", "/api/v1/admin/settings", admin);
    expect(initial.body.siteName).toBe("Ops Test");
    expect(initial.body.defaultApiKeyRpm).toBe(60);

    const patched = await call<PortalSettings>("PATCH", "/api/v1/admin/settings", admin, {
      siteName: "Renamed",
      siteSubtitle: "Fast lane",
      defaultBalanceUsd: "2.5",
      customNavLinks: [{ label: "Docs", url: "https://docs.example.com" }],
    });
    expect(patched.status).toBe(200);
    expect(patched.body.defaultBalanceNanoUsd).toBe((25n * NANO / 10n).toString());

    const setup = await call<{ siteName: string }>("GET", "/api/v1/setup/status");
    expect(setup.body.siteName).toBe("Renamed");
    const pub = await call<PublicSettings>("GET", "/api/v1/public/settings");
    expect(pub.body.siteSubtitle).toBe("Fast lane");
    expect(pub.body.customNavLinks).toHaveLength(1);
    expect((pub.body as Record<string, unknown>).defaultBalanceNanoUsd).toBeUndefined();

    const badUrl = await call("PATCH", "/api/v1/admin/settings", admin, { logoUrl: "javascript:alert(1)" });
    expect(badUrl.status).toBe(400);
  });
});

describe("registration extras", () => {
  it("credits the default balance and promo bonus, binds referrers and enforces invitations", async () => {
    const { call, admin, register } = await bootstrap();
    await call("PATCH", "/api/v1/admin/settings", admin, { defaultBalanceUsd: "1", affiliateEnabled: true });
    const promo = await call<{ item: { code: string } }>("POST", "/api/v1/admin/promo-codes", admin, {
      code: "WELCOME",
      bonusUsd: "3",
      maxUses: 1,
    });
    expect(promo.status).toBe(201);

    const referrer = await register("ref@ops.test");
    const aff = await call<{ inviteCode: string }>("GET", "/api/v1/user/affiliate", referrer.headers);
    expect(aff.body.inviteCode).toHaveLength(8);

    const checked = await call<{ valid: boolean }>("GET", "/api/v1/public/promo/welcome");
    expect(checked.body.valid).toBe(true);

    const newbie = await register("new@ops.test", { promoCode: "welcome", affCode: aff.body.inviteCode, username: "Newbie" });
    expect(newbie.status).toBe(201);
    const wallet = await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", newbie.headers);
    expect(wallet.body.wallet.balanceNanoUsd).toBe((4n * NANO).toString());

    const exhausted = await register("late@ops.test", { promoCode: "WELCOME" });
    expect(exhausted.status).toBe(400);

    const invitees = await call<{ inviteCount: number; invitees: { email: string }[] }>("GET", "/api/v1/user/affiliate", referrer.headers);
    expect(invitees.body.inviteCount).toBe(1);
    expect(invitees.body.invitees[0]!.email).toBe("n***@ops.test");

    await call("PATCH", "/api/v1/admin/settings", admin, { inviteRequired: true });
    expect((await register("noinvite@ops.test")).status).toBe(400);
    const codes = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, {
      kind: "invitation",
      count: 1,
    });
    const invite = codes.body.items[0]!.code;
    expect((await register("invited@ops.test", { inviteCode: invite.toLowerCase() })).status).toBe(201);
    expect((await register("reuse@ops.test", { inviteCode: invite })).status).toBe(400);
  });
});

describe("user administration", () => {
  it("lists, edits, adjusts balances, suspends and deletes users with admin guards", async () => {
    const { call, admin, register, snapshot } = await bootstrap();
    const alice = await register("alice@ops.test");
    await register("bob@ops.test");

    const list = await call<AdminUserListResponse>("GET", "/api/v1/admin/users?search=alice&pageSize=10", admin);
    expect(list.body.total).toBe(1);
    expect(list.body.stats.total).toBe(3);

    const created = await call<{ user: AdminUserItem }>("POST", "/api/v1/admin/users", admin, {
      email: "carol@ops.test",
      password: "CarolPassword1",
      username: "Carol",
      initialBalanceUsd: "10",
    });
    expect(created.status).toBe(201);
    expect(created.body.user.balanceNanoUsd).toBe((10n * NANO).toString());

    const sub = await call<{ balanceNanoUsd: string }>("POST", `/api/v1/admin/users/${created.body.user.id}/balance`, admin, {
      operation: "subtract",
      amountUsd: "2.5",
      reason: "refund",
    });
    expect(sub.body.balanceNanoUsd).toBe((75n * NANO / 10n).toString());
    const set = await call<{ balanceNanoUsd: string }>("POST", `/api/v1/admin/users/${created.body.user.id}/balance`, admin, {
      operation: "set",
      amountUsd: "1",
    });
    expect(set.body.balanceNanoUsd).toBe(NANO.toString());
    const ledger = await call<{ items: BalanceLedgerItem[] }>("GET", `/api/v1/admin/users/${created.body.user.id}/ledger`, admin);
    expect(ledger.body.items.map((e) => e.kind)).toEqual(["adjust", "adjust", "credit"]);

    // Alice's key stops serving once she is suspended, and her session is dropped.
    const groups = await call<{ groups: GroupItem[] }>("GET", "/api/v1/user/groups", alice.headers);
    const key = await call<{ item: ApiKeyItem }>("POST", "/api/v1/user/api-keys", alice.headers, {
      groupId: groups.body.groups[0]!.id,
      name: "alice-key",
    });
    expect(key.status).toBe(201);
    expect((await snapshot()).apiKeys.find((k) => k.id === key.body.item.id)?.enabled).toBe(true);
    const suspended = await call("PATCH", `/api/v1/admin/users/${alice.id}`, admin, { status: "suspended" });
    expect(suspended.status).toBe(200);
    expect((await snapshot()).apiKeys.find((k) => k.id === key.body.item.id)?.enabled).toBe(false);
    expect((await call("GET", "/api/v1/auth/me", alice.headers)).status).toBe(401);

    // Admin guards.
    const me = (await call<{ user: { id: string } }>("GET", "/api/v1/auth/me", admin)).body.user.id;
    expect((await call("PATCH", `/api/v1/admin/users/${me}`, admin, { role: "user" })).status).toBe(403);
    expect((await call("DELETE", `/api/v1/admin/users/${me}`, admin)).status).toBe(403);

    const deleted = await call("DELETE", `/api/v1/admin/users/${alice.id}`, admin);
    expect(deleted.status).toBe(200);
    expect((await snapshot()).apiKeys.some((k) => k.id === key.body.item.id)).toBe(false);
  });

  it("lets granted users bind keys to exclusive groups", async () => {
    const { call, admin, register } = await bootstrap();
    const dave = await register("dave@ops.test");
    const vip = (
      await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, {
        name: "vip",
        platform: "anthropic",
        isExclusive: true,
      })
    ).body.group;
    expect((await call("POST", "/api/v1/user/api-keys", dave.headers, { groupId: vip.id, name: "k" })).status).toBe(403);
    await call("PATCH", `/api/v1/admin/users/${dave.id}`, admin, { allowedGroupIds: [vip.id] });
    const visible = await call<{ groups: GroupItem[] }>("GET", "/api/v1/user/groups", dave.headers);
    expect(visible.body.groups.some((g) => g.id === vip.id)).toBe(true);
    expect((await call("POST", "/api/v1/user/api-keys", dave.headers, { groupId: vip.id, name: "k" })).status).toBe(201);
    const plaza = await call<{ groups: { id: string }[] }>("GET", "/api/v1/user/models", dave.headers);
    expect(plaza.body.groups.some((g) => g.id === vip.id)).toBe(true);
    const publicPlaza = await call<{ groups: { id: string }[] }>("GET", "/api/v1/public/models");
    expect(publicPlaza.body.groups.some((g) => g.id === vip.id)).toBe(false);
  });
});

describe("redeem codes", () => {
  it("generates, redeems once, disables and exports codes", async () => {
    const { call, admin, register } = await bootstrap();
    const erin = await register("erin@ops.test");
    const gen = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, {
      kind: "balance",
      amountUsd: "5",
      count: 3,
      prefix: "vip",
    });
    expect(gen.status).toBe(201);
    expect(gen.body.items).toHaveLength(3);
    const [first, second] = gen.body.items;
    expect(first!.code.startsWith("VIP-")).toBe(true);

    const ok = await call<{ wallet: WalletSummary }>("POST", "/api/v1/user/redeem", erin.headers, { code: first!.code.toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.wallet.balanceNanoUsd).toBe((5n * NANO).toString());
    expect((await call("POST", "/api/v1/user/redeem", erin.headers, { code: first!.code })).status).toBe(409);

    await call("POST", "/api/v1/admin/redeem-codes/batch", admin, { codes: [second!.code], action: "disable" });
    expect((await call("POST", "/api/v1/user/redeem", erin.headers, { code: second!.code })).status).toBe(404);

    const history = await call<{ items: RedeemCodeItem[] }>("GET", "/api/v1/user/redeem/history", erin.headers);
    expect(history.body.items[0]!.code).toBe(first!.code);

    const listed = await call<{ stats: { used: number; disabled: number; unused: number } }>(
      "GET",
      "/api/v1/admin/redeem-codes?status=used",
      admin,
    );
    expect(listed.body.stats).toMatchObject({ used: 1, disabled: 1, unused: 1 });

    const csv = await call<string>("GET", "/api/v1/admin/redeem-codes/export", admin);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.body).toContain(first!.code);
  });
});

describe("subscriptions", () => {
  it("gates keys on an active, under-cap subscription and never debits the wallet", async () => {
    const { call, admin, register, snapshot, settle, account } = await bootstrap();
    const frank = await register("frank@ops.test");
    await call("POST", `/api/v1/admin/users/${frank.id}/balance`, admin, { operation: "set", amountUsd: "1" });
    const group = (
      await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, {
        name: "claude-sub",
        platform: "anthropic",
        subscriptionType: "subscription",
        dailyLimitUsd: "0.001",
      })
    ).body.group;
    expect(group.dailyLimitNanoUsd).toBe("1000000");

    const key = (await call<{ item: ApiKeyItem }>("POST", "/api/v1/user/api-keys", frank.headers, { groupId: group.id, name: "sub" }))
      .body.item;
    const keyEnabled = async () => (await snapshot()).apiKeys.find((k) => k.id === key.id)?.enabled;
    expect(await keyEnabled()).toBe(false);

    const assigned = await call<{ items: UserSubscriptionItem[] }>("POST", "/api/v1/admin/subscriptions/assign", admin, {
      emails: ["frank@ops.test", "ghost@ops.test"],
      groupId: group.id,
      validityDays: 30,
    });
    expect(assigned.status).toBe(201);
    expect(assigned.body.items).toHaveLength(1);
    expect(await keyEnabled()).toBe(true);

    const subAccount = await account(group.id);
    await settle({ requestId: "r1", userId: frank.id, apiKeyId: key.id, groupId: group.id, accountId: subAccount, costNanoUsd: "2000000" });
    const wallet = await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", frank.headers);
    expect(wallet.body.wallet.balanceNanoUsd).toBe(NANO.toString());
    const mine = await call<{ items: UserSubscriptionItem[] }>("GET", "/api/v1/user/subscriptions", frank.headers);
    expect(mine.body.items[0]!.overLimit).toBe(true);
    expect(await keyEnabled()).toBe(false);

    const subId = mine.body.items[0]!.id;
    await call("PATCH", `/api/v1/admin/subscriptions/${subId}`, admin, { action: "reset_usage" });
    expect(await keyEnabled()).toBe(true);
    await call("PATCH", `/api/v1/admin/subscriptions/${subId}`, admin, { action: "revoke" });
    expect(await keyEnabled()).toBe(false);
    const extended = await call<{ item: UserSubscriptionItem }>("PATCH", `/api/v1/admin/subscriptions/${subId}`, admin, {
      action: "reactivate",
    });
    expect(extended.body.item.status).toBe("active");

    const redeem = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, {
      kind: "subscription",
      groupId: group.id,
      validityDays: 7,
    });
    const before = Date.parse(extended.body.item.expiresAtIso);
    await call("POST", "/api/v1/user/redeem", frank.headers, { code: redeem.body.items[0]!.code });
    const after = await call<{ items: UserSubscriptionItem[] }>("GET", "/api/v1/user/subscriptions", frank.headers);
    expect(after.body.items).toHaveLength(1);
    expect(Date.parse(after.body.items[0]!.expiresAtIso) - before).toBe(7 * 86_400_000);
  });
});

describe("announcements, audit and usage", () => {
  it("targets announcements, tracks reads, audits admin writes and pages usage", async () => {
    const { call, admin, register, settle } = await bootstrap();
    const gina = await register("gina@ops.test");
    const created = await call<{ item: { id: string } }>("POST", "/api/v1/admin/announcements", admin, {
      title: "Maintenance",
      content: "**Tonight** 02:00",
      status: "published",
      popup: true,
    });
    expect(created.status).toBe(201);
    await call("POST", "/api/v1/admin/announcements", admin, { title: "Admins only", status: "published", audience: "admins" });
    await call("POST", "/api/v1/admin/announcements", admin, { title: "Draft", status: "draft" });

    const feed = await call<{ items: UserAnnouncementItem[] }>("GET", "/api/v1/user/announcements", gina.headers);
    expect(feed.body.items.map((a) => a.title)).toEqual(["Maintenance"]);
    expect(feed.body.items[0]!.read).toBe(false);
    await call("POST", "/api/v1/user/announcements/read", gina.headers, { all: true });
    const reread = await call<{ items: UserAnnouncementItem[] }>("GET", "/api/v1/user/announcements", gina.headers);
    expect(reread.body.items[0]!.read).toBe(true);
    const readers = await call<{ items: { email: string }[] }>("GET", `/api/v1/admin/announcements/${created.body.item.id}/readers`, admin);
    expect(readers.body.items.map((r) => r.email)).toEqual(["gina@ops.test"]);

    await call("POST", "/api/v1/admin/users", admin, { email: "audit@ops.test", password: "SecretPassword9" });
    const audit = await call<{ items: AuditLogItem[]; total: number }>("GET", "/api/v1/admin/audit-logs?method=POST", admin);
    const createUser = audit.body.items.find((a) => a.route === "/api/v1/admin/users");
    expect(createUser?.statusCode).toBe(201);
    expect(createUser?.requestBody).toContain("[redacted]");
    expect(createUser?.requestBody).not.toContain("SecretPassword9");
    expect((await call("POST", "/api/v1/admin/audit-logs/clear", admin, { password: "wrong" })).status).toBe(403);

    await settle({ requestId: "u1", userId: gina.id, apiKeyId: "key_a", groupId: "grp_default", costNanoUsd: "1000" });
    await settle({ requestId: "u2", userId: gina.id, apiKeyId: "key_a", groupId: "grp_default", costNanoUsd: "0", statusCode: 529 });
    const page = await call<UsagePageResponse>("GET", `/api/v1/admin/usage/query?userId=${gina.id}&outcome=error`, admin);
    expect(page.body.total).toBe(1);
    expect(page.body.items[0]!.userEmail).toBe("gina@ops.test");
    const own = await call<UsagePageResponse>("GET", "/api/v1/user/usage/query", gina.headers);
    expect(own.body.summary?.requests).toBe(2);
    expect(own.body.summary?.errors).toBe(1);
    const opsView = await call<{ totals: { requests: number; errors: number }; statusCodes: { code: number }[]; recentErrors: unknown[] }>(
      "GET",
      "/api/v1/admin/ops/overview?range=1h",
      admin,
    );
    expect(opsView.body.totals.requests).toBe(2);
    expect(opsView.body.statusCodes[0]!.code).toBe(529);
    expect(opsView.body.recentErrors).toHaveLength(1);
    const csv = await call<string>("GET", "/api/v1/user/usage/export", gina.headers);
    expect(csv.body.split("\r\n")[0]).toContain("request_id");
  });
});

describe("public pages", () => {
  it("serves key usage, the model plaza and channel status, honouring their switches", async () => {
    const { call, admin, register } = await bootstrap();
    const hank = await register("hank@ops.test");
    const groups = await call<{ groups: GroupItem[] }>("GET", "/api/v1/user/groups", hank.headers);
    const created = await call<{ plaintextKey: string }>("POST", "/api/v1/user/api-keys", hank.headers, {
      groupId: groups.body.groups[0]!.id,
      name: "lookup",
    });
    const lookup = await call<{ keyName: string; billing: string }>("POST", "/api/v1/public/key-usage", JSON_HEADERS, {
      apiKey: created.body.plaintextKey,
    });
    expect(lookup.status).toBe(200);
    expect(lookup.body.keyName).toBe("lookup");
    expect((await call("POST", "/api/v1/public/key-usage", JSON_HEADERS, { apiKey: "sk-sg-0000000000000000" })).status).toBe(404);

    const models = await call<{ groups: { id: string }[] }>("GET", "/api/v1/public/models");
    expect(models.status).toBe(200);
    expect(models.body.groups.length).toBeGreaterThan(0);
    const status = await call<{ overall: string; channels: unknown[] }>("GET", "/api/v1/public/status");
    expect(status.status).toBe(200);
    expect(status.body.channels.length).toBeGreaterThan(0);

    await call("PATCH", "/api/v1/admin/settings", admin, { modelPlazaEnabled: false });
    expect((await call("GET", "/api/v1/public/models")).status).toBe(404);
  });
});

describe("API key limits", () => {
  it("pauses keys at their quota or window cap, resets them and supports custom keys and IP lists", async () => {
    const { call, register, snapshot, settle } = await bootstrap();
    const ivy = await register("ivy@ops.test");
    const groups = await call<{ groups: GroupItem[] }>("GET", "/api/v1/user/groups", ivy.headers);
    const created = await call<{ item: ApiKeyItem; plaintextKey: string }>("POST", "/api/v1/user/api-keys", ivy.headers, {
      groupId: groups.body.groups[0]!.id,
      name: "capped",
      customKey: "my-own-key-0123456789",
      quotaUsd: "0.000002",
      limit5hUsd: "0",
      ipDenylist: ["203.0.113.0/24"],
    });
    expect(created.status).toBe(201);
    expect(created.body.plaintextKey).toBe("my-own-key-0123456789");
    const key = created.body.item;
    expect(key.quotaNanoUsd).toBe("2000");
    const enabled = async () => (await snapshot()).apiKeys.find((k) => k.id === key.id);
    expect((await enabled())?.ipDenylist).toEqual(["203.0.113.0/24"]);
    expect((await enabled())?.enabled).toBe(true);

    await settle({ requestId: "k1", userId: ivy.id, apiKeyId: key.id, groupId: key.groupId, costNanoUsd: "2500" });
    const listed = await call<{ items: ApiKeyItem[] }>("GET", "/api/v1/user/api-keys", ivy.headers);
    const after = listed.body.items.find((k) => k.id === key.id)!;
    expect(after.spentNanoUsd).toBe("2500");
    expect(after.usage5hNanoUsd).toBe("2500");
    expect(after.limitState).toBe("quota_exhausted");
    expect((await enabled())?.enabled).toBe(false);

    // Raising the quota is not enough while a window cap is hit; resetting windows frees it.
    const patched = await call<{ item: ApiKeyItem }>("PATCH", `/api/v1/user/api-keys/${key.id}`, ivy.headers, {
      quotaUsd: "1",
      limit1dUsd: "0.000001",
    });
    expect(patched.body.item.limitState).toBe("window_exhausted");
    const reset = await call<{ item: ApiKeyItem }>("PATCH", `/api/v1/user/api-keys/${key.id}`, ivy.headers, { resetWindows: true });
    expect(reset.body.item.limitState).toBe("ok");
    expect((await enabled())?.enabled).toBe(true);

    const lookup = await call<{ keyName: string }>("POST", "/api/v1/public/key-usage", JSON_HEADERS, { apiKey: "my-own-key-0123456789" });
    expect(lookup.body.keyName).toBe("capped");
    const dup = await call("POST", "/api/v1/user/api-keys", ivy.headers, {
      groupId: key.groupId,
      name: "dup",
      customKey: "my-own-key-0123456789",
    });
    expect(dup.status).toBe(409);

    const bulk = await call<{ items: ApiKeyItem[]; failed: unknown[] }>("POST", "/api/v1/user/api-keys/bulk", ivy.headers, {
      keyIds: [key.id, "key_missing"],
      patch: { enabled: false },
    });
    expect(bulk.body.items).toHaveLength(1);
    expect(bulk.body.failed).toHaveLength(1);
  });
});

describe("two-factor authentication", () => {
  it("sets up, enforces at login, refuses replays, disables and can be reset by an admin", async () => {
    const { call, admin, register } = await bootstrap();
    const jack = await register("jack@ops.test");
    expect((await call("POST", "/api/v1/user/totp/setup", jack.headers, { password: "wrong" })).status).toBe(403);
    const setup = await call<{ secret: string; otpauthUrl: string }>("POST", "/api/v1/user/totp/setup", jack.headers, {
      password: "UserPassword123!",
    });
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl.startsWith("otpauth://totp/")).toBe(true);
    const step = () => Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    expect((await call("POST", "/api/v1/user/totp/enable", jack.headers, { code: "000000" })).status).toBe(400);
    const prevCode = await totpAt(setup.body.secret, step() - 1);
    const enable = await call("POST", "/api/v1/user/totp/enable", jack.headers, { code: prevCode });
    expect(enable.status).toBe(200);

    const login = (extra: Record<string, unknown> = {}) =>
      call<{ error?: string; accessToken?: string }>("POST", "/api/v1/auth/login", JSON_HEADERS, {
        email: "jack@ops.test",
        password: "UserPassword123!",
        ...extra,
      });
    expect((await login()).body.error).toBe("totp_required");
    expect((await login({ totpCode: "123456" })).status).toBe(401);
    // The step used to enable can't be replayed; the current one works once.
    expect((await login({ totpCode: prevCode })).status).toBe(401);
    const current = await totpAt(setup.body.secret, step());
    const ok = await login({ totpCode: current });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    expect((await login({ totpCode: current })).status).toBe(401);

    expect((await call("POST", `/api/v1/admin/users/${jack.id}/totp/reset`, admin)).status).toBe(403);
    await call("POST", `/api/v1/admin/users/${jack.id}/totp/reset`, admin, { confirm: { password: "AdminPassword123!" } });
    // Resetting 2FA bumps token_version so any session issued before the reset is revoked.
    expect((await call("GET", "/api/v1/user/totp", jack.headers)).status).toBe(401);
    const relogin = await login();
    expect(relogin.status).toBe(200);
    const freshHeaders = { ...JSON_HEADERS, Authorization: `Bearer ${relogin.body.accessToken}` };
    const state = await call<{ enabled: boolean }>("GET", "/api/v1/user/totp", freshHeaders);
    expect(state.body.enabled).toBe(false);
  });
});

describe("model pricing rules", () => {
  it("reprices charged turns with the most specific rule and the group multiplier", async () => {
    const { call, admin, register, settle } = await bootstrap();
    const kim = await register("kim@ops.test");
    const created = await call<{ item: { id: string; inputNanoPerMTok: string; cacheReadNanoPerMTok: string } }>(
      "POST",
      "/api/v1/admin/pricing",
      admin,
      { pattern: "claude-*", inputPerMTokUsd: "2", outputPerMTokUsd: "10" },
    );
    expect(created.status).toBe(201);
    expect(created.body.item.inputNanoPerMTok).toBe("2000000000");
    expect(created.body.item.cacheReadNanoPerMTok).toBe("200000000");
    await call("POST", "/api/v1/admin/pricing", admin, { pattern: "claude-sonnet-5-5", inputPerMTokUsd: "1", outputPerMTokUsd: "5" });
    expect((await call("POST", "/api/v1/admin/pricing", admin, { pattern: "claude-*", inputPerMTokUsd: "1", outputPerMTokUsd: "1" })).status).toBe(409);
    await call("PATCH", "/api/v1/admin/groups/grp_default", admin, { rateMultiplier: 2 });

    // Exact rule beats the prefix: (100 × $1 + 50 × $5) / 1M × 2 = $0.0007
    await settle({ requestId: "p1", userId: kim.id, apiKeyId: "key_p", groupId: "grp_default", costNanoUsd: "999", inputTokens: 100, outputTokens: 50 });
    // Free / failed turns keep the core's zero cost.
    await settle({ requestId: "p2", userId: kim.id, apiKeyId: "key_p", groupId: "grp_default", costNanoUsd: "0", inputTokens: 100, outputTokens: 50 });
    const page = await call<UsagePageResponse>("GET", "/api/v1/user/usage/query", kim.headers);
    const byId = new Map(page.body.items.map((r) => [r.requestId, r.costNanoUsd]));
    expect(byId.get("p1")).toBe("700000");
    expect(byId.get("p2")).toBe("0");

    const plaza = await call<{ groups: { models: { id: string; price: { inputNanoPerToken: number } }[] }[] }>("GET", "/api/v1/public/models");
    expect(plaza.status).toBe(200);
    const list = await call<{ items: { id: string }[] }>("GET", "/api/v1/admin/pricing", admin);
    expect(list.body.items).toHaveLength(2);
    expect((await call("DELETE", `/api/v1/admin/pricing/${created.body.item.id}`, admin)).status).toBe(200);
  });
});

describe("discovered upstream models", () => {
  it("lists the models slipgate-net discovered in the model plaza", async () => {
    const paths: string[] = [];
    const net = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        paths.push(path);
        if (path === "/internal/net/models/discovered") return Response.json({ models: { anthropic: ["claude-discovered-probe"] } });
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    const prev = { url: process.env.SLIPGATE_NET_INTERNAL_URL, token: process.env.SLIPGATE_INTERNAL_TOKEN };
    process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${net.port}`;
    process.env.SLIPGATE_INTERNAL_TOKEN = INTERNAL;
    try {
      const { call } = await bootstrap();
      const plaza = await call<{ groups: { id: string; models: { id: string; source: string }[] }[] }>("GET", "/api/v1/public/models");
      const models = plaza.body.groups.find((g) => g.id === "grp_default")?.models ?? [];
      expect(models.find((m) => m.id === "claude-discovered-probe")?.source).toBe("discovered");
      expect(paths).toContain("/internal/net/models/discovered");
    } finally {
      for (const [key, value] of [["SLIPGATE_NET_INTERNAL_URL", prev.url], ["SLIPGATE_INTERNAL_TOKEN", prev.token]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      net.stop(true);
    }
  });
});

describe("admin usage statistics", () => {
  it("charts the usage list's filters: totals, buckets, model / group / user breakdowns and ranking", async () => {
    const { call, admin, register, settle } = await bootstrap();
    const gina = await register("gina.stats@ops.test");
    const ivy = await register("ivy.stats@ops.test");
    await settle({ requestId: "s1", userId: gina.id, apiKeyId: "key_g", groupId: "grp_default", costNanoUsd: "1000" });
    await settle({ requestId: "s2", userId: gina.id, apiKeyId: "key_g", groupId: "grp_default", costNanoUsd: "0", statusCode: 529 });
    await settle({
      requestId: "s3",
      userId: ivy.id,
      apiKeyId: "key_i",
      groupId: "grp_default",
      publicModel: "gpt-5",
      upstreamModel: "gpt-5",
      ingressCodec: "openai_chat",
      egressCodec: "openai_responses",
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 40,
      costNanoUsd: "5000",
    });
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const stats = (q: string) => call<UsageStatsResponse>("GET", `/api/v1/admin/usage/stats?sinceIso=${encodeURIComponent(since)}${q}`, admin);

    const all = await stats("&rankBy=cost");
    expect(all.status).toBe(200);
    expect(all.body.granularity).toBe("hour");
    expect(all.body.clamped).toBe(false);
    expect(all.body.totals).toMatchObject({ requests: 3, errors: 1, inputTokens: 500, outputTokens: 200, cacheReadTokens: 40, costNanoUsd: "6000" });
    expect(all.body.series.length).toBeGreaterThanOrEqual(24);
    expect(all.body.series.length).toBeLessThanOrEqual(25);
    expect(all.body.series.reduce((n, p) => n + p.requests, 0)).toBe(3);
    expect(all.body.series.at(-1)!.requests).toBe(3);
    expect(all.body.models.map((m) => m.model)).toEqual(["gpt-5", "claude-sonnet-5-5"]);
    expect(all.body.groups).toHaveLength(1);
    expect(all.body.groups[0]!.groupId).toBe("grp_default");
    expect(all.body.groups[0]!.name).not.toBe("");
    expect(all.body.userCount).toBe(2);
    expect(all.body.rankBy).toBe("cost");
    expect(all.body.users.map((u) => u.email)).toEqual(["ivy.stats@ops.test", "gina.stats@ops.test"]);
    // Endpoints recognised from the codecs: "anthropic" is an older alias of anthropic_messages.
    expect(all.body.endpoints.map((e) => [e.endpoint, e.family, e.codecs, e.requests])).toEqual([
      ["/v1/chat/completions", "openai", ["openai_chat"], 1],
      ["/v1/messages", "anthropic", ["anthropic"], 2],
    ]);
    expect(all.body.upstreamEndpoints.map((e) => e.endpoint)).toEqual(["/v1/responses", "/v1/messages"]);
    expect(all.body.endpointPaths.map((p) => `${p.inbound} -> ${p.upstream}`)).toEqual([
      "/v1/chat/completions -> /v1/responses",
      "/v1/messages -> /v1/messages",
    ]);

    const byRequests = await stats("&rankBy=requests&rankLimit=1");
    expect(byRequests.body.users.map((u) => u.email)).toEqual(["gina.stats@ops.test"]);
    expect(byRequests.body.userCount).toBe(2);

    const oneUser = await stats(`&userId=${gina.id}`);
    expect(oneUser.body.totals.requests).toBe(2);
    expect(oneUser.body.models.map((m) => m.model)).toEqual(["claude-sonnet-5-5"]);
    const errorsOnly = await stats("&outcome=error");
    expect(errorsOnly.body.totals).toMatchObject({ requests: 1, errors: 1 });
    const daily = await stats("&granularity=day");
    expect(daily.body.granularity).toBe("day");
    expect(daily.body.series.reduce((n, p) => n + p.requests, 0)).toBe(3);

    // A "last 7 days" window computed a moment before the server's now still buckets by hour.
    const week = await call<UsageStatsResponse>(
      "GET",
      `/api/v1/admin/usage/stats?sinceIso=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000 - 5_000).toISOString())}&granularity=hour`,
      admin,
    );
    expect(week.body.granularity).toBe("hour");
    expect(week.body.series.length).toBeGreaterThanOrEqual(168);
    expect(week.body.series.length).toBeLessThanOrEqual(169);

    const defaults = await call<UsageStatsResponse>("GET", "/api/v1/admin/usage/stats", admin);
    expect(defaults.body.granularity).toBe("day");
    expect(defaults.body.series.length).toBeGreaterThanOrEqual(30);
    expect(defaults.body.totals.requests).toBe(3);
    const wide = await call<UsageStatsResponse>(
      "GET",
      `/api/v1/admin/usage/stats?sinceIso=${encodeURIComponent(new Date(Date.now() - 500 * 86_400_000).toISOString())}&granularity=hour`,
      admin,
    );
    expect(wide.body.clamped).toBe(true);
    expect(wide.body.granularity).toBe("day");
    expect(wide.body.totals.requests).toBe(3);

    expect((await call("GET", "/api/v1/admin/usage/stats", gina.headers)).status).toBe(403);
  });
});

describe("usage list sorting and dimensions", () => {
  it("orders rows server-side by time, model, cost, tokens or latency and returns reasoning effort / service tier", async () => {
    const { call, admin, register, settle } = await bootstrap();
    const sam = await register("sam.sort@ops.test");
    const rows = [
      { requestId: "srt_a", publicModel: "m-b", inputTokens: 10, outputTokens: 5, costNanoUsd: "300", durationMs: 900 },
      { requestId: "srt_b", publicModel: "m-a", inputTokens: 500, outputTokens: 50, costNanoUsd: "100", durationMs: 200, reasoningEffort: "high", serviceTier: "priority" },
      { requestId: "srt_c", publicModel: "m-c", inputTokens: 40, outputTokens: 4, costNanoUsd: "200", durationMs: 5000 },
    ];
    for (const r of rows) {
      await settle({ ...r, userId: sam.id, apiKeyId: "key_sort", groupId: "grp_default", upstreamModel: r.publicModel });
    }
    const ids = async (qs: string) =>
      (await call<UsagePageResponse>("GET", `/api/v1/admin/usage/query?userId=${sam.id}${qs}`, admin)).body.items.map((i) => i.requestId);
    expect(await ids("")).toEqual(["srt_c", "srt_b", "srt_a"]); // newest first
    expect(await ids("&sortBy=time&sortDir=asc")).toEqual(["srt_a", "srt_b", "srt_c"]);
    expect(await ids("&sortBy=model&sortDir=asc")).toEqual(["srt_b", "srt_a", "srt_c"]);
    expect(await ids("&sortBy=cost&sortDir=desc")).toEqual(["srt_a", "srt_c", "srt_b"]);
    expect(await ids("&sortBy=tokens&sortDir=desc")).toEqual(["srt_b", "srt_c", "srt_a"]);
    expect(await ids("&sortBy=latency&sortDir=desc")).toEqual(["srt_c", "srt_a", "srt_b"]);
    expect(await ids("&sortBy=bogus")).toEqual(["srt_c", "srt_b", "srt_a"]);
    const page = await call<UsagePageResponse>("GET", `/api/v1/admin/usage/query?userId=${sam.id}&sortBy=model&sortDir=asc&pageSize=1`, admin);
    expect(page.body.items[0]).toMatchObject({ requestId: "srt_b", reasoningEffort: "high", serviceTier: "priority" });
    const own = await call<UsagePageResponse>("GET", "/api/v1/user/usage/query?sortBy=cost&sortDir=asc", sam.headers);
    expect(own.body.items.map((i) => i.requestId)).toEqual(["srt_b", "srt_c", "srt_a"]);
  });
});
