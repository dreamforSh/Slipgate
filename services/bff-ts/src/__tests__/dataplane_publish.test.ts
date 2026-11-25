import { afterEach, describe, expect, it } from "bun:test";
import type { DataPlaneSyncSnapshot, DataPlaneSyncStatus } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { pushOutcome, syncState } from "../dataplane_sync.ts";

/**
 * Config publish confirmation: a push the edge answers 202 / coreApplied=false (slipgate-core
 * offline or rejecting) is not published, so it must not retire the pending risk unbans it
 * carried; GET /api/v1/admin/system/dataplane-sync shows "pending_core" until the core
 * acknowledges the revision, "unreachable" without an edge answer, "standalone" without an edge.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL = "publish-internal-token";

const savedUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
afterEach(() => {
  if (savedUrl === undefined) delete process.env.SLIPGATE_NET_INTERNAL_URL;
  else process.env.SLIPGATE_NET_INTERNAL_URL = savedUrl;
});

/** A stand-in edge: acknowledges pushes as applied in core only while `coreUp` is set. */
function fakeEdge() {
  const state = { coreUp: false, edgeRevision: 0, coreRevision: 0, pushes: [] as DataPlaneSyncSnapshot[] };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("X-Slipgate-Internal-Token") !== INTERNAL) return new Response("forbidden", { status: 403 });
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/internal/net/dataplane/sync") {
        const snap = (await req.json()) as DataPlaneSyncSnapshot;
        state.pushes.push(snap);
        state.edgeRevision = snap.revisionUnixMs;
        if (!state.coreUp) {
          return Response.json(
            { ok: true, degradedCoreSync: true, coreApplied: false, warning: "slipgate-core offline", revisionUnixMs: snap.revisionUnixMs, coreRevisionUnixMs: state.coreRevision },
            { status: 202 },
          );
        }
        state.coreRevision = snap.revisionUnixMs;
        return Response.json({ ok: true, coreApplied: true, revisionUnixMs: snap.revisionUnixMs, coreRevisionUnixMs: snap.revisionUnixMs });
      }
      if (req.method === "GET" && url.pathname === "/internal/net/dataplane/sync-status") {
        return Response.json({
          revisionUnixMs: state.edgeRevision,
          coreConfigured: true,
          coreRevisionUnixMs: state.coreRevision,
          corePending: state.coreRevision !== state.edgeRevision,
          lastCoreError: state.coreUp ? undefined : "slipgate-core offline",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { state, server };
}

async function bootstrap() {
  const app = createBffApp({
    jwtSecret: "publish-test-jwt-secret-32-bytes-min",
    vaultSecret: "publish-test-vault-secret-32-bytes-min",
    internalToken: INTERNAL,
  });
  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  };
  const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Publish Test",
    adminEmail: "admin@publish.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  const snapshot = async () =>
    (await call<DataPlaneSyncSnapshot>("GET", "/api/v1/internal/dataplane/snapshot", { "X-Slipgate-Internal-Token": INTERNAL })).body;
  const status = async () => (await call<DataPlaneSyncStatus>("GET", "/api/v1/admin/system/dataplane-sync", admin)).body;
  return { call, admin, snapshot, status };
}

describe("config publish confirmation", () => {
  it("classifies pushes and states", () => {
    expect(pushOutcome(200, { coreApplied: true })).toEqual({ outcome: "applied", error: null });
    expect(pushOutcome(200, {})).toEqual({ outcome: "applied", error: null }); // an edge without coreApplied
    expect(pushOutcome(202, { degradedCoreSync: true, warning: "core down" })).toEqual({ outcome: "pending_core", error: "core down" });
    expect(pushOutcome(200, { coreApplied: false })).toEqual({ outcome: "pending_core", error: null });
    expect(pushOutcome(200, { stale: true, coreApplied: false })).toEqual({ outcome: "stale", error: null });
    expect(pushOutcome(502, null)).toEqual({ outcome: "failed", error: "HTTP 502" });
    const edge = { revisionUnixMs: 5, coreConfigured: true, coreRevisionUnixMs: 5, corePending: false };
    expect(syncState(5, edge)).toBe("applied");
    expect(syncState(6, edge)).toBe("pending_edge");
    expect(syncState(5, { ...edge, coreRevisionUnixMs: 4, corePending: true })).toBe("pending_core");
    expect(syncState(null, { ...edge, coreConfigured: false, coreRevisionUnixMs: 0 })).toBe("applied");
  });

  it("falls back to the last push outcome for an edge without a status endpoint", async () => {
    const { DataPlanePublishTracker } = await import("../dataplane_sync.ts");
    const tracker = new DataPlanePublishTracker();
    const opts = { standalone: false, edgeError: "HTTP 404", nowMs: Date.now(), legacyEdge: true };
    expect(tracker.status(null, opts).state).toBe("unreachable");
    tracker.notePush(Date.now(), "applied", null);
    expect(tracker.status(null, opts).state).toBe("applied");
    tracker.notePush(Date.now(), "pending_core", "core down");
    expect(tracker.status(null, opts)).toMatchObject({ state: "pending_core", error: "core down" });
    expect(tracker.status(null, { ...opts, legacyEdge: false }).state).toBe("unreachable");
  });

  it("keeps pending unbans until slipgate-core acknowledges, and reports the publish state", async () => {
    const { call, admin, snapshot, status } = await bootstrap();
    expect((await status()).state).toBe("standalone");

    const { state, server } = fakeEdge();
    try {
      process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${server.port}`;

      // Core offline: the push is answered 202, so the unban is not retired.
      const unbanA = await call("POST", "/api/v1/admin/risk/unban", admin, { subjectKind: "api_key", subjectHash: "subj_a" });
      expect(unbanA.status).toBe(200);
      expect(state.pushes.at(-1)?.clearedRiskSubjects).toContain("subj_a");
      const pending = await status();
      expect(pending.state).toBe("pending_core");
      expect(pending.lastPushOutcome).toBe("pending_core");
      expect(pending.error).toBe("slipgate-core offline");
      expect(pending.edgeRevisionUnixMs).toBe(pending.desiredRevisionUnixMs);
      expect((await snapshot()).clearedRiskSubjects).toContain("subj_a");

      // Core back: the next push is acknowledged and retires both pending unbans.
      state.coreUp = true;
      await call("POST", "/api/v1/admin/risk/unban", admin, { subjectKind: "api_key", subjectHash: "subj_b" });
      expect(state.pushes.at(-1)?.clearedRiskSubjects).toEqual(expect.arrayContaining(["subj_a", "subj_b"]));
      const applied = await status();
      expect(applied.state).toBe("applied");
      expect(applied.lastPushOutcome).toBe("applied");
      expect(applied.coreRevisionUnixMs).toBe(applied.desiredRevisionUnixMs);
      expect(applied.error).toBeNull();
      expect((await snapshot()).clearedRiskSubjects ?? []).toEqual([]);
    } finally {
      server.stop(true);
    }

    // The edge stops answering: unreachable, never "applied".
    const down = await status();
    expect(down.state).toBe("unreachable");
    expect(down.error).toBeTruthy();
  });
});
