import { describe, expect, it } from "bun:test";
import {
  BindAccountExitRequestSchema,
  ClashExitNodeSchema,
  ClusterNodeSchema,
  CreateAccountRequestSchema,
  CreateApiKeyRequestSchema,
  CreateClashSubscriptionRequestSchema,
  CreateCompositeRouteRequestSchema,
  CreateTlsProfileRequestSchema,
  DataPlaneSyncSnapshotSchema,
  formatNanoUsd,
  HardwarePersonaSchema,
  NANO_PER_USD,
  parseUsdToNano,
  ProvisionVmSlotRequestSchema,
  RecordRiskBanInputSchema,
  SetupInitializeRequestSchema,
  SystemUpdateStatusSchema,
  TriggerUpdateSyncRequestSchema,
  TurnSettlementEventSchema,
  UpdateTlsProfileRequestSchema,
  VmFleetOverviewSchema,
  VmTerminalTicketResponseSchema,
} from "../index.ts";

describe("nano-USD fixed-point helpers", () => {
  it("parses and formats USD strings without floating-point drift", () => {
    const amount = parseUsdToNano("12.345000001");
    expect(amount).toBe(12n * NANO_PER_USD + 345_000_001n);
    expect(formatNanoUsd(amount)).toBe("$12.345000001");
    expect(formatNanoUsd(5n * NANO_PER_USD)).toBe("$5.00");
  });

  it("rejects excessive decimal precision", () => {
    expect(() => parseUsdToNano("1.0000000001")).toThrow();
  });
});

describe("ClashExitNodeSchema", () => {
  it("validates a healthy Clash exit node contract", () => {
    const parsed = ClashExitNodeSchema.parse({
      nodeId: "node-tokyo-01",
      subscriptionId: "sub-main",
      name: "Tokyo Premium 01",
      proxySlotId: "slot-01",
      listenerPort: 20001,
      exitIp: "203.0.113.8",
      latencyMs: 38,
      healthStatus: "healthy",
      driftUnconfirmed: false,
      boundAccounts: 1,
      maxAccounts: 1,
    });
    expect(parsed.listenerPort).toBe(20001);
  });
});

describe("HardwarePersonaSchema", () => {
  it("accepts valid non-zero 32-char lowercase machine-id and rejects all-zero id", () => {
    const ok = HardwarePersonaSchema.parse({
      guestMachineId: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
      macAddress: "02:42:ac:11:00:02",
      smbiosUuid: "11111111-2222-3333-4444-555555555555",
      smbiosSerial: "SG-01",
      cpuModel: "AMD EPYC 9354",
      cpuCores: 4,
      timezone: "Asia/Tokyo",
    });
    expect(ok.cpuCores).toBe(4);
    expect(() =>
      HardwarePersonaSchema.parse({
        ...ok,
        guestMachineId: "00000000000000000000000000000000",
      }),
    ).toThrow();
  });
});

describe("IAM, Pool and API Key contracts", () => {
  it("validates setup, account creation, and API key defaults", () => {
    const setup = SetupInitializeRequestSchema.parse({
      siteName: "Slipgate Cloud",
      adminEmail: "admin@slipgate.dev",
      adminPassword: "StrongPassword123!",
    });
    expect(setup.allowRegistration).toBe(true);

    const account = CreateAccountRequestSchema.parse({
      name: "claude-max-01",
      groupId: "grp-claude",
      platform: "anthropic",
      credentialSecret: "sk-ant-oat01-demo-secret",
    });
    expect(account.executionMode).toBe("stealth_http");
    expect(account.maxConcurrency).toBe(5);

    const apiKey = CreateApiKeyRequestSchema.parse({
      name: "cli-key",
      groupId: "grp-claude",
    });
    expect(apiKey.rpmLimit).toBe(60);
    expect(apiKey.ipAllowlist).toEqual([]);
  });

  it("validates SystemUpdateStatusSchema and TriggerUpdateSyncRequestSchema defaults", () => {
    const syncReq = TriggerUpdateSyncRequestSchema.parse({});
    expect(syncReq.checkOnly).toBe(false);

    const status = SystemUpdateStatusSchema.parse({
      mode: "dev",
      strategy: "auto",
      resolvedStrategy: "release",
      repo: "dreamforSh/Slipgate",
      branch: "main",
      version: "0.1.0-dev",
      activeCommit: "c08e679",
      remoteCommit: null,
      updateAvailable: false,
      autoSyncEnabled: true,
      intervalSeconds: 60,
      state: "idle",
      reloadCount: 0,
      webUiOverridden: false,
      edgeBinaryStaged: false,
      lastCheckedAtIso: null,
      lastUpdatedAtIso: null,
      lastError: null,
    });
    expect(status.mode).toBe("dev");
    expect(status.autoSyncEnabled).toBe(true);

    const subReq = CreateClashSubscriptionRequestSchema.parse({
      name: "Tokyo Inline",
      sourceKind: "inline",
      sourceUrl: "proxies:\n  - name: n1\n    type: socks5\n    server: 198.51.100.1\n    port: 1080",
    });
    expect(subReq.autoSync).toBe(true);

    const tlsReq = CreateTlsProfileRequestSchema.parse({
      name: "Custom Chrome",
    });
    expect(tlsReq.clientHelloPreset).toBe("chrome_auto");

    const tlsWireReq = CreateTlsProfileRequestSchema.parse({
      name: "Bun Wire Custom",
      clientHelloPreset: "custom_wire",
      enableGrease: true,
      curves: [4588, 29, 23],
      keyShareGroups: [4588, 29],
      extensions: [0, 10, 16, 43, 51, 65037],
      osHint: "linux",
    });
    expect(tlsWireReq.enableGrease).toBe(true);
    expect(tlsWireReq.curves).toEqual([4588, 29, 23]);

    const tlsUpdate = UpdateTlsProfileRequestSchema.parse({
      name: "Bun Updated",
      clientHelloPreset: "auto",
      keyShareGroups: [29],
    });
    expect(tlsUpdate.clientHelloPreset).toBe("auto");

    const vmProvision = ProvisionVmSlotRequestSchema.parse({
      accountId: "acc-vm-1",
      clashNodeId: "node-1",
    });
    expect(vmProvision.clusterNodeId).toBe("local-node");
    expect(vmProvision.maxSubagents).toBe(20);

    const clusterNode = ClusterNodeSchema.parse({
      id: "local-node",
      name: "Local Control Node",
      driverKind: "local",
      sshAddr: "127.0.0.1:22",
      sshUser: "slipgate",
      arch: "amd64",
      kvmCapable: true,
      dockerCapable: true,
      status: "online",
      maxSlots: 32,
      createdAtIso: "2026-11-20T00:00:00Z",
      updatedAtIso: "2026-11-20T00:00:00Z",
    });
    expect(clusterNode.driverKind).toBe("local");

    const wsTicket = VmTerminalTicketResponseSchema.parse({
      ticket: "abc123",
      slotId: "vm-01",
      actor: "admin",
      wsPath: "/ws/admin/vms/terminal/abc123",
      expiresAtIso: "2026-11-20T00:05:00Z",
    });
    expect(wsTicket.wsPath).toBe("/ws/admin/vms/terminal/abc123");

    const overview = VmFleetOverviewSchema.parse({
      nodes: [clusterNode],
      slots: [],
      migrations: [],
      invariants: {
        oneSlotOneEgress: true,
        maxSubagentsDefault: 20,
        zeroPromptInjection: true,
      },
      runtime: {
        vmDataDir: "/var/run/slipgate/vms",
        guestdBin: "/usr/local/share/slipgate/guest/slipgate-guestd",
        guestdAvailable: true,
        localNodeId: "local-node",
      },
    });
    expect(overview.invariants.oneSlotOneEgress).toBe(true);

    const bindReq = BindAccountExitRequestSchema.parse({
      accountId: "acc-1",
      nodeId: "node-1",
    });
    expect(bindReq.isShadowFollower).toBe(false);

    const routeCreate = CreateCompositeRouteRequestSchema.parse({
      publicModel: "claude-sonnet-4-5",
      targetPlatform: "anthropic",
    });
    expect(routeCreate.groupId).toBe("grp_default");

    const dpSnap = DataPlaneSyncSnapshotSchema.parse({
      revisionUnixMs: 1700000000000,
      groups: [],
      routes: [],
      accounts: [],
      apiKeys: [],
      wallets: [{ userId: "usr_1", balanceNanoUsd: "5000000000", heldNanoUsd: "0" }],
    });
    expect(dpSnap.wallets[0]?.balanceNanoUsd).toBe("5000000000");

    const settle = TurnSettlementEventSchema.parse({
      requestId: "req_1",
      userId: "usr_1",
      apiKeyId: "key_1",
      accountId: "acc_1",
      groupId: "grp_default",
      platform: "anthropic",
      publicModel: "claude-sonnet-4-5",
      upstreamModel: "claude-sonnet-4-5",
      ingressCodec: "openai_chat",
      egressCodec: "anthropic_messages",
      inputTokens: 120,
      outputTokens: 80,
      costNanoUsd: "1560000",
      statusCode: 200,
    });
    expect(settle.cacheReadTokens).toBe(0);

    const riskIn = RecordRiskBanInputSchema.parse({
      subjectKind: "api_key",
      subjectHash: "key_1",
      strikeLevel: 1,
      banDuration: "10m",
      reason: "prompt_distillation_signature",
    });
    expect(riskIn.banDuration).toBe("10m");

    const codexRoute = CreateCompositeRouteRequestSchema.parse({
      publicModel: "gpt-5-codex",
      targetPlatform: "codex",
    });
    expect(codexRoute.targetPlatform).toBe("codex");
  });
});
