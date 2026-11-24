import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "bun:test";
import { createBffApp } from "../app.ts";

async function initAdminHeaders(app: ReturnType<typeof createBffApp>, password = "AdminPassword123!") {
  const initRes = await app.request("/api/v1/setup/initialize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteName: "Slipgate Test",
      adminEmail: "admin@slipgate.dev",
      adminPassword: password,
      allowRegistration: false,
    }),
  });
  expect(initRes.status).toBe(201);
  const session = (await initRes.json()) as { accessToken: string };
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${session.accessToken}`,
  };
}

describe("admin system update routes", () => {
  it("handles standalone status, releases, policy config updates, and step-up guarded rollback", async () => {
    const prevUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    const prevToken = process.env.SLIPGATE_INTERNAL_TOKEN;
    delete process.env.SLIPGATE_NET_INTERNAL_URL;
    delete process.env.SLIPGATE_INTERNAL_TOKEN;

    try {
      const app = createBffApp({
        jwtSecret: "test-jwt-secret-32-bytes-minimum",
        vaultSecret: "test-vault-secret-32-bytes-minimum",
      });
      const headers = await initAdminHeaders(app);

      const statusRes = await app.request("/api/v1/admin/system/update", { headers });
      expect(statusRes.status).toBe(200);
      const status = (await statusRes.json()) as { standalone: boolean; channel: string; canRollback: boolean };
      expect(status.standalone).toBe(true);
      expect(status.channel).toBe("stable");
      expect(status.canRollback).toBe(false);

      const relRes = await app.request("/api/v1/admin/system/update/releases", { headers });
      expect(relRes.status).toBe(200);
      const relBody = (await relRes.json()) as { standalone: boolean; releases: unknown[] };
      expect(relBody.standalone).toBe(true);
      expect(relBody.releases).toEqual([]);

      const cfgRes = await app.request("/api/v1/admin/system/update/config", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          channel: "dev",
          autoSyncEnabled: true,
          intervalSeconds: 300,
          autoRestartAfterUpdate: false,
          strategy: "release",
        }),
      });
      expect(cfgRes.status).toBe(200);
      const cfgBody = (await cfgRes.json()) as {
        channel: string;
        autoSyncEnabled: boolean;
        intervalSeconds: number;
        autoRestartAfterUpdate: boolean;
      };
      expect(cfgBody.channel).toBe("dev");
      expect(cfgBody.autoSyncEnabled).toBe(true);
      expect(cfgBody.intervalSeconds).toBe(300);
      expect(cfgBody.autoRestartAfterUpdate).toBe(false);

      // Rollback without step-up confirmation is rejected (403)
      const rbNoStepUp = await app.request("/api/v1/admin/system/update/rollback", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(rbNoStepUp.status).toBe(403);

      // Rollback with valid password step-up fails cleanly in standalone mode (409)
      const rbStandalone = await app.request("/api/v1/admin/system/update/rollback", {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: { password: "AdminPassword123!" } }),
      });
      expect(rbStandalone.status).toBe(409);

      // Restart without step-up confirmation is rejected (403), with step-up returns 409 in standalone mode
      const rstNoStepUp = await app.request("/api/v1/admin/system/update/restart", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(rstNoStepUp.status).toBe(403);

      const rstStandalone = await app.request("/api/v1/admin/system/update/restart", {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: { password: "AdminPassword123!" } }),
      });
      expect(rstStandalone.status).toBe(409);
    } finally {
      if (prevUrl !== undefined) process.env.SLIPGATE_NET_INTERNAL_URL = prevUrl;
      else delete process.env.SLIPGATE_NET_INTERNAL_URL;
      if (prevToken !== undefined) process.env.SLIPGATE_INTERNAL_TOKEN = prevToken;
      else delete process.env.SLIPGATE_INTERNAL_TOKEN;
    }
  });

  it("enforces admin step-up on release apply/rollback/restart and strips credentials before proxying to supervisor", async () => {
    const receivedSyncPayloads: Array<Record<string, unknown>> = [];
    const receivedRollbackPayloads: Array<Record<string, unknown>> = [];
    const receivedRestartPayloads: Array<Record<string, unknown>> = [];
    let currentChannel = "stable";
    let autoRestartAfterUpdate = true;

    const mockSupervisor = createServer((req, res) => {
      if (req.headers["x-slipgate-internal-token"] !== "test-internal-token") {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        const jsonBody = bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : {};
        res.setHeader("Content-Type", "application/json");

        const baseStatus = {
          mode: "release",
          channel: currentChannel,
          standalone: false,
          strategy: "release",
          resolvedStrategy: "release",
          repo: "dreamforSh/Slipgate",
          branch: "main",
          version: "0.2.0",
          activeCommit: "22222222aaaa",
          remoteCommit: "33333333bbbb",
          remoteVersion: "0.3.0",
          remoteTag: "v0.3.0",
          updateAvailable: true,
          autoSyncEnabled: true,
          intervalSeconds: 3600,
          autoRestartAfterUpdate,
          restartScheduled: false,
          bootId: "boot-1",
          state: "idle",
          reloadCount: 1,
          webUiOverridden: true,
          edgeBinaryStaged: false,
          canRollback: true,
          lastCheckedAtIso: "2026-11-24T01:00:00Z",
          lastUpdatedAtIso: null,
          lastError: null,
        };

        if (req.method === "GET" && req.url === "/internal/supervisor/update") {
          res.end(JSON.stringify(baseStatus));
          return;
        }
        if (req.method === "GET" && req.url?.startsWith("/internal/supervisor/update/releases")) {
          res.end(
            JSON.stringify({
              repo: "dreamforSh/Slipgate",
              currentVersion: "0.2.0",
              currentCommit: "22222222aaaa",
              standalone: false,
              fetchedAtIso: "2026-11-24T01:00:00Z",
              releases: [
                {
                  tag: "v0.3.0",
                  name: "v0.3.0",
                  version: "0.3.0",
                  channel: "stable",
                  prerelease: false,
                  body: "- Improvements",
                  installable: true,
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/internal/supervisor/update/sync") {
          receivedSyncPayloads.push(jsonBody);
          res.end(JSON.stringify({ ...baseStatus, version: "0.3.0", updateAvailable: false }));
          return;
        }
        if (req.method === "PUT" && req.url === "/internal/supervisor/update/config") {
          if (typeof jsonBody.channel === "string") currentChannel = jsonBody.channel;
          if (typeof jsonBody.autoRestartAfterUpdate === "boolean") {
            autoRestartAfterUpdate = jsonBody.autoRestartAfterUpdate;
          }
          res.end(JSON.stringify({ ...baseStatus, channel: currentChannel, autoRestartAfterUpdate }));
          return;
        }
        if (req.method === "POST" && req.url === "/internal/supervisor/update/rollback") {
          receivedRollbackPayloads.push(jsonBody);
          res.end(JSON.stringify({ ...baseStatus, version: "0.1.0", canRollback: false }));
          return;
        }
        if (req.method === "POST" && req.url === "/internal/supervisor/update/restart") {
          receivedRestartPayloads.push(jsonBody);
          res.end(
            JSON.stringify({
              ...baseStatus,
              state: "restarting",
              restartScheduled: true,
              bootId: "boot-2",
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not_found" }));
      });
    });

    await new Promise<void>((resolve) => mockSupervisor.listen(0, "127.0.0.1", () => resolve()));
    const addr = mockSupervisor.address() as AddressInfo;

    const prevUrl = process.env.SLIPGATE_NET_INTERNAL_URL;
    const prevToken = process.env.SLIPGATE_INTERNAL_TOKEN;
    process.env.SLIPGATE_NET_INTERNAL_URL = `http://127.0.0.1:${addr.port}`;
    process.env.SLIPGATE_INTERNAL_TOKEN = "test-internal-token";

    try {
      const app = createBffApp({
        jwtSecret: "test-jwt-secret-32-bytes-minimum",
        vaultSecret: "test-vault-secret-32-bytes-minimum",
      });
      const headers = await initAdminHeaders(app);

      // checkOnly works without step-up
      const checkRes = await app.request("/api/v1/admin/system/update/sync", {
        method: "POST",
        headers,
        body: JSON.stringify({ checkOnly: true }),
      });
      expect(checkRes.status).toBe(200);
      expect(receivedSyncPayloads.length).toBe(1);
      expect(receivedSyncPayloads[0]?.allowReleaseApply).toBe(false);

      // Apply in release mode without confirm -> 403 step_up_required
      const blockedApply = await app.request("/api/v1/admin/system/update/sync", {
        method: "POST",
        headers,
        body: JSON.stringify({ checkOnly: false, targetTag: "v0.3.0" }),
      });
      expect(blockedApply.status).toBe(403);
      expect(((await blockedApply.json()) as { error: string }).error).toBe("step_up_required");

      // Apply with valid password step-up -> 200 & strips confirm before calling supervisor
      const approvedApply = await app.request("/api/v1/admin/system/update/sync", {
        method: "POST",
        headers,
        body: JSON.stringify({
          checkOnly: false,
          targetTag: "v0.3.0",
          confirm: { password: "AdminPassword123!" },
        }),
      });
      expect(approvedApply.status).toBe(200);
      expect(receivedSyncPayloads.length).toBe(2);
      expect(receivedSyncPayloads[1]?.allowReleaseApply).toBe(true);
      expect(receivedSyncPayloads[1]?.targetTag).toBe("v0.3.0");
      expect("confirm" in (receivedSyncPayloads[1] ?? {})).toBe(false);

      // Releases catalog & config update work via supervisor (including autoRestartAfterUpdate)
      const relRes = await app.request("/api/v1/admin/system/update/releases?refresh=1", { headers });
      expect(relRes.status).toBe(200);
      expect(((await relRes.json()) as { releases: Array<{ tag: string }> }).releases[0]?.tag).toBe("v0.3.0");

      const cfgRes = await app.request("/api/v1/admin/system/update/config", {
        method: "PUT",
        headers,
        body: JSON.stringify({ channel: "dev", autoRestartAfterUpdate: false }),
      });
      expect(cfgRes.status).toBe(200);
      const cfgPayload = (await cfgRes.json()) as { channel: string; autoRestartAfterUpdate: boolean };
      expect(cfgPayload.channel).toBe("dev");
      expect(cfgPayload.autoRestartAfterUpdate).toBe(false);

      // Rollback enforces step-up & forwards releaseId
      const blockedRollback = await app.request("/api/v1/admin/system/update/rollback", {
        method: "POST",
        headers,
        body: JSON.stringify({ releaseId: "rel-1" }),
      });
      expect(blockedRollback.status).toBe(403);

      const okRollback = await app.request("/api/v1/admin/system/update/rollback", {
        method: "POST",
        headers,
        body: JSON.stringify({
          releaseId: "rel-1",
          confirm: { password: "AdminPassword123!" },
        }),
      });
      expect(okRollback.status).toBe(200);
      expect(receivedRollbackPayloads[0]?.releaseId).toBe("rel-1");
      expect("confirm" in (receivedRollbackPayloads[0] ?? {})).toBe(false);

      // Restart enforces step-up in release mode, strips confirm, and returns restarting state
      const blockedRestart = await app.request("/api/v1/admin/system/update/restart", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(blockedRestart.status).toBe(403);

      const okRestart = await app.request("/api/v1/admin/system/update/restart", {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: { password: "AdminPassword123!" } }),
      });
      expect(okRestart.status).toBe(200);
      const restartBody = (await okRestart.json()) as {
        state: string;
        restartScheduled: boolean;
        bootId: string;
      };
      expect(restartBody.state).toBe("restarting");
      expect(restartBody.restartScheduled).toBe(true);
      expect(restartBody.bootId).toBe("boot-2");
      expect(receivedRestartPayloads.length).toBe(1);
      expect("confirm" in (receivedRestartPayloads[0] ?? {})).toBe(false);
    } finally {
      await new Promise<void>((resolve) => mockSupervisor.close(() => resolve()));
      if (prevUrl !== undefined) process.env.SLIPGATE_NET_INTERNAL_URL = prevUrl;
      else delete process.env.SLIPGATE_NET_INTERNAL_URL;
      if (prevToken !== undefined) process.env.SLIPGATE_INTERNAL_TOKEN = prevToken;
      else delete process.env.SLIPGATE_INTERNAL_TOKEN;
    }
  });
});
