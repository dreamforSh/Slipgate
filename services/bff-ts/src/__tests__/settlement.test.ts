import { afterEach, describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type { ApiKeyItem, DataPlaneSyncSnapshot, GroupItem, UsagePageResponse, WalletSummary } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { builtinTurnCostNano, priceTurn, repriceSettlement } from "../routes/pricing.ts";
import { CoalescingRunner, KeyedThrottle } from "../settlement_guards.ts";
import {
  backfillWalletSpend,
  ensureUsageLogIndexes,
  PG_SETTLEMENT_SCHEMA_SQL,
  pruneSettlementIds,
  runWithShortLockWait,
} from "../store/postgres_settlement.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "settle-internal-token";
const INTERNAL_HEADERS = { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL };

/**
 * `bun test --preload <pglite preload>` installs a factory returning a fresh Postgres-backed store,
 * so the same cases exercise PostgresControlStore's SQL; without it they run on the memory store.
 */
type StoreFactory = () => Promise<ControlStore>;
const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
type Sql = ReturnType<typeof postgres>;
const sqlOf = (store: ControlStore) => (store as unknown as { sql: Sql }).sql;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function bootstrap() {
  const store: ControlStore = factory ? await factory() : new (await import("../store/memory_store.ts")).MemoryControlStore();
  const app = createBffApp({
    store,
    jwtSecret: "settle-test-jwt-secret-32-bytes-minimum",
    vaultSecret: "settle-test-vault-secret-32-bytes-minimum",
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
    siteName: "Settle Test",
    adminEmail: "admin@settle.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  const register = async (email: string, balanceUsd = "1") => {
    const res = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email,
      password: "UserPassword123!",
    });
    expect(res.status).toBe(201);
    const id = res.body.user.id;
    await call("POST", `/api/v1/admin/users/${id}/balance`, admin, { operation: "set", amountUsd: balanceUsd });
    return { id, headers: { ...JSON_HEADERS, Authorization: `Bearer ${res.body.accessToken}` } };
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
  const defaultAccount = await account("grp_default");
  const createKey = async (headers: Record<string, string>, body: Record<string, unknown> = {}) => {
    const res = await call<{ item: ApiKeyItem }>("POST", "/api/v1/user/api-keys", headers, { groupId: "grp_default", name: "k", ...body });
    expect(res.status).toBe(201);
    return res.body.item;
  };
  const settle = async (ev: Record<string, unknown>) =>
    call<{ ok: boolean; duplicate: boolean; settlementId: string; appliedAtUnixMs: number; item: { id: string; costNanoUsd: string } }>(
      "POST",
      "/api/v1/internal/dataplane/settlement",
      INTERNAL_HEADERS,
      {
        accountId: defaultAccount,
        groupId: "grp_default",
        platform: "anthropic",
        publicModel: "claude-sonnet-5-5",
        upstreamModel: "claude-sonnet-5-5",
        ingressCodec: "anthropic_messages",
        egressCodec: "anthropic_messages",
        inputTokens: 100,
        outputTokens: 50,
        statusCode: 200,
        ...ev,
      },
    );
  const wallet = async (headers: Record<string, string>) =>
    BigInt((await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", headers)).body.wallet.balanceNanoUsd);
  const usage = async (headers: Record<string, string>) =>
    (await call<UsagePageResponse>("GET", "/api/v1/user/usage/query?pageSize=100", headers)).body.items;
  return { app, store, call, admin, register, account, createKey, settle, wallet, usage, defaultAccount };
}

/** Captures data-plane pushes on a local stand-in for slipgate-net. */
async function fakeNet() {
  const pushes: DataPlaneSyncSnapshot[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname === "/internal/net/dataplane/sync") pushes.push((await req.json()) as DataPlaneSyncSnapshot);
      return Response.json({ ok: true });
    },
  });
  const previous = process.env.SLIPGATE_NET_INTERNAL_URL;
  process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${server.port}`;
  return {
    pushes,
    stop: () => {
      if (previous === undefined) delete process.env.SLIPGATE_NET_INTERNAL_URL;
      else process.env.SLIPGATE_NET_INTERNAL_URL = previous;
      server.stop(true);
    },
  };
}

let stopNet: (() => void) | null = null;
afterEach(() => {
  stopNet?.();
  stopNet = null;
});

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(50);
  }
  return false;
}

describe("settlement idempotency (F00/F06)", () => {
  it("bills every turn that reuses a client X-Request-Id and dedupes only on the server-minted settlement id", async () => {
    const { call, register, createKey, settle, wallet, usage } = await bootstrap();
    const eve = await register("eve@settle.test", "1");
    const key = await createKey(eve.headers);
    const base = { userId: eve.id, apiKeyId: key.id, requestId: "abcd", costNanoUsd: "1000000" };

    // Same client request id on three different turns: three charges.
    for (const sid of ["stl_turn_000001", "stl_turn_000002", "stl_turn_000003"]) {
      const res = await settle({ ...base, settlementId: sid });
      expect(res.status).toBe(200);
      expect(res.body.duplicate).toBe(false);
    }
    expect(await wallet(eve.headers)).toBe(1_000_000_000n - 3_000_000n);

    // A redelivery of one of them is a no-op that points at the original usage row.
    const first = (await usage(eve.headers)).find((r) => r.requestId === "abcd");
    const again = await settle({ ...base, settlementId: "stl_turn_000002" });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(await wallet(eve.headers)).toBe(1_000_000_000n - 3_000_000n);
    const rows = await usage(eve.headers);
    expect(rows.filter((r) => r.requestId === "abcd")).toHaveLength(3);
    expect(first).toBeDefined();

    // Older edges without a settlement id are never deduped: each delivery is charged.
    await settle({ ...base, requestId: "legacy" });
    await settle({ ...base, requestId: "legacy" });
    expect(await wallet(eve.headers)).toBe(1_000_000_000n - 5_000_000n);

    // Key spend (lifetime quota) follows the same rule.
    const listed = (await call<{ items: ApiKeyItem[] }>("GET", "/api/v1/user/api-keys", eve.headers)).body.items;
    expect(listed.find((k) => k.id === key.id)!.spentNanoUsd).toBe("5000000");
  });

  it("charges a concurrently redelivered settlement exactly once", async () => {
    const { register, createKey, settle, wallet, usage } = await bootstrap();
    const fay = await register("fay@settle.test", "1");
    const key = await createKey(fay.headers);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        settle({ settlementId: "stl_race_000001", requestId: "race", userId: fay.id, apiKeyId: key.id, costNanoUsd: "7000000" }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.body.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.item.id)).size).toBe(1);
    expect(await wallet(fay.headers)).toBe(1_000_000_000n - 7_000_000n);
    expect((await usage(fay.headers)).filter((r) => r.requestId === "race")).toHaveLength(1);
  });

  it("bills a turn whose optional pricing dimensions are malformed instead of rejecting it", async () => {
    const { register, createKey, settle, wallet, usage } = await bootstrap();
    const gus = await register("gus@settle.test", "1");
    const key = await createKey(gus.headers);
    const before = Date.now();
    const res = await settle({
      settlementId: "stl_malformed_01",
      requestId: "malformed",
      userId: gus.id,
      apiKeyId: key.id,
      costNanoUsd: "3000000",
      serviceTier: "x".repeat(64),
      reasoningEffort: "y".repeat(64),
      window5hUsedBps: 12_000,
    });
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(false);
    // net-go relays this to slipgate-core: snapshots read from then on carry the debit.
    expect(res.body.appliedAtUnixMs).toBeGreaterThanOrEqual(before);
    expect(await wallet(gus.headers)).toBe(1_000_000_000n - 3_000_000n);
    expect((await usage(gus.headers)).filter((r) => r.requestId === "malformed")).toHaveLength(1);
  });

  it("shows and replays slipgate-net's dead-lettered settlements for administrators only", async () => {
    const { call, admin, register } = await bootstrap();
    const seen: { path: string; method: string; token: string | null }[] = [];
    let parked = 2;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push({ path, method: req.method, token: req.headers.get("X-Slipgate-Internal-Token") });
        if (path === "/internal/net/dataplane/settlements/dead-letter") return Response.json({ count: parked });
        if (path === "/internal/net/dataplane/settlements/dead-letter/replay") {
          const replayed = parked;
          parked = 0;
          return Response.json({ replayed });
        }
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    });
    const prev = { url: process.env.SLIPGATE_NET_INTERNAL_URL, token: process.env.SLIPGATE_INTERNAL_TOKEN };
    process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${server.port}`;
    process.env.SLIPGATE_INTERNAL_TOKEN = "dead-letter-token";
    stopNet = () => {
      for (const [key, value] of [["SLIPGATE_NET_INTERNAL_URL", prev.url], ["SLIPGATE_INTERNAL_TOKEN", prev.token]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      server.stop(true);
    };

    const deadLetterCalls = () => seen.filter((s) => s.path.includes("/dead-letter"));
    const member = await register("ida@settle.test");
    expect((await call("GET", "/api/v1/admin/ops/settlement-dead-letters", member.headers)).status).toBe(403);
    expect(deadLetterCalls()).toHaveLength(0);

    const listed = await call<{ count: number }>("GET", "/api/v1/admin/ops/settlement-dead-letters", admin);
    expect(listed.status).toBe(200);
    expect(listed.body.count).toBe(2);
    const replay = await call<{ replayed: number }>("POST", "/api/v1/admin/ops/settlement-dead-letters/replay", admin);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(2);
    expect((await call<{ count: number }>("GET", "/api/v1/admin/ops/settlement-dead-letters", admin)).body.count).toBe(0);
    expect(deadLetterCalls().every((s) => s.token === "dead-letter-token")).toBe(true);
    expect(deadLetterCalls().map((s) => `${s.method} ${s.path}`)).toContain("POST /internal/net/dataplane/settlements/dead-letter/replay");
  });

  it("still bills a turn whose upstream account was deleted while it was in flight", async () => {
    const { register, createKey, settle, wallet } = await bootstrap();
    const ivo = await register("ivo@settle.test", "1");
    const key = await createKey(ivo.headers);
    const res = await settle({
      settlementId: "stl_gone_000001",
      requestId: "gone",
      userId: ivo.id,
      apiKeyId: key.id,
      accountId: "acc_deleted_mid_turn",
      costNanoUsd: "4000000",
    });
    expect(res.status).toBe(200);
    expect(await wallet(ivo.headers)).toBe(1_000_000_000n - 4_000_000n);
  });

  it("rejects a malformed settlement id", async () => {
    const { register, createKey, settle } = await bootstrap();
    const gus = await register("gus@settle.test");
    const key = await createKey(gus.headers);
    const res = await settle({ settlementId: "x", requestId: "r", userId: gus.id, apiKeyId: key.id, costNanoUsd: "1" });
    expect(res.status).toBe(400);
  });
});

describe("turns the core could not settle (F05)", () => {
  it("prices coreSettled=false turns from the matching rule or the built-in rates instead of recording them free", async () => {
    const { call, admin, register, createKey, settle, usage } = await bootstrap();
    const hal = await register("hal@settle.test", "1");
    const key = await createKey(hal.headers);
    const common = { userId: hal.id, apiKeyId: key.id, costNanoUsd: "0", coreSettled: false, inputTokens: 1000, outputTokens: 500 };

    // No rule: the core's built-in claude-* rate (3000 / 15000 nano-USD per token).
    await settle({ ...common, settlementId: "stl_unsettled_01", requestId: "u1" });
    // Token counting stays free even when the core did not settle it.
    await settle({ ...common, settlementId: "stl_unsettled_02", requestId: "u2", ingressCodec: "anthropic_count_tokens" });
    // A charged turn the core did settle keeps its cost.
    await settle({ ...common, settlementId: "stl_unsettled_03", requestId: "u3", coreSettled: true, costNanoUsd: "0" });

    expect((await call("POST", "/api/v1/admin/pricing", admin, { pattern: "claude-*", inputPerMTokUsd: "2", outputPerMTokUsd: "10" })).status).toBe(201);
    await settle({ ...common, settlementId: "stl_unsettled_04", requestId: "u4" });

    const byId = new Map((await usage(hal.headers)).map((r) => [r.requestId, r.costNanoUsd]));
    expect(byId.get("u1")).toBe((1000n * 3000n + 500n * 15000n).toString());
    expect(byId.get("u2")).toBe("0");
    expect(byId.get("u3")).toBe("0");
    // (1000 × $2 + 500 × $10) / 1M = $0.007
    expect(byId.get("u4")).toBe("7000000");
  });

  it("keeps the built-in fallback equal to the core's table", () => {
    const ev = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 40 };
    // gateway.zig: in + out + cacheRead × in / 10 + cacheWrite × in × 5 / 4, × multiplier.
    expect(builtinTurnCostNano("claude-opus-5-5", ev, 1)).toBe(100n * 15000n + 50n * 75000n + 1_500_000n + 750_000n);
    expect(builtinTurnCostNano("unknown-model", ev, 2)).toBe((100n * 1000n + 50n * 4000n + 100_000n + 50_000n) * 2n);
    const unsettled = {
      requestId: "r",
      userId: "u",
      apiKeyId: "k",
      accountId: "a",
      groupId: "g",
      platform: "anthropic" as const,
      publicModel: "m",
      upstreamModel: "gpt-4o-mini",
      ingressCodec: "openai_chat",
      egressCodec: "openai_chat",
      inputTokens: 10,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costNanoUsd: "0",
      ttftMs: 0,
      durationMs: 0,
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      statusCode: 502,
      coreSettled: false,
    };
    // A failed upstream that still reported tokens is billed, like the core would.
    expect(repriceSettlement(unsettled, [], 1).costNanoUsd).toBe("1500");
    expect(repriceSettlement({ ...unsettled, inputTokens: 0 }, [], 1).costNanoUsd).toBe("0");
  });

  it("prices the shared rule vector exactly as gateway.zig's price-rule test expects", () => {
    // Mirror of gateway.zig `snapshot price rules drive the hold and the settled cost exactly like
    // the BFF's priceTurn`: change both together. The core must hold 18000000 and settle 6000000.
    const rule = {
      id: "r",
      pattern: "o3*",
      inputNanoPerMTok: "10000000000",
      outputNanoPerMTok: "40000000000",
      cacheReadNanoPerMTok: "1000000000",
      cacheWriteNanoPerMTok: "12500000000",
      enabled: true,
      notes: "",
      updatedAtIso: new Date(0).toISOString(),
    };
    const turn = {
      requestId: "r",
      userId: "usr_1",
      apiKeyId: "key_1",
      accountId: "acc_1",
      groupId: "grp_default",
      platform: "openai" as const,
      publicModel: "o3-mini",
      upstreamModel: "o3-mini",
      ingressCodec: "openai_chat",
      egressCodec: "openai_chat",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      // What the core reported (its own valuation); the BFF bill must not depend on it.
      costNanoUsd: "6000000",
      ttftMs: 0,
      durationMs: 0,
      window5hUsedBps: 0,
      window7dUsedBps: 0,
      statusCode: 200,
      coreSettled: true,
    };
    // Hold: estimated input 100 and maxTokens 200 at the rule price, group multiplier 2.
    expect(priceTurn(rule, { inputTokens: 100, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 }, 2)).toBe(18_000_000n);
    // Settle: the BFF's bill equals the core's settledCostNanoUsd for the same rule and multiplier.
    expect(repriceSettlement(turn, [rule], 2).costNanoUsd).toBe("6000000");
    expect(repriceSettlement({ ...turn, costNanoUsd: "1" }, [rule], 2).costNanoUsd).toBe("6000000");
  });
});

describe("settlement-path cap checks (F01/F02/F28)", () => {
  it("checks only the settled key, with the same verdict as the key list", async () => {
    const { store, register, createKey, settle, call } = await bootstrap();
    const ida = await register("ida@settle.test", "10");
    const quotaOnly = await createKey(ida.headers, { name: "quota", quotaUsd: "0.000005" });
    const window5h = await createKey(ida.headers, { name: "w5h", limit5hUsd: "0.000003" });
    const window7d = await createKey(ida.headers, { name: "w7d", limit7dUsd: "0.000100" });
    const open = await createKey(ida.headers, { name: "open" });

    let listCalls = 0;
    let stateCalls = 0;
    const realList = store.listUserApiKeys.bind(store);
    const realState = store.getApiKeyLimitState.bind(store);
    store.listUserApiKeys = async (userId) => {
      listCalls++;
      return realList(userId);
    };
    store.getApiKeyLimitState = async (keyId) => {
      stateCalls++;
      return realState(keyId);
    };

    let n = 0;
    for (const k of [quotaOnly, window5h, window7d, open]) {
      await settle({ settlementId: `stl_caps_${String(++n).padStart(6, "0")}`, requestId: `c${n}`, userId: ida.id, apiKeyId: k.id, costNanoUsd: "6000" });
    }
    expect(listCalls).toBe(0);
    // Uncapped keys never reach the check.
    expect(stateCalls).toBe(3);
    store.listUserApiKeys = realList;
    store.getApiKeyLimitState = realState;

    const listed = (await call<{ items: ApiKeyItem[] }>("GET", "/api/v1/user/api-keys", ida.headers)).body.items;
    for (const k of listed) expect(await store.getApiKeyLimitState(k.id)).toBe(k.limitState);
    expect(listed.find((k) => k.id === quotaOnly.id)!.limitState).toBe("quota_exhausted");
    expect(listed.find((k) => k.id === window5h.id)!.limitState).toBe("window_exhausted");
    expect(listed.find((k) => k.id === window7d.id)!.limitState).toBe("ok");
    expect(listed.find((k) => k.id === open.id)!.limitState).toBe("ok");
    expect((await store.listOverLimitKeyIds()).sort()).toEqual([quotaOnly.id, window5h.id].sort());
    expect(await store.getApiKeyLimitState("key_missing")).toBeNull();

    // Window reset frees the window cap; spend at the reset instant belongs to the old window.
    await call("PATCH", `/api/v1/user/api-keys/${window5h.id}`, ida.headers, { resetWindows: true });
    expect(await store.getApiKeyLimitState(window5h.id)).toBe("ok");
    expect(await store.listOverLimitKeyIds()).toEqual([quotaOnly.id]);
  });

  it("detects a cap crossed between throttled checks with the trailing run and pushes the paused key", async () => {
    const net = await fakeNet();
    stopNet = net.stop;
    const { store, register, createKey, settle } = await bootstrap();
    const jay = await register("jay@settle.test", "1");
    const key = await createKey(jay.headers, { quotaUsd: "0.000005" });
    let stateCalls = 0;
    const realState = store.getApiKeyLimitState.bind(store);
    store.getApiKeyLimitState = async (keyId) => {
      stateCalls++;
      return realState(keyId);
    };
    net.pushes.length = 0;
    for (let i = 1; i <= 3; i++) {
      await settle({ settlementId: `stl_burst_${String(i).padStart(6, "0")}`, requestId: `b${i}`, userId: jay.id, apiKeyId: key.id, costNanoUsd: "2000" });
    }
    // The first settlement is checked at once (still under the cap); the next two fold into one trailing check.
    expect(stateCalls).toBe(1);
    const paused = await until(() => net.pushes.some((s) => s.apiKeys.find((k) => k.id === key.id)?.enabled === false), 5000);
    expect(paused).toBe(true);
    expect(stateCalls).toBe(2);
  });

  it("checks the entitlement for capped and uncapped subscription groups alike", async () => {
    const { store, call, admin, register, account, createKey, settle } = await bootstrap();
    const kai = await register("kai@settle.test", "1");
    const mkGroup = async (name: string, dailyLimitUsd: string) =>
      (await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name, platform: "anthropic", subscriptionType: "subscription", dailyLimitUsd }))
        .body.group;
    const capped = await mkGroup("sub-capped", "0.001");
    const open = await mkGroup("sub-open", "0");
    for (const g of [capped, open]) {
      await call("POST", "/api/v1/admin/subscriptions/assign", admin, { emails: ["kai@settle.test"], groupId: g.id, validityDays: 30 });
    }
    const cappedKey = await createKey(kai.headers, { groupId: capped.id });
    const openKey = await createKey(kai.headers, { groupId: open.id });
    const cappedAcc = await account(capped.id);
    const openAcc = await account(open.id);

    const checked: string[] = [];
    const real = store.ops.isSubscriptionOverLimit.bind(store.ops);
    store.ops.isSubscriptionOverLimit = async (userId, groupId) => {
      checked.push(groupId);
      return real(userId, groupId);
    };
    await settle({ settlementId: "stl_sub_000001", requestId: "s1", userId: kai.id, apiKeyId: openKey.id, groupId: open.id, accountId: openAcc, costNanoUsd: "5000" });
    await settle({ settlementId: "stl_sub_000002", requestId: "s2", userId: kai.id, apiKeyId: cappedKey.id, groupId: capped.id, accountId: cappedAcc, costNanoUsd: "5000" });
    // The uncapped group is checked too (an expired subscription must be caught there as well);
    // its check sums no usage (see the Postgres plan test below).
    expect(checked).toEqual([open.id, capped.id]);
    store.ops.isSubscriptionOverLimit = real;
  });

  it("pushes disabled keys right after a settlement in an uncapped group whose subscription expired", async () => {
    const net = await fakeNet();
    stopNet = net.stop;
    const { store, call, admin, register, account, createKey, settle } = await bootstrap();
    const lea = await register("lea@settle.test", "1");
    const open = (
      await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name: "sub-open-exp", platform: "anthropic", subscriptionType: "subscription", dailyLimitUsd: "0" })
    ).body.group;
    await call("POST", "/api/v1/admin/subscriptions/assign", admin, { emails: ["lea@settle.test"], groupId: open.id, validityDays: 30 });
    const key = await createKey(lea.headers, { groupId: open.id });
    const acc = await account(open.id);
    // The subscription runs out between snapshot pulls.
    if (factory) {
      await sqlOf(store)`UPDATE commerce.subscriptions SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = ${lea.id} AND group_id = ${open.id}`;
    } else {
      const subs = (store.ops as unknown as { subs: Map<string, { userId: string; groupId: string; expiresAtIso: string }> }).subs;
      for (const s of subs.values()) if (s.userId === lea.id && s.groupId === open.id) s.expiresAtIso = new Date(Date.now() - 1000).toISOString();
    }
    net.pushes.length = 0;
    await settle({ settlementId: "stl_subexp_00001", requestId: "e1", userId: lea.id, apiKeyId: key.id, groupId: open.id, accountId: acc, costNanoUsd: "5000" });
    const disabled = await until(() => net.pushes.some((s) => s.apiKeys.find((k) => k.id === key.id)?.enabled === false), 5000);
    expect(disabled).toBe(true);
  });
});

describe("price rules reach the data plane (F16)", () => {
  it("ships enabled rules in the snapshot and pushes the real balance when a repriced turn leaves the wallet low", async () => {
    const net = await fakeNet();
    stopNet = net.stop;
    const { call, admin, register, createKey, settle, wallet } = await bootstrap();
    const created = await call<{ item: { id: string } }>("POST", "/api/v1/admin/pricing", admin, {
      pattern: "o3*",
      inputPerMTokUsd: "10",
      outputPerMTokUsd: "40",
    });
    expect(created.status).toBe(201);
    await call("POST", "/api/v1/admin/pricing", admin, { pattern: "off-*", inputPerMTokUsd: "1", outputPerMTokUsd: "1", enabled: false });
    // The rule edit itself pushed a snapshot carrying the enabled rules only.
    expect(await until(() => net.pushes.length > 0)).toBe(true);
    const pulled = await call<DataPlaneSyncSnapshot>("GET", "/api/v1/internal/dataplane/snapshot", { "X-Slipgate-Internal-Token": INTERNAL });
    expect(pulled.body.priceRules).toEqual([
      { pattern: "o3*", inputNanoPerMTok: "10000000000", outputNanoPerMTok: "40000000000", cacheReadNanoPerMTok: "1000000000", cacheWriteNanoPerMTok: "12500000000" },
    ]);

    const rich = await register("rich@settle.test", "100");
    const poor = await register("poor@settle.test", "0.05");
    const richKey = await createKey(rich.headers);
    const poorKey = await createKey(poor.headers);
    await sleep(300);
    net.pushes.length = 0;

    // The core valued the turn at its $1/$4 default; the rule makes it 10x: (1000×$10 + 500×$40)/1M = $0.03.
    const turn = { publicModel: "o3-mini", upstreamModel: "o3-mini", inputTokens: 1000, outputTokens: 500, costNanoUsd: "3000000" };
    await settle({ ...turn, settlementId: "stl_price_000001", requestId: "p1", userId: rich.id, apiKeyId: richKey.id });
    await sleep(600);
    expect(net.pushes).toHaveLength(0);
    expect(await wallet(rich.headers)).toBe(100_000_000_000n - 30_000_000n);

    await settle({ ...turn, settlementId: "stl_price_000002", requestId: "p2", userId: poor.id, apiKeyId: poorKey.id });
    expect(await wallet(poor.headers)).toBe(50_000_000n - 30_000_000n);
    expect(await until(() => net.pushes.length > 0, 2000)).toBe(true);
    expect(net.pushes.at(-1)!.wallets.find((w) => w.userId === poor.id)?.balanceNanoUsd).toBe("20000000");
  });
});

describe("data-plane sync coalescing (F07)", () => {
  it("serves bursts of writes with at most one running and one trailing export, and the last push has every write", async () => {
    const net = await fakeNet();
    stopNet = net.stop;
    const { store, register, createKey } = await bootstrap();
    const lea = await register("lea@settle.test");
    let exports = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    const real = store.exportDataPlaneSnapshot.bind(store);
    store.exportDataPlaneSnapshot = async () => {
      exports++;
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        await sleep(400);
        return await real();
      } finally {
        concurrent--;
      }
    };
    net.pushes.length = 0;
    const keys = await Promise.all(Array.from({ length: 20 }, (_, i) => createKey(lea.headers, { name: `burst-${i}` })));
    expect(maxConcurrent).toBe(1);
    expect(exports).toBeLessThanOrEqual(3);
    const last = net.pushes.at(-1)!;
    for (const k of keys) expect(last.apiKeys.some((a) => a.id === k.id)).toBe(true);
    store.exportDataPlaneSnapshot = real;
  });

  it("CoalescingRunner folds requests into one trailing run that starts after them", async () => {
    let runs = 0;
    let observed = 0;
    let value = 0;
    const runner = new CoalescingRunner(async () => {
      runs++;
      await sleep(30);
      observed = value;
    });
    const first = runner.request();
    value = 1;
    const rest = Array.from({ length: 10 }, () => runner.request());
    value = 2;
    await Promise.all([first, ...rest]);
    expect(runs).toBe(2);
    expect(observed).toBe(2);
    await runner.request();
    expect(runs).toBe(3);
  });

  it("KeyedThrottle runs at most once per interval per key and never drops the last request", async () => {
    const throttle = new KeyedThrottle(100);
    const runs: number[] = [];
    let counter = 0;
    for (let i = 0; i < 5; i++) {
      counter = i;
      await throttle.request("k", async () => {
        runs.push(counter);
      });
    }
    expect(runs).toEqual([0]);
    await sleep(250);
    expect(runs).toEqual([0, 4]);
    await sleep(250);
    expect(throttle.size).toBe(0);
  });
});

describe("API key update group check (F37)", () => {
  it("accepts a patch that repeats the key's current, now-disabled group and rejects moving into one", async () => {
    const { call, admin, register, createKey } = await bootstrap();
    const mia = await register("mia@settle.test");
    const mk = async (name: string) =>
      (await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name, platform: "anthropic" })).body.group;
    const home = await mk("home-group");
    const other = await mk("other-group");
    const key = await createKey(mia.headers, { groupId: home.id });
    for (const g of [home, other]) expect((await call("PATCH", `/api/v1/admin/groups/${g.id}`, admin, { enabled: false })).status).toBe(200);

    const same = await call<{ item: ApiKeyItem }>("PATCH", `/api/v1/user/api-keys/${key.id}`, mia.headers, { groupId: home.id, enabled: false });
    expect(same.status).toBe(200);
    expect(same.body.item.enabled).toBe(false);
    expect((await call("PATCH", `/api/v1/user/api-keys/${key.id}`, mia.headers, { groupId: other.id })).status).toBe(400);
    expect((await call("PATCH", "/api/v1/user/api-keys/key_missing", mia.headers, { groupId: other.id })).status).toBe(404);
  });
});

describe("usage_logs index DDL lock waits (F27)", () => {
  it("runs lock-heavy index DDL with a short lock wait and retries lock timeouts", async () => {
    const statements: string[] = [];
    let failures = 2;
    const stub = {
      unsafe: async (statement: string) => {
        statements.push(statement);
        if (statement.startsWith("ALTER INDEX") && failures-- > 0) throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
        return [];
      },
    };
    await runWithShortLockWait(stub, "ALTER INDEX core.p ATTACH PARTITION core.c", { retryDelayMs: 1 });
    expect(statements).toEqual([
      "SET lock_timeout = '3s'",
      "ALTER INDEX core.p ATTACH PARTITION core.c",
      "RESET lock_timeout",
      "SET lock_timeout = '3s'",
      "ALTER INDEX core.p ATTACH PARTITION core.c",
      "RESET lock_timeout",
      "SET lock_timeout = '3s'",
      "ALTER INDEX core.p ATTACH PARTITION core.c",
      "RESET lock_timeout",
    ]);
    // Out of attempts, or any other error: thrown (the maintenance job logs it and retries next start).
    failures = 5;
    await expect(runWithShortLockWait(stub, "ALTER INDEX core.p ATTACH PARTITION core.c", { attempts: 2, retryDelayMs: 1 })).rejects.toThrow("lock timeout");
    expect(statements.at(-1)).toBe("RESET lock_timeout");
  });
});

describe.skipIf(!factory)("Postgres settlement maintenance", () => {
  it("serves the settlement-path sums from the covering indexes (index-only scans)", async () => {
    const { store } = await bootstrap();
    const sql = sqlOf(store);
    const conn = await sql.reserve();
    try {
      await conn.unsafe("SET enable_seqscan = off");
      await conn.unsafe("SET enable_bitmapscan = off");
      const plan = async (q: string) => (await conn.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${q}`)).map((r) => r["QUERY PLAN"]).join("\n");
      const keyPlan = await plan(`
        SELECT SUM(l.cost_nano_usd) FROM core.usage_logs l
         WHERE l.api_key_id = 'key_x' AND l.created_at >= NOW() - INTERVAL '7 days'`);
      // Partition indexes are named by Postgres on fresh installs and by the BFF elsewhere.
      expect(keyPlan).toContain("Index Only Scan");
      expect(keyPlan).toMatch(/api_key_id_created_at_cost_nano_usd_idx|key_time_cost/);
      const subPlan = await plan(`
        SELECT SUM(l.cost_nano_usd) FROM core.usage_logs l
         WHERE l.user_id = 'usr_x' AND l.group_id = 'grp_x' AND l.created_at >= NOW() - INTERVAL '30 days'`);
      expect(subPlan).toContain("Index Only Scan");
      expect(subPlan).toMatch(/user_id_group_id_created_at_cost_nano_us\w*_idx|user_group_time_cost/);
      const dedupePlan = await plan(`SELECT usage_id FROM core.settlement_ids WHERE settlement_id = 'stl_x'`);
      expect(dedupePlan).toContain("settlement_ids_pkey");
      expect(await plan(`SELECT COUNT(*) FROM core.api_keys WHERE group_id = 'grp_x'`)).toContain("idx_core_api_keys_group");
    } finally {
      conn.release();
    }
  });

  it("prunes settlement ids past the retention only", async () => {
    const { store } = await bootstrap();
    const sql = sqlOf(store);
    await sql`
      INSERT INTO core.settlement_ids (settlement_id, usage_id, usage_created_at, created_at) VALUES
        ('stl_old_1', 'usg_1', NOW() - INTERVAL '9 days', NOW() - INTERVAL '9 days'),
        ('stl_old_2', 'usg_2', NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days'),
        ('stl_new_1', 'usg_3', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
    `;
    expect(await pruneSettlementIds(sql, { retentionDays: 7, batch: 1 })).toEqual({ deleted: 2, backlog: false });
    const left = await sql<{ settlement_id: string }[]>`SELECT settlement_id FROM core.settlement_ids WHERE settlement_id LIKE 'stl_%_1' OR settlement_id LIKE 'stl_old_%'`;
    expect(left.map((r) => r.settlement_id)).toEqual(["stl_new_1"]);
  });

  it("prunes an expired backlog larger than any fixed number of rounds, and reports what a spent budget left", async () => {
    const { store } = await bootstrap();
    const sql = sqlOf(store);
    // 50 rounds x batch was the old ceiling per run; this backlog is 3x that.
    await sql`
      INSERT INTO core.settlement_ids (settlement_id, usage_id, usage_created_at, created_at)
      SELECT 'stl_bk_' || i, 'usg_' || i, NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days' - i * INTERVAL '1 second'
        FROM generate_series(1, 300) i
    `;
    await sql`INSERT INTO core.settlement_ids (settlement_id, usage_id, usage_created_at) VALUES ('stl_bk_fresh', 'usg_f', NOW())`;
    // A spent budget stops after the batch in progress and says more is left.
    expect(await pruneSettlementIds(sql, { batch: 2, budgetMs: 0 })).toEqual({ deleted: 2, backlog: true });
    expect(await pruneSettlementIds(sql, { batch: 2 })).toEqual({ deleted: 298, backlog: false });
    const left = await sql<{ settlement_id: string }[]>`SELECT settlement_id FROM core.settlement_ids WHERE settlement_id LIKE 'stl_bk_%'`;
    expect(left.map((r) => r.settlement_id)).toEqual(["stl_bk_fresh"]);
  });

  it("prunes from the settlement path every few minutes, not hourly, and comes back soon for a backlog", async () => {
    const { store, register, createKey, settle } = await bootstrap();
    const sql = sqlOf(store);
    const pg = store as unknown as { settlementPruneAt: number; settlementPruneRunning: boolean };
    const max = await register("max@settle.test", "1");
    const key = await createKey(max.headers);
    await sql`
      INSERT INTO core.settlement_ids (settlement_id, usage_id, usage_created_at, created_at)
      SELECT 'stl_sp_' || i, 'usg_' || i, NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'
        FROM generate_series(1, 50) i
    `;
    pg.settlementPruneAt = 0;
    const before = Date.now();
    await settle({ settlementId: "stl_prune_00001", requestId: "p1", userId: max.id, apiKeyId: key.id, costNanoUsd: "1000" });
    expect(await until(async () => (await sql`SELECT 1 FROM core.settlement_ids WHERE settlement_id LIKE 'stl_sp_%'`).length === 0)).toBe(true);
    expect(await until(() => !pg.settlementPruneRunning)).toBe(true);
    // Next run in about five minutes (the old cadence was an hour).
    expect(pg.settlementPruneAt - before).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    expect(pg.settlementPruneAt - before).toBeLessThanOrEqual(5 * 60_000 + 60_000);
  });

  it("does not run the usage sums of an uncapped subscription group at all", async () => {
    const { store, call, admin, register } = await bootstrap();
    const sql = sqlOf(store);
    const ivy = await register("ivy@settle.test", "1");
    const open = (
      await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, { name: "sub-open-plan", platform: "anthropic", subscriptionType: "subscription", dailyLimitUsd: "0" })
    ).body.group;
    await call("POST", "/api/v1/admin/subscriptions/assign", admin, { emails: ["ivy@settle.test"], groupId: open.id, validityDays: 30 });
    expect(await store.ops.isSubscriptionOverLimit(ivy.id, open.id)).toBe(false);
    const conn = await sql.reserve();
    try {
      // entitlementRows' lateral, with the outer row bound: the cap test is a one-time filter.
      const rows = await conn.unsafe(`
        EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF)
        SELECT t.m FROM commerce.subscriptions s JOIN core.groups g ON g.id = s.group_id
          LEFT JOIN LATERAL (
            SELECT SUM(l.cost_nano_usd) AS m FROM core.usage_logs l
             WHERE l.user_id = s.user_id AND l.group_id = s.group_id
               AND l.created_at >= NOW() - INTERVAL '30 days'
               AND (g.daily_limit_nano_usd > 0 OR g.weekly_limit_nano_usd > 0 OR g.monthly_limit_nano_usd > 0)
          ) t ON (g.daily_limit_nano_usd > 0 OR g.weekly_limit_nano_usd > 0 OR g.monthly_limit_nano_usd > 0)
         WHERE s.user_id = '${ivy.id}' AND s.group_id = '${open.id}'
      `);
      const plan = (rows as unknown as Record<string, string>[]).map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toContain("One-Time Filter");
      expect(plan).toMatch(/usage_logs\w* .*never executed|never executed/);
    } finally {
      conn.release();
    }
    // And the store's own query carries the same in-lateral gate.
    const src = await Bun.file(new URL("../store/postgres_ops.ts", import.meta.url)).text();
    const lateral = src.slice(src.indexOf("private async entitlementRows"), src.indexOf("async subscriptionEntitlements"));
    expect(lateral).toMatch(/AND \(g\.daily_limit_nano_usd > 0 OR g\.weekly_limit_nano_usd > 0 OR g\.monthly_limit_nano_usd > 0\)\s*\) t ON/);
  });

  it("does not mark the spend backfill done when settle history exists but no cutoff was recorded", async () => {
    const { store, register } = await bootstrap();
    const sql = sqlOf(store);
    await (store as unknown as { whenMaintenanceIdle(): Promise<void> }).whenMaintenanceIdle();
    const ola = await register("ola@settle.test", "1");
    await sql`DELETE FROM commerce.portal_settings WHERE key IN ('spent_backfill_v1', 'spent_backfill_cutoff')`;
    // History the column never counted (0007 applied by hand, or an older build's backfill that never ran).
    await sql`
      INSERT INTO core.ledger_entries (id, idempotency_key, user_id, entry_kind, delta_nano_usd, balance_after_nano, created_at)
      VALUES ('ldg_nc1', 'settle:nc-1', ${ola.id}, 'settle', -9000, 0, NOW() - INTERVAL '3 days')
    `;
    await sql`UPDATE core.quota_wallets SET spent_nano_usd = 0 WHERE user_id = ${ola.id}`;
    const warnings: string[] = [];
    await backfillWalletSpend(sql, (m) => warnings.push(m));
    expect(await sql`SELECT 1 FROM commerce.portal_settings WHERE key = 'spent_backfill_v1'`).toHaveLength(0);
    expect(warnings.some((w) => w.includes("needs reconciliation"))).toBe(true);
    // Once an operator records when the column was added, the next start adds the older settles.
    await sql`INSERT INTO commerce.portal_settings (key, value_json) VALUES ('spent_backfill_cutoff', jsonb_build_object('at', NOW() - INTERVAL '1 day'))`;
    await backfillWalletSpend(sql, (m) => warnings.push(m));
    const rows = await sql<{ spent: string }[]>`SELECT spent_nano_usd::text AS spent FROM core.quota_wallets WHERE user_id = ${ola.id}`;
    expect(rows[0]!.spent).toBe("9000");
    expect(await sql`SELECT 1 FROM commerce.portal_settings WHERE key = 'spent_backfill_v1'`).toHaveLength(1);
  });

  it("marks the spend backfill done without a cutoff when the column already covers all settle history", async () => {
    const { store, register } = await bootstrap();
    const sql = sqlOf(store);
    await (store as unknown as { whenMaintenanceIdle(): Promise<void> }).whenMaintenanceIdle();
    const pia = await register("pia@settle.test", "1");
    await sql`DELETE FROM commerce.portal_settings WHERE key IN ('spent_backfill_v1', 'spent_backfill_cutoff')`;
    await sql`
      INSERT INTO core.ledger_entries (id, idempotency_key, user_id, entry_kind, delta_nano_usd, balance_after_nano, created_at)
      VALUES ('ldg_ok1', 'settle:ok-1', ${pia.id}, 'settle', -700, 0, NOW())
    `;
    await sql`UPDATE core.quota_wallets SET spent_nano_usd = 700 WHERE user_id = ${pia.id}`;
    const warnings: string[] = [];
    await backfillWalletSpend(sql, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(await sql`SELECT 1 FROM commerce.portal_settings WHERE key = 'spent_backfill_v1'`).toHaveLength(1);
    const rows = await sql<{ spent: string }[]>`SELECT spent_nano_usd::text AS spent FROM core.quota_wallets WHERE user_id = ${pia.id}`;
    expect(rows[0]!.spent).toBe("700");
  });

  it("backfills lifetime spend additively from settles before the cutoff, once", async () => {
    const { store, register } = await bootstrap();
    const sql = sqlOf(store);
    const ned = await register("ned@settle.test", "1");
    // Pretend this start added the column: older settles were never counted, newer ones were.
    await sql`DELETE FROM commerce.portal_settings WHERE key IN ('spent_backfill_v1', 'spent_backfill_cutoff')`;
    await sql`INSERT INTO commerce.portal_settings (key, value_json) VALUES ('spent_backfill_cutoff', jsonb_build_object('at', NOW() - INTERVAL '1 hour'))`;
    await sql`
      INSERT INTO core.ledger_entries (id, idempotency_key, user_id, entry_kind, delta_nano_usd, balance_after_nano, created_at) VALUES
        ('ldg_t1', 'settle:old-1', ${ned.id}, 'settle', -3000, 0, NOW() - INTERVAL '3 hours'),
        ('ldg_t2', 'settle:old-2', ${ned.id}, 'settle', -4000, 0, NOW() - INTERVAL '2 hours'),
        ('ldg_t3', 'settle:new-1', ${ned.id}, 'settle', -500, 0, NOW())
    `;
    // A settlement after the cutoff already counted itself (and raced the backfill).
    await sql`UPDATE core.quota_wallets SET spent_nano_usd = 500 WHERE user_id = ${ned.id}`;
    await backfillWalletSpend(sql);
    await backfillWalletSpend(sql);
    const rows = await sql<{ spent: string }[]>`SELECT spent_nano_usd::text AS spent FROM core.quota_wallets WHERE user_id = ${ned.id}`;
    expect(rows[0]!.spent).toBe("7500");
  });

  it("records the backfill cutoff in the same transaction that adds the spend column", async () => {
    const { store } = await bootstrap();
    const sql = sqlOf(store);
    await (store as unknown as { whenMaintenanceIdle(): Promise<void> }).whenMaintenanceIdle();
    await sql`DELETE FROM commerce.portal_settings WHERE key = 'spent_backfill_cutoff'`;
    await sql.unsafe(PG_SETTLEMENT_SCHEMA_SQL);
    expect(await sql`SELECT 1 FROM commerce.portal_settings WHERE key = 'spent_backfill_cutoff'`).toHaveLength(0);
    await sql`ALTER TABLE core.quota_wallets DROP COLUMN spent_nano_usd`;
    await sql.unsafe(PG_SETTLEMENT_SCHEMA_SQL);
    expect(await sql`SELECT 1 FROM commerce.portal_settings WHERE key = 'spent_backfill_cutoff'`).toHaveLength(1);
    expect(
      await sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'core' AND table_name = 'quota_wallets' AND column_name = 'spent_nano_usd'`,
    ).toHaveLength(1);
  });
  it("converges usage_logs on one attached index per purpose: attaches equal copies, rebuilds invalid ones, drops duplicates and superseded ones", async () => {
    const { store } = await bootstrap();
    const sql = sqlOf(store);
    await (store as unknown as { whenMaintenanceIdle(): Promise<void> }).whenMaintenanceIdle();
    // An "existing database": no parent indexes, standalone copies older builds made, the old
    // non-covering key index, and an INVALID leftover of an interrupted build.
    await sql.unsafe(`
      DROP INDEX IF EXISTS core.idx_core_usage_logs_group_time;
      DROP INDEX IF EXISTS core.idx_core_usage_logs_key_time_cost;
      DROP INDEX IF EXISTS core.idx_core_usage_logs_time;
      DROP INDEX IF EXISTS core.idx_core_usage_logs_user_group_time_cost;
      CREATE INDEX idx_core_usage_logs_key_time ON core.usage_logs (api_key_id, created_at DESC);
      CREATE INDEX idx_core_usage_logs_default_group_time ON core.usage_logs_default (group_id, created_at DESC);
      CREATE INDEX idx_core_usage_logs_default_key_time ON core.usage_logs_default (api_key_id, created_at DESC);
      CREATE INDEX idx_core_usage_logs_default_time ON core.usage_logs_default (created_at DESC);
      CREATE INDEX idx_core_usage_logs_default_time_copy ON core.usage_logs_default (created_at DESC);
      CREATE INDEX usage_logs_default_user_group_time_cost_idx ON core.usage_logs_default (user_id, group_id, created_at DESC) INCLUDE (cost_nano_usd);
      UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'core.usage_logs_default_user_group_time_cost_idx'::regclass;
    `);
    const logs: string[] = [];
    await ensureUsageLogIndexes(sql, (m) => logs.push(m));

    const rows = await sql<{ name: string; def: string; valid: boolean; parent: string | null }[]>`
      SELECT ci.relname AS name, regexp_replace(pg_get_indexdef(ix.indexrelid), '^.* USING btree ', '') AS def,
             ix.indisvalid AS valid, pc.relname AS parent
        FROM pg_index ix
        JOIN pg_class ci ON ci.oid = ix.indexrelid
        LEFT JOIN pg_inherits ih ON ih.inhrelid = ix.indexrelid
        LEFT JOIN pg_class pc ON pc.oid = ih.inhparent
       WHERE ix.indrelid = 'core.usage_logs_default'::regclass AND NOT ix.indisunique
    `;
    const byDef = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) byDef.set(r.def, [...(byDef.get(r.def) ?? []), r]);
    const expectOne = (def: string, parent: string) => {
      const list = byDef.get(def) ?? [];
      expect(list.map((r) => ({ parent: r.parent, valid: r.valid }))).toEqual([{ parent, valid: true }]);
    };
    expectOne("(group_id, created_at DESC)", "idx_core_usage_logs_group_time");
    expectOne("(api_key_id, created_at DESC) INCLUDE (cost_nano_usd)", "idx_core_usage_logs_key_time_cost");
    expectOne("(created_at DESC)", "idx_core_usage_logs_time");
    expectOne("(user_id, group_id, created_at DESC) INCLUDE (cost_nano_usd)", "idx_core_usage_logs_user_group_time_cost");
    // The existing valid copy was attached, not rebuilt.
    expect(byDef.get("(group_id, created_at DESC)")![0]!.name).toBe("idx_core_usage_logs_default_group_time");
    // Superseded non-covering key indexes are gone (parent and standalone).
    expect(byDef.get("(api_key_id, created_at DESC)") ?? []).toHaveLength(0);
    const parentGone = await sql`SELECT 1 FROM pg_class WHERE relname = 'idx_core_usage_logs_key_time'`;
    expect(parentGone).toHaveLength(0);
    expect(logs.some((m) => m.includes("INVALID"))).toBe(true);

    // Idempotent: a second run changes nothing.
    const before = rows.map((r) => r.name).sort();
    await ensureUsageLogIndexes(sql, () => undefined);
    const after = (
      await sql<{ name: string }[]>`
        SELECT ci.relname AS name FROM pg_index ix JOIN pg_class ci ON ci.oid = ix.indexrelid
         WHERE ix.indrelid = 'core.usage_logs_default'::regclass AND NOT ix.indisunique
      `
    )
      .map((r) => r.name)
      .sort();
    expect(after).toEqual(before);
  });
});
