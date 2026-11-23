import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import type postgres from "postgres";
import {
  USAGE_DEFAULT_WINDOW_DAYS,
  USAGE_QUERY_MAX_PAGED_ROWS,
  type ApiKeyItem,
  type ChannelStatusResponse,
  type GroupItem,
  type KeyUsageLookupResponse,
  type OpsOverview,
  type RedeemCodeItem,
  type UsageLogItem,
  type UsagePageResponse,
  type UserDashboardStats,
  type UserSubscriptionItem,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { channelStatusQuery, KeyedCache, opsUsageQuery } from "../insights.ts";
import { SCOPED_USAGE_LOADS_PER_MINUTE } from "../routes/ops.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import { PG_OPS_SCHEMA_SQL, pgAssignSubscriptionTx, pgReadWithTimeout } from "../store/postgres_ops.ts";
import type { ControlStore } from "../store/types.ts";
import {
  reduceChannelStatus,
  reduceOpsUsage,
  reduceScopedUsage,
  UsageAggregateTimeoutError,
  type ScopedUsageQuery,
} from "../store/usage_aggregates.ts";

/**
 * Group F regressions: aggregates computed by the store (exact, bounded), the public key lookup
 * by digest, atomic email codes / invitations / subscription grants, the bulk key update and the
 * memory/Postgres parity fixes. Runs on MemoryControlStore, and on PostgresControlStore when a
 * `--preload` installs `__slipgateTestStoreFactory` (PGlite).
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "integrity-internal-token";
const NANO = 1_000_000_000n;

type StoreFactory = () => Promise<ControlStore>;
const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
const onPostgres = Boolean(factory);

type Sql = { unsafe(q: string): Promise<unknown>; <T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T> };
type PgSql = ReturnType<typeof postgres>;
const DAY_MS = 86_400_000;

/** Moves one settled row `days` into the past (either store). */
async function ageUsage(store: ControlStore, requestId: string, days: number) {
  if (onPostgres) {
    const sql = (store as unknown as { sql: Sql }).sql;
    await sql`UPDATE core.usage_logs SET created_at = NOW() - ${`${days} days`}::interval WHERE request_id = ${requestId}`;
    return;
  }
  const row = (store as unknown as { usageLogs: UsageLogItem[] }).usageLogs.find((l) => l.requestId === requestId)!;
  row.createdAtIso = new Date(Date.now() - days * DAY_MS).toISOString();
}

async function bootstrap() {
  const store: ControlStore = factory ? await factory() : new MemoryControlStore();
  const app = createBffApp({
    store,
    jwtSecret: "integrity-test-jwt-secret-32-bytes-min",
    vaultSecret: "integrity-test-vault-secret-32-bytes-min",
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
  const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Integrity",
    adminEmail: "admin@integrity.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  const register = async (email: string, extra: Record<string, unknown> = {}) => {
    const res = await call<{ accessToken: string; user: { id: string }; error?: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
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
  let seq = 0;
  const settle = async (ev: Record<string, unknown>) => {
    const res = await call("POST", "/api/v1/internal/dataplane/settlement", { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL }, {
      requestId: `req-${++seq}`,
      platform: "anthropic",
      accountId: defaultAccountId,
      groupId: "grp_default",
      publicModel: "claude-sonnet-5-5",
      upstreamModel: "claude-sonnet-5-5",
      ingressCodec: "anthropic",
      egressCodec: "anthropic",
      inputTokens: 100,
      outputTokens: 50,
      costNanoUsd: "0",
      statusCode: 200,
      ...ev,
    });
    expect(res.status).toBe(200);
  };
  /** Counts calls of a store method from now on (both stores take own-property overrides). */
  const spy = <K extends keyof ControlStore>(name: K) => {
    const target = store as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = target[name as string]!.bind(store);
    const counter = { calls: 0 };
    target[name as string] = (...args: unknown[]) => {
      counter.calls++;
      return original(...args);
    };
    return counter;
  };
  const spyOps = <K extends keyof ControlStore["ops"]>(name: K) => {
    const target = store.ops as unknown as Record<string, (...args: unknown[]) => unknown>;
    const original = target[name as string]!.bind(store.ops);
    const counter = { calls: 0 };
    target[name as string] = (...args: unknown[]) => {
      counter.calls++;
      return original(...args);
    };
    return counter;
  };
  const createKey = async (headers: Record<string, string>, body: Record<string, unknown>) =>
    call<{ item: ApiKeyItem; plaintextKey: string; error?: string; message?: string }>("POST", "/api/v1/user/api-keys", headers, {
      groupId: "grp_default",
      name: "k",
      ...body,
    });
  return { app, store, call, admin, register, account, defaultAccountId, settle, spy, spyOps, createKey };
}

/** Maps → plain objects with bigints as strings, for deep equality between stores. */
function plain(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)).map(([k, v]) => [String(k), plain(v)]));
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  return value;
}

describe("usage aggregates (F09, F24, F25)", () => {
  it("aggregates in the store exactly as the reference reducers do", async () => {
    const { store, register, settle, account, call, admin } = await bootstrap();
    const u = await register("agg@integrity.test");
    const other = await register("other@integrity.test");
    const groupB = (await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name: "agg-b", platform: "anthropic" })).body.group;
    const accB = await account(groupB.id);
    const shapes = [
      { publicModel: "claude-sonnet-5-5", statusCode: 200, ttftMs: 120, durationMs: 900, costNanoUsd: "1500" },
      { publicModel: "claude-sonnet-5-5", statusCode: 200, ttftMs: 80, durationMs: 400, costNanoUsd: "2500" },
      { publicModel: "claude-opus-5-5", statusCode: 529, ttftMs: 0, durationMs: 50, costNanoUsd: "0" },
      { publicModel: "claude-opus-5-5", statusCode: 200, ttftMs: 300, durationMs: 0, costNanoUsd: "7000", inputTokens: 900 },
      { publicModel: "claude-haiku-5-5", statusCode: 429, ttftMs: 0, durationMs: 0, costNanoUsd: "0" },
    ];
    for (let i = 0; i < 15; i++) {
      const shape = shapes[i % shapes.length]!;
      await settle({ ...shape, userId: u.id, apiKeyId: i % 2 ? "key_a" : "key_b" });
    }
    await settle({ userId: other.id, apiKeyId: "key_o", groupId: groupB.id, accountId: accB, statusCode: 500, durationMs: 70, costNanoUsd: "10" });

    const logs = await store.listUsageLogs({ sinceIso: new Date(0).toISOString(), limit: 1000 });
    expect(logs).toHaveLength(16);
    const nowMs = Date.now();
    for (const range of ["24h", "7d", "30d"] as const) {
      for (const scope of [{ userId: u.id }, { apiKeyId: "key_a" }]) {
        const q: ScopedUsageQuery = { ...scope, range, nowMs, tzOffsetMinutes: -480 };
        expect(plain(await store.ops.scopedUsage(q))).toEqual(plain(reduceScopedUsage(q, logs)));
      }
    }
    const groups = await store.listGroups(true);
    const cq = channelStatusQuery(groups, nowMs);
    expect(cq.groupIds).toContain(groupB.id);
    expect(plain(await store.ops.channelStatusUsage(cq))).toEqual(plain(reduceChannelStatus(cq, logs)));

    const users = await store.listUsers();
    const allGroups = await store.listGroups(false);
    for (const range of ["1h", "24h"] as const) {
      const oq = opsUsageQuery(range, nowMs);
      const got = await store.ops.opsUsage(oq);
      const want = reduceOpsUsage(oq, logs, {
        userEmail: (id) => users.find((x) => x.id === id)?.email ?? "",
        groupName: (id) => allGroups.find((g) => g.id === id)?.name ?? "",
      });
      // Rows settled within one millisecond have no defined order between the stores.
      const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
      expect(plain({ ...got, recentErrors: [...got.recentErrors].sort(byId) })).toEqual(
        plain({ ...want, recentErrors: [...want.recentErrors].sort(byId) }),
      );
      expect(got.totals.requests).toBe(16);
      expect(got.totals.errors).toBe(7);
      expect(got.totals.durationP99).toBe(900);
    }
  });

  it("serves the user dashboard without listing raw rows, keys with spend windows or subscriptions", async () => {
    const { call, register, settle, spy, spyOps, createKey } = await bootstrap();
    const u = await register("dash@integrity.test");
    const key = (await createKey(u.headers, { name: "primary" })).body.item;
    await createKey(u.headers, { name: "spare" });
    for (let i = 0; i < 6; i++) await settle({ userId: u.id, apiKeyId: key.id, costNanoUsd: "1000", statusCode: i === 0 ? 500 : 200 });
    const rows = spy("listUsageLogs");
    const keyLists = spy("listUserApiKeys");
    const subLists = spyOps("listUserSubscriptions");
    const dash = await call<UserDashboardStats>("GET", "/api/v1/user/dashboard?range=7d&tz=0", u.headers);
    expect(dash.status).toBe(200);
    expect(rows.calls).toBe(0);
    expect(keyLists.calls).toBe(0);
    expect(subLists.calls).toBe(0);
    expect(dash.body.truncated).toBe(false);
    expect(dash.body.period.requests).toBe(6);
    expect(dash.body.period.errors).toBe(1);
    expect(dash.body.period.costNanoUsd).toBe("6000");
    expect(dash.body.today.requests).toBe(6);
    expect(dash.body.apiKeys).toEqual({ total: 2, enabled: 2 });
    expect(dash.body.subscriptions.active).toBe(0);
    expect(dash.body.keys).toEqual([{ apiKeyId: key.id, name: "primary", requests: 6, tokens: 900, costNanoUsd: "6000" }]);
    expect(dash.body.series.reduce((s, p) => s + p.requests, 0)).toBe(6);
  });

  it("reuses dashboard figures per (user, range, tz) and budgets fresh aggregates per user", async () => {
    const { call, register, settle, spyOps } = await bootstrap();
    const u = await register("cache@integrity.test");
    await settle({ userId: u.id, apiKeyId: "key_c", costNanoUsd: "10" });
    const loads = spyOps("scopedUsage");
    const dash = (query: string, headers = u.headers) => call<UserDashboardStats & { error?: string }>("GET", `/api/v1/user/dashboard?${query}`, headers);
    const first = await dash("range=7d&tz=0");
    expect(first.status).toBe(200);
    expect(first.body.period.requests).toBe(1);
    // A refresh within the TTL (another tab, a visibility change) reuses the same aggregate.
    await settle({ userId: u.id, apiKeyId: "key_c", costNanoUsd: "10" });
    const again = await dash("range=7d&tz=0");
    expect(loads.calls).toBe(1);
    expect(again.body.period.requests).toBe(1);
    expect(again.body.generatedAtIso).toBe(first.body.generatedAtIso);
    // Other ranges or time zones are other aggregates, up to the per-user budget a minute.
    const zones = Array.from({ length: SCOPED_USAGE_LOADS_PER_MINUTE - 1 }, (_, i) => (i + 1) * 60);
    for (const tz of zones) expect((await dash(`range=7d&tz=${tz}`)).status).toBe(200);
    expect(loads.calls).toBe(SCOPED_USAGE_LOADS_PER_MINUTE);
    const over = await dash("range=30d&tz=0");
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("too_many_requests");
    expect(loads.calls).toBe(SCOPED_USAGE_LOADS_PER_MINUTE);
    // Cached figures stay served, and the budget is per user.
    expect((await dash("range=7d&tz=0")).status).toBe(200);
    const v = await register("cache-2@integrity.test");
    expect((await dash("range=30d&tz=0", v.headers)).status).toBe(200);
  });

  it("answers 503 when a scoped aggregate runs past its timeout, without caching the failure", async () => {
    const { call, register, store, createKey } = await bootstrap();
    const u = await register("timeout@integrity.test");
    await createKey(u.headers, { name: "slow", customKey: "slow-key-0123456789ab" });
    const ops = store.ops as unknown as Record<string, unknown>;
    ops.scopedUsage = async () => {
      throw new UsageAggregateTimeoutError();
    };
    const dash = await call<{ error: string }>("GET", "/api/v1/user/dashboard?range=30d&tz=0", u.headers);
    expect(dash.status).toBe(503);
    expect(dash.body.error).toBe("usage_timeout");
    const lookup = await call<{ error: string }>("POST", "/api/v1/public/key-usage?tz=0", JSON_HEADERS, { apiKey: "slow-key-0123456789ab" });
    expect(lookup.status).toBe(503);
    delete ops.scopedUsage;
    expect((await call("GET", "/api/v1/user/dashboard?range=30d&tz=0", u.headers)).status).toBe(200);
    expect((await call("POST", "/api/v1/public/key-usage?tz=0", JSON_HEADERS, { apiKey: "slow-key-0123456789ab" })).status).toBe(200);
  });

  it.skipIf(!onPostgres)("reads scoped usage under a transaction-local statement timeout (Postgres)", async () => {
    // PGlite accepts statement_timeout but never fires it; the setting and the mapping are checked.
    const store = await factory!();
    const sql = (store as unknown as { sql: PgSql }).sql;
    const seen = await pgReadWithTimeout(
      sql,
      1234,
      (tx) => tx<{ timeout: string; ro: string }[]>`SELECT current_setting('statement_timeout') AS timeout, current_setting('transaction_read_only') AS ro`,
    );
    expect({ ...seen[0] }).toEqual({ timeout: "1234ms", ro: "on" });
    // SET LOCAL: the pooled connection keeps its own setting afterwards.
    const after = await sql<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`;
    expect(after[0]!.timeout).toBe("0");
    // A cancelled statement (57014) is reported as a usage timeout; other errors pass through.
    await expect(
      pgReadWithTimeout(sql, 1000, (tx) => tx`DO $$ BEGIN RAISE EXCEPTION 'cancelled' USING ERRCODE = '57014'; END $$`),
    ).rejects.toBeInstanceOf(UsageAggregateTimeoutError);
    const other = await pgReadWithTimeout(sql, 1000, (tx) => tx`SELECT 1 / 0`).catch((err: unknown) => err);
    expect(other).not.toBeInstanceOf(UsageAggregateTimeoutError);
    expect((other as { code?: string }).code).toBe("22012");
  });

  it("lists recent rows without the summary when asked (summary=false)", async () => {
    const { call, register, settle } = await bootstrap();
    const u = await register("recent@integrity.test");
    for (let i = 0; i < 8; i++) await settle({ userId: u.id, apiKeyId: "key_r", costNanoUsd: "10" });
    const recent = await call<UsagePageResponse>("GET", "/api/v1/user/usage/query?pageSize=6&summary=false", u.headers);
    expect(recent.status).toBe(200);
    expect(recent.body.summary).toBeNull();
    expect(recent.body.items).toHaveLength(6);
    expect(recent.body.total).toBe(6);
    const page2 = await call<UsagePageResponse>("GET", "/api/v1/user/usage/query?pageSize=6&page=2&summary=0", u.headers);
    expect(page2.body.items).toHaveLength(2);
    expect(page2.body.total).toBe(8);
    const full = await call<UsagePageResponse>("GET", "/api/v1/user/usage/query?pageSize=6", u.headers);
    expect(full.body.total).toBe(8);
    expect(full.body.summary?.requests).toBe(8);
    expect(full.body.summary?.costNanoUsd).toBe("80");
  });

  it("bounds self-service usage browsing to a default window and a paging depth", async () => {
    const { call, register, settle, store } = await bootstrap();
    const u = await register("window@integrity.test");
    await settle({ userId: u.id, apiKeyId: "key_w", costNanoUsd: "7", requestId: "aged-row" });
    await settle({ userId: u.id, apiKeyId: "key_w", costNanoUsd: "10", requestId: "fresh-row" });
    await ageUsage(store, "aged-row", USAGE_DEFAULT_WINDOW_DAYS + 30);
    const iso = (msAgo: number) => encodeURIComponent(new Date(Date.now() - msAgo).toISOString());
    // No start: the summary covers only the default window, not the whole history.
    const recent = await call<UsagePageResponse>("GET", "/api/v1/user/usage/query", u.headers);
    expect(recent.body.summary?.requests).toBe(1);
    expect(recent.body.items.map((r) => r.requestId)).toEqual(["fresh-row"]);
    // An explicit start still reaches older rows.
    const all = await call<UsagePageResponse>("GET", `/api/v1/user/usage/query?sinceIso=${iso(400 * DAY_MS)}`, u.headers);
    expect(all.body.summary?.requests).toBe(2);
    // Only an end: the window ends there.
    const older = await call<UsagePageResponse>("GET", `/api/v1/user/usage/query?untilIso=${iso(100 * DAY_MS)}`, u.headers);
    expect(older.body.items.map((r) => r.requestId)).toEqual(["aged-row"]);
    // The export follows the same window.
    const csv = await call<string>("GET", "/api/v1/user/usage/export", u.headers);
    expect(csv.body).toContain("fresh-row");
    expect(csv.body).not.toContain("aged-row");
    // Paging stops at USAGE_QUERY_MAX_PAGED_ROWS rows.
    const lastPage = USAGE_QUERY_MAX_PAGED_ROWS / 200;
    expect((await call("GET", `/api/v1/user/usage/query?pageSize=200&page=${lastPage}&summary=false`, u.headers)).status).toBe(200);
    const deep = await call<{ error: string }>("GET", `/api/v1/user/usage/query?pageSize=200&page=${lastPage + 1}&summary=false`, u.headers);
    expect(deep.status).toBe(400);
    expect(deep.body.error).toBe("bad_request");
  });

  it("builds the ops overview without loading every user, labels errors and caches briefly", async () => {
    const { call, admin, register, settle, spy } = await bootstrap();
    const u = await register("opsview@integrity.test");
    await settle({ userId: u.id, apiKeyId: "key_x", statusCode: 503, durationMs: 40 });
    await settle({ userId: u.id, apiKeyId: "key_x", statusCode: 200, durationMs: 80, ttftMs: 20 });
    const users = spy("listUsers");
    const overview = await call<OpsOverview>("GET", "/api/v1/admin/ops/overview?range=1h", admin);
    expect(overview.status).toBe(200);
    expect(users.calls).toBe(0);
    expect(overview.body.truncated).toBe(false);
    expect(overview.body.totals.requests).toBe(2);
    expect(overview.body.statusCodes).toEqual([{ code: 503, count: 1 }]);
    expect(overview.body.recentErrors).toHaveLength(1);
    expect(overview.body.recentErrors[0]!.userEmail).toBe("opsview@integrity.test");
    expect(overview.body.recentErrors[0]!.groupName).toBe("default-composite");
    expect(overview.body.series.reduce((s, p) => s + p.requests, 0)).toBe(2);
  });

  it.skipIf(!onPostgres)(
    "reports exact 24h figures past the old 100k-row cap (Postgres)",
    async () => {
      const { store, call, admin, register, defaultAccountId } = await bootstrap();
      const u = await register("heavy@integrity.test");
      const sql = (store as unknown as { sql: Sql }).sql;
      // 120k settled turns over the last 23 hours: every 10th failed, ttft 1..1000, duration 1..2000.
      await sql.unsafe(`
        INSERT INTO core.usage_logs (id, request_id, user_id, api_key_id, account_id, group_id, platform, public_model,
                                     upstream_model, ingress_codec, egress_codec, input_tokens, output_tokens,
                                     cost_nano_usd, ttft_ms, duration_ms, status_code, created_at)
        SELECT 'usg_bulk_' || i, 'bulk-' || i, '${u.id}', 'key_heavy', '${defaultAccountId}', 'grp_default', 'anthropic',
               'claude-sonnet-5-5', 'claude-sonnet-5-5', 'anthropic', 'anthropic', 10, 5, 3,
               (i % 1000) + 1, (i % 2000) + 1, CASE WHEN i % 10 = 0 THEN 500 ELSE 200 END,
               NOW() - (i * 690) * INTERVAL '1 millisecond'
          FROM generate_series(1, 120000) AS i
      `);
      const dash = await call<UserDashboardStats>("GET", "/api/v1/user/dashboard?range=24h&tz=0", u.headers);
      expect(dash.body.truncated).toBe(false);
      expect(dash.body.period.requests).toBe(120_000);
      expect(dash.body.period.errors).toBe(12_000);
      expect(dash.body.period.costNanoUsd).toBe("360000");
      expect(dash.body.series.reduce((s, p) => s + p.requests, 0)).toBe(120_000);

      const status = await call<ChannelStatusResponse>("GET", "/api/v1/public/status");
      const channel = status.body.channels.find((c) => c.groupId === "grp_default")!;
      expect(channel.requests24h).toBe(120_000);
      expect(channel.successRate24h).toBeCloseTo(0.9, 10);
      expect(channel.buckets.filter((b) => b.requests > 0).length).toBeGreaterThanOrEqual(46);

      const overview = await call<OpsOverview>("GET", "/api/v1/admin/ops/overview?range=24h", admin);
      expect(overview.body.truncated).toBe(false);
      expect(overview.body.totals.requests).toBe(120_000);
      expect(overview.body.totals.errors).toBe(12_000);
      expect(overview.body.totals.ttftP50).toBe(500);
      expect(overview.body.totals.ttftP95).toBe(950);
      expect(overview.body.totals.durationP50).toBe(1000);
      expect(overview.body.totals.durationP95).toBe(1900);
      expect(overview.body.totals.durationP99).toBe(1980);
      expect(overview.body.statusCodes).toEqual([{ code: 500, count: 12_000 }]);
      expect(overview.body.recentErrors).toHaveLength(25);
      expect(overview.body.recentErrors[0]!.userEmail).toBe("heavy@integrity.test");
    },
    180_000,
  );
});

describe("public key-usage lookup (F08)", () => {
  it("finds the key by digest without exporting the snapshot or listing keys", async () => {
    const { call, register, settle, spy, createKey } = await bootstrap();
    const u = await register("lookup@integrity.test");
    const created = await createKey(u.headers, { name: "looked-up", customKey: "lookup-key-0123456789" });
    expect(created.status).toBe(201);
    const key = created.body.item;
    await settle({ userId: u.id, apiKeyId: key.id, costNanoUsd: "2000", publicModel: "claude-opus-5-5" });
    await settle({ userId: u.id, apiKeyId: key.id, costNanoUsd: "1000" });
    await settle({ userId: u.id, apiKeyId: "key_someone_else", costNanoUsd: "999999" });

    const snapshots = spy("exportDataPlaneSnapshot");
    const keyLists = spy("listUserApiKeys");
    const rows = spy("listUsageLogs");
    const miss = await call("POST", "/api/v1/public/key-usage?tz=0", JSON_HEADERS, { apiKey: "sk-sg-not-a-real-key-000000" });
    expect(miss.status).toBe(404);
    const hit = await call<KeyUsageLookupResponse>("POST", "/api/v1/public/key-usage?tz=0", JSON_HEADERS, { apiKey: "lookup-key-0123456789" });
    expect(hit.status).toBe(200);
    expect(snapshots.calls).toBe(0);
    expect(keyLists.calls).toBe(0);
    expect(rows.calls).toBe(0);
    expect(hit.body.keyName).toBe("looked-up");
    expect(hit.body.keyPrefix).toBe("look...");
    expect(hit.body.groupName).toBe("default-composite");
    expect(hit.body.billing).toBe("balance");
    expect(hit.body.enabled).toBe(true);
    expect(hit.body.last30d.requests).toBe(2);
    expect(hit.body.last30d.costNanoUsd).toBe("3000");
    expect(hit.body.today.requests).toBe(2);
    expect(hit.body.recent).toHaveLength(2);
    expect(hit.body.models.map((m) => m.model).sort()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(hit.body.series).toHaveLength(30);
  });

  it("reuses a key's figures per time zone and budgets fresh aggregates per key", async () => {
    const { call, register, settle, spyOps, createKey } = await bootstrap();
    const u = await register("lookup-cache@integrity.test");
    const key = (await createKey(u.headers, { name: "cached", customKey: "cached-key-0123456789" })).body.item;
    await settle({ userId: u.id, apiKeyId: key.id, costNanoUsd: "5" });
    const loads = spyOps("scopedUsage");
    const look = (tz: number) =>
      call<KeyUsageLookupResponse & { error?: string }>("POST", `/api/v1/public/key-usage?tz=${tz}`, JSON_HEADERS, { apiKey: "cached-key-0123456789" });
    expect((await look(0)).body.last30d.requests).toBe(1);
    await settle({ userId: u.id, apiKeyId: key.id, costNanoUsd: "5" });
    const again = await look(0);
    expect(again.body.last30d.requests).toBe(1);
    expect(again.body.recent).toHaveLength(1);
    expect(loads.calls).toBe(1);
    for (let i = 1; i < SCOPED_USAGE_LOADS_PER_MINUTE; i++) expect((await look(i * 60)).status).toBe(200);
    expect(loads.calls).toBe(SCOPED_USAGE_LOADS_PER_MINUTE);
    const over = await look(-60);
    expect(over.status).toBe(429);
    expect(loads.calls).toBe(SCOPED_USAGE_LOADS_PER_MINUTE);
    expect((await look(0)).status).toBe(200);
  });
});

describe("KeyedCache", () => {
  it("shares one load per key, expires values, keeps no failures and stays bounded", async () => {
    const cache = new KeyedCache<number>(1_000, 3);
    let loads = 0;
    const load = (value: number) => async () => {
      loads++;
      await Bun.sleep(5);
      return value;
    };
    expect(await Promise.all([cache.get("a", load(1)), cache.get("a", load(2)), cache.get("a", load(3))])).toEqual([1, 1, 1]);
    expect(loads).toBe(1);
    expect(await cache.get("a", load(4))).toBe(1);
    expect(loads).toBe(1);
    expect(cache.peek("a", Date.now() + 1_001)).toBeUndefined();
    expect(await cache.get("a", load(5))).toBe(5);

    await expect(cache.get("f", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(cache.peek("f")).toBeUndefined();
    expect(await cache.get("f", load(6))).toBe(6);

    for (const k of ["b", "c", "d"]) await cache.get(k, load(7));
    expect(cache.size).toBe(3);
    expect(cache.peek("a")).toBeUndefined();
    expect(await cache.peek("d")).toBe(7);
  });
});

describe("atomic store operations (F21, F22, F31, F36)", () => {
  it("evaluates at most five guesses per email code, even when they arrive at once", async () => {
    // A bare store: no app, so no background traffic shares PGlite's single session with the burst.
    const store: ControlStore = factory ? await factory() : new MemoryControlStore();
    const ops = store.ops;
    const expires = new Date(Date.now() + 600_000).toISOString();
    await ops.saveEmailCode("burst@integrity.test", "register", "right", expires);
    // Eight in flight: larger first bursts trip PGlite's single-session socket bridge while many
    // connections prepare the same statements ("portal does not exist"), a harness artifact.
    const guesses = Array.from({ length: 8 }, (_, i) => (i === 7 ? "right" : `wrong-${i}`));
    const results = await Promise.all(guesses.map((g) => ops.consumeEmailCode("burst@integrity.test", "register", g)));
    // Seven wrong guesses were queued before the right one: the code was burned by the fifth.
    expect(results.filter(Boolean)).toHaveLength(0);
    expect(await ops.lastEmailCodeAt("burst@integrity.test", "register")).toBeNull();

    await ops.saveEmailCode("slow@integrity.test", "register", "right", expires);
    for (let i = 0; i < 4; i++) expect(await ops.consumeEmailCode("slow@integrity.test", "register", `wrong-${i}`)).toBe(false);
    expect(await ops.consumeEmailCode("slow@integrity.test", "register", "right")).toBe(true);
    expect(await ops.consumeEmailCode("slow@integrity.test", "register", "right")).toBe(false);

    await ops.saveEmailCode("late@integrity.test", "register", "right", expires);
    for (let i = 0; i < 5; i++) expect(await ops.consumeEmailCode("late@integrity.test", "register", `wrong-${i}`)).toBe(false);
    expect(await ops.consumeEmailCode("late@integrity.test", "register", "right")).toBe(false);
  });

  // Over HTTP on the memory store only: PGlite's single-session socket bridge can interleave the
  // protocol messages of concurrent requests ("portal does not exist"), which real Postgres never
  // does. The Postgres claim itself races at the store level in the next test.
  it.skipIf(onPostgres)("lets exactly one of many concurrent registrations use an invitation code", async () => {
    const { call, admin, register, store } = await bootstrap();
    await call("PATCH", "/api/v1/admin/settings", admin, { inviteRequired: true, defaultBalanceUsd: "1" });
    const codes = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, { kind: "invitation", count: 1 });
    const code = codes.body.items[0]!.code;
    const attempts = await Promise.all(Array.from({ length: 6 }, (_, i) => register(`race${i}@integrity.test`, { inviteCode: code })));
    const winners = attempts.filter((a) => a.status === 201);
    expect(winners).toHaveLength(1);
    for (const lost of attempts.filter((a) => a.status !== 201)) {
      expect(lost.status).toBe(400);
      expect(lost.body.error).toBe("invite_required");
    }
    const listed = await call<{ items: RedeemCodeItem[] }>("GET", `/api/v1/admin/redeem-codes?kind=invitation`, admin);
    const item = listed.body.items.find((c) => c.code === code)!;
    expect(item.status).toBe("used");
    expect(item.redeemedBy).toBe(winners[0]!.id);
    const users = await store.listUsers();
    expect(users.filter((x) => x.email.startsWith("race"))).toHaveLength(1);
    expect((await call<{ wallet: { balanceNanoUsd: string } }>("GET", "/api/v1/user/wallet", winners[0]!.headers)).body.wallet.balanceNanoUsd).toBe(
      NANO.toString(),
    );
  }, 60_000);

  it("claims an invitation for exactly one concurrent registration in the store", async () => {
    const { call, admin, store } = await bootstrap();
    const codes = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, { kind: "invitation", count: 1 });
    const code = codes.body.items[0]!.code;
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.ops.registerWithInvitation(code.toLowerCase(), () => store.registerUser(`claim${i}@integrity.test`, "hash")),
      ),
    );
    const created = outcomes.filter((o) => o !== null);
    expect(created).toHaveLength(1);
    expect((await store.listUsers()).filter((u) => u.email.startsWith("claim"))).toHaveLength(1);
    expect(await store.ops.isInvitationCodeUsable(code)).toBe(false);
    const item = (await store.ops.listRedeemCodes({ page: 1, pageSize: 20, kind: "invitation" } as never)).items.find((c) => c.code === code)!;
    expect(item.redeemedBy).toBe(created[0]!.id);
    // A registration that fails hands the code back for the next one.
    const other = (await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, { kind: "invitation", count: 1 })).body
      .items[0]!.code;
    await expect(store.ops.registerWithInvitation(other, () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await store.ops.isInvitationCodeUsable(other)).toBe(true);
    expect(await store.ops.registerWithInvitation("NO-SUCH-CODE", () => store.registerUser("never@integrity.test", "hash"))).toBeNull();
    expect(await store.findUserByEmail("never@integrity.test")).toBeNull();
  });

  it("hands the invitation back when the registration itself fails", async () => {
    const { call, admin, register } = await bootstrap();
    expect((await register("taken@integrity.test")).status).toBe(201);
    await call("PATCH", "/api/v1/admin/settings", admin, { inviteRequired: true });
    const codes = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, { kind: "invitation", count: 1 });
    const code = codes.body.items[0]!.code;
    expect((await register("taken@integrity.test", { inviteCode: code })).status).toBe(409);
    const next = await register("fresh@integrity.test", { inviteCode: code });
    expect(next.status).toBe(201);
    expect((await register("again@integrity.test", { inviteCode: code })).status).toBe(400);
  });

  // Behavioural check only. On memory the grant is synchronous; on PGlite (the test Postgres) one
  // session serves every connection, so concurrent transactions never overlap and the race the
  // advisory lock prevents cannot happen: this run does NOT cover cross-session locking. The next
  // test asserts the lock itself.
  it("stacks concurrent subscription grants for one (user, group) onto a single subscription", async () => {
    const { call, admin, register, store } = await bootstrap();
    const u = await register("grants@integrity.test");
    const group = (
      await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name: "stack", platform: "anthropic", subscriptionType: "subscription" })
    ).body.group;
    const before = Date.now();
    await Promise.all([
      store.ops.assignSubscription(u.id, group.id, 30, "", "order:a"),
      store.ops.assignSubscription(u.id, group.id, 30, "", "order:b"),
      store.ops.assignSubscription(u.id, group.id, 30, "", "redeem:c"),
    ]);
    const subs = await store.ops.listUserSubscriptions(u.id);
    expect(subs).toHaveLength(1);
    const days = (Date.parse(subs[0]!.expiresAtIso) - before) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it.skipIf(!onPostgres)("holds the (user, group) advisory lock from before the active-row lookup until commit (Postgres)", async () => {
    const { call, admin, register, store } = await bootstrap();
    const u = await register("lock@integrity.test");
    const group = (
      await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name: "locked", platform: "anthropic", subscriptionType: "subscription" })
    ).body.group;
    const sql = (store as unknown as { sql: PgSql }).sql;
    const statements: string[] = [];
    const held = await sql.begin(async (txRaw) => {
      const tx = txRaw as unknown as PgSql;
      // Records each statement's text, in order, and runs it in this transaction.
      const traced = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        statements.push(strings.join("?"));
        return (tx as unknown as (s: TemplateStringsArray, ...v: unknown[]) => unknown)(strings, ...values);
      }) as unknown as PgSql;
      await pgAssignSubscriptionTx(traced, u.id!, group.id, 30, "", "order:lock");
      return tx<{ classid: string; objid: string; objsubid: number }[]>`
        SELECT classid::bigint::text AS classid, objid::bigint::text AS objid, objsubid
          FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
      `;
    });
    const [hash] = await sql<{ h: number }[]>`SELECT hashtext(${u.id!}::text || '/' || ${group.id}::text) AS h`;
    expect(held.map((r) => ({ ...r }))).toContainEqual({ classid: "74210036", objid: String(hash!.h >>> 0), objsubid: 2 });
    const lockAt = statements.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const lookupAt = statements.findIndex((s) => s.includes("FROM commerce.subscriptions"));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lookupAt).toBeGreaterThan(lockAt);
  });

  // The memory half is the regression (redeemCode no longer awaits between its check and use);
  // on PGlite the two transactions are serialised by the single session, as above.
  it("redeems one subscription code once under concurrent attempts", async () => {
    const { call, admin, register, store } = await bootstrap();
    const a = await register("redeem-a@integrity.test");
    const b = await register("redeem-b@integrity.test");
    const group = (
      await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name: "redeem-sub", platform: "anthropic", subscriptionType: "subscription" })
    ).body.group;
    const gen = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, {
      kind: "subscription",
      groupId: group.id,
      validityDays: 7,
    });
    const code = gen.body.items[0]!.code;
    const outcomes = await Promise.allSettled([store.ops.redeemCode(a.id, code), store.ops.redeemCode(b.id, code)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const subs = [...(await store.ops.listUserSubscriptions(a.id)), ...(await store.ops.listUserSubscriptions(b.id))];
    expect(subs).toHaveLength(1);
  });
});

describe("API keys (F29, F32)", () => {
  it("bulk-updates keys in one pass, reporting unknown and foreign ids in order", async () => {
    const { call, admin, register, spy, createKey } = await bootstrap();
    const owner = await register("bulk@integrity.test");
    const stranger = await register("stranger@integrity.test");
    const mine = [];
    for (let i = 0; i < 3; i++) mine.push((await createKey(owner.headers, { name: `k${i}` })).body.item);
    const theirs = (await createKey(stranger.headers, { name: "theirs" })).body.item;
    const lists = spy("listUserApiKeys");
    const bulk = await call<{ items: ApiKeyItem[]; failed: { keyId: string; message: string }[] }>("POST", "/api/v1/user/api-keys/bulk", owner.headers, {
      keyIds: [mine[2]!.id, "key_missing", mine[0]!.id, theirs.id, mine[1]!.id, mine[0]!.id],
      patch: { enabled: false, rpmLimit: 7 },
    });
    expect(bulk.status).toBe(200);
    expect(lists.calls).toBe(0);
    expect(bulk.body.items.map((k) => k.id)).toEqual([mine[2]!.id, mine[0]!.id, mine[1]!.id]);
    expect(bulk.body.items.every((k) => !k.enabled && k.rpmLimit === 7)).toBe(true);
    expect(bulk.body.failed.map((f) => f.keyId)).toEqual(["key_missing", theirs.id]);
    const strangerKeys = await call<{ items: ApiKeyItem[] }>("GET", "/api/v1/user/api-keys", stranger.headers);
    expect(strangerKeys.body.items[0]!.enabled).toBe(true);

    // Moving to an unavailable group fails per key, except for keys already in it.
    const off = (await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name: "off", platform: "anthropic" })).body.group;
    const moved = await call<{ items: ApiKeyItem[] }>("PATCH", `/api/v1/user/api-keys/${mine[0]!.id}`, owner.headers, { groupId: off.id });
    expect(moved.status).toBe(200);
    await call("PATCH", `/api/v1/admin/groups/${off.id}`, admin, { enabled: false });
    const move = await call<{ items: ApiKeyItem[]; failed: { keyId: string; message: string }[] }>("POST", "/api/v1/user/api-keys/bulk", owner.headers, {
      keyIds: [mine[0]!.id, mine[1]!.id],
      patch: { groupId: off.id, rpmLimit: 9 },
    });
    expect(move.body.items.map((k) => [k.id, k.rpmLimit])).toEqual([[mine[0]!.id, 9]]);
    expect(move.body.failed).toEqual([{ keyId: mine[1]!.id, message: `Group ${off.id} is unavailable` }]);
    expect((await call("PATCH", `/api/v1/user/api-keys/${mine[1]!.id}`, owner.headers, { groupId: off.id })).status).toBe(400);
    expect((await call("PATCH", `/api/v1/user/api-keys/key_missing`, owner.headers, { name: "x" })).status).toBe(404);
  });

  it("keeps four characters of a custom key, refuses collisions generically and budgets attempts", async () => {
    const { register, createKey } = await bootstrap();
    const alice = await register("custom-a@integrity.test");
    const bob = await register("custom-b@integrity.test");
    const first = await createKey(alice.headers, { customKey: "alice-chosen-key-2026" });
    expect(first.status).toBe(201);
    expect(first.body.item.keyPrefix).toBe("alic...");
    const theirs = await createKey(bob.headers, { customKey: "alice-chosen-key-2026" });
    const own = await createKey(alice.headers, { customKey: "alice-chosen-key-2026" });
    expect(theirs.status).toBe(409);
    expect(own.status).toBe(409);
    // Same answer whoever holds the key, and nothing beyond "can't be used".
    expect(theirs.body.message).toBe(own.body.message);
    expect(theirs.body.message).not.toContain("in use");
    for (let i = 0; i < 8; i++) expect((await createKey(alice.headers, { customKey: `alice-extra-key-${i}-abcdef` })).status).toBe(201);
    const over = await createKey(alice.headers, { customKey: "alice-one-too-many-key" });
    expect(over.status).toBe(429);
    // Generated keys are not budgeted and keep their sk-sg- prefix.
    const generated = await createKey(alice.headers, {});
    expect(generated.status).toBe(201);
    expect(generated.body.item.keyPrefix).toMatch(/^sk-sg-[0-9a-f]{6}\.\.\.[0-9a-f]{4}$/);
  });

  it.skipIf(!onPostgres)("shortens stored custom-key prefixes once, idempotently (Postgres migration)", async () => {
    const { store, register, createKey } = await bootstrap();
    const u = await register("legacy@integrity.test");
    const custom = (await createKey(u.headers, { customKey: "legacy-custom-key-0001" })).body.item;
    const generated = (await createKey(u.headers, {})).body.item;
    const sql = (store as unknown as { sql: Sql }).sql;
    await sql`UPDATE core.api_keys SET key_prefix = 'legacy-c...0001' WHERE id = ${custom.id}`;
    const migration = readFileSync(join(import.meta.dir, "../../../../migrations/commerce/0007_ops_integrity.sql"), "utf8");
    await sql.unsafe(migration);
    await sql.unsafe(migration);
    await sql.unsafe(PG_OPS_SCHEMA_SQL);
    const rows = await sql<{ id: string; key_prefix: string }[]>`SELECT id, key_prefix FROM core.api_keys WHERE user_id = ${u.id}`;
    const prefix = new Map(rows.map((r) => [r.id, r.key_prefix]));
    expect(prefix.get(custom.id)).toBe("lega...");
    expect(prefix.get(generated.id)).toBe(generated.keyPrefix);
  });
});

describe("memory/Postgres parity (F38, F39)", () => {
  it("refuses to delete users that payment orders or referral rebates still reference", async () => {
    const { call, admin, register, store } = await bootstrap();
    await call("PATCH", "/api/v1/admin/settings", admin, { affiliateEnabled: true });
    const referrer = await register("ref@integrity.test");
    const aff = await call<{ inviteCode: string }>("GET", "/api/v1/user/affiliate", referrer.headers);
    const buyer = await register("buyer@integrity.test", { affCode: aff.body.inviteCode });
    const loner = await register("loner@integrity.test");
    const order = await store.payments.createOrder({
      userId: buyer.id,
      kind: "recharge",
      planId: null,
      planName: "Top-up",
      provider: "manual",
      method: null,
      amountMinor: 1000,
      currency: "USD",
      creditNano: 10n * NANO,
      groupId: null,
      validityDays: null,
      expiresAtIso: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const paid = await store.payments.fulfillOrder(order.id, null, { enabled: true, bps: 1000 });
    expect(paid.delivered).toBe(true);

    const delBuyer = await call<{ message: string }>("DELETE", `/api/v1/admin/users/${buyer.id}`, admin);
    expect(delBuyer.status).toBe(409);
    expect(delBuyer.body.message).toBe("This user has payment orders; suspend the account instead");
    const delReferrer = await call<{ message: string }>("DELETE", `/api/v1/admin/users/${referrer.id}`, admin);
    expect(delReferrer.status).toBe(409);
    expect(delReferrer.body.message).toBe("This user has earned referral rebates; suspend the account instead");
    expect((await call("DELETE", `/api/v1/admin/users/${loner.id}`, admin)).status).toBe(200);
    expect(await store.getUserById(buyer.id)).not.toBeNull();
  });

  it("reports the real window spend of expired and revoked subscriptions", async () => {
    const { call, admin, register, settle, account } = await bootstrap();
    const u = await register("lapsed@integrity.test");
    const group = (
      await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, {
        name: "capped-sub",
        platform: "anthropic",
        subscriptionType: "subscription",
        dailyLimitUsd: "0.000001",
      })
    ).body.group;
    const acc = await account(group.id);
    const assigned = await call<{ items: UserSubscriptionItem[] }>("POST", "/api/v1/admin/subscriptions/assign", admin, {
      userIds: [u.id],
      groupId: group.id,
      validityDays: 30,
    });
    const subId = assigned.body.items[0]!.id;
    await settle({ userId: u.id, apiKeyId: "key_sub", groupId: group.id, accountId: acc, costNanoUsd: "5000" });
    await call("PATCH", `/api/v1/admin/subscriptions/${subId}`, admin, { action: "revoke" });
    const revoked = await call<{ items: UserSubscriptionItem[] }>("GET", `/api/v1/admin/subscriptions?status=revoked`, admin);
    const row = revoked.body.items.find((s) => s.id === subId)!;
    expect(row.status).toBe("revoked");
    expect(row.usage).toEqual({ dailyNanoUsd: "5000", weeklyNanoUsd: "5000", monthlyNanoUsd: "5000" });
    expect(row.overLimit).toBe(true);
    const mine = await call<{ items: UserSubscriptionItem[] }>("GET", "/api/v1/user/subscriptions", u.headers);
    expect(mine.body.items[0]!.usage.dailyNanoUsd).toBe("5000");
  });
});
