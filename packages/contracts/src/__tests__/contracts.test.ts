import { describe, expect, it } from "bun:test";
import {
  ClashExitNodeSchema,
  formatNanoUsd,
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
