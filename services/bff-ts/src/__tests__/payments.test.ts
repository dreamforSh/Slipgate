import { describe, expect, it } from "bun:test";
import type postgres from "postgres";
import type {
  AuditLogItem,
  CreateOrderResponse,
  GroupItem,
  PaymentConfig,
  PaymentDashboard,
  PaymentOptions,
  PaymentOrderItem,
  PaymentPlan,
  UserSubscriptionItem,
  WalletSummary,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { easypaySign, stripeSignatureHeader, stripeVerifySignature } from "../payments/providers.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import { PG_PAYMENTS_SCHEMA_SQL, pendingAuditSecretScrub, scrubStoredAuditSecrets } from "../store/postgres_payments.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const NANO = 1_000_000_000n;
const DAY_MS = 86_400_000;
const EASYPAY_KEY = "easypay-merchant-key";
const STRIPE_WHSEC = "whsec_test_secret";

type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const store: ControlStore = factory ? await factory() : new MemoryControlStore();
  const app = createBffApp({
    store,
    jwtSecret: "payments-test-jwt-secret-32-bytes-min",
    vaultSecret: "payments-test-vault-secret-32-bytes-min",
  });
  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
    const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // plain-text webhook acks
    }
    return { status: res.status, body: parsed as T };
  };
  const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Pay Test",
    adminEmail: "admin@pay.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
  const register = async (email: string, extra: Record<string, unknown> = {}) => {
    const res = await call<{ accessToken: string; user: { id: string } }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
      email,
      password: "UserPassword123!",
      ...extra,
    });
    expect(res.status).toBe(201);
    return { id: res.body.user.id, headers: { ...JSON_HEADERS, Authorization: `Bearer ${res.body.accessToken}` } };
  };
  const act = (orderId: string, body: Record<string, unknown>) =>
    call<{ order: PaymentOrderItem }>("POST", `/api/v1/admin/payments/orders/${orderId}/action`, admin, body);
  const balance = async (headers: Record<string, string>) =>
    BigInt((await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", headers)).body.wallet.balanceNanoUsd);
  const subscriptions = async (headers: Record<string, string>) =>
    (await call<{ items: UserSubscriptionItem[] }>("GET", "/api/v1/user/subscriptions", headers)).body.items;
  /** Payments on, ¥7.00 per $1, manual transfers and EasyPay (pid 1001). */
  const enablePayments = async () => {
    const res = await call<PaymentConfig>("PATCH", "/api/v1/admin/payments/config", admin, {
      enabled: true,
      callbackBaseUrl: "https://pay.example.com",
      minorPerUsd: 700,
      maxPendingOrders: 50,
      easypay: { enabled: true, apiUrl: "https://epay.example.com", pid: "1001", key: EASYPAY_KEY, methods: ["alipay"] },
      manual: { enabled: true, instructions: "Bank transfer" },
    });
    expect(res.status).toBe(200);
  };
  const subscriptionGroup = async (name: string) => {
    const res = await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, {
      name,
      platform: "anthropic",
      subscriptionType: "subscription",
    });
    expect(res.status).toBe(201);
    return res.body.group;
  };
  const plan = async (body: Record<string, unknown>) => {
    const res = await call<{ item: PaymentPlan }>("POST", "/api/v1/admin/payments/plans", admin, body);
    expect(res.status).toBe(201);
    return res.body.item;
  };
  const order = async (headers: Record<string, string>, body: Record<string, unknown>) => {
    const res = await call<CreateOrderResponse>("POST", "/api/v1/user/orders", headers, body);
    expect(res.status).toBe(201);
    return res.body.order;
  };
  return { app, store, call, admin, register, act, balance, subscriptions, enablePayments, subscriptionGroup, plan, order };
}

const daysLeft = (s: UserSubscriptionItem) => (Date.parse(s.expiresAtIso) - Date.now()) / DAY_MS;

describe("payment providers", () => {
  it("signs EasyPay params like the reference gateway and verifies Stripe signatures", async () => {
    // Sorted, empty values skipped, key appended.
    const sign = easypaySign({ pid: "1001", money: "1.00", type: "alipay", sign_type: "MD5", empty: "" }, "k");
    expect(sign).toBe(new Bun.CryptoHasher("md5").update("money=1.00&pid=1001&type=alipayk").digest("hex"));
    const body = JSON.stringify({ hello: "world" });
    const header = await stripeSignatureHeader(body, "whsec_x", 1_700_000_000);
    expect(await stripeVerifySignature(body, header, "whsec_x", 1_700_000_100)).toBe(true);
    expect(await stripeVerifySignature(body, header, "whsec_x", 1_700_001_000)).toBe(false);
    expect(await stripeVerifySignature(`${body} `, header, "whsec_x", 1_700_000_100)).toBe(false);
  });
});

describe("payments", () => {
  it("sells plans and custom top-ups through EasyPay with rebates, refunds and idempotent notifications", async () => {
    const { call, admin, register } = await bootstrap();
    await call("PATCH", "/api/v1/admin/settings", admin, { affiliateEnabled: true, affiliateRebateBps: 1000 });

    // Disabled by default: no channels offered, ordering refused.
    const closed = await register("closed@pay.test");
    expect((await call<PaymentOptions>("GET", "/api/v1/user/payments/options", closed.headers)).body.channels).toEqual([]);

    const cfg = await call<PaymentConfig>("PATCH", "/api/v1/admin/payments/config", admin, {
      enabled: true,
      callbackBaseUrl: "https://pay.example.com",
      minorPerUsd: 700,
      easypay: { enabled: true, apiUrl: "https://epay.example.com", pid: "1001", key: EASYPAY_KEY, methods: ["alipay"] },
      manual: { enabled: true, instructions: "Transfer to **ACME Bank**" },
    });
    expect(cfg.status).toBe(200);
    expect(cfg.body.easypay.keySet).toBe(true);
    expect(JSON.stringify(cfg.body)).not.toContain(EASYPAY_KEY);

    const plan = await call<{ item: PaymentPlan }>("POST", "/api/v1/admin/payments/plans", admin, {
      name: "Starter",
      kind: "recharge",
      price: "70",
      creditUsd: "12",
      badge: "Hot",
    });
    expect(plan.status).toBe(201);

    // The referrer's invite code comes from the affiliate page.
    const referrer = await register("ref@pay.test");
    const aff = await call<{ inviteCode: string }>("GET", "/api/v1/user/affiliate", referrer.headers);
    const buyer = await register("buyer@pay.test", { affCode: aff.body.inviteCode });

    const options = await call<PaymentOptions>("GET", "/api/v1/user/payments/options", buyer.headers);
    expect(options.body.channels.map((c) => `${c.provider}:${c.method ?? ""}`)).toEqual(["easypay:alipay", "manual:"]);
    expect(options.body.plans.map((p) => p.name)).toEqual(["Starter"]);

    const created = await call<CreateOrderResponse>("POST", "/api/v1/user/orders", buyer.headers, {
      planId: plan.body.item.id,
      provider: "easypay",
      method: "alipay",
    });
    expect(created.status).toBe(201);
    const payUrl = new URL(created.body.payUrl!);
    expect(payUrl.origin + payUrl.pathname).toBe("https://epay.example.com/submit.php");
    expect(payUrl.searchParams.get("money")).toBe("70.00");
    expect(payUrl.searchParams.get("notify_url")).toBe("https://pay.example.com/webhooks/payment/easypay");
    const orderId = created.body.order.id;

    // Forged notification is rejected; a correctly signed one fulfils exactly once.
    const notify = (money: string, key = EASYPAY_KEY) => {
      const params: Record<string, string> = {
        pid: "1001",
        trade_no: "EP2026001",
        out_trade_no: orderId,
        type: "alipay",
        name: "Starter",
        money,
        trade_status: "TRADE_SUCCESS",
      };
      const q = new URLSearchParams({ ...params, sign: easypaySign(params, key), sign_type: "MD5" });
      return call<string>("GET", `/webhooks/payment/easypay?${q.toString()}`, {});
    };
    expect((await notify("70.00", "wrong-key")).status).toBe(400);
    expect((await notify("1.00")).status).toBe(400);
    const ok = await notify("70.00");
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("success");
    expect((await notify("70.00")).body).toBe("success");

    const wallet = await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", buyer.headers);
    expect(wallet.body.wallet.balanceNanoUsd).toBe((12n * NANO).toString());
    const refWallet = await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", referrer.headers);
    expect(refWallet.body.wallet.balanceNanoUsd).toBe(((12n * NANO) / 10n).toString());
    const refAff = await call<{ rebateTotalNanoUsd: string; rebates: unknown[] }>("GET", "/api/v1/user/affiliate", referrer.headers);
    expect(refAff.body.rebateTotalNanoUsd).toBe(((12n * NANO) / 10n).toString());
    expect(refAff.body.rebates).toHaveLength(1);

    const mine = await call<{ order: PaymentOrderItem }>("GET", `/api/v1/user/orders/${orderId}`, buyer.headers);
    expect(mine.body.order.status).toBe("paid");
    expect(mine.body.order.providerTradeNo).toBe("EP2026001");
    expect((await call("GET", `/api/v1/user/orders/${orderId}`, referrer.headers)).status).toBe(404);

    // Custom amount converts at minorPerUsd: ¥14.00 → $2.
    const custom = await call<CreateOrderResponse>("POST", "/api/v1/user/orders", buyer.headers, { amount: "14", provider: "manual" });
    expect(custom.status).toBe(201);
    expect(custom.body.payUrl).toBeNull();
    expect(custom.body.order.creditNanoUsd).toBe((2n * NANO).toString());
    const paid = await call<{ order: PaymentOrderItem }>("POST", `/api/v1/admin/payments/orders/${custom.body.order.id}/action`, admin, {
      action: "mark_paid",
    });
    expect(paid.body.order.status).toBe("paid");
    const refunded = await call<{ order: PaymentOrderItem }>(
      "POST",
      `/api/v1/admin/payments/orders/${custom.body.order.id}/action`,
      admin,
      { action: "refund", reclaimBalance: true },
    );
    expect(refunded.body.order.status).toBe("refunded");
    const after = await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", buyer.headers);
    expect(after.body.wallet.balanceNanoUsd).toBe((12n * NANO).toString());

    // Pending orders can be cancelled by their owner; limits are enforced.
    expect((await call("POST", "/api/v1/user/orders", buyer.headers, { amount: "0.5", provider: "manual" })).status).toBe(400);
    const pending = await call<CreateOrderResponse>("POST", "/api/v1/user/orders", buyer.headers, { amount: "7", provider: "manual" });
    const cancelled = await call<{ order: PaymentOrderItem }>("POST", `/api/v1/user/orders/${pending.body.order.id}/cancel`, buyer.headers);
    expect(cancelled.body.order.status).toBe("cancelled");

    const dash = await call<PaymentDashboard>("GET", "/api/v1/admin/payments/dashboard?days=7", admin);
    expect(dash.body.totals.paidOrders).toBe(1);
    expect(dash.body.totals.revenueMinor).toBe(7000);
    expect(dash.body.totals.refundedOrders).toBe(1);
    expect(dash.body.series).toHaveLength(7);
    const orders = await call<{ total: number }>("GET", "/api/v1/admin/payments/orders?status=paid", admin);
    expect(orders.body.total).toBe(1);
  });

  it("fulfils Stripe orders only for correctly signed, matching events", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    const { createBffApp: create } = await import("../app.ts");
    const app = create({
      store: factory ? await factory() : undefined,
      jwtSecret: "payments-test-jwt-secret-32-bytes-min",
      vaultSecret: "payments-test-vault-secret-32-bytes-min",
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://api.stripe.com/")) {
        expect(String(init?.body)).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=2000");
        return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" }), { status: 200 });
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
        const res = await app.request(path, { method, headers, body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
      };
      const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
        siteName: "Stripe",
        adminEmail: "admin@stripe.test",
        adminPassword: "AdminPassword123!",
        allowRegistration: true,
      });
      const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
      const group = (
        await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, {
          name: "pro-sub",
          platform: "anthropic",
          subscriptionType: "subscription",
        })
      ).body.group;
      await call("PATCH", "/api/v1/admin/payments/config", admin, {
        enabled: true,
        currency: "USD",
        callbackBaseUrl: "https://pay.example.com",
        stripe: { enabled: true, secretKey: "sk_test_123", webhookSecret: STRIPE_WHSEC },
      });
      const plan = (
        await call<{ item: PaymentPlan }>("POST", "/api/v1/admin/payments/plans", admin, {
          name: "Pro monthly",
          kind: "subscription",
          price: "20",
          currency: "USD",
          groupId: group.id,
          validityDays: 30,
        })
      ).body.item;
      const reg = await call<{ accessToken: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
        email: "buyer@stripe.test",
        password: "UserPassword123!",
      });
      const user = { ...JSON_HEADERS, Authorization: `Bearer ${reg.body.accessToken}` };
      const order = await call<CreateOrderResponse>("POST", "/api/v1/user/orders", user, { planId: plan.id, provider: "stripe" });
      expect(order.status).toBe(201);
      expect(order.body.payUrl).toBe("https://checkout.stripe.test/cs_test_1");

      const event = (amount: number) =>
        JSON.stringify({
          type: "checkout.session.completed",
          data: {
            object: {
              id: "cs_test_1",
              payment_status: "paid",
              amount_total: amount,
              currency: "usd",
              payment_intent: "pi_123",
              metadata: { order_id: order.body.order.id },
            },
          },
        });
      const post = async (payload: string, secret = STRIPE_WHSEC) =>
        call("POST", "/webhooks/payment/stripe", { "Content-Type": "application/json", "Stripe-Signature": await stripeSignatureHeader(payload, secret) }, payload);
      expect((await post(event(2000), "whsec_wrong")).status).toBe(400);
      expect((await post(event(100))).status).toBe(400);
      expect((await post(event(2000))).status).toBe(200);

      const subs = await call<{ items: UserSubscriptionItem[] }>("GET", "/api/v1/user/subscriptions", user);
      expect(subs.body.items).toHaveLength(1);
      expect(subs.body.items[0]!.groupId).toBe(group.id);
      const paid = await call<{ order: PaymentOrderItem }>("GET", `/api/v1/user/orders/${order.body.order.id}`, user);
      expect(paid.body.order.status).toBe("paid");
      expect(paid.body.order.providerTradeNo).toBe("pi_123");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("payment integrity", () => {
  it("reverses the referrer's rebate on every refund, exactly once", async () => {
    const { call, admin, register, act, balance, enablePayments, order } = await bootstrap();
    await call("PATCH", "/api/v1/admin/settings", admin, { affiliateEnabled: true, affiliateRebateBps: 1000 });
    await enablePayments();
    const referrer = await register("rebate-ref@pay.test");
    const aff = await call<{ inviteCode: string }>("GET", "/api/v1/user/affiliate", referrer.headers);
    const buyer = await register("rebate-buyer@pay.test", { affCode: aff.body.inviteCode });

    // ¥70 at ¥7/$ credits $10; the referrer earns 10% = $1.
    const kept = await order(buyer.headers, { amount: "70", provider: "manual" });
    const reclaimed = await order(buyer.headers, { amount: "70", provider: "manual" });
    expect((await act(kept.id, { action: "mark_paid" })).body.order.status).toBe("paid");
    expect((await act(reclaimed.id, { action: "mark_paid" })).body.order.status).toBe("paid");
    expect(await balance(buyer.headers)).toBe(20n * NANO);
    expect(await balance(referrer.headers)).toBe(2n * NANO);

    // A refund that leaves the payer's balance alone still takes the rebate back.
    const first = await act(kept.id, { action: "refund", reclaimBalance: false });
    expect(first.status).toBe(200);
    expect(first.body.order.status).toBe("refunded");
    expect(await balance(buyer.headers)).toBe(20n * NANO);
    expect(await balance(referrer.headers)).toBe(NANO);

    const second = await act(reclaimed.id, { action: "refund", reclaimBalance: true });
    expect(second.body.order.status).toBe("refunded");
    expect(await balance(buyer.headers)).toBe(10n * NANO);
    expect(await balance(referrer.headers)).toBe(0n);

    // Refunding again is refused and moves nothing.
    expect((await act(reclaimed.id, { action: "refund", reclaimBalance: true })).status).toBe(409);
    expect(await balance(buyer.headers)).toBe(10n * NANO);
    expect(await balance(referrer.headers)).toBe(0n);

    // Reversed rebates no longer count as earned anywhere.
    const refAff = await call<{ rebateTotalNanoUsd: string; rebates: unknown[] }>("GET", "/api/v1/user/affiliate", referrer.headers);
    expect(refAff.body.rebateTotalNanoUsd).toBe("0");
    expect(refAff.body.rebates).toHaveLength(0);
    expect((await call<{ items: unknown[] }>("GET", "/api/v1/admin/affiliates/rebates", admin)).body.items).toHaveLength(0);
    const dash = await call<PaymentDashboard>("GET", "/api/v1/admin/payments/dashboard?days=7", admin);
    expect(dash.body.totals.rebatesNanoUsd).toBe("0");
    expect(dash.body.totals.refundedOrders).toBe(2);
  });

  it("takes a refunded subscription order's days back and grants each payment once", async () => {
    const { register, act, subscriptions, enablePayments, subscriptionGroup, plan, order } = await bootstrap();
    await enablePayments();
    const group = await subscriptionGroup("refund-sub");
    const monthly = await plan({ name: "Monthly", kind: "subscription", price: "30", groupId: group.id, validityDays: 30 });
    const buyer = await register("sub-refund@pay.test");

    const first = await order(buyer.headers, { planId: monthly.id, provider: "manual" });
    // Racing confirmations of the same payment deliver it once.
    const racing = await Promise.all([act(first.id, { action: "mark_paid" }), act(first.id, { action: "mark_paid" })]);
    expect(racing.map((r) => r.status)).toEqual([200, 200]);
    let subs = await subscriptions(buyer.headers);
    expect(subs).toHaveLength(1);
    expect(daysLeft(subs[0]!)).toBeLessThan(30.01);

    const second = await order(buyer.headers, { planId: monthly.id, provider: "manual" });
    await act(second.id, { action: "mark_paid" });
    subs = await subscriptions(buyer.headers);
    expect(subs).toHaveLength(1);
    expect(daysLeft(subs[0]!)).toBeGreaterThan(59.9);

    // A goodwill refund (no reclaim) leaves the subscription alone.
    const third = await order(buyer.headers, { planId: monthly.id, provider: "manual" });
    await act(third.id, { action: "mark_paid" });
    expect((await act(third.id, { action: "refund", reclaimBalance: false })).body.order.status).toBe("refunded");
    expect(daysLeft((await subscriptions(buyer.headers))[0]!)).toBeGreaterThan(89.9);

    // Reclaiming removes exactly the refunded order's 30 days...
    expect((await act(second.id, { action: "refund", reclaimBalance: true })).body.order.status).toBe("refunded");
    subs = await subscriptions(buyer.headers);
    expect(subs[0]!.status).toBe("active");
    expect(daysLeft(subs[0]!)).toBeGreaterThan(59.9);
    expect(daysLeft(subs[0]!)).toBeLessThan(60.01);
    expect((await act(third.id, { action: "refund", reclaimBalance: true })).status).toBe(409);

    // ...and refunding the first order removes its 30 days too, leaving the goodwill order's.
    await act(first.id, { action: "refund", reclaimBalance: true });
    const after = await subscriptions(buyer.headers);
    expect(after[0]!.status).toBe("active");
    expect(daysLeft(after[0]!)).toBeGreaterThan(29.9);
    expect(daysLeft(after[0]!)).toBeLessThan(30.01);
  });

  it("revokes a subscription whose only remaining time came from the refunded order", async () => {
    const { register, act, subscriptions, enablePayments, subscriptionGroup, plan, order } = await bootstrap();
    await enablePayments();
    const group = await subscriptionGroup("refund-revoke");
    const monthly = await plan({ name: "Monthly", kind: "subscription", price: "30", groupId: group.id, validityDays: 30 });
    const buyer = await register("sub-revoke@pay.test");
    const only = await order(buyer.headers, { planId: monthly.id, provider: "manual" });
    await act(only.id, { action: "mark_paid" });
    expect((await subscriptions(buyer.headers))[0]!.status).toBe("active");
    expect((await act(only.id, { action: "refund", reclaimBalance: true })).body.order.status).toBe("refunded");
    const subs = await subscriptions(buyer.headers);
    expect(subs).toHaveLength(1);
    expect(subs[0]!.status).toBe("revoked");
  });

  it("accepts money for a subscription order whose group changed, flags it, and redelivers or refunds it", async () => {
    const { call, admin, register, act, subscriptions, enablePayments, subscriptionGroup, plan, order } = await bootstrap();
    await enablePayments();
    const group = await subscriptionGroup("switching");
    const monthly = await plan({ name: "Switching", kind: "subscription", price: "30", groupId: group.id, validityDays: 30 });
    const buyer = await register("late-payer@pay.test");
    const pending = await order(buyer.headers, { planId: monthly.id, provider: "manual" });

    // The group is switched to balance billing while the order is unpaid.
    expect((await call("PATCH", `/api/v1/admin/groups/${group.id}`, admin, { subscriptionType: "balance" })).status).toBe(200);
    const options = await call<PaymentOptions>("GET", "/api/v1/user/payments/options", buyer.headers);
    expect(options.body.plans.map((p) => p.id)).not.toContain(monthly.id);
    expect((await call("POST", "/api/v1/user/orders", buyer.headers, { planId: monthly.id, provider: "manual" })).status).toBe(409);
    const adminPlans = await call<{ items: PaymentPlan[] }>("GET", "/api/v1/admin/payments/plans", admin);
    expect(adminPlans.body.items.map((p) => p.id)).toContain(monthly.id);

    // The payment still lands: the order is paid and flagged instead of failing forever.
    const paid = await act(pending.id, { action: "mark_paid", providerTradeNo: "BANK-1" });
    expect(paid.status).toBe(200);
    expect(paid.body.order.status).toBe("paid");
    expect(paid.body.order.deliveryError).toContain("not subscription-billed");
    expect(await subscriptions(buyer.headers)).toHaveLength(0);
    const retried = await act(pending.id, { action: "mark_paid" });
    expect(retried.body.order.deliveryError).toContain("not subscription-billed");
    expect(retried.body.order.providerTradeNo).toBe("BANK-1");

    // Once the group sells subscriptions again, a retry delivers it, once.
    expect((await call("PATCH", `/api/v1/admin/groups/${group.id}`, admin, { subscriptionType: "subscription" })).status).toBe(200);
    const delivered = await act(pending.id, { action: "mark_paid" });
    expect(delivered.body.order.deliveryError).toBeNull();
    expect(delivered.body.order.providerTradeNo).toBe("BANK-1");
    await act(pending.id, { action: "mark_paid" });
    const subs = await subscriptions(buyer.headers);
    expect(subs).toHaveLength(1);
    expect(daysLeft(subs[0]!)).toBeGreaterThan(29.9);
    expect(daysLeft(subs[0]!)).toBeLessThan(30.01);

    // A provider notification for an order whose group was deleted is acknowledged, not
    // bounced, and the order can be refunded.
    const doomed = await subscriptionGroup("doomed");
    const doomedPlan = await plan({ name: "Doomed", kind: "subscription", price: "10", groupId: doomed.id, validityDays: 7 });
    const lost = await order(buyer.headers, { planId: doomedPlan.id, provider: "easypay", method: "alipay" });
    expect((await call("DELETE", `/api/v1/admin/groups/${doomed.id}`, admin)).status).toBe(200);
    const params: Record<string, string> = {
      pid: "1001",
      trade_no: "EP-LOST",
      out_trade_no: lost.id,
      type: "alipay",
      name: "Doomed",
      money: "10.00",
      trade_status: "TRADE_SUCCESS",
    };
    const q = new URLSearchParams({ ...params, sign: easypaySign(params, EASYPAY_KEY), sign_type: "MD5" });
    const ack = await call<string>("GET", `/webhooks/payment/easypay?${q.toString()}`, {});
    expect(ack.status).toBe(200);
    expect(ack.body).toBe("success");
    const flagged = (await call<{ order: PaymentOrderItem }>("GET", `/api/v1/user/orders/${lost.id}`, buyer.headers)).body.order;
    expect(flagged.status).toBe("paid");
    expect(flagged.deliveryError).toContain("not found");
    const refunded = await act(lost.id, { action: "refund", reclaimBalance: true });
    expect(refunded.status).toBe(200);
    expect(refunded.body.order.status).toBe("refunded");
    // The unrelated subscription was not touched by that refund.
    expect(daysLeft((await subscriptions(buyer.headers))[0]!)).toBeGreaterThan(29.9);
  });

  it("ranks providers and top plans by revenue as numbers", async () => {
    const { call, admin, register, act, enablePayments, plan, order } = await bootstrap();
    await enablePayments();
    const small = await plan({ name: "Small", kind: "recharge", price: "99", creditUsd: "1" });
    const big = await plan({ name: "Big", kind: "recharge", price: "1200", creditUsd: "100" });
    const buyer = await register("ranking@pay.test");
    // 9900 vs 120000 minor units: compared as text, "9900" would rank first.
    for (const p of [small, big]) await act((await order(buyer.headers, { planId: p.id, provider: "manual" })).id, { action: "mark_paid" });
    const dash = await call<PaymentDashboard>("GET", "/api/v1/admin/payments/dashboard?days=7", admin);
    expect(dash.body.topPlans.map((p) => [p.planName, p.revenueMinor])).toEqual([
      ["Big", 120000],
      ["Small", 9900],
    ]);
    expect(dash.body.byProvider).toEqual([{ provider: "manual", orders: 2, revenueMinor: 129900 }]);
  });

  it("rejects fiat amounts the order and plan columns cannot hold with 400s", async () => {
    const { call, admin, register, enablePayments } = await bootstrap();
    await enablePayments();
    // 30,000,000.00 = 3e9 minor units, beyond INTEGER.
    const tooBig = await call("POST", "/api/v1/admin/payments/plans", admin, { name: "Huge", kind: "recharge", price: "30000000", creditUsd: "1" });
    expect(tooBig.status).toBe(400);
    expect((await call("PATCH", "/api/v1/admin/payments/config", admin, { maxAmountMinor: 3_000_000_000 })).status).toBe(400);
    expect((await call("PATCH", "/api/v1/admin/payments/config", admin, { maxAmountMinor: 2_147_483_647 })).status).toBe(200);
    const buyer = await register("huge@pay.test");
    expect((await call("POST", "/api/v1/user/orders", buyer.headers, { amount: "21474836.48", provider: "manual" })).status).toBe(400);
    // The largest accepted amount is stored without overflowing.
    const edge = await call<CreateOrderResponse>("POST", "/api/v1/user/orders", buyer.headers, { amount: "21474836.47", provider: "manual" });
    expect(edge.status).toBe(201);
    expect(edge.body.order.amountMinor).toBe(2_147_483_647);
  });

  it("clamps an over-cap limit saved earlier instead of falling back to the defaults", async () => {
    const { store, call, admin, enablePayments } = await bootstrap();
    await enablePayments();
    const blob = (await store.payments.getConfigBlob())!;
    await store.payments.saveConfigBlob({ ...blob, maxAmountMinor: 5_000_000_000 });
    const cfg = await call<PaymentConfig>("GET", "/api/v1/admin/payments/config", admin);
    expect(cfg.body.enabled).toBe(true);
    expect(cfg.body.minorPerUsd).toBe(700);
    expect(cfg.body.maxAmountMinor).toBe(2_147_483_647);
  });

  it("keeps the EasyPay merchant key out of the admin audit log", async () => {
    const { call, admin, enablePayments } = await bootstrap();
    await enablePayments();
    await call("PATCH", "/api/v1/admin/payments/config", admin, { stripe: { secretKey: "sk_live_abcdefghijklmnop", webhookSecret: STRIPE_WHSEC } });
    const logs = await call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs?pageSize=50", admin);
    const bodies = logs.body.items.filter((i) => i.route === "/api/v1/admin/payments/config").map((i) => i.requestBody);
    expect(bodies).toHaveLength(2);
    for (const b of bodies) {
      expect(b).not.toContain(EASYPAY_KEY);
      expect(b).not.toContain("sk_live_abcdefghijklmnop");
      expect(b).not.toContain(STRIPE_WHSEC);
    }
    expect(bodies.join("\n")).toContain('"key":"[redacted]"');
    // Non-secret settings stay readable.
    expect(bodies.join("\n")).toContain('"pid":"1001"');
  });

  it("scrubs provider secrets that older redaction left in stored audit rows", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    if (!factory) return; // Only Postgres keeps audit rows across a restart.
    const store = await factory();
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ";
    const entry = (route: string, requestBody: string) => ({
      actorId: "adm",
      actorEmail: "admin@pay.test",
      actorRole: "admin",
      method: "PATCH",
      route,
      path: route,
      targetId: "",
      statusCode: 200,
      ip: "",
      userAgent: "",
      durationMs: 1,
      requestBody,
    });
    await store.ops.recordAudit(entry("/api/v1/admin/payments/config", '{"easypay":{"pid":"1001","key":"plain-merchant-key","enabled":true}}'));
    await store.ops.recordAudit(entry("/api/v1/admin/vms/nodes", `{"name":"n1","sshKeyPem":"${pem}…`));
    const sql = (store as unknown as { sql: postgres.Sql }).sql;
    await sql`DELETE FROM commerce.portal_settings WHERE key = 'audit_secret_scrub_v1'`;
    await sql.unsafe(PG_PAYMENTS_SCHEMA_SQL);
    await sql.unsafe(PG_PAYMENTS_SCHEMA_SQL);
    const { items } = await store.ops.listAudit({ page: 1, pageSize: 50 });
    const bodies = items.map((i) => i.requestBody).join("\n");
    expect(bodies).not.toContain("plain-merchant-key");
    expect(bodies).not.toContain("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ");
    expect(bodies).toContain('{"easypay":{"pid":"1001","key":"[redacted]","enabled":true}}');
    expect(bodies).toContain('"name":"n1"');
  });

  it("applies the current audit redaction once to every row older builds stored", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    if (!factory) return; // Only Postgres keeps audit rows across a restart.
    const store = await factory();
    await (store as unknown as { whenMaintenanceIdle(): Promise<void> }).whenMaintenanceIdle();
    const sql = (store as unknown as { sql: postgres.Sql }).sql;
    // A fresh database has nothing to scrub: startup marks the pass done without starting it.
    expect(await pendingAuditSecretScrub(sql)).toBeNull();
    expect(await sql`SELECT 1 FROM commerce.portal_settings WHERE key = 'audit_secret_scrub_v2'`).toHaveLength(1);
    const entry = (route: string, requestBody: string) => ({
      actorId: "adm",
      actorEmail: "admin@pay.test",
      actorRole: "admin",
      method: "POST",
      route,
      path: route,
      targetId: "",
      statusCode: 200,
      ip: "",
      userAgent: "",
      durationMs: 1,
      requestBody,
    });
    const clean = '{"name":"Pro","monthly":30}';
    await store.ops.recordAudit(entry("/api/v1/admin/proxies", '{"name":"p1","url":"socks5://alice:hunter2@10.0.0.1:1080","otp":123456}'));
    await store.ops.recordAudit(entry("/api/v1/admin/notes", '{"notes":"Bearer abcdefghijklmnop and sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"}'));
    // Cut mid-JSON by the old size cap, with a signature that older rules kept.
    await store.ops.recordAudit(entry("/api/v1/admin/plugins", `{"name":"pl","pad":"${"x".repeat(150)}","config":{"signature":"sig-value-123…`));
    await store.ops.recordAudit(entry("/api/v1/admin/plans", clean));
    await store.ops.recordAudit(entry("/api/v1/admin/upload", "[non-JSON body, 12 bytes]"));
    await sql`DELETE FROM commerce.portal_settings WHERE key = 'audit_secret_scrub_v2'`;

    // An upgraded database with rows gets the pass (run here with small pages).
    expect(typeof (await pendingAuditSecretScrub(sql))).toBe("function");
    expect(await scrubStoredAuditSecrets(sql, 2)).toBe(3);
    expect(await pendingAuditSecretScrub(sql)).toBeNull();
    const { items } = await store.ops.listAudit({ page: 1, pageSize: 50 });
    const byRoute = Object.fromEntries(items.map((i) => [i.route, i.requestBody]));
    expect(byRoute["/api/v1/admin/proxies"]).toBe('{"name":"p1","url":"socks5://[redacted]@10.0.0.1:1080","otp":"[redacted]"}');
    expect(byRoute["/api/v1/admin/notes"]).toBe('{"notes":"Bearer [redacted] and [redacted]"}');
    expect(byRoute["/api/v1/admin/plugins"]).toBe(`{"name":"pl","pad":"${"x".repeat(150)}","config":{"signature":"[redacted]…`);
    expect(byRoute["/api/v1/admin/plans"]).toBe(clean);
    expect(byRoute["/api/v1/admin/upload"]).toBe("[non-JSON body, 12 bytes]");
    const all = items.map((i) => i.requestBody).join("\n");
    for (const secret of ["hunter2", "123456", "abcdefghijklmnop", "sk-ant", "sig-value"]) expect(all).not.toContain(secret);

    // A one-off: the marker stops later starts from walking the table again.
    await store.ops.recordAudit(entry("/api/v1/admin/late", '{"signature":"late-value"}'));
    expect(await scrubStoredAuditSecrets(sql)).toBe(0);
  });

  it("reverses, once, the rebates of orders refunded before refunds reversed them", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    if (!factory) return; // A backfill of stored rows: Postgres only.
    const { store, call, admin, register, act, balance, enablePayments, order } = await bootstrap();
    await call("PATCH", "/api/v1/admin/settings", admin, { affiliateEnabled: true, affiliateRebateBps: 1000 });
    await enablePayments();
    const referrer = await register("legacy-ref@pay.test");
    const aff = await call<{ inviteCode: string }>("GET", "/api/v1/user/affiliate", referrer.headers);
    const buyer = await register("legacy-buyer@pay.test", { affCode: aff.body.inviteCode });
    // ¥70 at ¥7/$ credits $10 each; the referrer earns $1 per order.
    const refunded = await order(buyer.headers, { amount: "70", provider: "manual" });
    const kept = await order(buyer.headers, { amount: "70", provider: "manual" });
    await act(refunded.id, { action: "mark_paid" });
    await act(kept.id, { action: "mark_paid" });
    expect(await balance(referrer.headers)).toBe(2n * NANO);

    // What an older build's refund left behind: the order refunded, its rebate still settled.
    const sql = (store as unknown as { sql: postgres.Sql }).sql;
    await sql`UPDATE commerce.payment_orders SET status = 'refunded', refunded_at = NOW() WHERE id = ${refunded.id}`;
    expect((await call<{ rebateTotalNanoUsd: string }>("GET", "/api/v1/user/affiliate", referrer.headers)).body.rebateTotalNanoUsd).toBe(
      (2n * NANO).toString(),
    );

    await sql`DELETE FROM commerce.portal_settings WHERE key = 'rebate_refund_backfill_v1'`;
    await sql.unsafe(PG_PAYMENTS_SCHEMA_SQL);
    await sql`DELETE FROM commerce.portal_settings WHERE key = 'rebate_refund_backfill_v1'`;
    await sql.unsafe(PG_PAYMENTS_SCHEMA_SQL); // a second run (marker lost) moves nothing more

    expect(await balance(referrer.headers)).toBe(NANO);
    expect(await balance(buyer.headers)).toBe(20n * NANO);
    const debits = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM core.ledger_entries WHERE idempotency_key = ${`rebate-refund:${refunded.id}`}
    `;
    expect(debits[0]!.n).toBe(1);
    const refAff = await call<{ rebateTotalNanoUsd: string; rebates: unknown[] }>("GET", "/api/v1/user/affiliate", referrer.headers);
    expect(refAff.body.rebateTotalNanoUsd).toBe(NANO.toString());
    expect(refAff.body.rebates).toHaveLength(1);
    const dash = await call<PaymentDashboard>("GET", "/api/v1/admin/payments/dashboard?days=7", admin);
    expect(dash.body.totals.rebatesNanoUsd).toBe(NANO.toString());
    // The paid order's rebate is untouched and still reversible by a refund today.
    expect((await act(kept.id, { action: "refund", reclaimBalance: false })).body.order.status).toBe("refunded");
    expect(await balance(referrer.headers)).toBe(0n);
  });
});
