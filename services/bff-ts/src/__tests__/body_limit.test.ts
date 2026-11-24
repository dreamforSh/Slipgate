import { describe, expect, test } from "bun:test";
import { API_BODY_LIMIT_BYTES, createBffApp } from "../app.ts";

const TOKEN = "body-limit-internal-token-0123456789abcdef";
const JSON_HEADERS = { "Content-Type": "application/json" };

describe("request body limits", () => {
  const app = createBffApp({ internalToken: TOKEN });
  const oversized = JSON.stringify({ pad: "x".repeat(API_BODY_LIMIT_BYTES) });

  test("console API bodies over the limit are refused with 413", async () => {
    const res = await app.request("/api/v1/auth/login", { method: "POST", headers: JSON_HEADERS, body: oversized });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe("payload_too_large");
  });

  test("ordinary bodies pass through", async () => {
    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "nobody@example.com", password: "not-the-password" }),
    });
    expect(res.status).not.toBe(413);
  });

  test("internal data-plane callbacks are not held to the console limit", async () => {
    const res = await app.request("/api/v1/internal/dataplane/media-tasks", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Slipgate-Internal-Token": TOKEN },
      body: oversized,
    });
    expect(res.status).not.toBe(413);
  });
});
