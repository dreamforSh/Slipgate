import { describe, expect, it } from "bun:test";
import { PAYMENT_NOTIFICATION_MAX_ATTEMPTS, type PaymentNotification, type PaymentOrderItem, type WalletSummary } from "@slipgate/contracts";
import { defineSlipgatePlugin, PluginRegistry } from "@slipgate/plugin-sdk";
import { createBffApp } from "../app.ts";
import { PaymentNotifier } from "../payments/notifications.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import type { ControlStore } from "../store/types.ts";

/**
 * Payment notifications: the order's event is written with the payment (once per order), each
 * plugin is delivered on its own with backoff retries, a failing plugin holds nobody back, a
 * replay re-sends the notification without re-crediting, and a plugin that keeps failing ends in
 * dead_letter. Runs on Postgres when a `--preload` installs `__slipgateTestStoreFactory`.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
type StoreFactory = () => Promise<ControlStore>;

function flakyPlugin(name: string, failures: { remaining: number }, calls: string[]) {
  return defineSlipgatePlugin({
    name,
    version: "1.0.0",
    async onPaymentSettled(_ctx, event) {
      calls.push(event.orderId);
      if (failures.remaining > 0) {
        failures.remaining -= 1;
        throw new Error(`${name} endpoint down`);
      }
    },
  });
}

describe("payment notifications", () => {
  it("delivers per plugin with retries, replays without re-crediting, and dead-letters persistent failures", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    const store = factory ? await factory() : new MemoryControlStore();
    if (factory) await store.init();
    const failures = { remaining: 1 };
    const calls: string[] = [];
    const registry = new PluginRegistry();
    registry.register(flakyPlugin("erp-sync", failures, calls));
    try {
      const app = createBffApp({ store, registry, jwtSecret: "notify-test-jwt-secret-32-bytes-min", vaultSecret: "notify-test-vault-secret-32-bytes-min" });
      const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
        const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
      };
      const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
        siteName: "Notify",
        adminEmail: "admin@notify.test",
        adminPassword: "AdminPassword123!",
        allowRegistration: true,
      });
      const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
      const reg = await call<{ accessToken: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, { email: "buyer@notify.test", password: "UserPassword123!" });
      const buyer = { ...JSON_HEADERS, Authorization: `Bearer ${reg.body.accessToken}` };
      expect(
        (await call("PATCH", "/api/v1/admin/payments/config", admin, { enabled: true, minorPerUsd: 700, maxPendingOrders: 50, manual: { enabled: true, instructions: "Bank" } })).status,
      ).toBe(200);
      const balance = async () => BigInt((await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", buyer)).body.wallet.balanceNanoUsd);
      const notificationOf = async (orderId: string) => {
        const res = await call<{ items: PaymentNotification[] }>("GET", `/api/v1/admin/payments/notifications?orderId=${orderId}`, admin);
        expect(res.status).toBe(200);
        expect(res.body.items).toHaveLength(1);
        return res.body.items[0]!;
      };
      const pay = async () => {
        const created = await call<{ order: PaymentOrderItem }>("POST", "/api/v1/user/orders", buyer, { amount: "7", provider: "manual" });
        expect(created.status).toBe(201);
        const paid = await call<{ order: PaymentOrderItem }>("POST", `/api/v1/admin/payments/orders/${created.body.order.id}/action`, admin, { action: "mark_paid" });
        expect(paid.body.order.status).toBe("paid");
        return created.body.order.id;
      };

      // First attempt fails for erp-sync only; the built-in webhook (no URL: a no-op) has it.
      const orderId = await pay();
      const credited = await balance();
      expect(credited).toBe(1_000_000_000n);
      let n = await notificationOf(orderId);
      expect(n.status).toBe("pending");
      const erp = () => n.deliveries.find((d) => d.plugin === "erp-sync")!;
      expect(erp()).toMatchObject({ status: "failed", attempts: 1, lastError: "erp-sync endpoint down" });
      expect(Date.parse(erp().nextAttemptAtIso!)).toBeGreaterThan(Date.now() + 30_000);
      expect(n.deliveries.find((d) => d.plugin === "payment-webhook")?.status).toBe("delivered");

      // A repeated payment callback writes no second event and respects the backoff.
      await call("POST", `/api/v1/admin/payments/orders/${orderId}/action`, admin, { action: "mark_paid" });
      n = await notificationOf(orderId);
      expect(calls).toEqual([orderId]);
      expect(erp().attempts).toBe(1);

      // Replay: re-sent now and delivered; the wallet is not credited again.
      const replayed = await call<{ item: PaymentNotification }>("POST", `/api/v1/admin/payments/notifications/${orderId}/replay`, admin, { plugin: "erp-sync" });
      expect(replayed.status).toBe(200);
      expect(replayed.body.item.status).toBe("dispatched");
      expect(replayed.body.item.deliveries.find((d) => d.plugin === "erp-sync")?.status).toBe("delivered");
      expect(calls).toEqual([orderId, orderId]);
      // Replaying everything re-sends to every plugin, still without touching the order.
      expect((await call("POST", `/api/v1/admin/payments/notifications/${orderId}/replay`, admin, {})).status).toBe(200);
      expect(calls).toHaveLength(3);
      expect(await balance()).toBe(credited);
      expect((await call("POST", "/api/v1/admin/payments/notifications/ord_missing/replay", admin, {})).status).toBe(404);

      // A plugin that keeps failing: retried on its backoff by the sweep, then dead-lettered.
      failures.remaining = 1_000;
      const stuck = await pay();
      let nowMs = Date.now();
      const notifier = new PaymentNotifier({ payments: store.payments, registry, context: () => ({ serviceVersion: "test", logger: () => {} }), now: () => nowMs });
      for (let i = 0; i < PAYMENT_NOTIFICATION_MAX_ATTEMPTS + 2; i++) {
        nowMs += 13 * 3_600_000;
        await notifier.dispatchDue();
      }
      const dead = await notificationOf(stuck);
      expect(dead.status).toBe("dead_letter");
      expect(dead.deliveries.find((d) => d.plugin === "erp-sync")).toMatchObject({ status: "failed", attempts: PAYMENT_NOTIFICATION_MAX_ATTEMPTS, nextAttemptAtIso: null });
      const listed = await call<{ items: PaymentNotification[] }>("GET", "/api/v1/admin/payments/notifications?status=dead_letter", admin);
      expect(listed.body.items.map((i) => i.orderId)).toEqual([stuck]);
    } finally {
      await store.close();
    }
  });
});
