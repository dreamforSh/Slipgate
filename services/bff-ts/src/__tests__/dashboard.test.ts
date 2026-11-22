import { describe, expect, it } from "bun:test";
import type { AdminDashboardStats, GroupItem, UpstreamAccount, UsageLogItem, UserProfile } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { buildDashboardStats, dashboardWindow } from "../dashboard.ts";
import { MemoryControlStore } from "../store/memory_store.ts";

const UTC8 = -480; // Date#getTimezoneOffset() for UTC+8
// 2026-11-22 10:30 local (UTC+8) == 02:30Z
const NOW = Date.parse("2026-11-22T02:30:00Z");

let seq = 0;
function log(atIso: string, over: Partial<UsageLogItem> = {}): UsageLogItem {
  seq += 1;
  return {
    id: `usg_${seq}`,
    requestId: `req_${seq}`,
    userId: "u1",
    apiKeyId: "k1",
    accountId: "a1",
    groupId: "g1",
    platform: "anthropic",
    publicModel: "claude-sonnet-4-5",
    upstreamModel: "claude-sonnet-4-5",
    ingressCodec: "openai_chat",
    egressCodec: "anthropic_messages",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costNanoUsd: "1000",
    ttftMs: 200,
    durationMs: 800,
    window5hUsedBps: 0,
    window7dUsedBps: 0,
    statusCode: 200,
    formattedCostUsd: "$0.000001",
    createdAtIso: atIso,
    ...over,
  };
}

const users: UserProfile[] = [
  { id: "u1", email: "a@x.test", role: "admin", status: "active", totpEnabled: false, createdAtIso: "2026-01-01T00:00:00Z" },
  // Created 2026-11-22 08:00 local -> counts as new today.
  { id: "u2", email: "b@x.test", role: "user", status: "active", totpEnabled: false, createdAtIso: "2026-11-22T00:00:00Z" },
];

const groups = [{ id: "g1", name: "main" }, { id: "g2", name: "vip" }] as GroupItem[];

const accounts = [
  { status: "active", lastTest: { ok: false } },
  { status: "active", lastTest: null },
  { status: "paused", lastTest: { ok: true } },
  { status: "cooldown", lastTest: null },
] as unknown as UpstreamAccount[];

describe("dashboard window", () => {
  it("buckets by the viewer's local day and hour", () => {
    const week = dashboardWindow("7d", NOW, UTC8);
    // Local midnight 2026-11-22 (UTC+8) is 2026-11-21T16:00Z.
    expect(new Date(week.todayStartMs).toISOString()).toBe("2026-11-21T16:00:00.000Z");
    expect(new Date(week.yesterdayStartMs).toISOString()).toBe("2026-11-20T16:00:00.000Z");
    expect(week.granularity).toBe("day");
    expect(week.bucketStarts).toHaveLength(7);
    expect(new Date(week.bucketStarts[0]!).toISOString()).toBe("2026-11-15T16:00:00.000Z");

    const day = dashboardWindow("24h", NOW, UTC8);
    expect(day.granularity).toBe("hour");
    expect(day.bucketStarts).toHaveLength(24);
    expect(new Date(day.bucketStarts[23]!).toISOString()).toBe("2026-11-22T02:00:00.000Z");
    // 24h window starts after yesterday's local midnight, so rows are fetched from yesterday.
    expect(day.sinceMs).toBe(day.yesterdayStartMs);

    expect(dashboardWindow("30d", NOW, 0).bucketStarts).toHaveLength(30);
  });
});

describe("buildDashboardStats", () => {
  const logs = [
    log("2026-11-22T02:29:30Z", { outputTokens: 10 }), // within the last minute
    log("2026-11-22T01:10:00Z", { statusCode: 502, durationMs: 0, ttftMs: 0, costNanoUsd: "0" }),
    log("2026-11-21T17:00:00Z", { userId: "u2", publicModel: "gpt-4o-mini", groupId: "g2", inputTokens: 1000 }),
    log("2026-11-21T10:00:00Z", { costNanoUsd: "5000" }), // yesterday (local 18:00)
    log("2026-11-16T01:00:00Z", { publicModel: "gpt-4o-mini" }), // first day of the 7d window
    log("2026-11-10T00:00:00Z"), // outside the window (should be ignored)
  ];

  const stats = buildDashboardStats({
    range: "7d",
    nowMs: NOW,
    tzOffsetMinutes: UTC8,
    logs,
    truncated: false,
    users,
    groups,
    accounts,
    apiKeys: [{ enabled: true }, { enabled: false }, { enabled: true }],
  });

  it("splits today and yesterday in local time", () => {
    expect(stats.today).toMatchObject({
      requests: 3,
      errors: 1,
      inputTokens: 1200,
      outputTokens: 110,
      costNanoUsd: "2000",
      avgDurationMs: 800,
      avgTtftMs: 200,
    });
    expect(stats.yesterday).toMatchObject({ requests: 1, costNanoUsd: "5000" });
    expect(stats.period.requests).toBe(5);
    expect(stats.throughput).toEqual({ rpm: 1, tpm: 110 });
  });

  it("fills daily series buckets including empty days", () => {
    expect(stats.series).toHaveLength(7);
    expect(stats.series[0]).toMatchObject({ requests: 1 }); // 2026-11-16 local
    expect(stats.series[5]).toMatchObject({ requests: 1, costNanoUsd: "5000" }); // yesterday
    expect(stats.series[6]).toMatchObject({ requests: 3, errors: 1 }); // today
    expect(stats.series.slice(1, 5).every((p) => p.requests === 0)).toBe(true);
  });

  it("ranks models, users and groups by tokens", () => {
    expect(stats.models[0]).toMatchObject({ model: "gpt-4o-mini", requests: 2, tokens: 1050 + 150 });
    expect(stats.models[1]).toMatchObject({ model: "claude-sonnet-4-5", requests: 3 });
    expect(stats.topUsers[0]).toMatchObject({ userId: "u2", email: "b@x.test" });
    expect(stats.groups.map((g) => g.name)).toEqual(["vip", "main"]);
  });

  it("summarizes users, keys and account health", () => {
    expect(stats.users).toEqual({ total: 2, newToday: 1, activeToday: 2 });
    expect(stats.apiKeys).toEqual({ total: 3, enabled: 2 });
    expect(stats.accounts).toEqual({ total: 4, active: 2, paused: 1, cooldown: 1, expired: 0, failedTests: 1 });
  });
});

describe("GET /api/v1/admin/dashboard/stats", () => {
  it("aggregates recorded settlements for admins", async () => {
    const store = new MemoryControlStore();
    const app = createBffApp({
      store,
      jwtSecret: "dash-jwt-secret-32-bytes-minimum!!",
      vaultSecret: "dash-vault-secret-32-bytes-minimum!",
    });
    const init = await app.request("/api/v1/setup/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteName: "Dash",
        adminEmail: "admin@dash.test",
        adminPassword: "AdminPassword123!",
        allowRegistration: true,
      }),
    });
    const { accessToken, user } = (await init.json()) as { accessToken: string; user: { id: string } };

    for (let i = 0; i < 3; i++) {
      await store.recordTurnSettlement({
        requestId: `req_dash_${i}`,
        userId: user.id,
        apiKeyId: "key_x",
        accountId: "acc_x",
        groupId: "grp_default",
        platform: "openai",
        publicModel: "gpt-4o-mini",
        upstreamModel: "gpt-4o-mini",
        ingressCodec: "openai_chat",
        egressCodec: "openai_chat",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costNanoUsd: "250",
        ttftMs: 100,
        durationMs: 300,
        window5hUsedBps: 0,
        window7dUsedBps: 0,
        statusCode: i === 2 ? 429 : 200,
      });
    }

    const res = await app.request("/api/v1/admin/dashboard/stats?range=24h&tz=-480", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(res.status).toBe(200);
    const stats = (await res.json()) as AdminDashboardStats;
    expect(stats.range).toBe("24h");
    expect(stats.granularity).toBe("hour");
    expect(stats.series).toHaveLength(24);
    expect(stats.today).toMatchObject({ requests: 3, errors: 1, costNanoUsd: "750" });
    expect(stats.series[23]?.requests).toBe(3);
    expect(stats.models[0]).toMatchObject({ model: "gpt-4o-mini", requests: 3 });
    expect(stats.groups[0]?.name).toBe("default-composite");
    expect(stats.throughput.rpm).toBe(3);

    const bad = await app.request("/api/v1/admin/dashboard/stats?range=bogus", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(((await bad.json()) as AdminDashboardStats).range).toBe("7d");

    const anon = await app.request("/api/v1/admin/dashboard/stats");
    expect(anon.status).toBe(401);
  });
});
