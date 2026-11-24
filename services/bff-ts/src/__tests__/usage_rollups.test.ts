import { describe, expect, it } from "bun:test";
import type {
  UsageLogItem,
  UsageRollupBackfillResponse,
  UsageRollupCleanupResponse,
  UsageRollupSeriesResponse,
  UsageRollupStatus,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "usage-rollups-internal-token";

type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const store = factory ? await factory() : new MemoryControlStore();
  if (factory) await store.init();
  const app = createBffApp({
    store,
    jwtSecret: "usage-rollups-test-jwt-secret-32b",
    vaultSecret: "usage-rollups-test-vault-secret-32b",
    internalToken: INTERNAL,
  });

  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
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

  const init = await call<{ accessToken: string; user: { id: string } }>(
    "POST",
    "/api/v1/setup/initialize",
    JSON_HEADERS,
    {
      siteName: "Rollups Test",
      adminEmail: "admin@rollups.test",
      adminPassword: "AdminPassword123!",
      allowRegistration: true,
    },
  );
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };

  const member = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
    email: "member@rollups.test",
    password: "MemberPassword123!",
  });
  expect(member.status).toBe(201);

  return { app, store, call, admin, memberId: member.body.user.id, memberHeaders: { ...JSON_HEADERS, Authorization: `Bearer ${member.body.accessToken}` } };
}

async function ageUsageLog(store: ControlStore, requestId: string, daysAgo: number): Promise<void> {
  const sql = (store as unknown as { sql?: (...args: unknown[]) => Promise<unknown> }).sql;
  if (sql) {
    await sql`UPDATE core.usage_logs SET created_at = NOW() - ${`${daysAgo} days`}::interval WHERE request_id = ${requestId}`;
  } else {
    const row = (store as unknown as { usageLogs: UsageLogItem[] }).usageLogs.find((l) => l.requestId === requestId);
    if (!row) throw new Error(`Missing usage log ${requestId}`);
    row.createdAtIso = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  }
}

describe("Lane O4: usage rollups and retention cleanup", () => {
  it("validates retention config, backfills hourly/daily rollups, queries series, and prunes old logs after rolling them up", async () => {
    const { store, call, admin, memberId, memberHeaders } = await bootstrap();

    try {
      // Non-admin blocked
      const forbidden = await call("GET", "/api/v1/admin/usage-rollups/status", memberHeaders);
      expect(forbidden.status).toBe(403);

      // Rejects invalid retention days (1..6)
      const invalidCfg = await call("PATCH", "/api/v1/admin/usage-rollups/config", admin, {
        usageRetentionDays: 3,
      });
      expect(invalidCfg.status).toBe(400);

      // Allows 0 (forever) and 14 days
      const cfg0 = await call<UsageRollupStatus>("PATCH", "/api/v1/admin/usage-rollups/config", admin, {
        rollupEnabled: false,
        usageRetentionDays: 0,
      });
      expect(cfg0.status).toBe(200);
      expect(cfg0.body.rollupEnabled).toBe(false);
      expect(cfg0.body.usageRetentionDays).toBe(0);

      const cfg14 = await call<UsageRollupStatus>("PATCH", "/api/v1/admin/usage-rollups/config", admin, {
        rollupEnabled: true,
        usageRetentionDays: 14,
      });
      expect(cfg14.status).toBe(200);
      expect(cfg14.body.rollupEnabled).toBe(true);
      expect(cfg14.body.usageRetentionDays).toBe(14);

      // Seed group, account, key and two usage logs: one 20 days ago and one recent
      const groupRes = await call<{ group: { id: string } }>("POST", "/api/v1/admin/groups", admin, {
        name: "Rollup Group",
        platform: "openai",
      });
      expect(groupRes.status).toBe(201);
      const groupId = groupRes.body.group.id;

      const keyRes = await call<{ item: { id: string } }>("POST", "/api/v1/user/api-keys", memberHeaders, {
        groupId,
        name: "Rollup Key",
      });
      expect(keyRes.status).toBe(201);
      const keyId = keyRes.body.item.id;

      await store.recordTurnSettlement({
        settlementId: "stl_rollup_old_1",
        coreSettled: false,
        requestId: "req_rollup_old_1",
        userId: memberId,
        apiKeyId: keyId,
        accountId: "acc_1",
        groupId,
        platform: "openai",
        publicModel: "gpt-4o",
        upstreamModel: "gpt-4o",
        ingressCodec: "openai_chat",
        egressCodec: "openai_chat",
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costNanoUsd: "2500000",
        ttftMs: 120,
        durationMs: 420,
        window5hUsedBps: 0,
        window7dUsedBps: 0,
        statusCode: 200,
      });
      await ageUsageLog(store, "req_rollup_old_1", 20);

      await store.recordTurnSettlement({
        settlementId: "stl_rollup_new_1",
        coreSettled: false,
        requestId: "req_rollup_new_1",
        userId: memberId,
        apiKeyId: keyId,
        accountId: "acc_1",
        groupId,
        platform: "openai",
        publicModel: "gpt-4o",
        upstreamModel: "gpt-4o",
        ingressCodec: "openai_chat",
        egressCodec: "openai_chat",
        inputTokens: 300,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costNanoUsd: "500000",
        ttftMs: 80,
        durationMs: 220,
        window5hUsedBps: 0,
        window7dUsedBps: 0,
        statusCode: 502,
      });

      // Backfill 30 days hourly & daily
      const bf = await call<UsageRollupBackfillResponse>("POST", "/api/v1/admin/usage-rollups/backfill", admin, {
        days: 30,
        granularity: "both",
      });
      expect(bf.status).toBe(200);
      expect(bf.body.hourlyUpserted).toBeGreaterThanOrEqual(2);
      expect(bf.body.dailyUpserted).toBeGreaterThanOrEqual(2);

      // Series query returns summed metrics across both buckets
      const sr = await call<UsageRollupSeriesResponse>(
        "GET",
        "/api/v1/admin/usage-rollups/series?granularity=daily&days=30&platform=openai&publicModel=gpt-4o",
        admin,
      );
      expect(sr.status).toBe(200);
      expect(sr.body.points.length).toBeGreaterThanOrEqual(2);
      expect(sr.body.totals.requests).toBe(2);
      expect(sr.body.totals.errors).toBe(1);
      expect(sr.body.totals.inputTokens).toBe(1300);
      expect(sr.body.totals.outputTokens).toBe(600);
      expect(sr.body.totals.costNanoUsd).toBe("3000000");

      // Dry-run cleanup matches only the 20-day-old log
      const dry = await call<UsageRollupCleanupResponse>("POST", "/api/v1/admin/usage-rollups/cleanup", admin, {
        dryRun: true,
      });
      expect(dry.status).toBe(200);
      expect(dry.body.dryRun).toBe(true);
      expect(dry.body.matchedOrDeleted).toBe(1);

      // Actual cleanup deletes the 20-day-old log while preserving rollups and recent log
      const clean = await call<UsageRollupCleanupResponse>("POST", "/api/v1/admin/usage-rollups/cleanup", admin, {
        dryRun: false,
      });
      expect(clean.status).toBe(200);
      expect(clean.body.dryRun).toBe(false);
      expect(clean.body.matchedOrDeleted).toBe(1);
      expect(clean.body.rolledUpBeforeDelete).toBe(true);

      const remaining = await store.listUsageLogs({ limit: 50 });
      expect(remaining.length).toBe(1);
      expect(remaining[0]?.requestId).toBe("req_rollup_new_1");

      // Status reflects cleanup count & rolled up history remains queryable
      const st = await call<UsageRollupStatus>("GET", "/api/v1/admin/usage-rollups/status", admin);
      expect(st.status).toBe(200);
      expect(st.body.lastCleanupDeleted).toBe(1);
      expect(st.body.dailyRows).toBeGreaterThanOrEqual(2);
    } finally {
      await store.close();
    }
  });
});
