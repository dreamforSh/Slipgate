import { describe, expect, it } from "bun:test";
import { createBffApp } from "../app.ts";

describe("slipgate-bff ControlPlane IAM, Pool, and API Key CRUD", () => {
  it("reports healthy BFF plane status and blocks unauthenticated admin access", async () => {
    const app = createBffApp();
    const healthRes = await app.request("/api/v1/health");
    expect(healthRes.status).toBe(200);
    const body = (await healthRes.json()) as { service: string; planes: { bff: string } };
    expect(body.service).toBe("slipgate-bff");
    expect(body.planes.bff).toBe("up");

    const unauthRes = await app.request("/api/v1/admin/vms/slots");
    expect(unauthRes.status).toBe(401);

    const unauthUpdateRes = await app.request("/api/v1/admin/system/update");
    expect(unauthUpdateRes.status).toBe(401);
  });

  it("enforces one-time setup, admin RBAC, encrypted account pool CRUD, and user API keys", async () => {
    const app = createBffApp({
      jwtSecret: "test-jwt-secret-32-bytes-minimum",
      vaultSecret: "test-vault-secret-32-bytes-minimum",
    });

    const preStatus = await app.request("/api/v1/setup/status");
    expect(preStatus.status).toBe(200);
    expect(((await preStatus.json()) as { initialized: boolean }).initialized).toBe(false);

    // 1. Initialize admin
    const initRes = await app.request("/api/v1/setup/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteName: "Slipgate Test",
        adminEmail: "admin@slipgate.dev",
        adminPassword: "AdminPassword123!",
        allowRegistration: true,
      }),
    });
    expect(initRes.status).toBe(201);
    const adminSession = (await initRes.json()) as {
      accessToken: string;
      user: { id: string; role: string };
    };
    expect(adminSession.user.role).toBe("admin");

    // Replaying setup must conflict (409)
    const replayRes = await app.request("/api/v1/setup/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteName: "Hack",
        adminEmail: "other@slipgate.dev",
        adminPassword: "AdminPassword123!",
      }),
    });
    expect(replayRes.status).toBe(409);

    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminSession.accessToken}`,
    };

    // 2. Admin routes require valid admin token
    const slotsRes = await app.request("/api/v1/admin/vms/slots", { headers: adminHeaders });
    expect(slotsRes.status).toBe(200);
    const slotsBody = (await slotsRes.json()) as { slots: Array<{ hypervisorKind: string; maxSubagents: number }> };
    expect(slotsBody.slots[0]?.hypervisorKind).toBe("kvm_qemu");

    const updateStatusRes = await app.request("/api/v1/admin/system/update", { headers: adminHeaders });
    expect(updateStatusRes.status).toBe(200);
    const updateStatusBody = (await updateStatusRes.json()) as { repo: string; branch: string };
    expect(updateStatusBody.repo).toBe("dreamforSh/Slipgate");
    expect(updateStatusBody.branch).toBe("main");

    const updateSyncRes = await app.request("/api/v1/admin/system/update/sync", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ checkOnly: true }),
    });
    expect(updateSyncRes.status).toBe(200);

    const clashOverviewRes = await app.request("/api/v1/admin/clash/overview", { headers: adminHeaders });
    expect(clashOverviewRes.status).toBe(200);
    const clashOverview = (await clashOverviewRes.json()) as {
      profiles: Array<{ id: string }>;
      policy: { failClosed: boolean };
    };
    expect(clashOverview.policy.failClosed).toBe(true);
    expect(clashOverview.profiles.some((p) => p.id === "chrome-131")).toBe(true);

    const tlsCreateRes = await app.request("/api/v1/admin/tls-profiles", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "Custom Safari Pool",
        clientHelloPreset: "safari_auto",
        alpnProtocols: ["h2", "http/1.1"],
      }),
    });
    expect(tlsCreateRes.status).toBe(201);

    // 3. Create group + upstream account (secret encrypted & masked)
    const grpRes = await app.request("/api/v1/admin/groups", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "claude-pro-pool",
        platform: "anthropic",
        subscriptionType: "subscription",
        rateMultiplier: 1.2,
      }),
    });
    expect(grpRes.status).toBe(201);
    const { group } = (await grpRes.json()) as { group: { id: string } };

    const rawSecret = "sk-ant-oat01-very-secret-upstream-token-9999";
    const accRes = await app.request("/api/v1/admin/accounts", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "tokyo-vm-claude-01",
        groupId: group.id,
        platform: "anthropic",
        executionMode: "vm_slot",
        authKind: "vm_cli_seed",
        credentialSecret: rawSecret,
        maxConcurrency: 20,
      }),
    });
    expect(accRes.status).toBe(201);
    const { account } = (await accRes.json()) as {
      account: { id: string; credentialPreview: string; executionMode: string };
    };
    expect(account.executionMode).toBe("vm_slot");
    expect(account.credentialPreview).toBe("sk-ant...9999");

    // 4. Composite route preview works with admin auth
    const previewRes = await app.request("/api/v1/admin/routes/preview", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        groupId: group.id,
        publicModel: "claude-sonnet-4-5",
        endpoint: "messages",
      }),
    });
    expect(previewRes.status).toBe(200);

    // 5. Register standard user -> blocked from admin routes (403), allowed user API key CRUD
    const regRes = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "dev@slipgate.dev",
        password: "UserPassword123!",
      }),
    });
    expect(regRes.status).toBe(201);
    const userSession = (await regRes.json()) as {
      accessToken: string;
      user: { id: string; role: string };
    };
    expect(userSession.user.role).toBe("user");

    const userHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userSession.accessToken}`,
    };

    const forbiddenRes = await app.request("/api/v1/admin/accounts", { headers: userHeaders });
    expect(forbiddenRes.status).toBe(403);

    // Admin credits user's wallet
    const creditRes = await app.request(`/api/v1/admin/users/${userSession.user.id}/credit`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ amountUsd: "15.50" }),
    });
    expect(creditRes.status).toBe(200);

    const meRes = await app.request("/api/v1/auth/me", { headers: userHeaders });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { wallet: { formattedAvailableUsd: string } };
    expect(meBody.wallet.formattedAvailableUsd).toBe("$15.5");

    // User creates and manages API key
    const createKeyRes = await app.request("/api/v1/user/api-keys", {
      method: "POST",
      headers: userHeaders,
      body: JSON.stringify({
        name: "claude-code-laptop",
        groupId: group.id,
        rpmLimit: 120,
        concurrencyLimit: 8,
      }),
    });
    expect(createKeyRes.status).toBe(201);
    const createdKey = (await createKeyRes.json()) as {
      plaintextKey: string;
      item: { id: string; keyPrefix: string; enabled: boolean };
    };
    expect(createdKey.plaintextKey.startsWith("sk-sg-")).toBe(true);

    const toggleRes = await app.request(`/api/v1/user/api-keys/${createdKey.item.id}`, {
      method: "PATCH",
      headers: userHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggleRes.status).toBe(200);

    const delRes = await app.request(`/api/v1/user/api-keys/${createdKey.item.id}`, {
      method: "DELETE",
      headers: userHeaders,
    });
    expect(delRes.status).toBe(200);
  });

  it("exposes wire uTLS profiles and fail-closed VM fleet admin routes", async () => {
    const app = createBffApp();
    const setupRes = await app.request("/api/v1/setup/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Slipgate VM Test",
        adminEmail: "admin@vm.test",
        adminPassword: "StrongPassword123!",
      }),
    });
    const { accessToken } = (await setupRes.json()) as { accessToken: string };
    const adminHeaders = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    };

    const tlsListRes = await app.request("/api/v1/admin/tls-profiles", { headers: adminHeaders });
    expect(tlsListRes.status).toBe(200);
    const tlsListBody = (await tlsListRes.json()) as { profiles: Array<{ id: string }> };
    expect(tlsListBody.profiles.some((p) => p.id === "claude-bun-21")).toBe(true);
    expect(tlsListBody.profiles.some((p) => p.id === "codex-rustls-01")).toBe(true);
    expect(tlsListBody.profiles.some((p) => p.id === "antigravity-electron-15")).toBe(true);
    expect(tlsListBody.profiles.some((p) => p.id === "auto")).toBe(true);

    const putLocked = await app.request("/api/v1/admin/tls-profiles/claude-bun-21", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Cannot Mutate Builtin" }),
    });
    expect(putLocked.status).toBe(403);

    const putAgLocked = await app.request("/api/v1/admin/tls-profiles/antigravity-electron-15", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Cannot Mutate Antigravity Builtin" }),
    });
    expect(putAgLocked.status).toBe(403);

    const putCustom = await app.request("/api/v1/admin/tls-profiles/custom-bun-1", {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ name: "Custom Bun Updated", enableGrease: true, curves: [4588, 29] }),
    });
    expect(putCustom.status).toBe(200);

    const vmOverviewRes = await app.request("/api/v1/admin/vms/overview", { headers: adminHeaders });
    expect(vmOverviewRes.status).toBe(200);
    const vmOverview = (await vmOverviewRes.json()) as {
      nodes: Array<{ id: string }>;
      invariants: { oneSlotOneEgress: boolean };
    };
    expect(vmOverview.nodes.some((n) => n.id === "local-node")).toBe(true);
    expect(vmOverview.invariants.oneSlotOneEgress).toBe(true);

    const vmBadCreate = await app.request("/api/v1/admin/vms/slots", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ accountId: "acc-unbound" }),
    });
    expect(vmBadCreate.status).toBe(503);
  });

  it("synchronizes DataPlane snapshots, composite routes, idempotent nano-USD settlements, and risk events", async () => {
    const internalToken = "internal-dp-bridge-secret";
    const app = createBffApp({
      jwtSecret: "dp-test-jwt-secret-32-bytes-minimum",
      vaultSecret: "dp-test-vault-secret-32-bytes-minimum",
      internalToken,
    });

    const setupRes = await app.request("/api/v1/setup/initialize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        siteName: "Slipgate DataPlane Test",
        adminEmail: "admin@dp.test",
        adminPassword: "StrongPassword123!",
      }),
    });
    expect(setupRes.status).toBe(201);
    const { accessToken, user } = (await setupRes.json()) as {
      accessToken: string;
      user: { id: string };
    };
    const adminHeaders = {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    };

    // Credit $10.000000000 -> 10_000_000_000 nano-USD
    const creditRes = await app.request(`/api/v1/admin/users/${user.id}/credit`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ amountUsd: "10.00" }),
    });
    expect(creditRes.status).toBe(200);

    // Create direct_api mock account (Claude Ultra 20x) + Codex Pro 25x + verify tier validation
    const accRes = await app.request("/api/v1/admin/accounts", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "mock-anthropic-ultra",
        groupId: "grp_default",
        platform: "anthropic",
        executionMode: "direct_api",
        authKind: "oauth",
        subscriptionTier: "ultra",
        credentialSecret: "mock://ok",
      }),
    });
    expect(accRes.status).toBe(201);
    const { account } = (await accRes.json()) as {
      account: { id: string; subscriptionTier: string; tierMultiplier: number };
    };
    expect(account.subscriptionTier).toBe("ultra");
    expect(account.tierMultiplier).toBe(20);

    const codex25Res = await app.request("/api/v1/admin/accounts", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "mock-codex-pro-25x",
        groupId: "grp_default",
        platform: "codex",
        executionMode: "direct_api",
        authKind: "oauth",
        subscriptionTier: "pro_25x",
        credentialSecret: "mock://ok",
      }),
    });
    expect(codex25Res.status).toBe(201);
    const { account: codexAcc } = (await codex25Res.json()) as {
      account: { subscriptionTier: string; tierMultiplier: number };
    };
    expect(codexAcc.subscriptionTier).toBe("pro_25x");
    expect(codexAcc.tierMultiplier).toBe(25);

    // Reject cross-provider tier mismatch (e.g. pro_25x on anthropic, max on codex)
    const badClaudeTier = await app.request("/api/v1/admin/accounts", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "bad-claude-tier",
        groupId: "grp_default",
        platform: "anthropic",
        subscriptionTier: "pro_25x",
        credentialSecret: "mock://ok",
      }),
    });
    expect(badClaudeTier.status).toBe(400);

    const badCodexTier = await app.request("/api/v1/admin/accounts", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "bad-codex-tier",
        groupId: "grp_default",
        platform: "codex",
        subscriptionTier: "max",
        credentialSecret: "mock://ok",
      }),
    });
    expect(badCodexTier.status).toBe(400);

    const keyRes = await app.request("/api/v1/user/api-keys", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        name: "dp-smoke-key",
        groupId: "grp_default",
      }),
    });
    expect(keyRes.status).toBe(201);
    const { item: apiKey } = (await keyRes.json()) as { item: { id: string } };

    // Create composite route rule and verify persisted preview
    const routeCreate = await app.request("/api/v1/admin/routes", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        groupId: "grp_default",
        publicModel: "sonnet-fast",
        matchType: "exact",
        targetPlatform: "anthropic",
        upstreamModel: "claude-sonnet-4-5",
        endpoint: "any",
        priority: 10,
      }),
    });
    expect(routeCreate.status).toBe(201);
    const { route } = (await routeCreate.json()) as { route: { id: string } };

    const previewPersisted = await app.request("/api/v1/admin/routes/preview", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        groupId: "grp_default",
        publicModel: "sonnet-fast",
        endpoint: "chat_completions",
      }),
    });
    expect(previewPersisted.status).toBe(200);
    const previewBody = (await previewPersisted.json()) as {
      matchedRuleId: string;
      upstreamModel: string;
      resolutionSource: string;
    };
    expect(previewBody.matchedRuleId).toBe(route.id);
    expect(previewBody.upstreamModel).toBe("claude-sonnet-4-5");
    expect(previewBody.resolutionSource).toBe("explicit_rule");

    // Verify built-in detector for Codex and Antigravity models
    const previewCodex = await app.request("/api/v1/admin/routes/preview", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        groupId: "grp_default",
        publicModel: "gpt-5-codex",
        endpoint: "responses",
      }),
    });
    expect(previewCodex.status).toBe(200);
    const codexPreviewBody = (await previewCodex.json()) as { targetPlatform: string; resolutionSource: string };
    expect(codexPreviewBody.targetPlatform).toBe("codex");
    expect(codexPreviewBody.resolutionSource).toBe("builtin_detector");

    const previewAg = await app.request("/api/v1/admin/routes/preview", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        groupId: "grp_default",
        publicModel: "antigravity/claude-sonnet-4-5",
        endpoint: "chat_completions",
      }),
    });
    expect(previewAg.status).toBe(200);
    const agPreviewBody = (await previewAg.json()) as { targetPlatform: string };
    expect(agPreviewBody.targetPlatform).toBe("antigravity");

    // Internal snapshot requires X-Slipgate-Internal-Token
    const forbiddenSnap = await app.request("/api/v1/internal/dataplane/snapshot");
    expect(forbiddenSnap.status).toBe(403);

    const internalHeaders = {
      "content-type": "application/json",
      "X-Slipgate-Internal-Token": internalToken,
    };
    const snapRes = await app.request("/api/v1/internal/dataplane/snapshot", { headers: internalHeaders });
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      accounts: Array<{ id: string; credentialsEncHex: string }>;
      apiKeys: Array<{ id: string; keyHashHex: string }>;
      routes: Array<{ id: string }>;
    };
    expect(snap.accounts.some((a) => a.id === account.id && a.credentialsEncHex.length > 24)).toBe(true);
    expect(snap.apiKeys.some((k) => k.id === apiKey.id && k.keyHashHex.length === 64)).toBe(true);
    expect(snap.routes.some((r) => r.id === route.id)).toBe(true);

    // Post turn settlement (210,000 nano-USD = $0.00021) twice to verify idempotency
    const settlePayload = {
      requestId: "req_test_settle_001",
      userId: user.id,
      apiKeyId: apiKey.id,
      accountId: account.id,
      groupId: "grp_default",
      platform: "anthropic",
      publicModel: "sonnet-fast",
      upstreamModel: "claude-sonnet-4-5",
      ingressCodec: "openai_chat",
      egressCodec: "anthropic_messages",
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costNanoUsd: "210000",
      window5hUsedBps: 4250,
      window7dUsedBps: 1500,
      ttftMs: 42,
      durationMs: 115,
      statusCode: 200,
    };
    const settle1 = await app.request("/api/v1/internal/dataplane/settlement", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify(settlePayload),
    });
    expect(settle1.status).toBe(200);
    const settle2 = await app.request("/api/v1/internal/dataplane/settlement", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify(settlePayload),
    });
    expect(settle2.status).toBe(200);

    const walletRes = await app.request("/api/v1/user/wallet", { headers: adminHeaders });
    expect(walletRes.status).toBe(200);
    const { wallet } = (await walletRes.json()) as { wallet: { balanceNanoUsd: string } };
    expect(wallet.balanceNanoUsd).toBe("9999790000");

    const usageRes = await app.request("/api/v1/user/usage", { headers: adminHeaders });
    expect(usageRes.status).toBe(200);
    const usageBody = (await usageRes.json()) as { items: Array<{ requestId: string; publicModel: string }> };
    expect(usageBody.items.length).toBe(1);
    expect(usageBody.items[0]?.publicModel).toBe("sonnet-fast");

    const accountsAfterRes = await app.request("/api/v1/admin/accounts", { headers: adminHeaders });
    expect(accountsAfterRes.status).toBe(200);
    const accountsAfterBody = (await accountsAfterRes.json()) as {
      accounts: Array<{ id: string; window5hUsedBps: number; window7dUsedBps: number }>;
    };
    const updatedAcc = accountsAfterBody.accounts.find((a) => a.id === account.id);
    expect(updatedAcc?.window5hUsedBps).toBe(4250);
    expect(updatedAcc?.window7dUsedBps).toBe(1500);

    // Post risk ban event and verify admin visibility
    const riskPost = await app.request("/api/v1/internal/dataplane/risk-events", {
      method: "POST",
      headers: internalHeaders,
      body: JSON.stringify({
        subjectKind: "api_key",
        subjectHash: apiKey.id,
        strikeLevel: 1,
        banDuration: "10m",
        reason: "prompt_distillation_signature",
        sourceRequestId: "req_risk_001",
      }),
    });
    expect(riskPost.status).toBe(200);

    const riskList = await app.request("/api/v1/admin/risk/events", { headers: adminHeaders });
    expect(riskList.status).toBe(200);
    const riskBody = (await riskList.json()) as { events: Array<{ reason: string; banDuration: string }> };
    expect(riskBody.events.some((e) => e.reason === "prompt_distillation_signature" && e.banDuration === "10m")).toBe(
      true,
    );

    const delRoute = await app.request(`/api/v1/admin/routes/${route.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    expect(delRoute.status).toBe(200);
  });
});
