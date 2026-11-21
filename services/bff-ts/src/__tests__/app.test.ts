import { describe, expect, it } from "bun:test";
import { createBffApp } from "../app.ts";

describe("slipgate-bff ControlPlane API", () => {
  const app = createBffApp();

  it("reports healthy BFF plane status", async () => {
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string; planes: { bff: string } };
    expect(body.service).toBe("slipgate-bff");
    expect(body.planes.bff).toBe("up");
  });

  it("previews explicit composite route override and fail-closed unknown models", async () => {
    const okRes = await app.request("/api/v1/admin/routes/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: "grp-mixed",
        publicModel: "claude-sonnet-4-5",
        endpoint: "messages",
        rules: [
          {
            routeId: "r-1",
            groupId: "grp-mixed",
            publicModel: "claude-sonnet-4-5",
            matchType: "exact",
            targetPlatform: "antigravity",
            upstreamModel: "claude-sonnet-4-5-thinking",
            endpoint: "messages",
            priority: 10,
            enabled: true,
          },
        ],
      }),
    });
    expect(okRes.status).toBe(200);
    const okBody = (await okRes.json()) as { targetPlatform: string; upstreamModel: string };
    expect(okBody.targetPlatform).toBe("antigravity");
    expect(okBody.upstreamModel).toBe("claude-sonnet-4-5-thinking");

    const badRes = await app.request("/api/v1/admin/routes/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: "grp-mixed",
        publicModel: "unknown-experimental-model",
        endpoint: "chat_completions",
      }),
    });
    expect(badRes.status).toBe(400);
  });

  it("exposes VM slot fleet, live seed inspection, and pre-hop risk audit endpoints", async () => {
    const slotsRes = await app.request("/api/v1/admin/vms/slots");
    expect(slotsRes.status).toBe(200);
    const slotsBody = (await slotsRes.json()) as { slots: Array<{ hypervisorKind: string; maxSubagents: number }> };
    expect(slotsBody.slots[0]?.hypervisorKind).toBe("kvm_qemu");
    expect(slotsBody.slots[0]?.maxSubagents).toBe(20);

    const seedRes = await app.request("/api/v1/admin/vms/vm-tokyo-01/seed");
    expect(seedRes.status).toBe(200);
    const seedBody = (await seedRes.json()) as { rejectClientSettings: boolean; telemetryDaemonRunning: boolean };
    expect(seedBody.rejectClientSettings).toBe(true);
    expect(seedBody.telemetryDaemonRunning).toBe(true);

    const riskRes = await app.request("/api/v1/admin/risk/events");
    expect(riskRes.status).toBe(200);
    const riskBody = (await riskRes.json()) as { exemptOrdinaryUpstream400: boolean };
    expect(riskBody.exemptOrdinaryUpstream400).toBe(true);
  });
});
