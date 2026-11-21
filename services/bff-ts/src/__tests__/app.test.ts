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
});
