import { describe, expect, it } from "bun:test";
import assert from "node:assert/strict";
import { createBffApp } from "../app.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import { priceTurn } from "../routes/pricing.ts";
import type { ModelPricingRule } from "@slipgate/contracts";

const JSON_HEADERS = { "Content-Type": "application/json" };

function makeUnsignedJwt(payload: Record<string, unknown>): string {
  const hdr = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${hdr}.${body}.sig`;
}

async function bootApp(opts: { oauthFetch?: typeof fetch; internalToken?: string } = {}) {
  const store = new MemoryControlStore();
  const internalToken = opts.internalToken ?? "p1-internal-token-secret";
  const app = createBffApp({
    store,
    jwtSecret: "p1-test-jwt-secret-32-bytes-minimum!!",
    vaultSecret: "p1-test-vault-secret-32-bytes-minimum!",
    internalToken,
    oauthFetch: opts.oauthFetch,
  });
  const initRes = await app.request("/api/v1/setup/initialize", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      siteName: "P1 Test",
      adminEmail: "admin@p1.test",
      adminPassword: "AdminPassword123!",
      allowRegistration: true,
    }),
  });
  assert.equal(initRes.status, 201);
  const { accessToken, user } = (await initRes.json()) as { accessToken: string; user: { id: string } };
  return {
    store,
    app,
    adminId: user.id,
    internalToken,
    adminHeaders: { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` },
    internalHeaders: { ...JSON_HEADERS, "X-Slipgate-Internal-Token": internalToken },
  };
}

describe("P1 gateway, pricing, window reset & payment features", () => {
  it("runs interactive PKCE account OAuth start + exchange for Anthropic code#state and Codex callback URL", async () => {
    const codexIdToken = makeUnsignedJwt({
      email: "codex-pro@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_codex_777",
        chatgpt_plan_type: "pro",
      },
    });

    const mockOAuthFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://platform.claude.com/v1/oauth/token") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        assert.equal(body.grant_type, "authorization_code");
        assert.equal(body.code, "ant-auth-code-123");
        assert.ok(typeof body.code_verifier === "string" && body.code_verifier.length >= 32);
        return new Response(
          JSON.stringify({
            access_token: "sk-ant-oat01-fresh",
            refresh_token: "sk-ant-ort01-fresh",
            expires_in: 7200,
            account: { email_address: "claude-max@example.com" },
          }),
          { status: 200, headers: JSON_HEADERS },
        );
      }
      if (url === "https://auth.openai.com/oauth/token") {
        const params = new URLSearchParams(String(init?.body ?? ""));
        assert.equal(params.get("code"), "codex-code-999");
        return new Response(
          JSON.stringify({
            access_token: "eyJ-codex-access",
            refresh_token: "rt-codex-999",
            id_token: codexIdToken,
            expires_in: 3600,
          }),
          { status: 200, headers: JSON_HEADERS },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const { app, adminHeaders } = await bootApp({ oauthFetch: mockOAuthFetch });

    // 1. Anthropic code#state flow + state mismatch guard
    const startAnt = await app.request("/api/v1/admin/accounts/oauth/start", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ platform: "anthropic", addMethod: "oauth" }),
    });
    assert.equal(startAnt.status, 200);
    const antSession = (await startAnt.json()) as { sessionId: string; state: string; authorizeUrl: string };
    assert.ok(antSession.authorizeUrl.startsWith("https://claude.com/cai/oauth/authorize?"));

    const badState = await app.request("/api/v1/admin/accounts/oauth/exchange", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ sessionId: antSession.sessionId, codeInput: "ant-auth-code-123#wrong-state" }),
    });
    assert.equal(badState.status, 400);

    const okAnt = await app.request("/api/v1/admin/accounts/oauth/exchange", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ sessionId: antSession.sessionId, codeInput: `ant-auth-code-123#${antSession.state}` }),
    });
    assert.equal(okAnt.status, 200);
    const antResult = (await okAnt.json()) as { credentialSecret: string; email: string };
    assert.equal(antResult.email, "claude-max@example.com");
    assert.ok(antResult.credentialSecret.includes("sk-ant-ort01-fresh"));

    // 2. Codex localhost callback URL flow
    const startCodex = await app.request("/api/v1/admin/accounts/oauth/start", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ platform: "codex" }),
    });
    assert.equal(startCodex.status, 200);
    const codexSession = (await startCodex.json()) as { sessionId: string; state: string };

    const okCodex = await app.request("/api/v1/admin/accounts/oauth/exchange", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        sessionId: codexSession.sessionId,
        codeInput: `http://localhost:1455/auth/callback?code=codex-code-999&state=${encodeURIComponent(codexSession.state)}`,
      }),
    });
    assert.equal(okCodex.status, 200);
    const codexResult = (await okCodex.json()) as { credentialSecret: string; email: string; accountIdHint?: string; subscriptionTier: string };
    assert.equal(codexResult.email, "codex-pro@example.com");
    assert.equal(codexResult.accountIdHint, "acct_codex_777");
    assert.equal(codexResult.subscriptionTier, "pro_5x");
  });

  it("unlocks saturated 5h/7d account quota windows once windowResetAtUnixMs elapses ([H-04]) and handles internal credential/cooldown callbacks", async () => {
    const { app, store, adminHeaders, internalHeaders } = await bootApp();

    const accRes = await app.request("/api/v1/admin/accounts", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "claude-pool-1",
        groupId: "grp_default",
        platform: "anthropic",
        executionMode: "stealth_http",
        authKind: "oauth",
        subscriptionTier: "max",
        credentialSecret: '{"access_token":"old-at","refresh_token":"old-rt"}',
        maxConcurrency: 5,
        priority: 100,
        status: "active",
      }),
    });
    assert.equal(accRes.status, 201);
    const { account } = (await accRes.json()) as { account: { id: string } };

    // Saturate 5h window at 9600 bps with a short 80ms reset horizon.
    const resetSoon = Date.now() + 80;
    await store.recordTurnSettlement({
      settlementId: "stl_win_reset_1",
      requestId: "req_1",
      userId: "usr_any",
      apiKeyId: "key_any",
      accountId: account.id,
      groupId: "grp_default",
      platform: "anthropic",
      publicModel: "claude-sonnet-4-5",
      upstreamModel: "claude-sonnet-4-5",
      ingressCodec: "anthropic_messages",
      egressCodec: "anthropic_messages",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costNanoUsd: "0",
      ttftMs: 10,
      durationMs: 25,
      window5hUsedBps: 9600,
      window7dUsedBps: 0,
      window5hResetAtUnixMs: resetSoon,
      statusCode: 200,
    });

    const snapBefore = await store.exportDataPlaneSnapshot();
    const snapAccBefore = snapBefore.accounts.find((a) => a.id === account.id)!;
    assert.equal(snapAccBefore.window5hUsedBps, 9600);

    await new Promise((r) => setTimeout(r, 120));

    const snapAfter = await store.exportDataPlaneSnapshot();
    const snapAccAfter = snapAfter.accounts.find((a) => a.id === account.id)!;
    assert.equal(snapAccAfter.window5hUsedBps, 0);

    // Internal credential rotation & cooldown persistence endpoints
    const rotRes = await app.request(`/api/v1/internal/dataplane/accounts/${account.id}/credentials`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ credentialSecret: '{"access_token":"rotated-at","refresh_token":"rotated-rt"}' }),
    });
    assert.equal(rotRes.status, 200);

    const cdUntil = new Date(Date.now() + 60_000).toISOString();
    const cdRes = await app.request(`/api/v1/internal/dataplane/accounts/${account.id}/cooldown`, {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({ cooldownUntilIso: cdUntil, cooldownReason: "upstream_http_429" }),
    });
    assert.equal(cdRes.status, 200);
    const updatedAcc = await store.getAccount(account.id);
    assert.equal(updatedAcc?.effectiveStatus, "cooldown");
    assert.equal(updatedAcc?.cooldownReason, "upstream_http_429");
  });

  it("computes multi-dimensional tiered/multimodal pricing and syncs official presets", async () => {
    const { app, adminHeaders } = await bootApp();

    const syncRes = await app.request("/api/v1/admin/pricing/sync-presets", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ overwrite: false }),
    });
    assert.equal(syncRes.status, 200);
    const synced = (await syncRes.json()) as { added: number; items: ModelPricingRule[] };
    assert.ok(synced.added >= 10);

    const geminiRule = synced.items.find((r) => r.pattern === "gemini-2.5-pro*")!;
    assert.ok(geminiRule);

    // Under 200k threshold: 100k input * $1.25/1M = $0.125 = 125_000_000 nano
    const normalCost = priceTurn(
      geminiRule,
      { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      1,
    );
    assert.equal(normalCost, 125_000_000n);

    // Over 200k threshold (2x input): 300k input * $2.50/1M = $0.75 = 750_000_000 nano
    const longCtxCost = priceTurn(
      geminiRule,
      { inputTokens: 300_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      1,
    );
    assert.equal(longCtxCost, 750_000_000n);

    // Priority serviceTier (2x) vs Flex (0.5x)
    const gpt5Rule = synced.items.find((r) => r.pattern === "gpt-5*")!;
    const baseGpt = priceTurn(gpt5Rule, { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1);
    const priorityGpt = priceTurn(
      gpt5Rule,
      { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, serviceTier: "priority" },
      1,
    );
    const flexGpt = priceTurn(
      gpt5Rule,
      { inputTokens: 0, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, serviceTier: "flex" },
      1,
    );
    assert.equal(priorityGpt, baseGpt * 2n);
    assert.equal(flexGpt, baseGpt / 2n);

    // Image & video unit billing
    const dalleRule = synced.items.find((r) => r.pattern === "dall-e-3")!;
    const imgCost = priceTurn(
      dalleRule,
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, imageCount: 3 },
      1,
    );
    assert.equal(imgCost, 120_000_000n); // 3 * $0.04 = $0.12
  });

  it("supports sequential partial refunds, rejects over-remaining refunds, and filters dashboard rebates by currency ([H-10])", async () => {
    const { store, adminId } = await bootApp();

    // Create referrer + invitee to verify proportional rebate reversal & currency filtering
    const referrer = await store.registerUser("ref@p1.test", "hash");
    const buyer = await store.registerUser("buyer@p1.test", "hash");
    const affCode = await store.ops.ensureInviteCode(referrer.id);
    await store.ops.applyRegistrationExtras(buyer.id, { affCode });

    const expiresAtIso = new Date(Date.now() + 3600_000).toISOString();
    const usdOrder = await store.payments.createOrder({
      userId: buyer.id,
      kind: "recharge",
      planId: null,
      planName: "Top-up $10",
      provider: "manual",
      method: null,
      amountMinor: 1000,
      currency: "USD",
      creditNano: 10_000_000_000n, // $10
      groupId: null,
      validityDays: null,
      expiresAtIso,
    });
    await store.payments.fulfillOrder(usdOrder.id, "manual-1", { enabled: true, bps: 1000 }); // 10% = $1 rebate

    // Dashboard for CNY must NOT count USD order's $1 rebate; USD dashboard MUST count it.
    const cnyDash = await store.payments.dashboard(30, "CNY");
    const usdDash = await store.payments.dashboard(30, "USD");
    assert.equal(cnyDash.totals.rebatesNanoUsd, "0");
    assert.equal(usdDash.totals.rebatesNanoUsd, "1000000000");

    // Partial refund #1: $4.00 (400 minor) -> partially_refunded
    await store.payments.beginRefund(usdOrder.id, { amountMinor: 400, reason: "partial-1", reclaim: true, force: false });
    const afterPart1 = await store.payments.completeRefund(usdOrder.id, "rf_1");
    assert.equal(afterPart1.status, "partially_refunded");
    assert.equal(afterPart1.refundAmountMinor, 400);
    assert.equal((await store.getWallet(buyer.id)).balanceNanoUsd, "6000000000");
    assert.equal((await store.getWallet(referrer.id)).balanceNanoUsd, "600000000");

    // Attempting to refund $7.00 when only $6.00 remains must fail bad_request
    await assert.rejects(
      () => store.payments.beginRefund(usdOrder.id, { amountMinor: 700, reason: "too-much", reclaim: true, force: false }),
      /remaining refundable amount/,
    );

    // Partial refund #2: remaining $6.00 (600 minor) -> refunded
    await store.payments.beginRefund(usdOrder.id, { amountMinor: 600, reason: "partial-2", reclaim: true, force: false });
    const afterPart2 = await store.payments.completeRefund(usdOrder.id, "rf_2");
    assert.equal(afterPart2.status, "refunded");
    assert.equal(afterPart2.refundAmountMinor, 1000);
    assert.equal((await store.getWallet(buyer.id)).balanceNanoUsd, "0");
    assert.equal((await store.getWallet(referrer.id)).balanceNanoUsd, "0");
    expect(Boolean(adminId)).toBe(true);
  });
});
