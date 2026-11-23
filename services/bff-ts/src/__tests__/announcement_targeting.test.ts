import { describe, expect, it } from "bun:test";
import type {
  AnnouncementItem,
  AnnouncementReadStatusResponse,
  AnnouncementTargeting,
  AuditLogItem,
  AuditRetentionRunResponse,
  AuditRetentionStatus,
  GroupItem,
  PortalSettings,
  PublicSettings,
  UserAnnouncementItem,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { AuditRetentionSweeper } from "../audit_retention.ts";
import { readAuditBody } from "../routes/ops.ts";
import { totpAt, TOTP_STEP_SECONDS } from "../security/totp.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import { storedTargeting, targetingMatches } from "../store/ops_shared.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const NANO = 1_000_000_000n;
const ADMIN_PASSWORD = "AdminPassword123!";

/** `bun test --preload` may install a Postgres-backed (PGlite) store factory; memory otherwise. */
type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const store: ControlStore = factory ? await factory() : new MemoryControlStore();
  const app = createBffApp({
    store,
    jwtSecret: "ann-test-jwt-secret-32-bytes-minimum-x",
    vaultSecret: "ann-test-vault-secret-32-bytes-minimum-x",
    internalToken: "ann-internal-token",
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
  const init = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Ann Test",
    adminEmail: "admin@ann.test",
    adminPassword: ADMIN_PASSWORD,
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  const register = async (email: string) => {
    const res = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email,
      password: "UserPassword123!",
    });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, email, headers: { ...JSON_HEADERS, Authorization: `Bearer ${res.body.accessToken}` } };
  };
  const setBalance = async (userId: string, amountUsd: string) => {
    const res = await call("POST", `/api/v1/admin/users/${userId}/balance`, admin, { operation: "set", amountUsd });
    expect(res.status).toBe(200);
  };
  return { app, store, call, admin, register, setBalance };
}

function balanceRule(operator: "gt" | "gte" | "lt" | "lte" | "eq", usd: bigint): AnnouncementTargeting["anyOf"][number]["allOf"][number] {
  return { type: "balance", operator, valueNanoUsd: (usd * NANO).toString() };
}

describe("targetingMatches", () => {
  it("is an OR across groups and an AND inside each, like Linksyncx Targeting.Matches", () => {
    const none = new Set<string>();
    expect(targetingMatches({ anyOf: [] }, 0n, none)).toBe(true);
    const rule: AnnouncementTargeting = {
      anyOf: [
        { allOf: [balanceRule("gte", 100n), { type: "subscription", operator: "in", groupIds: ["g10"] }] },
        { allOf: [balanceRule("lt", 5n)] },
      ],
    };
    expect(targetingMatches(rule, 4n * NANO + 999_999_999n, none)).toBe(true);
    expect(targetingMatches(rule, 5n * NANO, none)).toBe(false);
    expect(targetingMatches(rule, 100n * NANO, none)).toBe(false);
    expect(targetingMatches(rule, 99n * NANO, new Set(["g10"]))).toBe(false);
    expect(targetingMatches(rule, 100n * NANO, new Set(["g10"]))).toBe(true);
    // Negative balances compare as numbers.
    expect(targetingMatches({ anyOf: [{ allOf: [balanceRule("lte", 0n)] }] }, -1n, none)).toBe(true);
    expect(targetingMatches({ anyOf: [{ allOf: [balanceRule("eq", 3n)] }] }, 3n * NANO, none)).toBe(true);
    expect(targetingMatches({ anyOf: [{ allOf: [balanceRule("gt", 3n)] }] }, 3n * NANO, none)).toBe(false);
    // Any listed group is enough.
    const sub: AnnouncementTargeting = { anyOf: [{ allOf: [{ type: "subscription", operator: "in", groupIds: ["a", "b"] }] }] };
    expect(targetingMatches(sub, 0n, new Set(["b"]))).toBe(true);
    expect(targetingMatches(sub, 0n, none)).toBe(false);
    // A group without conditions never matches (no accidental "everyone" branch).
    expect(targetingMatches({ anyOf: [{ allOf: [] }] }, 0n, none)).toBe(false);
  });

  it("reads stored documents fail-closed", () => {
    expect(storedTargeting({})).toEqual({ anyOf: [] });
    expect(storedTargeting(null)).toEqual({ anyOf: [] });
    expect(storedTargeting('{"anyOf":[]}')).toEqual({ anyOf: [] });
    // Unreadable rules hide the announcement from everyone rather than showing it to all.
    const broken = storedTargeting({ anyOf: [{ allOf: [{ type: "balance", operator: "between", valueNanoUsd: "1" }] }] });
    expect(targetingMatches(broken, 0n, new Set())).toBe(false);
    expect(targetingMatches(storedTargeting("not json"), 0n, new Set())).toBe(false);
  });
});

describe("announcement targeting", () => {
  it("shows, marks read and reports eligibility by balance and subscription conditions", async () => {
    const { call, admin, register, setBalance } = await bootstrap();
    const group = (
      await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, {
        name: "pro-sub",
        platform: "anthropic",
        subscriptionType: "subscription",
      })
    ).body.group;
    expect(group.id).toBeTruthy();
    const amy = await register("amy@ann.test"); // $1, subscribed
    const ben = await register("ben@ann.test"); // $10, no subscription
    const cat = await register("cat@ann.test"); // $0
    await setBalance(amy.id, "1");
    await setBalance(ben.id, "10");
    const assigned = await call("POST", "/api/v1/admin/subscriptions/assign", admin, { emails: [amy.email], groupId: group.id, validityDays: 30 });
    expect(assigned.status).toBe(201);

    const create = (title: string, targeting: unknown, extra: Record<string, unknown> = {}) =>
      call<{ item: AnnouncementItem; error?: string; message?: string }>("POST", "/api/v1/admin/announcements", admin, {
        title,
        status: "published",
        audience: "users",
        targeting,
        ...extra,
      });

    // Validation: unknown groups, balance groups and malformed rules are refused.
    const unknown = await create("x", { anyOf: [{ allOf: [{ type: "subscription", operator: "in", groupIds: ["grp_missing"] }] }] });
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toContain("grp_missing");
    expect((await create("x", { anyOf: [{ allOf: [{ type: "subscription", operator: "in", groupIds: ["grp_default"] }] }] })).status).toBe(400);
    expect((await create("x", { anyOf: [{ allOf: [] }] })).status).toBe(400);
    expect((await create("x", { anyOf: [{ allOf: [{ type: "balance", operator: "between", valueUsd: "1" }] }] })).status).toBe(400);
    expect((await create("x", { anyOf: [{ allOf: [{ type: "balance", operator: "lt", valueUsd: "five" }] }] })).status).toBe(400);

    const low = await create("Low balance", { anyOf: [{ allOf: [{ type: "balance", operator: "lt", valueUsd: "5" }] }] });
    expect(low.status).toBe(201);
    expect(low.body.item.targeting).toEqual({ anyOf: [{ allOf: [balanceRule("lt", 5n)] }] });
    const subOrRich = await create("Subscribers or rich", {
      anyOf: [
        { allOf: [{ type: "subscription", operator: "in", groupIds: [group.id] }] },
        { allOf: [{ type: "balance", operator: "gte", valueNanoUsd: (10n * NANO).toString() }] },
      ],
    });
    expect(subOrRich.status).toBe(201);
    const subAndFunded = await create("Funded subscribers", {
      anyOf: [{ allOf: [{ type: "subscription", operator: "in", groupIds: [group.id] }, { type: "balance", operator: "gte", valueUsd: "5" }] }],
    });
    const everyone = await create("Everyone", undefined);
    expect(everyone.body.item.targeting).toEqual({ anyOf: [] });

    const titles = async (who: { headers: Record<string, string> }) =>
      (await call<{ items: UserAnnouncementItem[] }>("GET", "/api/v1/user/announcements", who.headers)).body.items.map((a) => a.title).sort();
    expect(await titles(amy)).toEqual(["Everyone", "Low balance", "Subscribers or rich"]);
    expect(await titles(ben)).toEqual(["Everyone", "Subscribers or rich"]);
    expect(await titles(cat)).toEqual(["Everyone", "Low balance"]);
    // The user feed never carries the rule.
    const feed = await call<{ items: Record<string, unknown>[] }>("GET", "/api/v1/user/announcements", amy.headers);
    expect(feed.body.items.every((a) => !("targeting" in a) && !("audience" in a))).toBe(true);

    // Conditions are evaluated against the current balance.
    await setBalance(amy.id, "6");
    expect(await titles(amy)).toEqual(["Everyone", "Funded subscribers", "Subscribers or rich"]);

    // Mark-all and explicit ids only touch what the user is targeted with.
    await call("POST", "/api/v1/user/announcements/read", cat.headers, { ids: [subOrRich.body.item.id, subAndFunded.body.item.id] });
    await call("POST", "/api/v1/user/announcements/read", cat.headers, { all: true });
    const readers = await call<{ items: { email: string }[] }>("GET", `/api/v1/admin/announcements/${subOrRich.body.item.id}/readers`, admin);
    expect(readers.body.items).toEqual([]);
    const lowReaders = await call<{ items: { email: string }[] }>("GET", `/api/v1/admin/announcements/${low.body.item.id}/readers`, admin);
    expect(lowReaders.body.items.map((r) => r.email)).toEqual(["cat@ann.test"]);

    // Update: omitted targeting keeps the rule, null clears it.
    const base = { title: "Low balance", status: "published", audience: "users" };
    const kept = await call<{ item: AnnouncementItem }>("PUT", `/api/v1/admin/announcements/${low.body.item.id}`, admin, base);
    expect(kept.body.item.targeting.anyOf).toHaveLength(1);
    expect(
      (await call("PUT", `/api/v1/admin/announcements/${low.body.item.id}`, admin, {
        ...base,
        targeting: { anyOf: [{ allOf: [{ type: "subscription", operator: "in", groupIds: ["nope"] }] }] },
      })).status,
    ).toBe(400);
    const cleared = await call<{ item: AnnouncementItem }>("PUT", `/api/v1/admin/announcements/${low.body.item.id}`, admin, { ...base, targeting: null });
    expect(cleared.body.item.targeting).toEqual({ anyOf: [] });
    expect(await titles(ben)).toEqual(["Everyone", "Low balance", "Subscribers or rich"]);
    const list = await call<{ items: AnnouncementItem[] }>("GET", "/api/v1/admin/announcements", admin);
    expect(list.body.items.find((a) => a.id === subOrRich.body.item.id)?.targeting.anyOf).toHaveLength(2);
  });

  it("carries targeting through a configuration backup, following the restored group ids", async () => {
    const a = await bootstrap();
    const group = (
      await a.call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", a.admin, { name: "vip-sub", platform: "anthropic", subscriptionType: "subscription" })
    ).body.group;
    const targeting = {
      anyOf: [{ allOf: [{ type: "subscription", operator: "in", groupIds: [group.id] }, balanceRule("gte", 1n)] }, { allOf: [balanceRule("lt", 0n)] }],
    };
    expect((await a.call("POST", "/api/v1/admin/announcements", a.admin, { title: "VIP news", targeting })).status).toBe(201);
    const exported = await a.call<{ announcements: Record<string, unknown>[] }>("GET", "/api/v1/admin/backup/export", a.admin);
    expect(exported.body.announcements.find((x) => x.title === "VIP news")?.targeting).toEqual(targeting);

    // A rule that no longer parses is exported fail-closed ({anyOf:[{allOf:[]}]}).
    const broken = {
      title: "Broken rule",
      content: "kept",
      status: "published",
      audience: "users",
      targeting: { anyOf: [{ allOf: [] }] },
    };
    const b = await bootstrap();
    const imported = await b.call<{ created: Record<string, number>; errors: string[] }>("POST", "/api/v1/admin/backup/import", b.admin, {
      file: { ...exported.body, announcements: [...exported.body.announcements, broken] },
      sections: ["groups", "announcements"],
    });
    expect(imported.status).toBe(200);
    expect(imported.body.created).toMatchObject({ groups: 1, announcements: 2 });
    // ... and comes back as a hidden draft without the rule instead of being dropped.
    expect(imported.body.errors.some((e) => e.includes("Broken rule"))).toBe(true);
    const keptDraft = (await b.call<{ items: AnnouncementItem[] }>("GET", "/api/v1/admin/announcements", b.admin)).body.items.find(
      (x) => x.title === "Broken rule",
    )!;
    expect(keptDraft).toMatchObject({ status: "draft", content: "kept", audience: "users", targeting: { anyOf: [] } });
    const restoredGroup = (await b.call<{ groups: GroupItem[] }>("GET", "/api/v1/admin/groups", b.admin)).body.groups.find((g) => g.name === "vip-sub")!;
    expect(restoredGroup.id).not.toBe(group.id);
    const restored = (await b.call<{ items: AnnouncementItem[] }>("GET", "/api/v1/admin/announcements", b.admin)).body.items.find(
      (x) => x.title === "VIP news",
    )!;
    expect(restored.targeting).toEqual({
      anyOf: [
        { allOf: [{ type: "subscription", operator: "in", groupIds: [restoredGroup.id] }, balanceRule("gte", 1n)] },
        { allOf: [balanceRule("lt", 0n)] },
      ],
    });
  });

  it("pages every account's read status with search, filters, sort and stats", async () => {
    const { call, admin, register, setBalance } = await bootstrap();
    const amy = await register("amy@ann.test");
    const ben = await register("ben@ann.test");
    const cat = await register("cat@ann.test");
    await setBalance(ben.id, "10");
    const ann = (
      await call<{ item: AnnouncementItem }>("POST", "/api/v1/admin/announcements", admin, {
        title: "Top up",
        status: "published",
        audience: "users",
        targeting: { anyOf: [{ allOf: [{ type: "balance", operator: "lt", valueUsd: "5" }] }] },
      })
    ).body.item;
    await call("POST", "/api/v1/user/announcements/read", amy.headers, { all: true });
    await Bun.sleep(5);
    await call("POST", "/api/v1/user/announcements/read", cat.headers, { ids: [ann.id] });
    // Ben is not targeted: his read attempt is ignored.
    await call("POST", "/api/v1/user/announcements/read", ben.headers, { all: true });

    const status = (qs = "") => call<AnnouncementReadStatusResponse>("GET", `/api/v1/admin/announcements/${ann.id}/read-status${qs}`, admin);
    const all = await status();
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(4);
    // admin (audience "users" excludes it), amy and cat (< $5), ben ($10).
    expect(all.body.stats).toEqual({ users: 4, eligible: 2, read: 2, eligibleRead: 2 });
    expect(all.body.items.map((r) => r.email)).toEqual(["admin@ann.test", "amy@ann.test", "ben@ann.test", "cat@ann.test"]);
    const amyRow = all.body.items.find((r) => r.email === "amy@ann.test")!;
    expect(amyRow).toMatchObject({ userId: amy.id, read: true, eligible: true, role: "user", status: "active", balanceNanoUsd: "0" });
    expect(typeof amyRow.readAtIso).toBe("string");
    expect(all.body.items.find((r) => r.email === "ben@ann.test")).toMatchObject({
      read: false,
      readAtIso: null,
      eligible: false,
      balanceNanoUsd: (10n * NANO).toString(),
    });
    expect(all.body.items.find((r) => r.email === "admin@ann.test")).toMatchObject({ eligible: false, role: "admin" });

    expect((await status("?read=unread")).body.items.map((r) => r.email)).toEqual(["admin@ann.test", "ben@ann.test"]);
    expect((await status("?read=read&sort=read_at_desc")).body.items.map((r) => r.email)).toEqual(["cat@ann.test", "amy@ann.test"]);
    expect((await status("?sort=read_at_asc")).body.items.map((r) => r.email)).toEqual([
      "amy@ann.test",
      "cat@ann.test",
      "admin@ann.test",
      "ben@ann.test",
    ]);
    expect((await status("?eligible=ineligible")).body.items.map((r) => r.email)).toEqual(["admin@ann.test", "ben@ann.test"]);
    expect((await status("?eligible=eligible&read=unread")).body.total).toBe(0);
    const search = await status("?q=BEN");
    expect(search.body.items.map((r) => r.email)).toEqual(["ben@ann.test"]);
    expect(search.body.total).toBe(1);
    // Stats ignore the filters.
    expect(search.body.stats.users).toBe(4);
    expect((await status("?q=%25")).body.total).toBe(0);
    const page2 = await status("?sort=email_desc&page=2&pageSize=3");
    expect(page2.body.items.map((r) => r.email)).toEqual(["admin@ann.test"]);
    expect(page2.body.total).toBe(4);

    // Balance compares as a number (ties by email); accounts without a username sort last.
    expect((await status("?sort=balance_desc")).body.items.map((r) => r.email)).toEqual([
      "ben@ann.test",
      "admin@ann.test",
      "amy@ann.test",
      "cat@ann.test",
    ]);
    expect((await status("?sort=balance_asc")).body.items.map((r) => r.email)).toEqual([
      "admin@ann.test",
      "amy@ann.test",
      "cat@ann.test",
      "ben@ann.test",
    ]);
    expect((await call("PATCH", `/api/v1/admin/users/${cat.id}`, admin, { username: "alpha" })).status).toBe(200);
    expect((await call("PATCH", `/api/v1/admin/users/${amy.id}`, admin, { username: "zulu" })).status).toBe(200);
    const byUsername = async (sort: string) =>
      (await status(`?sort=${sort}&q=ann.test`)).body.items.filter((r) => r.role === "user").map((r) => `${r.username || "-"}:${r.email}`);
    expect(await byUsername("username_asc")).toEqual(["alpha:cat@ann.test", "zulu:amy@ann.test", "-:ben@ann.test"]);
    expect(await byUsername("username_desc")).toEqual(["zulu:amy@ann.test", "alpha:cat@ann.test", "-:ben@ann.test"]);

    expect((await call("GET", "/api/v1/admin/announcements/ann_missing/read-status", admin)).status).toBe(404);
    expect((await call("GET", `/api/v1/admin/announcements/${ann.id}/read-status`, amy.headers)).status).toBe(403);
  });
});

/** Turns on two-factor sign-in for the admin; returns a code for any step offset from now. */
async function enableAdminTotp(call: Awaited<ReturnType<typeof bootstrap>>["call"], admin: Record<string, string>) {
  const setup = await call<{ secret: string }>("POST", "/api/v1/user/totp/setup", admin, { password: ADMIN_PASSWORD });
  expect(setup.status).toBe(200);
  const step = () => Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
  const codeAt = (offset: number) => totpAt(setup.body.secret, step() + offset);
  const enableCode = await codeAt(-1);
  expect((await call("POST", "/api/v1/user/totp/enable", admin, { code: enableCode })).status).toBe(200);
  return { enableCode, codeAt };
}

describe("audit log clear", () => {
  it("refuses administrators without two-factor authentication, even with the right password", async () => {
    const { call, admin } = await bootstrap();
    await call("POST", "/api/v1/admin/announcements", admin, { title: "Something to audit" });
    const clear = (body: unknown) => call<{ error?: string; deleted?: number }>("POST", "/api/v1/admin/audit-logs/clear", admin, body);
    for (const body of [{}, { password: ADMIN_PASSWORD }, { totpCode: "123456" }]) {
      const res = await clear(body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("totp_not_enabled");
    }
    // Nothing was removed; the refusals are on record (without the password).
    const audit = await call<{ items: AuditLogItem[]; total: number }>("GET", "/api/v1/admin/audit-logs?search=clear", admin);
    expect(audit.body.total).toBe(3);
    for (const item of audit.body.items) {
      expect(item.statusCode).toBe(403);
      expect(item.requestBody).not.toContain(ADMIN_PASSWORD);
    }
    const all = await call<{ total: number }>("GET", "/api/v1/admin/audit-logs", admin);
    expect(all.body.total).toBeGreaterThan(3);
  });

  it("requires a fresh TOTP code from administrators with two-factor authentication", async () => {
    const { call, admin } = await bootstrap();
    const { enableCode, codeAt } = await enableAdminTotp(call, admin); // limiter: 1

    const clear = (body: unknown) => call<{ error?: string; deleted?: number }>("POST", "/api/v1/admin/audit-logs/clear", admin, body);
    // The password is never a substitute for the code.
    const pw = await clear({ password: ADMIN_PASSWORD });
    expect(pw.status).toBe(403);
    expect(pw.body.error).toBe("totp_required");
    expect((await clear({ totpCode: "12" })).status).toBe(400);
    const wrong = await clear({ totpCode: "000000" === enableCode ? "111111" : "000000" }); // 2
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe("invalid_totp");
    // A step already accepted (here the one that enabled 2FA) is never accepted again.
    expect((await clear({ totpCode: enableCode })).body.error).toBe("invalid_totp"); // 3
    const fresh = await codeAt(0);
    const ok = await clear({ totpCode: fresh }); // 4
    expect(ok.status).toBe(200);
    expect(typeof ok.body.deleted).toBe("number");
    // Only the clear's own trace is left, noting the rows it removed.
    const left = await call<{ items: AuditLogItem[]; total: number }>("GET", "/api/v1/admin/audit-logs", admin);
    expect(left.body.total).toBe(1);
    expect(left.body.items[0]!.route).toBe("/api/v1/admin/audit-logs/clear");
    expect((JSON.parse(left.body.items[0]!.requestBody) as { _outcome?: unknown })._outcome).toEqual({
      deleted: ok.body.deleted,
      confirmedWith: "totp",
    });
    expect((await clear({ totpCode: fresh })).body.error).toBe("invalid_totp"); // 5
    for (let i = 0; i < 3; i++) await clear({ totpCode: "999999" === fresh ? "888888" : "999999" }); // 6..8
    const limited = await clear({ totpCode: "123456" });
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe("too_many_attempts");
    // The code never reaches the audit record.
    const audit = await call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs?search=clear", admin);
    expect(audit.body.items.length).toBeGreaterThan(0);
    for (const item of audit.body.items) expect(item.requestBody).not.toContain(fresh);
  });
});

describe("audit log retention", () => {
  it("deletes only rows older than the cutoff, oldest first, in bounded batches", async () => {
    const { store } = await bootstrap();
    const ops = store.ops;
    await ops.clearAudit();
    const entry = (path: string) => ({
      actorId: "usr_x",
      actorEmail: "x@ann.test",
      actorRole: "admin",
      method: "POST",
      route: path,
      path,
      targetId: "",
      statusCode: 200,
      ip: "127.0.0.1",
      userAgent: "test",
      durationMs: 1,
      requestBody: "",
    });
    for (const p of ["/a", "/b", "/c"]) {
      await ops.recordAudit(entry(p));
      await Bun.sleep(5);
    }
    const middle = new Date();
    await Bun.sleep(5);
    await ops.recordAudit(entry("/d"));
    expect(await ops.deleteAuditBefore(new Date(Date.now() - 60_000))).toBe(0);
    expect(await ops.deleteAuditBefore(middle, 1)).toBe(1);
    let left = await ops.listAudit({ page: 1, pageSize: 50 } as Parameters<typeof ops.listAudit>[0]);
    expect(left.items.map((i) => i.path).sort()).toEqual(["/b", "/c", "/d"]);
    expect(await ops.deleteAuditBefore(middle, 5)).toBe(2);
    left = await ops.listAudit({ page: 1, pageSize: 50 } as Parameters<typeof ops.listAudit>[0]);
    expect(left.items.map((i) => i.path)).toEqual(["/d"]);
  });

  it("sweeps by the portal setting, skips when it is 0 and exposes admin controls", async () => {
    const { store, call, admin } = await bootstrap();
    const settings = await call<PortalSettings>("GET", "/api/v1/admin/settings", admin);
    expect(settings.body.auditLogRetentionDays).toBe(180);
    const pub = await call<PublicSettings>("GET", "/api/v1/public/settings");
    expect(pub.status).toBe(200);
    expect("auditLogRetentionDays" in pub.body).toBe(false);

    for (let i = 0; i < 5; i++) await call("POST", "/api/v1/admin/announcements", admin, { title: `audit-${i}` });
    const count = async () => (await store.ops.listAudit({ page: 1, pageSize: 1 } as Parameters<typeof store.ops.listAudit>[0])).total;
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(5);

    // Two days from now with 1-day retention: every current row is past it.
    const later = () => Date.now() + 2 * 86_400_000;
    const off = await call<AuditRetentionStatus>("PUT", "/api/v1/admin/audit-logs/retention", admin, { retentionDays: 0 });
    expect(off.status).toBe(200);
    expect(off.body.retentionDays).toBe(0);
    const idle = new AuditRetentionSweeper(store, { now: later, batchSize: 2 });
    expect(await idle.runOnce()).toEqual({ retentionDays: 0, skipped: true, deleted: 0 });
    expect(await count()).toBeGreaterThanOrEqual(before);

    expect((await call("PUT", "/api/v1/admin/audit-logs/retention", admin, { retentionDays: -1 })).status).toBe(400);
    expect((await call("PUT", "/api/v1/admin/audit-logs/retention", admin, { retentionDays: 3651 })).status).toBe(400);

    // Shortening the period (here from keep-forever) or sweeping on demand removes history: never
    // without a fresh two-factor code, and never through the settings patch.
    const shorten = (body: Record<string, unknown>) =>
      call<AuditRetentionStatus & { error?: string }>("PUT", "/api/v1/admin/audit-logs/retention", admin, { retentionDays: 1, ...body });
    const runNow = (body?: unknown) => call<AuditRetentionRunResponse & { error?: string }>("POST", "/api/v1/admin/audit-logs/retention/run", admin, body);
    expect((await shorten({})).body.error).toBe("totp_not_enabled");
    expect((await runNow()).body.error).toBe("totp_not_enabled");
    const patched = await call<{ error?: string }>("PATCH", "/api/v1/admin/settings", admin, { auditLogRetentionDays: 1 });
    expect(patched.status).toBe(403);
    expect(patched.body.error).toBe("retention_step_up");
    // An unchanged value in a full settings patch is fine.
    expect((await call("PATCH", "/api/v1/admin/settings", admin, { auditLogRetentionDays: 0, siteSubtitle: "x" })).status).toBe(200);

    const { codeAt } = await enableAdminTotp(call, admin);
    const noCode = await shorten({});
    expect(noCode.status).toBe(403);
    expect(noCode.body.error).toBe("totp_required");
    expect((await shorten({ totpCode: "000000" === (await codeAt(0)) ? "111111" : "000000" })).body.error).toBe("invalid_totp");
    expect((await call("PATCH", "/api/v1/admin/settings", admin, { auditLogRetentionDays: 1 })).status).toBe(403);
    const shortened = await shorten({ totpCode: await codeAt(0) });
    expect(shortened.status).toBe(200);
    expect(shortened.body.retentionDays).toBe(1);
    // The same value again shortens nothing and needs no code.
    expect((await shorten({})).status).toBe(200);
    const putRows = await call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs?search=retention&outcome=success", admin);
    const putNote = putRows.body.items.find((a) => a.method === "PUT" && a.requestBody.includes('"confirmedWith":"totp"'));
    expect((JSON.parse(putNote!.requestBody) as { _outcome?: unknown })._outcome).toEqual({ fromDays: 0, toDays: 1, confirmedWith: "totp" });

    expect((await call<AuditRetentionStatus>("GET", "/api/v1/admin/audit-logs/retention", admin)).body).toMatchObject({
      retentionDays: 1,
      running: false,
      nextRunAtIso: null,
    });

    // Bounded: one batch of two per sweep at most here.
    const total = await count();
    const capped = new AuditRetentionSweeper(store, { now: later, batchSize: 2, maxBatches: 1 });
    const first = await capped.runOnce();
    expect(first).toEqual({ retentionDays: 1, skipped: false, deleted: 2 });
    expect(await count()).toBe(total - 2);
    // Without the cap it loops batch after batch until none is left.
    const rest = await new AuditRetentionSweeper(store, { now: later, batchSize: 2 }).runOnce();
    expect(rest.deleted).toBe(total - 2);
    expect(await count()).toBe(0);
    const status = await (async () => {
      const s = new AuditRetentionSweeper(store, { now: later });
      await s.runOnce();
      return s.status();
    })();
    expect(status.lastDeleted).toBe(0);
    expect(status.lastRunAtIso).not.toBeNull();

    // The on-demand run needs a fresh code too, and reports its outcome (real clock: nothing is a
    // day old yet), also in its own audit row.
    expect((await runNow({})).body.error).toBe("totp_required");
    const run = await runNow({ totpCode: await codeAt(1) });
    expect(run.status).toBe(200);
    expect(run.body.run).toEqual({ retentionDays: 1, skipped: false, deleted: 0 });
    const runRows = await call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs?search=retention/run&outcome=success", admin);
    expect(runRows.body.items).toHaveLength(1);
    expect((JSON.parse(runRows.body.items[0]!.requestBody) as { _outcome?: unknown })._outcome).toEqual({
      retentionDays: 1,
      skipped: false,
      deleted: 0,
      confirmedWith: "totp",
    });

    // Keeping entries longer needs no code, from either place.
    const longer = await call<AuditRetentionStatus>("PUT", "/api/v1/admin/audit-logs/retention", admin, { retentionDays: 365 });
    expect(longer.status).toBe(200);
    expect(longer.body.retentionDays).toBe(365);
    const forever = await call<PortalSettings>("PATCH", "/api/v1/admin/settings", admin, { auditLogRetentionDays: 0 });
    expect(forever.status).toBe(200);
    expect(forever.body.auditLogRetentionDays).toBe(0);
  });

  it("never lets a configuration import shorten the retention period", async () => {
    const a = await bootstrap();
    const exported = await a.call<{ portalSettings: Record<string, unknown> }>("GET", "/api/v1/admin/backup/export", a.admin);
    expect(exported.body.portalSettings.auditLogRetentionDays).toBe(180);

    const b = await bootstrap();
    expect((await b.call("PUT", "/api/v1/admin/audit-logs/retention", b.admin, { retentionDays: 0 })).status).toBe(200);
    const imported = await b.call<{ errors: string[]; updated: string[] }>("POST", "/api/v1/admin/backup/import", b.admin, {
      file: { ...exported.body, portalSettings: { ...exported.body.portalSettings, siteSubtitle: "imported" } },
      sections: ["portalSettings"],
    });
    expect(imported.status).toBe(200);
    expect(imported.body.updated).toContain("portalSettings");
    expect(imported.body.errors.some((e) => e.includes("auditLogRetentionDays"))).toBe(true);
    const after = (await b.call<PortalSettings>("GET", "/api/v1/admin/settings", b.admin)).body;
    expect(after.siteSubtitle).toBe("imported");
    expect(after.auditLogRetentionDays).toBe(0);

    // A backup made before the setting existed leaves it alone; a longer period is taken.
    const { auditLogRetentionDays: _drop, ...legacy } = exported.body.portalSettings;
    await b.call("POST", "/api/v1/admin/backup/import", b.admin, { file: { ...exported.body, portalSettings: legacy }, sections: ["portalSettings"] });
    expect((await b.call<PortalSettings>("GET", "/api/v1/admin/settings", b.admin)).body.auditLogRetentionDays).toBe(0);
    await a.call("PUT", "/api/v1/admin/audit-logs/retention", a.admin, { retentionDays: 400 });
    const c = await bootstrap();
    const longer = await a.call<{ portalSettings: Record<string, unknown> }>("GET", "/api/v1/admin/backup/export", a.admin);
    const ok = await c.call<{ errors: string[] }>("POST", "/api/v1/admin/backup/import", c.admin, { file: longer.body, sections: ["portalSettings"] });
    expect(ok.body.errors).toEqual([]);
    expect((await c.call<PortalSettings>("GET", "/api/v1/admin/settings", c.admin)).body.auditLogRetentionDays).toBe(400);
  });

  it("start() and stop() leave no timers behind", async () => {
    const sweeper = new AuditRetentionSweeper(new MemoryControlStore(), { startupDelayMs: 60_000 });
    sweeper.start();
    expect((await sweeper.status()).nextRunAtIso).not.toBeNull();
    sweeper.stop();
    expect((await sweeper.status()).nextRunAtIso).toBeNull();
  });
});

describe("audit body capture", () => {
  const streamOf = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  const chunked = (chunks: string[]) =>
    new Request("http://local/api/v1/admin/x", { method: "POST", body: streamOf(chunks), duplex: "half" } as RequestInit);

  it("caps what it reads from a chunked body and leaves the handler's stream whole", async () => {
    const chunks = Array.from({ length: 40 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(2046)}`);
    const req = chunked(chunks);
    expect(req.headers.get("content-length")).toBeNull();
    expect(await readAuditBody(req, 8 * 1024)).toBe(JSON.stringify({ omitted: `over ${8 * 1024} bytes` }));
    expect(await req.text()).toBe(chunks.join(""));

    const small = chunked(['{"a":', '"b"}']);
    expect(await readAuditBody(small, 1024)).toBe('{"a":"b"}');
    expect(await small.json()).toEqual({ a: "b" });

    const declared = new Request("http://local/x", { method: "POST", body: "y".repeat(2000), headers: { "content-length": "2000" } });
    expect(await readAuditBody(declared, 1000)).toBe(JSON.stringify({ omitted: "2000 bytes" }));
    expect((await declared.text()).length).toBe(2000);
  });

  it("audits a chunked admin write without disturbing the route", async () => {
    const { app, call, admin } = await bootstrap();
    const res = await app.request("/api/v1/admin/announcements", {
      method: "POST",
      headers: admin,
      body: streamOf(['{"title":"Chunked', ' upload","content":"', "z".repeat(5000), '"}']),
      duplex: "half",
    } as RequestInit);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { item: AnnouncementItem };
    expect(created.item.title).toBe("Chunked upload");
    expect(created.item.content.length).toBe(5000);
    const audit = await call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs?method=POST", admin);
    const row = audit.body.items.find((a) => a.route === "/api/v1/admin/announcements");
    expect(row?.requestBody).toContain("Chunked upload");
  });
});
