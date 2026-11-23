import { afterEach, describe, expect, it } from "bun:test";
import type {
  RuntimeLogConfig,
  SystemLogIngestResponse,
  SystemLogListResponse,
  SystemLogSinkHealth,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { crashHandler } from "../logging/crash.ts";
import {
  getDefaultLogDestination,
  installConsoleCapture,
  LogSampler,
  logger,
  parseConsoleLine,
  passesLevel,
  setDefaultLogDestination,
  shouldStore,
} from "../logging/logger.ts";
import { baselineRuntimeLogConfig, resolveRuntimeLogConfig } from "../logging/runtime_config.ts";
import { SystemLogService, toSystemLogInsert } from "../logging/service.ts";
import { SystemLogSink } from "../logging/sink.ts";
import { systemLogServiceOf } from "../routes/system_logs.ts";
import { MemorySystemLogStore } from "../store/memory_system_logs.ts";
import type { SystemLogInsert, SystemLogStore } from "../store/system_logs_types.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "system-logs-internal-token";

type StoreFactory = () => Promise<ControlStore>;

type TestApp = ReturnType<typeof createBffApp>;

/** `routes` adds test-only routes before the first request (Hono's router is built then). */
async function bootstrap(routes?: (app: TestApp) => void) {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const app = createBffApp({
    store: factory ? await factory() : undefined,
    jwtSecret: "system-logs-test-jwt-secret-32-bytes",
    vaultSecret: "system-logs-test-vault-secret-32-bytes",
    internalToken: INTERNAL,
  });
  routes?.(app);
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
  const service = systemLogServiceOf(app)!;
  const flush = () => service.sink.flush();
  return { app, call, service, flush };
}

async function withAdmin(routes?: (app: TestApp) => void) {
  const ctx = await bootstrap(routes);
  const init = await ctx.call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Logs Test",
    adminEmail: "admin@logs.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  const adminId = init.body.user.id;
  const ingest = (body: unknown) =>
    ctx.call<SystemLogIngestResponse>("POST", "/api/v1/internal/system-logs", { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL }, body);
  const list = async (query = "") => {
    await ctx.flush();
    return ctx.call<SystemLogListResponse>("GET", `/api/v1/admin/ops/system-logs${query}`, admin);
  };
  return { ...ctx, admin, adminId, ingest, list };
}

/* ------------------------------------------------------------------------------------------ */
/* Units                                                                                        */
/* ------------------------------------------------------------------------------------------ */

describe("logger rules", () => {
  it("stores warnings, errors and audit entries; access entries only when persisted", () => {
    expect(shouldStore("warn", "app", false)).toBe(true);
    expect(shouldStore("error", "http", false)).toBe(true);
    expect(shouldStore("info", "app", false)).toBe(false);
    expect(shouldStore("info", "audit.log_config_change", false)).toBe(true);
    expect(shouldStore("info", "http.access", false)).toBe(false);
    expect(shouldStore("info", "http.access", true)).toBe(true);
    expect(shouldStore("debug", "core", true)).toBe(false);
  });

  it("applies the runtime level except to audit entries", () => {
    expect(passesLevel("warn", "app", "error")).toBe(false);
    expect(passesLevel("error", "app", "error")).toBe(true);
    expect(passesLevel("info", "audit.x", "error")).toBe(true);
    expect(passesLevel("debug", "app", "debug")).toBe(true);
  });

  it("samples per second and key: first N, then every M-th", () => {
    const s = new LogSampler();
    const t = 1_700_000_000_000;
    const kept = Array.from({ length: 10 }, () => s.allow("k", 2, 3, t)).filter(Boolean).length;
    // 1, 2 kept, then 5 and 8 (every 3rd after the first 2).
    expect(kept).toBe(4);
    expect(s.sampledOut).toBe(6);
    // A new second starts over.
    expect(s.allow("k", 2, 3, t + 1000)).toBe(true);
  });

  it("reads a leading [tag] of a console line as the component", () => {
    expect(parseConsoleLine("[security] WARNING: weak")).toEqual({ component: "security", message: "WARNING: weak" });
    expect(parseConsoleLine("[slipgate-bff] audit write failed")).toEqual({ component: "app", message: "audit write failed" });
    expect(parseConsoleLine("plain text")).toEqual({ component: "app", message: "plain text" });
  });

  it("redacts secrets from the message and context and lifts correlation fields", () => {
    const row = toSystemLogInsert({
      timeMs: Date.parse("2026-01-01T00:00:00Z"),
      level: "error",
      source: "bff",
      component: "http",
      host: "h1",
      message: "upstream said Bearer abcdefghijklmnop1234 for https://user:pw@proxy.example/x",
      fields: {
        apiKeyId: "key_1",
        account_id: "acc_1",
        model: "claude-x",
        platform: "anthropic",
        password: "hunter2",
        nested: { refreshToken: "rt-123", note: "sk-ant-abcdefghijklmnop1234" },
        status: 502,
      },
      requestId: "req_1",
      clientRequestId: "",
      userId: "u_1",
      stack: "Error: x\n    at y",
    });
    expect(row.message).not.toContain("abcdefghijklmnop1234");
    expect(row.message).not.toContain("user:pw");
    expect(row.apiKeyId).toBe("key_1");
    expect(row.accountId).toBe("acc_1");
    expect(row.model).toBe("claude-x");
    expect(row.platform).toBe("anthropic");
    const ctx = JSON.parse(row.contextJson) as Record<string, unknown>;
    expect(ctx.password).toBe("[redacted]");
    expect((ctx.nested as Record<string, unknown>).refreshToken).toBe("[redacted]");
    expect(JSON.stringify(ctx)).not.toContain("sk-ant-abcdefghijklmnop1234");
    expect(ctx.status).toBe(502);
    expect(ctx.stack).toContain("Error: x");
    expect(ctx.apiKeyId).toBeUndefined();
    expect(ctx.model).toBeUndefined();
  });

  it("resolves a saved config field by field over the baseline", () => {
    const baseline = baselineRuntimeLogConfig({ SLIPGATE_LOG_LEVEL: "warning", SLIPGATE_SYSTEM_LOG_RETENTION_DAYS: "7" });
    expect(baseline.level).toBe("warn");
    expect(baseline.retentionDays).toBe(7);
    expect(baseline.source).toBe("baseline");
    const resolved = resolveRuntimeLogConfig({ level: "error", retentionDays: -4, caller: false, updatedBy: "u1" }, baseline);
    expect(resolved.level).toBe("error");
    expect(resolved.retentionDays).toBe(7);
    expect(resolved.caller).toBe(false);
    expect(resolved.source).toBe("runtime_setting");
    expect(resolved.updatedBy).toBe("u1");
  });
});

function row(message: string, overrides: Partial<SystemLogInsert> = {}): SystemLogInsert {
  return {
    createdAtIso: new Date().toISOString(),
    level: "warn",
    source: "bff",
    component: "app",
    host: "h",
    message,
    requestId: "",
    clientRequestId: "",
    userId: null,
    apiKeyId: null,
    accountId: null,
    platform: "",
    model: "",
    contextJson: "{}",
    ...overrides,
  };
}

describe("system log sink", () => {
  it("batches inserts and drops (counted) when the queue is full", async () => {
    const store = new MemorySystemLogStore();
    const batches: number[] = [];
    const spy: SystemLogStore = Object.assign(Object.create(store) as SystemLogStore, {
      insertSystemLogs: async (rows: SystemLogInsert[]) => {
        batches.push(rows.length);
        return store.insertSystemLogs(rows);
      },
    });
    const sink = new SystemLogSink(spy, { capacity: 5, batchSize: 2, flushIntervalMs: 60_000 });
    for (let i = 0; i < 7; i++) sink.enqueue(row(`m${i}`));
    expect(sink.counters().queueDepth).toBe(5);
    expect(sink.counters().droppedCount).toBe(2);
    await sink.flush();
    expect(batches).toEqual([2, 2, 1]);
    const health = sink.counters();
    expect(health.writtenCount).toBe(5);
    expect(health.queueDepth).toBe(0);
    expect(health.lastFlushAtIso).not.toBeNull();
    const listed = await store.listSystemLogs({}, 1, 50);
    expect(listed.total).toBe(5);
  });

  it("backs off after a failed insert: the window drops batches, then recovers", async () => {
    let now = 1_000_000;
    let failing = true;
    const store = new MemorySystemLogStore();
    const flaky: SystemLogStore = Object.assign(Object.create(store) as SystemLogStore, {
      insertSystemLogs: async (rows: SystemLogInsert[]) => {
        if (failing) throw new Error("db down");
        return store.insertSystemLogs(rows);
      },
    });
    const sink = new SystemLogSink(flaky, { flushIntervalMs: 60_000, backoffBaseMs: 2_000, backoffMaxMs: 8_000, now: () => now });
    expect([1, 2, 3, 4, 5].map((n) => sink.backoffFor(n))).toEqual([2_000, 4_000, 8_000, 8_000, 8_000]);

    sink.enqueue(row("a"));
    sink.enqueue(row("b"));
    await sink.flush();
    let c = sink.counters();
    expect(c.writeFailedCount).toBe(2);
    expect(c.lastError).toBe("db down");

    // Inside the 2 s window: dropped without touching the store.
    failing = false;
    now += 1_000;
    sink.enqueue(row("c"));
    await sink.flush();
    c = sink.counters();
    expect(c.droppedCount).toBe(1);
    expect(c.writtenCount).toBe(0);

    // After it: written, error cleared.
    now += 2_000;
    sink.enqueue(row("d"));
    await sink.flush();
    c = sink.counters();
    expect(c.writtenCount).toBe(1);
    expect(c.lastError).toBe("");
    expect((await store.listSystemLogs({}, 1, 10)).items.map((i) => i.message)).toEqual(["d"]);
  });

  it("refuses entries after stop and writes what was queued", async () => {
    const store = new MemorySystemLogStore();
    const sink = new SystemLogSink(store, { flushIntervalMs: 60_000 });
    sink.enqueue(row("queued"));
    await sink.stop();
    expect(sink.enqueue(row("late"))).toBe(false);
    expect((await store.listSystemLogs({}, 1, 10)).total).toBe(1);
  });
});

describe("retention", () => {
  it("prunes entries older than the runtime retention", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    const store: SystemLogStore = factory ? (await factory()).systemLogs : new MemorySystemLogStore();
    const now = Date.parse("2026-06-01T00:00:00Z");
    const service = new SystemLogService(store, { env: { SLIPGATE_SYSTEM_LOG_RETENTION_DAYS: "10" }, now: () => now });
    await store.insertSystemLogs([
      row("old", { createdAtIso: new Date(now - 11 * 86_400_000).toISOString() }),
      row("recent", { createdAtIso: new Date(now - 9 * 86_400_000).toISOString() }),
    ]);
    expect(await service.prune()).toBe(1);
    expect((await store.listSystemLogs({}, 1, 10)).items.map((i) => i.message)).toEqual(["recent"]);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Routes (memory store, or Postgres through the PGlite preload)                               */
/* ------------------------------------------------------------------------------------------ */

let restoreConsole: (() => void) | null = null;
afterEach(() => {
  restoreConsole?.();
  restoreConsole = null;
});

describe("request logging", () => {
  it("records unexpected route failures with the request id, user and a stack", async () => {
    const t = await withAdmin((app) => {
      app.get("/api/v1/admin/__boom", () => {
        throw new Error("kaboom with Bearer abcdefghijklmnopqrstu");
      });
    });
    const res = await t.call("GET", "/api/v1/admin/__boom", { ...t.admin, "X-Request-Id": "req-from-edge-1" });
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Request-Id")).toBe("req-from-edge-1");

    const listed = await t.list("?component=http&level=error");
    expect(listed.status).toBe(200);
    expect(listed.body.items).toHaveLength(1);
    const item = listed.body.items[0]!;
    expect(item.source).toBe("bff");
    expect(item.requestId).toBe("req-from-edge-1");
    expect(item.userId).toBe(t.adminId);
    expect(item.message).toContain("GET /api/v1/admin/__boom failed");
    expect(item.message).not.toContain("abcdefghijklmnopqrstu");
    expect(String(item.context.stack)).toContain("kaboom");
    expect(item.context.path).toBe("/api/v1/admin/__boom");
    expect(typeof item.context.caller).toBe("string");
  });

  it("generates a request id when none (or a malformed one) is sent", async () => {
    const t = await bootstrap();
    const res = await t.call("GET", "/api/v1/health", { "X-Request-Id": "bad id with spaces" });
    expect(res.headers.get("X-Request-Id")).toMatch(/^req_[0-9a-f]{24}$/);
  });

  it("captures console.warn / console.error inside a request", async () => {
    const t = await withAdmin((app) => {
      app.post("/api/v1/admin/__warn", (c) => {
        console.warn("[security] suspicious login token=abcdef123456 from", "10.0.0.1");
        console.error(new Error("plain failure"));
        return c.json({ ok: true });
      });
    });
    restoreConsole = installConsoleCapture();
    expect((await t.call("POST", "/api/v1/admin/__warn", t.admin, {})).status).toBe(200);
    restoreConsole();
    restoreConsole = null;
    const security = await t.list("?component=security");
    expect(security.body.items).toHaveLength(1);
    expect(security.body.items[0]!.level).toBe("warn");
    expect(security.body.items[0]!.message).toContain("suspicious login");
    expect(security.body.items[0]!.message).not.toContain("abcdef123456");
    const errors = await t.list("?level=error&component=app");
    expect(errors.body.items.some((i) => i.message.includes("plain failure"))).toBe(true);
    expect(errors.body.items[0]!.userId).toBe(t.adminId);
  });

  it("stores access entries only while access logs are persisted", async () => {
    const t = await withAdmin();
    await t.call("GET", "/api/v1/health");
    expect((await t.list("?component=http.access")).body.total).toBe(0);
    const put = await t.call<RuntimeLogConfig>("PUT", "/api/v1/admin/ops/runtime/logging", t.admin, { persistAccessLogs: true });
    expect(put.status).toBe(200);
    await t.call("GET", "/api/v1/setup/status");
    await t.call("GET", "/api/v1/admin/ops/system-logs/health", t.admin);
    const access = await t.list("?component=http.access");
    // From the switch on (decided when each response is done); the viewer's own polling is never recorded.
    expect(access.body.items.map((i) => i.message)).toEqual(["GET /api/v1/setup/status 200", "PUT /api/v1/admin/ops/runtime/logging 200"]);
    expect(access.body.items[0]!.level).toBe("info");
    expect(access.body.items[0]!.context.status).toBe(200);
  });
});

describe("system log list", () => {
  it("filters by level, source, component, ids, text and window, newest first, paginated", async () => {
    const t = await withAdmin();
    const now = Date.now();
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    const res = await t.ingest({
      host: "edge-1",
      entries: [
        { source: "net", level: "warning", component: "dataplane", message: "relay interrupted", requestId: "r-1", timeIso: at(60_000), apiKeyId: "k1", accountId: "a1", model: "m1", platform: "openai" },
        { source: "core", level: "err", component: "core", message: "accept error: ConnectionResetByPeer", timeIso: at(50_000), context: { scope: "ipc" } },
        { source: "net", level: "info", component: "clash", message: "info lines are not stored", timeIso: at(40_000) },
        { source: "net", level: "error", component: "clash", message: "probe FAILED for node 7", timeIso: at(3 * 3_600_000) },
        { source: "net", level: "info", component: "audit.vm", message: "vm slot reassigned", userId: "u9", timeIso: at(30_000) },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(4);
    expect(res.body.filtered).toBe(1);
    expect(res.body.config.level).toBe("info");

    // Default window is the last hour.
    const all = await t.list("");
    expect(all.body.total).toBe(3);
    expect(all.body.items.map((i) => i.message)).toEqual(["vm slot reassigned", "accept error: ConnectionResetByPeer", "relay interrupted"]);
    expect(Date.parse(all.body.untilIso) - Date.parse(all.body.sinceIso)).toBe(3_600_000);

    expect((await t.list("?timeRange=6h")).body.total).toBe(4);
    expect((await t.list("?level=warn")).body.items.map((i) => i.component)).toEqual(["dataplane"]);
    expect((await t.list("?minLevel=warn&timeRange=24h")).body.total).toBe(3);
    expect((await t.list("?source=core")).body.items[0]!.context).toEqual({ scope: "ipc" });
    expect((await t.list("?requestId=r-1")).body.items[0]!.apiKeyId).toBe("k1");
    expect((await t.list("?apiKeyId=k1&accountId=a1&model=m1&platform=openai")).body.total).toBe(1);
    expect((await t.list("?userId=u9")).body.items[0]!.source).toBe("net");
    expect((await t.list("?host=edge-1")).body.total).toBe(3);
    // Case-insensitive text search over message and context.
    expect((await t.list("?q=failed&timeRange=24h")).body.items.map((i) => i.message)).toEqual(["probe FAILED for node 7"]);
    expect((await t.list("?q=IPC")).body.total).toBe(1);
    // LIKE wildcards are literal.
    expect((await t.list("?q=%25")).body.total).toBe(0);

    const sinceIso = encodeURIComponent(at(55_000));
    const untilIso = encodeURIComponent(at(35_000));
    expect((await t.list(`?sinceIso=${sinceIso}&untilIso=${untilIso}`)).body.items.map((i) => i.message)).toEqual([
      "accept error: ConnectionResetByPeer",
    ]);

    const page1 = await t.list("?pageSize=2&page=1");
    const page2 = await t.list("?pageSize=2&page=2");
    expect(page1.body.items).toHaveLength(2);
    expect(page2.body.items).toHaveLength(1);
    expect(page1.body.total).toBe(3);

    // Live tail: only rows newer than the largest id shown.
    const newest = all.body.items[0]!.id;
    expect((await t.list(`?afterId=${newest}`)).body.total).toBe(0);
    await t.ingest({ host: "edge-1", entries: [{ source: "net", level: "error", component: "dataplane", message: "fresh" }] });
    expect((await t.list(`?afterId=${newest}`)).body.items.map((i) => i.message)).toEqual(["fresh"]);

    expect((await t.list("?level=verbose")).status).toBe(400);
    expect((await t.list(`?sinceIso=${untilIso}&untilIso=${sinceIso}`)).status).toBe(400);
  });

  it("is admin only", async () => {
    const t = await withAdmin();
    const reg = await t.call<{ accessToken: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email: "user@logs.test",
      password: "UserPassword123!",
    });
    const user = { ...JSON_HEADERS, Authorization: `Bearer ${reg.body.accessToken}` };
    expect((await t.call("GET", "/api/v1/admin/ops/system-logs", user)).status).toBe(403);
    expect((await t.call("POST", "/api/v1/admin/ops/system-logs/cleanup", user, { level: "warn" })).status).toBe(403);
    expect((await t.call("GET", "/api/v1/admin/ops/system-logs/health", user)).status).toBe(403);
    expect((await t.call("PUT", "/api/v1/admin/ops/runtime/logging", user, { level: "debug" })).status).toBe(403);
    expect((await t.call("POST", "/api/v1/admin/ops/runtime/logging/reset", user)).status).toBe(403);
    expect((await t.call("GET", "/api/v1/admin/ops/system-logs")).status).toBe(401);
  });
});

describe("system log cleanup", () => {
  it("requires a filter and a valid range, deletes matches and audits the cleanup", async () => {
    const t = await withAdmin();
    await t.ingest({
      host: "edge-1",
      entries: [
        { source: "net", level: "warn", component: "dataplane", message: "w1" },
        { source: "net", level: "warn", component: "clash", message: "w2" },
        { source: "net", level: "error", component: "dataplane", message: "e1" },
      ],
    });
    await t.flush();
    const none = await t.call<{ error: string }>("POST", "/api/v1/admin/ops/system-logs/cleanup", t.admin, {});
    expect(none.status).toBe(400);
    expect(none.body.error).toBe("cleanup_filter_required");
    const blank = await t.call<{ error: string }>("POST", "/api/v1/admin/ops/system-logs/cleanup", t.admin, { component: "  ", level: "" });
    expect(blank.body.error).toBe("cleanup_filter_required");
    const range = await t.call<{ error: string }>("POST", "/api/v1/admin/ops/system-logs/cleanup", t.admin, {
      sinceIso: "2026-02-01T00:00:00Z",
      untilIso: "2026-01-01T00:00:00Z",
    });
    expect(range.status).toBe(400);
    expect(range.body.error).toBe("cleanup_invalid_range");
    const unknown = await t.call<{ error: string }>("POST", "/api/v1/admin/ops/system-logs/cleanup", t.admin, { everything: true });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("bad_request");

    const del = await t.call<{ deleted: number }>("POST", "/api/v1/admin/ops/system-logs/cleanup", t.admin, { level: "warn", component: "dataplane" });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(1);
    const left = await t.list("?source=net");
    expect(left.body.items.map((i) => i.message).sort()).toEqual(["e1", "w2"]);
    // The cleanup itself is an audit entry.
    const audit = await t.list("?component=audit.system_log_cleanup");
    expect(audit.body.total).toBe(1);
    expect(audit.body.items[0]!.userId).toBe(t.adminId);
    expect((audit.body.items[0]!.context.conditions as Record<string, unknown>).component).toBe("dataplane");
  });

  it("records who cleaned up what (memory store)", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    if (factory) return; // The audit table is only read back through the memory store.
    const t = await withAdmin();
    await t.call("POST", "/api/v1/admin/ops/system-logs/cleanup", t.admin, { q: "nothing-matches" });
    const store = (t.service as unknown as { store: MemorySystemLogStore }).store;
    expect(store.cleanupAudits()).toEqual([{ operatorId: t.adminId, conditions: { q: "nothing-matches" }, deletedRows: 0 }]);
  });
});

describe("ingest", () => {
  it("requires the internal token and a valid body", async () => {
    const t = await withAdmin();
    const noToken = await t.call("POST", "/api/v1/internal/system-logs", JSON_HEADERS, { host: "x", entries: [] });
    expect(noToken.status).toBe(403);
    const bad = await t.ingest({ host: "x", entries: [{ source: "bff", level: "warn", message: "spoofed" }] });
    expect(bad.status).toBe(400);
    const tooMany = await t.ingest({ host: "x", entries: Array.from({ length: 501 }, () => ({ source: "net", level: "warn", message: "m" })) });
    expect(tooMany.status).toBe(400);
  });

  it("files net's structured turn entries under the turn's user, key, account, platform and model", async () => {
    const t = await withAdmin();
    const turn = { requestId: "req_42", userId: "u_7", apiKeyId: "key_3", accountId: "acc_9", platform: "anthropic", model: "claude-sonnet-4-5" };
    const access = {
      source: "net",
      level: "info",
      component: "http.access",
      message: "POST /v1/messages 200",
      ...turn,
      context: { method: "POST", path: "/v1/messages", status: 200, latencyMs: 35, clientIp: "203.0.113.9" },
    };
    const first = await t.ingest({
      host: "edge-1",
      entries: [{ source: "net", level: "warn", component: "dataplane", message: "stream relay interrupted: unexpected EOF", ...turn, context: { upstreamStatus: 200 } }, access],
    });
    // Access entries are kept only while access logs are persisted.
    expect(first.body).toMatchObject({ accepted: 1, filtered: 1 });
    expect(first.body.config.persistAccessLogs).toBe(false);
    await t.call("PUT", "/api/v1/admin/ops/runtime/logging", t.admin, { persistAccessLogs: true });
    expect((await t.ingest({ host: "edge-1", entries: [access] })).body).toMatchObject({ accepted: 1, filtered: 0 });

    const byTurn = await t.list("?apiKeyId=key_3&accountId=acc_9&model=claude-sonnet-4-5&userId=u_7&platform=anthropic&source=net");
    expect(byTurn.body.items.map((i) => i.component).sort()).toEqual(["dataplane", "http.access"]);
    const warn = byTurn.body.items.find((i) => i.component === "dataplane")!;
    expect(warn).toMatchObject({ requestId: "req_42", userId: "u_7", apiKeyId: "key_3", accountId: "acc_9", platform: "anthropic", model: "claude-sonnet-4-5" });
    expect(warn.context).toEqual({ upstreamStatus: 200 });
    const stored = (await t.list("?component=http.access&apiKeyId=key_3")).body.items[0]!;
    expect(stored.context).toMatchObject({ method: "POST", path: "/v1/messages", status: 200, latencyMs: 35 });
    expect((await t.list("?apiKeyId=key_other")).body.total).toBe(0);
  });

  it("applies the runtime level and reports forwarder health", async () => {
    const t = await withAdmin();
    const put = await t.call<RuntimeLogConfig>("PUT", "/api/v1/admin/ops/runtime/logging", t.admin, { level: "error" });
    expect(put.body.level).toBe("error");
    const res = await t.ingest({
      host: "edge-9",
      entries: [
        { source: "net", level: "warn", component: "dataplane", message: "below level" },
        { source: "core", level: "error", component: "core", message: "kept", timeIso: new Date(Date.now() + 3_600_000).toISOString() },
      ],
      health: { queueDepth: 3, queueCapacity: 2000, droppedCount: 1, sentCount: 40, failedCount: 2, lastError: "connection refused" },
    });
    expect(res.body).toMatchObject({ accepted: 1, filtered: 1, dropped: 0 });
    expect(res.body.config.level).toBe("error");
    await t.flush();
    const kept = await t.list("?source=core");
    // A clock far ahead is clamped to the receive time (it stays inside "the last hour").
    expect(kept.body.items.map((i) => i.message)).toEqual(["kept"]);
    expect(Date.parse(kept.body.items[0]!.createdAtIso)).toBeLessThanOrEqual(Date.now());

    const health = await t.call<SystemLogSinkHealth>("GET", "/api/v1/admin/ops/system-logs/health", t.admin);
    expect(health.status).toBe(200);
    expect(health.body.writtenCount).toBeGreaterThanOrEqual(1);
    expect(health.body.queueCapacity).toBe(5000);
    expect(health.body.forwarders).toHaveLength(1);
    expect(health.body.forwarders[0]).toMatchObject({ host: "edge-9", source: "net", sentCount: 40, lastError: "connection refused" });
  });
});

describe("runtime log config", () => {
  it("reads the baseline, saves a partial update, audits it and resets", async () => {
    const t = await withAdmin();
    const initial = await t.call<RuntimeLogConfig>("GET", "/api/v1/admin/ops/runtime/logging", t.admin);
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ source: "baseline", updatedAtIso: null, updatedBy: null, retentionDays: 30 });

    const bad = await t.call("PUT", "/api/v1/admin/ops/runtime/logging", t.admin, { retentionDays: 0 });
    expect(bad.status).toBe(400);
    const badLevel = await t.call("PUT", "/api/v1/admin/ops/runtime/logging", t.admin, { level: "verbose" });
    expect(badLevel.status).toBe(400);

    // The full object the viewer shows can be sent back (provenance fields are ignored).
    const put = await t.call<RuntimeLogConfig>("PUT", "/api/v1/admin/ops/runtime/logging", t.admin, {
      ...initial.body,
      level: "warn",
      retentionDays: 14,
      enableSampling: true,
      samplingInitial: 5,
      samplingThereafter: 10,
      stacktraceLevel: "none",
    });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({
      level: "warn",
      retentionDays: 14,
      enableSampling: true,
      samplingInitial: 5,
      samplingThereafter: 10,
      stacktraceLevel: "none",
      source: "runtime_setting",
      updatedBy: t.adminId,
    });
    expect(put.body.updatedAtIso).not.toBeNull();
    expect((await t.call<RuntimeLogConfig>("GET", "/api/v1/admin/ops/runtime/logging", t.admin)).body.level).toBe("warn");

    // Audited (info entry kept even though the level is now warn).
    const audit = await t.list("?component=audit.log_config_change");
    expect(audit.body.total).toBe(1);
    expect(audit.body.items[0]!.level).toBe("info");
    expect(audit.body.items[0]!.context.action).toBe("updated");
    expect((audit.body.items[0]!.context.new as Record<string, unknown>).level).toBe("warn");

    const reset = await t.call<RuntimeLogConfig>("POST", "/api/v1/admin/ops/runtime/logging/reset", t.admin);
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ level: "info", retentionDays: 30, source: "baseline", updatedBy: t.adminId });
    const after = await t.call<RuntimeLogConfig>("GET", "/api/v1/admin/ops/runtime/logging", t.admin);
    expect(after.body).toMatchObject({ level: "info", source: "baseline", updatedBy: null });
  });

  it("keeps a save or reset when a re-read that started before it returns afterwards", async () => {
    const store = new MemorySystemLogStore();
    await store.setRuntimeLogConfig({ level: "error", retentionDays: 9, updatedAtIso: "2026-01-01T00:00:00.000Z", updatedBy: "someone" });
    let gate: (() => void) | null = null;
    const gated: SystemLogStore = Object.assign(Object.create(store) as SystemLogStore, {
      getRuntimeLogConfig: async () => {
        const saved = await store.getRuntimeLogConfig();
        if (gate === null) return saved;
        await new Promise<void>((resolve) => (gate = resolve));
        return saved;
      },
      setRuntimeLogConfig: (value: Record<string, unknown> | null) => store.setRuntimeLogConfig(value),
    });
    const service = new SystemLogService(gated, { env: {} });
    expect((await service.ensureLoaded()).level).toBe("error");

    // A periodic re-read starts and reads the old saved document, then a reset is applied.
    gate = () => undefined;
    const reread = service.reload();
    await Bun.sleep(0);
    const reset = await service.reset("admin-1");
    expect(reset.level).toBe("info");
    // The re-read finishes after the reset: it must not bring the old config back.
    (gate as () => void)();
    await reread;
    expect(service.runtimeConfig()).toMatchObject({ level: "info", retentionDays: 30, source: "baseline" });
  });

  it("merges a partial update over the saved config, not a stale cache", async () => {
    const t = await withAdmin();
    const store = (t.service as unknown as { store: SystemLogStore }).store;
    const other = new SystemLogService(store);
    await other.ensureLoaded(); // cached before the change below
    await t.call("PUT", "/api/v1/admin/ops/runtime/logging", t.admin, { level: "error" });
    const merged = await other.update({ retentionDays: 7 }, t.adminId);
    expect(merged).toMatchObject({ level: "error", retentionDays: 7 });
    // The first instance picks both up on its next re-read.
    expect(await t.service.reload()).toMatchObject({ level: "error", retentionDays: 7 });
  });

  it("persists across app instances sharing the store", async () => {
    const t = await withAdmin();
    await t.call("PUT", "/api/v1/admin/ops/runtime/logging", t.admin, { level: "error", persistAccessLogs: true });
    const store = (t.service as unknown as { store: SystemLogStore }).store;
    const second = new SystemLogService(store);
    const loaded = await second.ensureLoaded();
    expect(loaded).toMatchObject({ level: "error", persistAccessLogs: true, source: "runtime_setting" });
  });
});

describe("startup and crashes", () => {
  it("holds entries written before the server registers its destination", async () => {
    const store = new MemorySystemLogStore();
    const service = new SystemLogService(store, { env: {} });
    const previous = getDefaultLogDestination();
    setDefaultLogDestination(null);
    try {
      logger.warn("security", "WARNING: running with weak secrets (startup test)");
      logger.info("app", "info entries are not kept (startup test)");
      setDefaultLogDestination(service);
      await service.sink.flush();
      const listed = await store.listSystemLogs({}, 1, 200);
      expect(listed.items.filter((i) => i.message.includes("(startup test)")).map((i) => [i.component, i.level, i.source])).toEqual([
        ["security", "warn", "bff"],
      ]);
    } finally {
      setDefaultLogDestination(previous);
    }
  });

  it("stores a crash, writes the queue, then exits with status 1", async () => {
    const store = new MemorySystemLogStore();
    const service = new SystemLogService(store, { env: {} });
    const previous = getDefaultLogDestination();
    setDefaultLogDestination(service);
    const exits: number[] = [];
    try {
      const state = { crashing: false };
      const onRejection = crashHandler("unhandled rejection", () => service.sink.flush(), state, { exit: (code) => exits.push(code) });
      const onException = crashHandler("uncaught exception", () => service.sink.flush(), state, { exit: (code) => exits.push(code) });
      onRejection(new Error("db pool exploded"));
      // A second failure while the first one is being written changes nothing.
      onException(new Error("follow-up failure"));
      for (let i = 0; i < 100 && exits.length === 0; i++) await Bun.sleep(5);
      expect(exits).toEqual([1]);
      const listed = await store.listSystemLogs({ component: "process" }, 1, 10);
      expect(listed.items.map((i) => i.message)).toEqual(["unhandled rejection: db pool exploded"]);
      expect(listed.items[0]!.level).toBe("error");
      expect(String(listed.items[0]!.context.stack)).toContain("db pool exploded");
    } finally {
      setDefaultLogDestination(previous);
    }
  });
});
