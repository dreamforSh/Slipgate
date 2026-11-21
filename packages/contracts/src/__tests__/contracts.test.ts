import { describe, expect, it } from "bun:test";
import {
  ClashExitNodeSchema,
  formatNanoUsd,
  HardwarePersonaSchema,
  NANO_PER_USD,
  parseUsdToNano,
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
