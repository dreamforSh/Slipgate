import { afterEach, describe, expect, it } from "bun:test";
import { ACCOUNT_TEST_HISTORY_LIMIT, type AccountTestRun, type UpstreamAccount } from "@slipgate/contracts";
import { AccountTestTally } from "../account_test_runs.ts";
import { createBffApp } from "../app.ts";
import { AccountAutoTester } from "../autotest.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";

// Account test history: every console, scheduled and automatic test is recorded (any kind), the
// newest ACCOUNT_TEST_HISTORY_LIMIT per account are kept, and only text tests set lastTest.
// Runs against Postgres too when a test preload provides a store factory.

const storeFactory = (globalThis as { __slipgateTestStoreFactory?: () => Promise<ControlStore> }).__slipgateTestStoreFactory;
const JSON_HEADERS = { "Content-Type": "application/json" };
const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

async function bootstrap(internalToken: string) {
  const store = storeFactory ? await storeFactory() : new MemoryControlStore();
  const app = createBffApp({
    store,
    jwtSecret: "test-runs-jwt-secret-32-bytes-minimum",
    vaultSecret: "test-runs-vault-secret-32-bytes-minimum",
    internalToken,
  });
  const init = await app.request("/api/v1/setup/initialize", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ siteName: "Runs", adminEmail: "admin@runs.test", adminPassword: "Admin-pass-123!", allowRegistration: false }),
  });
  const { accessToken } = (await init.json()) as { accessToken: string };
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` };
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: admin, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  };
  const createAccount = async (name: string, platform = "openai") =>
    (
      await call<{ account: UpstreamAccount }>("POST", "/api/v1/admin/accounts", {
        name,
        platform,
        executionMode: "direct_api",
        authKind: "api_key",
        credentialSecret: `sk-${name}-0000000001`,
      })
    ).body.account;
  return { app, store, admin, call, createAccount };
}

describe("AccountTestTally", () => {
  it("folds a text test, even when lines arrive split across chunks", () => {
    const tally = new AccountTestTally("text", "");
    const stream = sse([
      { type: "start", kind: "text", model: "gpt-4o-mini" },
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo " },
      { type: "done", success: true, status: 200, durationMs: 321, ttftMs: 80 },
    ]);
    tally.feed(stream.slice(0, 17));
    tally.feed(stream.slice(17, 90));
    tally.feed(stream.slice(90));
    tally.flush();
    expect(tally.result()).toMatchObject({ ok: true, model: "gpt-4o-mini", durationMs: 321, message: "" });
    expect(tally.run("acc_1", "manual")).toMatchObject({
      accountId: "acc_1",
      source: "manual",
      kind: "text",
      ok: true,
      status: 200,
      ttftMs: 80,
      code: "",
      output: "Hello",
      mediaCount: 0,
      dimensions: null,
    });
  });

  it("counts media, keeps failure codes, dimensions and a video's last status line", () => {
    const image = new AccountTestTally("image", "");
    image.feed(
      sse([
        { type: "start", kind: "image", model: "gpt-image-1" },
        { type: "media", kind: "image", mediaUrl: "data:image/png;base64,AAAA" },
        { type: "done", kind: "image", success: false, status: 400, code: "model_not_found", message: "no image models" },
      ]),
    );
    expect(image.run("a", "manual")).toMatchObject({ ok: false, status: 400, code: "model_not_found", message: "no image models", mediaCount: 1, ttftMs: null });

    const embedding = new AccountTestTally("embedding", "");
    embedding.feed(sse([{ type: "start", kind: "embedding" }, { type: "done", success: true, status: 200, dimensions: 1536 }]));
    expect(embedding.run("a", "manual")).toMatchObject({ ok: true, dimensions: 1536, output: "" });

    const video = new AccountTestTally("video", "sora-2");
    video.feed(
      sse([
        { type: "start", kind: "video", model: "sora-2" },
        { type: "progress", kind: "video", text: "task v1: queued" },
        { type: "progress", kind: "video", text: "task v1 is still rendering after 70s; the account accepted the job" },
        { type: "done", kind: "video", success: true, status: 200, durationMs: 70_000 },
      ]),
    );
    expect(video.run("a", "manual")).toMatchObject({ ok: true, mediaCount: 0, output: "task v1 is still rendering after 70s; the account accepted the job" });

    const cut = new AccountTestTally("text", "m");
    cut.feed(sse([{ type: "start", model: "m" }, { type: "delta", text: "par" }]));
    expect(cut.run("a", "auto")).toMatchObject({ ok: false, code: "stream_interrupted", message: "stream_interrupted", output: "par" });
  });
});

describe("account test history", () => {
  const savedUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
  let netServer: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    netServer?.stop(true);
    netServer = null;
    if (savedUrl === undefined) delete process.env.SLIPGATE_NET_INTERNAL_URL;
    else process.env.SLIPGATE_NET_INTERNAL_URL = savedUrl;
  });

  it("records console tests of every kind, passes uploads through and lists them newest first", async () => {
    const seen: Record<string, unknown>[] = [];
    netServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/internal/net/dataplane/sync") return Response.json({ ok: true });
        const body = (await req.json()) as Record<string, unknown>;
        seen.push(body);
        const kind = (body.kind as string | undefined) ?? "text";
        const events =
          kind === "transcription"
            ? [
                { type: "start", kind, model: "whisper-1" },
                { type: "delta", text: "hi there" },
                { type: "done", kind, success: true, status: 200, durationMs: 900 },
              ]
            : kind === "image"
              ? [
                  { type: "start", kind, model: "gpt-image-1" },
                  { type: "media", kind, mediaUrl: "data:image/png;base64,AAAA" },
                  { type: "done", kind, success: true, status: 200, durationMs: 4000 },
                ]
              : [
                  { type: "start", kind: "text", model: "gpt-4o-mini" },
                  { type: "delta", text: "pong" },
                  { type: "done", success: true, status: 200, durationMs: 300, ttftMs: 120 },
                ];
        return new Response(sse(events), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${netServer.port}`;
    const { app, admin, call, createAccount } = await bootstrap("runs-internal-token");
    const acc = await createAccount("runs");

    const test = async (body: unknown) => {
      const res = await app.request(`/api/v1/admin/accounts/${acc.id}/test`, { method: "POST", headers: admin, body: JSON.stringify(body) });
      expect(res.status).toBe(200);
      await res.text();
    };
    await test({ prompt: "ping" });
    const audio = "data:audio/wav;base64,UklGRgAAAAA=";
    await test({ kind: "transcription", audioDataUrl: audio });
    const image = "data:image/png;base64,iVBORw0KGgo=";
    await test({ kind: "image", prompt: "blue", imageDataUrl: image });

    expect(seen[1]).toEqual({ kind: "transcription", audioDataUrl: audio });
    expect(seen[2]).toEqual({ kind: "image", prompt: "blue", imageDataUrl: image });
    // An upload must be a base64 data: URL of the right type.
    expect((await call("POST", `/api/v1/admin/accounts/${acc.id}/test`, { kind: "image", imageDataUrl: "https://img.example/x.png" })).status).toBe(400);
    expect((await call("POST", `/api/v1/admin/accounts/${acc.id}/test`, { kind: "image", imageDataUrl: "data:audio/wav;base64,AA==" })).status).toBe(400);

    const runs = (await call<{ items: AccountTestRun[] }>("GET", `/api/v1/admin/accounts/${acc.id}/test-runs`)).body.items;
    expect(runs.map((r) => [r.kind, r.source, r.ok])).toEqual([
      ["image", "manual", true],
      ["transcription", "manual", true],
      ["text", "manual", true],
    ]);
    expect(runs[0]).toMatchObject({ model: "gpt-image-1", mediaCount: 1, output: "", durationMs: 4000 });
    expect(runs[1]).toMatchObject({ model: "whisper-1", output: "hi there" });
    expect(runs[2]).toMatchObject({ model: "gpt-4o-mini", output: "pong", ttftMs: 120, status: 200 });
    expect(runs[0]!.id).toStartWith("atr_");
    expect((await call<{ items: AccountTestRun[] }>("GET", `/api/v1/admin/accounts/${acc.id}/test-runs?limit=1`)).body.items).toHaveLength(1);

    // Only the text test is the account's last test.
    const account = (await call<{ accounts: UpstreamAccount[] }>("GET", "/api/v1/admin/accounts")).body.accounts.find((a) => a.id === acc.id);
    expect(account?.lastTest).toMatchObject({ ok: true, model: "gpt-4o-mini", durationMs: 300 });

    expect((await call("GET", "/api/v1/admin/accounts/acc_missing/test-runs")).status).toBe(404);
  });

  it("keeps the newest runs per account and drops them with the account", async () => {
    const { store, call, createAccount } = await bootstrap("");
    const a = await createAccount("keep");
    const b = await createAccount("other");
    const base = Date.parse("2026-11-20T00:00:00Z");
    const run = (accountId: string, i: number) => ({
      accountId,
      atIso: new Date(base + i * 1000).toISOString(),
      source: "auto" as const,
      kind: "text" as const,
      ok: i % 2 === 0,
      model: "m",
      status: 200,
      durationMs: i,
      ttftMs: null,
      code: "",
      message: "",
      output: `#${i}`,
      mediaCount: 0,
      dimensions: null,
    });
    for (let i = 0; i < ACCOUNT_TEST_HISTORY_LIMIT + 5; i++) await store.recordAccountTestRun(run(a.id, i));
    await store.recordAccountTestRun(run(b.id, 0));

    const kept = await store.listAccountTestRuns(a.id);
    expect(kept).toHaveLength(ACCOUNT_TEST_HISTORY_LIMIT);
    expect(kept[0]!.output).toBe(`#${ACCOUNT_TEST_HISTORY_LIMIT + 4}`);
    expect(kept.at(-1)!.output).toBe("#5");
    expect(await store.listAccountTestRuns(b.id)).toHaveLength(1);
    await expect(store.recordAccountTestRun(run("acc_missing", 0))).rejects.toThrow();

    expect((await call("DELETE", `/api/v1/admin/accounts/${a.id}`)).status).toBeLessThan(300);
    expect(await store.listAccountTestRuns(a.id)).toHaveLength(0);
    expect(await store.listAccountTestRuns(b.id)).toHaveLength(1);
  });

  it("records scheduled tests with their source", async () => {
    const { store, createAccount } = await bootstrap("");
    const acc = await createAccount("sched");
    const fetchImpl = (async () =>
      new Response(sse([{ type: "start", model: "gpt-4o-mini" }, { type: "done", success: false, status: 401, code: "invalid_api_key", message: "bad key" }]), {
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const tester = new AccountAutoTester(store, () => ({ url: "http://net.invalid", token: "t" }), fetchImpl);
    await tester.saveSchedule(acc.id, { enabled: true, intervalMinutes: 60, model: "", autoRecover: false });
    const out = await tester.runSchedule(acc.id);
    expect(out.result).toMatchObject({ ok: false, message: "bad key" });
    const runs = await store.listAccountTestRuns(acc.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: "scheduled", kind: "text", ok: false, status: 401, code: "invalid_api_key", message: "bad key" });
  });
});
