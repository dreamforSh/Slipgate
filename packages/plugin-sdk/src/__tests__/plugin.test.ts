import { describe, expect, it } from "bun:test";
import { defineSlipgatePlugin, PluginRegistry } from "../index.ts";

describe("PluginRegistry", () => {
  it("invokes lifecycle hooks in registration order", async () => {
    const calls: string[] = [];
    const registry = new PluginRegistry();

    registry.register(
      defineSlipgatePlugin({
        name: "audit-hook",
        version: "0.1.0",
        onInit: () => {
          calls.push("init:audit");
        },
        onPaymentSettled: (_ctx, ev) => {
          calls.push(`paid:${ev.orderId}`);
        },
      }),
    );

    const ctx = { serviceVersion: "0.1.0", logger: () => {} };
    await registry.initAll(ctx);
    await registry.emitPaymentSettled(ctx, {
      orderId: "ord-1",
      userId: "usr-1",
      provider: "stripe",
      amountNanoUsd: "5000000000",
    });

    expect(calls).toEqual(["init:audit", "paid:ord-1"]);
  });
});
