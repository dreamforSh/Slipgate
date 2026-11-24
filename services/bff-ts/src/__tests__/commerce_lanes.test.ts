import { describe, expect, it } from "bun:test";
import type {
  AffiliateAccountItem,
  AffiliateWithdrawalItem,
  GroupItem,
  PaymentConfig,
  RedeemCodeClaimItem,
  RedeemCodeItem,
  UserSubscriptionItem,
  WalletSummary,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const store = factory ? await factory() : undefined;
  const app = createBffApp({
    store,
    jwtSecret: "commerce-lanes-test-jwt-secret-32-bytes",
    vaultSecret: "commerce-lanes-test-vault-secret-32b",
    internalToken: "commerce-lanes-internal-token",
  });

  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T, text };
  };

  const init = await call<{ accessToken: string; user: { id: string } }>(
    "POST",
    "/api/v1/setup/initialize",
    JSON_HEADERS,
    {
      siteName: "Commerce Lanes Test",
      adminEmail: "admin@commerce.test",
      adminPassword: "AdminPassword123!",
      allowRegistration: true,
    },
  );
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };

  const register = async (email: string, extra: Record<string, unknown> = {}) => {
    const res = await call<{ accessToken: string; user: { id: string; email: string } }>(
      "POST",
      "/api/v1/auth/register",
      JSON_HEADERS,
      { email, password: "MemberPassword123!", ...extra },
    );
    return {
      status: res.status,
      id: res.body.user?.id,
      email: res.body.user?.email,
      headers: res.body.accessToken ? { ...JSON_HEADERS, Authorization: `Bearer ${res.body.accessToken}` } : JSON_HEADERS,
      body: res.body,
    };
  };

  return { app, call, admin, register, store };
}

describe("Lanes C2/C3/C4: payment_settings table, affiliate pool/withdrawals, and multi-use redeem codes", () => {
  it("C2: persists payment_settings config with encrypted secrets masked on read", async () => {
    const { call, admin } = await bootstrap();

    const patch = await call<PaymentConfig>("PATCH", "/api/v1/admin/payments/config", admin, {
      enabled: true,
      currency: "USD",
      minorPerUsd: 100,
      minAmountMinor: 200,
      maxAmountMinor: 50000,
      easypay: { enabled: true, apiUrl: "https://pay.example.test", pid: "pid123", key: "secret-ep-key" },
      stripe: { enabled: true, secretKey: "sk_test_12345", webhookSecret: "whsec_67890" },
      manual: { enabled: true, instructions: "Send wire to acct 123" },
    });
    expect(patch.status).toBe(200);
    expect(patch.body.enabled).toBe(true);
    expect(patch.body.currency).toBe("USD");
    expect(patch.body.easypay.keySet).toBe(true);
    expect(patch.body.stripe.secretKeySet).toBe(true);
    expect(patch.body.stripe.webhookSecretSet).toBe(true);
    expect(patch.body.manual.instructions).toBe("Send wire to acct 123");

    const getRes = await call<PaymentConfig>("GET", "/api/v1/admin/payments/config", admin);
    expect(getRes.status).toBe(200);
    expect(getRes.body.enabled).toBe(true);
    expect(getRes.body.easypay.pid).toBe("pid123");
    expect(getRes.body.easypay.keySet).toBe(true);
  });

  it("C3: supports custom per-user rates, commission_pool rebates, refund clawback, wallet transfer and payout review", async () => {
    const { call, admin, register } = await bootstrap();

    // Enable affiliate in commission_pool mode with global 10% rate and $5 min withdrawal.
    const cfgRes = await call("PATCH", "/api/v1/admin/settings", admin, {
      affiliateEnabled: true,
      affiliateRebateBps: 1000,
      affiliateCreditMode: "commission_pool",
      affiliateMinWithdrawUsd: "5",
    });
    expect(cfgRes.status).toBe(200);

    const alice = await register("alice@aff.test");
    expect(alice.status).toBe(201);
    const affInfo = await call<{ inviteCode: string }>("GET", "/api/v1/user/affiliate", alice.headers);
    const bob = await register("bob@aff.test", { affCode: affInfo.body.inviteCode });
    expect(bob.status).toBe(201);

    // Give Alice a custom 25% rate (2500 bps).
    const rateRes = await call<{ item: AffiliateAccountItem }>(
      "PUT",
      `/api/v1/admin/affiliates/rates/${alice.id}`,
      admin,
      { customRebateBps: 2500 },
    );
    expect(rateRes.status).toBe(200);
    expect(rateRes.body.item.customRebateBps).toBe(2500);
    expect(rateRes.body.item.effectiveRebateBps).toBe(2500);

    // Enable manual payments and let Bob pay a $100 order.
    await call("PATCH", "/api/v1/admin/payments/config", admin, {
      enabled: true,
      currency: "USD",
      minorPerUsd: 100,
      manual: { enabled: true, instructions: "Wire", allowUserRefund: true },
    });
    const orderRes = await call<{ order: { id: string } }>("POST", "/api/v1/user/orders", bob.headers, {
      amount: "100.00",
      provider: "manual",
    });
    expect(orderRes.status).toBe(201);
    const orderId = orderRes.body.order.id;

    const paid = await call("POST", `/api/v1/admin/payments/orders/${orderId}/action`, admin, {
      action: "mark_paid",
      providerTradeNo: "tx_aff_1",
    });
    expect(paid.status).toBe(200);

    // Alice earned 25% of $100 = $25 in her commission pool; her API wallet stays $0!
    const aliceAfter = await call<{
      creditMode: string;
      rebateBps: number;
      commissionBalanceNanoUsd: string;
      totalEarnedNanoUsd: string;
    }>("GET", "/api/v1/user/affiliate", alice.headers);
    expect(aliceAfter.body.creditMode).toBe("commission_pool");
    expect(aliceAfter.body.rebateBps).toBe(2500);
    expect(aliceAfter.body.commissionBalanceNanoUsd).toBe("25000000000");
    expect(aliceAfter.body.totalEarnedNanoUsd).toBe("25000000000");

    const aliceWallet0 = await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", alice.headers);
    expect(aliceWallet0.body.wallet.balanceNanoUsd).toBe("0");

    // Transfer $10 from commission pool to API wallet -> pool=$15, wallet=$10.
    const xfer = await call<{ affiliateBalanceNanoUsd: string; walletBalanceNanoUsd: string }>(
      "POST",
      "/api/v1/user/affiliate/transfer",
      alice.headers,
      { amountUsd: "10" },
    );
    expect(xfer.status).toBe(200);
    expect(xfer.body.affiliateBalanceNanoUsd).toBe("15000000000");
    expect(xfer.body.walletBalanceNanoUsd).toBe("10000000000");

    // Withdrawal below $5 minimum fails.
    const tooSmall = await call("POST", "/api/v1/user/affiliate/withdraw", alice.headers, {
      amountUsd: "2",
      payoutMethod: "alipay",
      payoutAccount: "alice@alipay.test",
    });
    expect(tooSmall.status).toBe(400);

    // Submit $6 payout -> pool drops to $9, status pending.
    const w1 = await call<{ item: AffiliateWithdrawalItem }>("POST", "/api/v1/user/affiliate/withdraw", alice.headers, {
      amountUsd: "6",
      payoutMethod: "alipay",
      payoutAccount: "alice@alipay.test",
    });
    expect(w1.status).toBe(201);
    expect(w1.body.item.status).toBe("pending");

    // Submit another $6 payout (exceeds? remaining is $9 -> succeeds, remaining pool $3) then reject it -> refunds $6 back to $9.
    const w2 = await call<{ item: AffiliateWithdrawalItem }>("POST", "/api/v1/user/affiliate/withdraw", alice.headers, {
      amountUsd: "6",
      payoutMethod: "bank",
      payoutAccount: "62220000",
    });
    expect(w2.status).toBe(201);

    const approve1 = await call<{ item: AffiliateWithdrawalItem }>(
      "POST",
      `/api/v1/admin/affiliates/withdrawals/${w1.body.item.id}/review`,
      admin,
      { action: "approve", reviewNote: "ok" },
    );
    expect(approve1.status).toBe(200);
    expect(approve1.body.item.status).toBe("approved");

    const paid1 = await call<{ item: AffiliateWithdrawalItem }>(
      "POST",
      `/api/v1/admin/affiliates/withdrawals/${w1.body.item.id}/review`,
      admin,
      { action: "mark_paid", reviewNote: "wired" },
    );
    expect(paid1.status).toBe(200);
    expect(paid1.body.item.status).toBe("paid");

    const reject2 = await call<{ item: AffiliateWithdrawalItem }>(
      "POST",
      `/api/v1/admin/affiliates/withdrawals/${w2.body.item.id}/review`,
      admin,
      { action: "reject", reviewNote: "invalid card" },
    );
    expect(reject2.status).toBe(200);
    expect(reject2.body.item.status).toBe("rejected");

    const accountsRes = await call<{ items: AffiliateAccountItem[] }>(
      "GET",
      "/api/v1/admin/affiliates/accounts?search=alice",
      admin,
    );
    expect(accountsRes.status).toBe(200);
    expect(accountsRes.body.items[0]!.balanceNanoUsd).toBe("9000000000");
    expect(accountsRes.body.items[0]!.totalTransferredNanoUsd).toBe("10000000000");
    expect(accountsRes.body.items[0]!.totalWithdrawnNanoUsd).toBe("6000000000");

    // Refunding Bob's $100 order reverses $25 rebate: takes remaining $9 from pool -> pool=$0, and claws back remaining $16 from API wallet ($10 - $16 = -$6).
    const refundRes = await call("POST", `/api/v1/admin/payments/orders/${orderId}/action`, admin, {
      action: "refund",
      reclaimBalance: true,
    });
    expect(refundRes.status).toBe(200);

    const accountsAfterRefund = await call<{ items: AffiliateAccountItem[] }>(
      "GET",
      "/api/v1/admin/affiliates/accounts?search=alice",
      admin,
    );
    expect(accountsAfterRefund.body.items[0]!.balanceNanoUsd).toBe("0");
    const aliceWalletAfterRefund = await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", alice.headers);
    expect(aliceWalletAfterRefund.body.wallet.balanceNanoUsd).toBe("-6000000000");
  });

  it("C4: enforces multi-use caps, per-user limits, batch per-user limits, multi-use invitations and claim history", async () => {
    const { call, admin, register } = await bootstrap();

    const u1 = await register("u1@redeem.test");
    const u2 = await register("u2@redeem.test");
    const u3 = await register("u3@redeem.test");
    const u4 = await register("u4@redeem.test");

    // 1. Single multi-use code: maxUses=3, perUserLimit=1.
    const gen1 = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, {
      kind: "balance",
      amountUsd: "5",
      count: 1,
      maxUses: 3,
      perUserLimit: 1,
      batchPerUserLimit: 0,
      prefix: "MULTI",
    });
    expect(gen1.status).toBe(201);
    const multiCode = gen1.body.items[0]!.code;
    expect(gen1.body.items[0]!.maxUses).toBe(3);

    expect((await call("POST", "/api/v1/user/redeem", u1.headers, { code: multiCode })).status).toBe(200);
    // Same user cannot exceed perUserLimit=1.
    expect((await call("POST", "/api/v1/user/redeem", u1.headers, { code: multiCode })).status).toBe(409);
    expect((await call("POST", "/api/v1/user/redeem", u2.headers, { code: multiCode })).status).toBe(200);

    // After 2 of 3 claims, status stays "unused".
    const midList = await call<{ items: RedeemCodeItem[] }>("GET", `/api/v1/admin/redeem-codes?search=${multiCode}`, admin);
    expect(midList.body.items[0]!.usedCount).toBe(2);
    expect(midList.body.items[0]!.status).toBe("unused");

    expect((await call("POST", "/api/v1/user/redeem", u3.headers, { code: multiCode })).status).toBe(200);
    // 4th user hits maxUses=3.
    expect((await call("POST", "/api/v1/user/redeem", u4.headers, { code: multiCode })).status).toBe(409);

    const claims = await call<{ items: RedeemCodeClaimItem[] }>(
      "GET",
      `/api/v1/admin/redeem-codes/${encodeURIComponent(multiCode)}/claims`,
      admin,
    );
    expect(claims.status).toBe(200);
    expect(claims.body.items).toHaveLength(3);

    // Every redeemer sees their claim in /user/redeem/history.
    const h2 = await call<{ items: RedeemCodeItem[] }>("GET", "/api/v1/user/redeem/history", u2.headers);
    expect(h2.body.items.some((x) => x.code === multiCode)).toBe(true);

    // 2. Batch per-user limit: 2 codes in one batch with batchPerUserLimit=1.
    const genBatch = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, {
      kind: "balance",
      amountUsd: "2",
      count: 2,
      maxUses: 5,
      perUserLimit: 1,
      batchPerUserLimit: 1,
      prefix: "BAT",
    });
    expect(genBatch.status).toBe(201);
    const [b1, b2] = genBatch.body.items;

    expect((await call("POST", "/api/v1/user/redeem", u1.headers, { code: b1!.code })).status).toBe(200);
    const secondInBatch = await call("POST", "/api/v1/user/redeem", u1.headers, { code: b2!.code });
    expect(secondInBatch.status).toBe(409);
    // u2 can still claim b2.
    expect((await call("POST", "/api/v1/user/redeem", u2.headers, { code: b2!.code })).status).toBe(200);

    // 3. Multi-use subscription code + multi-use invitation code.
    const grp = await call<{ group: GroupItem }>("POST", "/api/v1/admin/groups", admin, {
      name: "multi-sub-grp",
      platform: "anthropic",
      subscriptionType: "subscription",
      dailyLimitUsd: "10",
    });
    const subGen = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, {
      kind: "subscription",
      groupId: grp.body.group.id,
      validityDays: 14,
      count: 1,
      maxUses: 2,
      perUserLimit: 1,
    });
    const subCode = subGen.body.items[0]!.code;
    expect((await call("POST", "/api/v1/user/redeem", u1.headers, { code: subCode })).status).toBe(200);
    expect((await call("POST", "/api/v1/user/redeem", u2.headers, { code: subCode })).status).toBe(200);
    const subsU2 = await call<{ items: UserSubscriptionItem[] }>("GET", "/api/v1/user/subscriptions", u2.headers);
    expect(subsU2.body.items.length).toBe(1);

    await call("PATCH", "/api/v1/admin/settings", admin, { inviteRequired: true });
    const invGen = await call<{ items: RedeemCodeItem[] }>("POST", "/api/v1/admin/redeem-codes/generate", admin, {
      kind: "invitation",
      count: 1,
      maxUses: 2,
    });
    const invCode = invGen.body.items[0]!.code;

    const inv1 = await register("inv1@redeem.test", { inviteCode: invCode });
    expect(inv1.status).toBe(201);
    const inv2 = await register("inv2@redeem.test", { inviteCode: invCode });
    expect(inv2.status).toBe(201);
    const inv3 = await register("inv3@redeem.test", { inviteCode: invCode });
    expect(inv3.status).not.toBe(201);

    const invClaims = await call<{ items: RedeemCodeClaimItem[] }>(
      "GET",
      `/api/v1/admin/redeem-codes/${encodeURIComponent(invCode)}/claims`,
      admin,
    );
    expect(invClaims.body.items).toHaveLength(2);
  });
});
