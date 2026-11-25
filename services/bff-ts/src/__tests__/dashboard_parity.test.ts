import { describe, expect, it } from "bun:test";
import type { AdminDashboardStats, DashboardGranularity, DashboardRange, UsageLogItem } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { buildDashboardStats, dashboardWindow } from "../dashboard.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";

/**
 * The dashboard route aggregates in the store (SQL GROUPING SETS in Postgres) instead of reducing
 * up to 100k rows in the BFF. Its answer must equal the reference reducer run over the very same
 * rows, for every range and bucket size. Runs on Postgres when a `--preload` installs
 * `__slipgateTestStoreFactory` (PGlite).
 */

type StoreFactory = () => Promise<ControlStore>;
const TZ = -480;

async function setCreatedAt(store: ControlStore, requestId: string, at: Date): Promise<void> {
  const sql = (store as unknown as { sql?: (...args: unknown[]) => Promise<unknown> }).sql;
  if (sql) {
    await sql`UPDATE core.usage_logs SET created_at = ${at} WHERE request_id = ${requestId}`;
  } else {
    const row = (store as unknown as { usageLogs: UsageLogItem[] }).usageLogs.find((l) => l.requestId === requestId);
    if (!row) throw new Error(`Missing usage log ${requestId}`);
    row.createdAtIso = at.toISOString();
  }
}

describe("admin dashboard aggregation parity", () => {
  it("matches the reference reducer over the same rows for every range", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    const store = factory ? await factory() : new MemoryControlStore();
    if (factory) await store.init();
    try {
      const app = createBffApp({ store, jwtSecret: "parity-jwt-secret-32-bytes-minimum!", vaultSecret: "parity-vault-secret-32-bytes-minimum" });
      const json = { "Content-Type": "application/json" };
      const init = await app.request("/api/v1/setup/initialize", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ siteName: "Parity", adminEmail: "admin@parity.test", adminPassword: "AdminPassword123!", allowRegistration: true }),
      });
      const { accessToken, user } = (await init.json()) as { accessToken: string; user: { id: string } };
      const auth = { Authorization: `Bearer ${accessToken}` };
      const userIds = [user.id];
      for (const email of ["p1@parity.test", "p2@parity.test", "p3@parity.test"]) {
        const res = await app.request("/api/v1/auth/register", { method: "POST", headers: json, body: JSON.stringify({ email, password: "UserPassword123!" }) });
        userIds.push(((await res.json()) as { user: { id: string } }).user.id);
      }

      const now = Date.now();
      const ages = [0, 30_000, 20 * 60_000, 3 * 3_600_000, 26 * 3_600_000, 3 * 86_400_000, 6.5 * 86_400_000, 12 * 86_400_000, 40 * 86_400_000];
      const models = ["gpt-4o-mini", "claude-sonnet-4-5", "gemini-2.5-flash"];
      let n = 0;
      for (const [i, age] of ages.entries()) {
        for (let k = 0; k < 3; k++) {
          const requestId = `req_parity_${n++}`;
          await store.recordTurnSettlement({
            requestId,
            userId: userIds[(i + k) % userIds.length]!,
            apiKeyId: "key_parity",
            accountId: "acc_parity",
            groupId: k === 2 ? "grp_other" : "grp_default",
            platform: "openai",
            publicModel: models[(i * 2 + k) % models.length]!,
            upstreamModel: "upstream",
            ingressCodec: "openai_chat",
            egressCodec: "openai_chat",
            inputTokens: 100 * (i + 1) + k,
            outputTokens: 10 * (k + 1),
            cacheReadTokens: k * 7,
            cacheWriteTokens: 0,
            costNanoUsd: String(1000 * (i + 1) + k * 3),
            ttftMs: k === 1 ? 0 : 120 + i,
            durationMs: k === 0 ? 0 : 400 + i * 10,
            window5hUsedBps: 0,
            window7dUsedBps: 0,
            statusCode: (i + k) % 4 === 0 ? 502 : 200,
          });
          await setCreatedAt(store, requestId, new Date(now - age - k * 1000));
        }
      }

      const cases: { range: DashboardRange; granularity?: DashboardGranularity }[] = [
        { range: "24h" },
        { range: "7d" },
        { range: "7d", granularity: "hour" },
        { range: "30d" },
      ];
      // Postgres: the store's SQL directly (PGlite serves one statement stream at a time, so the
      // route's concurrent reads beside a transaction are only exercised on the memory store).
      const viaRoute = !factory;
      for (const c of cases) {
        let got: AdminDashboardStats;
        if (viaRoute) {
          const qs = `range=${c.range}&tz=${TZ}${c.granularity ? `&granularity=${c.granularity}` : ""}`;
          const res = await app.request(`/api/v1/admin/dashboard/stats?${qs}`, { headers: auth });
          expect(res.status).toBe(200);
          got = (await res.json()) as AdminDashboardStats;
        } else {
          const nowMs = Date.now();
          const w = dashboardWindow(c.range, nowMs, TZ, c.granularity);
          got = JSON.parse(
            JSON.stringify(
              buildDashboardStats({
                range: c.range,
                granularity: c.granularity,
                nowMs,
                tzOffsetMinutes: TZ,
                usage: await store.ops.dashboardUsage(w, nowMs),
                users: await store.listUsers(),
                groups: await store.listGroups(false),
                accounts: await store.listAccounts(),
                apiKeys: await store.ops.countApiKeys(),
              }),
            ),
          ) as AdminDashboardStats;
        }
        const nowMs = Date.parse(got.generatedAtIso);
        const win = dashboardWindow(c.range, nowMs, TZ, c.granularity);
        const expected = buildDashboardStats({
          range: c.range,
          granularity: c.granularity,
          nowMs,
          tzOffsetMinutes: TZ,
          logs: await store.listUsageLogs({ sinceIso: new Date(win.sinceMs).toISOString(), limit: 100_000 }),
          users: await store.listUsers(),
          groups: await store.listGroups(false),
          accounts: await store.listAccounts(),
          apiKeys: await store.ops.countApiKeys(),
        });
        expect(got).toEqual(JSON.parse(JSON.stringify(expected)));
        expect(got.period.requests).toBeGreaterThan(0);
      }
    } finally {
      await store.close();
    }
  });
});
