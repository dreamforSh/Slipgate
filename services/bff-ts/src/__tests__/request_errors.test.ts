import { describe, expect, it } from "bun:test";
import type {
  RequestErrorCleanupResponse,
  RequestErrorItem,
  RequestErrorListResponse,
  RequestErrorSummary,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL_TOKEN = "reqerr-internal-secret";

type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const app = createBffApp({
    store: factory ? await factory() : undefined,
    jwtSecret: "reqerr-test-jwt-secret-32-bytes-min",
    vaultSecret: "reqerr-test-vault-secret-32-bytes",
    internalToken: INTERNAL_TOKEN,
  });

  const call = async <T>(
    method: string,
    path: string,
    headers: Record<string, string> = JSON_HEADERS,
    body?: unknown,
  ) => {
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

  const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Error Center Test",
    adminEmail: "admin@err.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };

  const reg = await call<{ accessToken: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
    email: "user@err.test",
    password: "UserPassword123!",
  });
  expect(reg.status).toBe(201);
  const user = { ...JSON_HEADERS, Authorization: `Bearer ${reg.body.accessToken}` };

  return { call, admin, user };
}

describe("Request & Upstream Error Center (Lane O1)", () => {
  it("requires internal token on ingest and redacts secret material in error text, bodies and metadata", async () => {
    const { call, admin } = await bootstrap();

    const denied = await call("POST", "/api/v1/internal/dataplane/request-errors", JSON_HEADERS, {
      requestId: "req_unauth",
      phase: "upstream_http",
      statusCode: 502,
    });
    expect(denied.status).toBe(403);

    const batchRes = await call<{ ok: boolean; accepted: number }>(
      "POST",
      "/api/v1/internal/dataplane/request-errors",
      { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL_TOKEN },
      {
        items: [
          {
            requestId: "req_upstream_429",
            clientRequestId: "cli_1",
            platform: "openai",
            model: "gpt-5.2",
            upstreamModel: "gpt-5.2",
            phase: "upstream_http",
            kind: "upstream_http_429",
            statusCode: 429,
            upstreamStatus: 429,
            errorType: "rate_limit_error",
            errorCode: "rate_limit_exceeded",
            errorMessage: "Authorization: Bearer sk-proj-supersecretvalue123456 triggered limit",
            upstreamBody: JSON.stringify({
              error: { message: "quota reached", apiKey: "sk-live-secret9999999999" },
            }),
            attempt: 1,
            failoverUsed: true,
            durationMs: 245,
            executionMode: "direct_api",
            metadata: { token: "raw-token-value", path: "/v1/chat/completions" },
          },
          {
            requestId: "req_outbound_502",
            platform: "anthropic",
            model: "claude-sonnet-4-5",
            phase: "outbound",
            kind: "outbound_dispatch_failed",
            statusCode: 502,
            upstreamStatus: 0,
            errorType: "upstream_error",
            errorCode: "outbound_dispatch_failed",
            errorMessage: "dial tcp timeout",
            upstreamBody: "",
            attempt: 2,
            failoverUsed: false,
            durationMs: 1200,
          },
        ],
      },
    );
    expect(batchRes.status).toBe(200);
    expect(batchRes.body).toEqual({ ok: true, accepted: 2 });

    const list = await call<RequestErrorListResponse>("GET", "/api/v1/admin/ops/request-errors?page=1&pageSize=10", admin);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    const e429 = list.body.items.find((x) => x.requestId === "req_upstream_429");
    expect(e429).toBeTruthy();
    expect(e429!.errorMessage).not.toContain("sk-proj-supersecretvalue123456");
    expect(e429!.upstreamBody).not.toContain("sk-live-secret9999999999");
    expect(e429!.upstreamBody).toContain("[redacted]");
    expect(e429!.metadata.token).toBe("[redacted]");
  });

  it("supports summary aggregation, resolve/reopen transitions, and filtered cleanup", async () => {
    const { call, admin, user } = await bootstrap();

    const userForbidden = await call("GET", "/api/v1/admin/ops/request-errors", user);
    expect(userForbidden.status).toBe(403);

    const internalHeaders = { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL_TOKEN };
    await call("POST", "/api/v1/internal/dataplane/request-errors", internalHeaders, {
      requestId: "req_single_500",
      phase: "stream_relay",
      kind: "stream_relay_interrupted",
      statusCode: 502,
      upstreamStatus: 200,
      model: "claude-opus-4-6",
      errorMessage: "unexpected EOF",
    });

    const summary = await call<RequestErrorSummary>("GET", "/api/v1/admin/ops/request-errors/summary", admin);
    expect(summary.status).toBe(200);
    expect(summary.body.total).toBe(1);
    expect(summary.body.openCount).toBe(1);
    expect(summary.body.status5xx).toBe(1);

    const list = await call<RequestErrorListResponse>("GET", "/api/v1/admin/ops/request-errors", admin);
    const id = list.body.items[0]!.id;

    const detail = await call<{ item: RequestErrorItem }>("GET", `/api/v1/admin/ops/request-errors/${id}`, admin);
    expect(detail.status).toBe(200);
    expect(detail.body.item.requestId).toBe("req_single_500");

    const resolved = await call<{ item: RequestErrorItem }>(
      "POST",
      `/api/v1/admin/ops/request-errors/${id}/resolve`,
      admin,
      { resolved: true },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.item.resolved).toBe(true);
    expect(resolved.body.item.resolvedBy).toBeTruthy();

    const badCleanup = await call("POST", "/api/v1/admin/ops/request-errors/cleanup", admin, {});
    expect(badCleanup.status).toBe(400);

    const cleaned = await call<RequestErrorCleanupResponse>(
      "POST",
      "/api/v1/admin/ops/request-errors/cleanup",
      admin,
      { resolvedOnly: true },
    );
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.deleted).toBe(1);

    const after = await call<RequestErrorListResponse>("GET", "/api/v1/admin/ops/request-errors", admin);
    expect(after.body.total).toBe(0);
  });

  it("filters by group and by a model substring (the usage page's errors tab)", async () => {
    const { call, admin } = await bootstrap();
    const internalHeaders = { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL_TOKEN };
    for (const [requestId, groupId, model] of [
      ["req_g1_opus", "grp_default", "claude-opus-4-6"],
      ["req_g1_mini", "grp_default", "gpt-4.1-mini"],
      ["req_g2_opus", "grp_other", "claude-opus-4-6"],
    ] as const) {
      const res = await call("POST", "/api/v1/internal/dataplane/request-errors", internalHeaders, {
        requestId,
        groupId,
        phase: "upstream_http",
        kind: "upstream_status",
        statusCode: 502,
        upstreamStatus: 529,
        model,
        errorMessage: "overloaded",
      });
      expect(res.status).toBeLessThan(300);
    }
    const ids = async (qs: string) =>
      (await call<RequestErrorListResponse>("GET", `/api/v1/admin/ops/request-errors?${qs}`, admin)).body.items.map((i) => i.requestId).sort();
    expect(await ids("groupId=grp_default")).toEqual(["req_g1_mini", "req_g1_opus"]);
    expect(await ids("modelContains=OPUS")).toEqual(["req_g1_opus", "req_g2_opus"]);
    expect(await ids("groupId=grp_default&modelContains=opus")).toEqual(["req_g1_opus"]);
    expect(await ids("model=opus")).toEqual([]);
  });
});
