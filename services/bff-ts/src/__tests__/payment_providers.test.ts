import { describe, expect, it } from "bun:test";
import { createCipheriv, createSign, createVerify, generateKeyPairSync, randomBytes } from "node:crypto";
import type postgres from "postgres";
import type {
  AdminRefundResult,
  AuditLogItem,
  CreateOrderResponse,
  OrderVerifyResult,
  PaymentOptions,
  PaymentOrderItem,
  PaymentPlan,
  PaymentProviderInstance,
  PaymentSweepResult,
  PublicOrderStatus,
  RefundRequiresForce,
  WalletSummary,
  WechatOAuthExchangeResponse,
  WechatOAuthRequired,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { airwallexWebhookSignature, clearAirwallexTokens } from "../payments/airwallex.ts";
import { alipaySignContent, rawJsonValue } from "../payments/alipay.ts";
import { decimalToMinor } from "../payments/http.ts";
import { easypaySign, resolveEasypayRef, stripeSignatureHeader } from "../payments/providers.ts";
import { orderResumeToken, verifyWechatOAuthState, wechatOAuthState } from "../payments/tokens.ts";
import { wxpayDecryptResource } from "../payments/wxpay.ts";
import { MemoryControlStore } from "../store/memory_store.ts";
import { PG_PAYMENT_PROVIDERS_SCHEMA_SQL } from "../store/postgres_payment_providers.ts";
import { PG_PAYMENTS_SCHEMA_SQL } from "../store/postgres_payments.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const NANO = 1_000_000_000n;
const VAULT = "providers-test-vault-secret-32-bytes-min";

type StoreFactory = () => Promise<ControlStore>;

/* ---------------- Generated test keys (never real credentials) ---------------- */

const pemPair = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
// Alipay's key tool prints bare base64: the app key as PKCS#1, Alipay's public key as SPKI.
const derPair = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs1", format: "der" },
});
const ALIPAY_APP = { privateKey: Buffer.from(derPair.privateKey).toString("base64"), publicKeyDer: derPair.publicKey };
const ALIPAY_PLATFORM = pemPair();
const WX_MERCHANT = pemPair();
const WX_PLATFORM = pemPair();
const WX_APIV3 = "0123456789abcdef0123456789abcdef";

const rsaSign = (text: string, key: string) => createSign("RSA-SHA256").update(text, "utf8").sign(key, "base64");

/* ---------------- A fake payment gateway (injected fetch) ---------------- */

type Handler = (url: URL, body: string, init: RequestInit) => Response | Promise<Response>;

function fakeGateway() {
  const routes: [string, Handler][] = [];
  const calls: { url: string; method: string; body: string; headers: Headers }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = typeof init.body === "string" ? init.body : "";
    calls.push({ url: url.toString(), method: init.method ?? "GET", body, headers: new Headers(init.headers) });
    for (const [prefix, h] of routes) if (url.toString().startsWith(prefix)) return h(url, body, init);
    return new Response("not stubbed", { status: 599 });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    /** Later registrations win. */
    on: (prefix: string, h: Handler) => routes.unshift([prefix, h]),
    form: (body: string) => Object.fromEntries(new URLSearchParams(body)),
  };
}

type Call = { url: string; method: string; body: string; headers: Headers };
const lastCall = (calls: Call[], pred: (c: Call) => boolean): Call | undefined => [...calls].reverse().find(pred);

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", ...headers } });

/** EasyPay gateway: mapi.php (QR), api.php?act=order (query), api.php?act=refund. */
function easypayGateway(gw: ReturnType<typeof fakeGateway>, base: string, opts: { paid: Set<string>; refundFail?: { msg: string } | null }) {
  let n = 0;
  gw.on(`${base}/mapi.php`, (_u, body) => {
    const p = gw.form(body);
    n++;
    return json({ code: 1, trade_no: `EPT${n}`, qrcode: `/qr/${p.out_trade_no}`, payurl: `${base}/pay/${p.out_trade_no}` });
  });
  gw.on(`${base}/api.php`, (u, body) => {
    const p = gw.form(body);
    if (u.searchParams.get("act") === "refund") {
      if (opts.refundFail) return json({ code: 0, msg: opts.refundFail.msg });
      return json({ code: 1, msg: "退款成功" });
    }
    const paid = opts.paid.has(p.out_trade_no ?? "");
    return json({ code: 1, status: paid ? 1 : 0, money: "30.00", trade_no: `Q-${p.out_trade_no}` });
  });
}

async function bootstrap(gw = fakeGateway()) {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const store: ControlStore = factory ? await factory() : new MemoryControlStore();
  const app = createBffApp({ store, jwtSecret: "providers-test-jwt-secret-32-bytes-min", vaultSecret: VAULT, paymentFetch: gw.fetchImpl });
  const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
    const res = await app.request(path, { method, headers, body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body) });
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
    siteName: "Providers",
    adminEmail: "admin@prov.test",
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
  const balance = async (headers: Record<string, string>) =>
    BigInt((await call<{ wallet: WalletSummary }>("GET", "/api/v1/user/wallet", headers)).body.wallet.balanceNanoUsd);
  const instance = async (body: Record<string, unknown>) => {
    const res = await call<{ item: PaymentProviderInstance }>("POST", "/api/v1/admin/payments/providers", admin, body);
    expect(res.status).toBe(201);
    return res.body.item;
  };
  const config = async (body: Record<string, unknown>) => {
    const res = await call("PATCH", "/api/v1/admin/payments/config", admin, { enabled: true, callbackBaseUrl: "https://pay.example.com", maxPendingOrders: 50, ...body });
    expect(res.status).toBe(200);
  };
  const order = async (headers: Record<string, string>, body: Record<string, unknown>) => {
    const res = await call<CreateOrderResponse>("POST", "/api/v1/user/orders", headers, body);
    expect(res.status).toBe(201);
    return res.body;
  };
  const getOrder = async (headers: Record<string, string>, id: string) =>
    (await call<{ order: PaymentOrderItem }>("GET", `/api/v1/user/orders/${id}`, headers)).body.order;
  const refund = (id: string, body: Record<string, unknown> = {}) => call<AdminRefundResult & RefundRequiresForce>("POST", `/api/v1/admin/payments/orders/${id}/refund`, admin, body);
  /** Moves an order's deadline into the past (what waiting orderTimeoutMinutes would do). */
  const expire = async (id: string) => {
    const sql = (store as unknown as { sql?: postgres.Sql }).sql;
    if (sql) await sql`UPDATE commerce.payment_orders SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = ${id}`;
    else {
      const rec = (store.payments as unknown as { orders: Map<string, { expiresAtIso: string }> }).orders.get(id)!;
      rec.expiresAtIso = new Date(Date.now() - 60_000).toISOString();
    }
  };
  const easypayNotify = (o: PaymentOrderItem, key: string, pid: string, money = "30.00") => {
    const params: Record<string, string> = {
      pid,
      trade_no: `EPN-${o.id}`,
      out_trade_no: o.id,
      type: o.method ?? "alipay",
      name: "x",
      money,
      trade_status: "TRADE_SUCCESS",
    };
    const q = new URLSearchParams({ ...params, sign: easypaySign(params, key), sign_type: "MD5" });
    return call<string>("GET", `/webhooks/payment/easypay?${q.toString()}`, {});
  };
  /** What spending through the data plane does to the wallet (test shortcut). */
  const spend = async (userId: string, nano: bigint) => {
    const sql = (store as unknown as { sql?: postgres.Sql }).sql;
    if (sql) await sql`UPDATE core.quota_wallets SET balance_nano_usd = balance_nano_usd - ${nano.toString()}::numeric WHERE user_id = ${userId}`;
    else (store as unknown as { wallets: Map<string, { balanceNano: bigint }> }).wallets.get(userId)!.balanceNano -= nano;
  };
  return { gw, store, call, admin, register, balance, instance, config, order, getOrder, refund, expire, easypayNotify, spend };
}

describe("payment provider helpers", () => {
  it("parses amounts, resolves EasyPay references, extracts signed Alipay nodes and round-trips tokens", () => {
    expect(decimalToMinor("30")).toBe(3000);
    expect(decimalToMinor("30.5")).toBe(3050);
    expect(decimalToMinor(30.25)).toBe(3025);
    expect(decimalToMinor("30.000")).toBe(3000);
    expect(decimalToMinor("30.005")).toBeNull();
    expect(decimalToMinor("-1")).toBeNull();
    expect(resolveEasypayRef("https://ep.test/submit.php", "/qr/1")).toBe("https://ep.test/qr/1");
    expect(resolveEasypayRef("https://ep.test", "weixin://wxpay/x")).toBe("weixin://wxpay/x");
    expect(resolveEasypayRef("https://ep.test", "OpaqueToken")).toBe("OpaqueToken");
    const text = '{"alipay_trade_query_response":{"code":"10000","msg":"a \\"}\\" b","x":{"y":1}},"sign":"S"}';
    expect(rawJsonValue(text, "alipay_trade_query_response")).toBe('{"code":"10000","msg":"a \\"}\\" b","x":{"y":1}}');
    expect(alipaySignContent({ b: "2", a: "1", sign: "x", empty: "" })).toBe("a=1&b=2");
    const state = wechatOAuthState(VAULT, "usr_1", "ppiabc123");
    expect(state).toMatch(/^[A-Za-z0-9]+$/);
    expect(state.length).toBeLessThanOrEqual(128);
    expect(verifyWechatOAuthState(VAULT, "usr_1", state)).toBe("ppiabc123");
    expect(verifyWechatOAuthState(VAULT, "usr_2", state)).toBeNull();
    expect(verifyWechatOAuthState("another-vault-secret-of-32-bytes!!", "usr_1", state)).toBeNull();
  });
});

describe("payment provider schema", () => {
  it("re-applies its DDL idempotently on a database that already has orders", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    if (!factory) return; // Postgres only.
    const t = await bootstrap();
    await t.config({ manual: { enabled: true, instructions: "bank" } });
    const buyer = await t.register("schema@prov.test");
    const o = await t.order(buyer.headers, { amount: "7", provider: "manual" });
    const sql = (t.store as unknown as { sql: postgres.Sql }).sql;
    // The older startup block runs first at every start; it must not narrow the status check again.
    await sql.unsafe(PG_PAYMENTS_SCHEMA_SQL);
    await sql.unsafe(PG_PAYMENT_PROVIDERS_SCHEMA_SQL);
    await sql.unsafe(PG_PAYMENT_PROVIDERS_SCHEMA_SQL);
    const def = await sql<{ d: string }[]>`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'payment_orders_status_check'`;
    expect(def[0]!.d).toContain("partially_refunded");
    expect(def[0]!.d).toContain("refund_requested");
    expect((await t.getOrder(buyer.headers, o.order.id)).status).toBe("pending");
  });
});

describe("payment provider instances", () => {
  it("manages instances with write-only secrets, load-balances orders and enforces per-channel limits", async () => {
    const t = await bootstrap();
    const { call, admin, register, instance, config, order } = t;
    const paid = new Set<string>();
    easypayGateway(t.gw, "https://epa.test", { paid });
    easypayGateway(t.gw, "https://epb.test", { paid });

    // Validation: unknown secret fields, broken keys and inverted limits are refused.
    const badSecret = await call("POST", "/api/v1/admin/payments/providers", admin, {
      provider: "easypay",
      name: "x",
      config: { apiUrl: "https://epa.test", pid: "1" },
      secrets: { privateKey: "nope" },
    });
    expect(badSecret.status).toBe(400);
    const badLimit = await call("POST", "/api/v1/admin/payments/providers", admin, {
      provider: "easypay",
      name: "x",
      config: { apiUrl: "https://epa.test", pid: "1" },
      limits: { alipay: { singleMinMinor: 500, singleMaxMinor: 100 } },
    });
    expect(badLimit.status).toBe(400);
    const badKey = await call("POST", "/api/v1/admin/payments/providers", admin, {
      provider: "alipay",
      name: "x",
      config: { appId: "2021", alipayPublicKey: "not a key" },
    });
    expect(badKey.status).toBe(400);

    const a = await instance({
      provider: "easypay",
      name: "EP-A",
      paymentMode: "qrcode",
      supportedTypes: ["alipay", "wxpay"],
      config: { apiUrl: "https://epa.test/submit.php", pid: "2001" },
      secrets: { key: "merchant-key-a" },
      limits: { alipay: { dailyLimitMinor: 10_000 } },
    });
    expect(a.secretsSet).toEqual({ key: true });
    expect(a.ready).toBe(true);
    expect(JSON.stringify(a)).not.toContain("merchant-key-a");
    const b = await instance({
      provider: "easypay",
      name: "EP-B",
      paymentMode: "qrcode",
      supportedTypes: ["alipay"],
      config: { apiUrl: "https://epb.test", pid: "2002" },
      secrets: { key: "merchant-key-b" },
      limits: { alipay: { dailyLimitMinor: 10_000 } },
    });
    const notReady = await instance({ provider: "stripe", name: "Stripe without key", config: {} });
    expect(notReady.ready).toBe(false);
    expect(notReady.secretsSet).toEqual({ secretKey: false, webhookSecret: false });

    // Secrets never reach the audit log.
    const logs = await call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs?pageSize=50", admin);
    const bodies = logs.body.items.filter((i) => i.route.startsWith("/api/v1/admin/payments/providers")).map((i) => i.requestBody);
    expect(bodies.length).toBeGreaterThanOrEqual(3);
    expect(bodies.join("\n")).not.toContain("merchant-key-a");
    expect(bodies.join("\n")).toContain('"pid":"2001"');

    await config({ minorPerUsd: 700, loadBalanceStrategy: "round-robin" });
    const buyer = await register("lb@prov.test");
    let options = await call<PaymentOptions>("GET", "/api/v1/user/payments/options", buyer.headers);
    const alipayChannel = () => options.body.channels.find((ch) => ch.provider === "easypay" && ch.method === "alipay")!;
    expect(options.body.channels.map((ch) => `${ch.provider}:${ch.method ?? ""}`)).toEqual(["easypay:alipay", "easypay:wxpay"]);
    expect(alipayChannel()).toMatchObject({ available: true, dailyLimitMinor: 20_000, dailyRemainingMinor: 20_000 });
    // wxpay is served by A alone, without a limit.
    expect(options.body.channels[1]).toMatchObject({ dailyLimitMinor: 0, dailyRemainingMinor: null });

    // Round-robin over A and B; every order remembers its merchant and shows an in-page QR.
    const placed: CreateOrderResponse[] = [];
    for (let i = 0; i < 4; i++) placed.push(await order(buyer.headers, { amount: "30", provider: "easypay", method: "alipay" }));
    const ids = placed.map((p) => p.order.providerInstanceId);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toBe(ids[2]!);
    const first = placed[0]!;
    expect(first.checkout.flow).toBe("qrcode");
    const host = first.order.providerInstanceId === a.id ? "https://epa.test" : "https://epb.test";
    expect(first.qrCode).toBe(`${host}/qr/${first.order.id}`);
    expect(first.order.providerTradeNo).toMatch(/^EPT/);
    expect(first.order.providerInstanceName).toBe(first.order.providerInstanceId === a.id ? "EP-A" : "EP-B");
    const mapi = t.gw.calls.find((cl) => cl.url.endsWith("/mapi.php") && cl.body.includes(first.order.id))!;
    const sent = t.gw.form(mapi.body);
    expect(sent.notify_url).toBe("https://pay.example.com/webhooks/payment/easypay");
    expect(sent.money).toBe("30.00");
    expect(new URL(sent.return_url!).searchParams.get("token")).toBeTruthy();

    // 6000 of 10000 used on each: a 5000 order fits neither (fail-closed), 4000 still fits.
    const over = await call<{ error: string }>("POST", "/api/v1/user/orders", buyer.headers, { amount: "50", provider: "easypay", method: "alipay" });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe("payment_limit_exceeded");
    await order(buyer.headers, { amount: "40", provider: "easypay", method: "alipay" });
    options = await call<PaymentOptions>("GET", "/api/v1/user/payments/options", buyer.headers);
    expect(alipayChannel().dailyRemainingMinor).toBe(20_000 - 16_000);

    // Single limits steer orders: A takes at most ¥20 now, so a ¥30 plan goes to B (or nowhere).
    await call("PUT", `/api/v1/admin/payments/providers/${a.id}`, admin, { limits: { alipay: { singleMaxMinor: 2000 } } });
    const plan = (await call<{ item: PaymentPlan }>("POST", "/api/v1/admin/payments/plans", admin, { name: "P30", kind: "recharge", price: "30", creditUsd: "1" })).body.item;
    const planOrder = await call<CreateOrderResponse & { error?: string }>("POST", "/api/v1/user/orders", buyer.headers, { planId: plan.id, provider: "easypay", method: "alipay" });
    // B has 10000 - (2×3000 or 3000+4000) left; either way the plan lands on B or is refused.
    if (planOrder.status === 201) expect(planOrder.body.order.providerInstanceId).toBe(b.id);
    else expect(planOrder.body.error).toBe("payment_limit_exceeded");

    // Least-amount picks the merchant with the lower volume today.
    await config({ loadBalanceStrategy: "least-amount" });
    const usage = await call<{ items: PaymentProviderInstance[] }>("GET", "/api/v1/admin/payments/providers", admin);
    const byId = new Map(usage.body.items.map((i) => [i.id, i]));
    expect(byId.get(a.id)!.todayUsageMinor + byId.get(b.id)!.todayUsageMinor).toBeGreaterThanOrEqual(16_000);
    const small = await order(buyer.headers, { amount: "10", provider: "easypay", method: "alipay" });
    const lower = byId.get(a.id)!.todayUsageMinor <= byId.get(b.id)!.todayUsageMinor ? a.id : b.id;
    expect(small.order.providerInstanceId).toBe(lower);

    // Notifications are verified with the order's own merchant key and pid.
    const aOrder = placed.find((p) => p.order.providerInstanceId === a.id)!.order;
    expect((await t.easypayNotify(aOrder, "merchant-key-b", "2002")).status).toBe(400);
    expect((await t.easypayNotify(aOrder, "merchant-key-a", "2002")).status).toBe(400);
    const ok = await t.easypayNotify(aOrder, "merchant-key-a", "2001");
    expect(ok.status).toBe(200);
    expect(ok.body).toBe("success");
    expect((await t.getOrder(buyer.headers, aOrder.id)).status).toBe("paid");

    // Open orders pin the merchant: no deletion, no identity change; the name may change.
    expect((await call("DELETE", `/api/v1/admin/payments/providers/${b.id}`, admin)).status).toBe(409);
    const pidChange = await call<{ error: string }>("PUT", `/api/v1/admin/payments/providers/${b.id}`, admin, { config: { apiUrl: "https://epb.test", pid: "9999" } });
    expect(pidChange.status).toBe(409);
    expect(pidChange.body.error).toBe("instance_has_open_orders");
    const keyChange = await call("PUT", `/api/v1/admin/payments/providers/${b.id}`, admin, { secrets: { key: "rotated" } });
    expect(keyChange.status).toBe(409);
    const renamed = await call<{ item: PaymentProviderInstance }>("PUT", `/api/v1/admin/payments/providers/${b.id}`, admin, { name: "EP-B2", enabled: false });
    expect(renamed.status).toBe(200);
    expect(renamed.body.item).toMatchObject({ name: "EP-B2", enabled: false, secretsSet: { key: true } });
    // A disabled merchant takes no new orders but still verifies its callbacks.
    const bOrder = placed.find((p) => p.order.providerInstanceId === b.id)!.order;
    expect((await t.easypayNotify(bOrder, "merchant-key-b", "2002")).body).toBe("success");

    // Reorder, then delete an instance without open orders.
    const reordered = await call<{ items: PaymentProviderInstance[] }>("POST", "/api/v1/admin/payments/providers/reorder", admin, { ids: [notReady.id, b.id, a.id] });
    expect(reordered.body.items.map((i) => i.id)).toEqual([notReady.id, b.id, a.id]);
    expect((await call("DELETE", `/api/v1/admin/payments/providers/${notReady.id}`, admin)).status).toBe(200);
    expect((await call<{ items: unknown[] }>("GET", "/api/v1/admin/payments/providers", admin)).body.items).toHaveLength(2);
  });
});

describe("order recovery", () => {
  it("checks unpaid orders with the provider, resolves signed resume tokens and sweeps expired orders", async () => {
    const t = await bootstrap();
    const { call, admin, register, instance, config, order } = t;
    const paid = new Set<string>();
    easypayGateway(t.gw, "https://epa.test", { paid });
    const a = await instance({ provider: "easypay", name: "EP", paymentMode: "popup", config: { apiUrl: "https://epa.test", pid: "3001" }, secrets: { key: "k3001" } });
    await config({ minorPerUsd: 700 });
    const buyer = await register("verify@prov.test");
    const other = await register("other@prov.test");

    const created = await order(buyer.headers, { amount: "30", provider: "easypay", method: "alipay", device: "mobile" });
    expect(created.checkout.flow).toBe("redirect");
    const payUrl = new URL(created.payUrl!);
    expect(payUrl.origin + payUrl.pathname).toBe("https://epa.test/submit.php");
    expect(payUrl.searchParams.get("device")).toBe("mobile");
    expect(created.order.providerInstanceId).toBe(a.id);

    // Not paid yet: nothing changes. Someone else's order is not found.
    let verified = await call<OrderVerifyResult>("POST", `/api/v1/user/orders/${created.order.id}/verify`, buyer.headers);
    expect(verified.body).toMatchObject({ providerStatus: "pending", recovered: false });
    expect((await call("POST", `/api/v1/user/orders/${created.order.id}/verify`, other.headers)).status).toBe(404);

    // The notification was lost but the money arrived: the check fulfils the order once.
    paid.add(created.order.id);
    verified = await call<OrderVerifyResult>("POST", `/api/v1/user/orders/${created.order.id}/verify`, buyer.headers);
    expect(verified.body).toMatchObject({ providerStatus: "paid", recovered: true });
    expect(verified.body.order.status).toBe("paid");
    expect(verified.body.order.providerTradeNo).toBe(`Q-${created.order.id}`);
    expect(await t.balance(buyer.headers)).toBe((3000n * NANO) / 700n);
    const again = await call<OrderVerifyResult>("POST", `/api/v1/admin/payments/orders/${created.order.id}/verify`, admin);
    expect(again.body).toMatchObject({ providerStatus: "paid", recovered: false });
    expect(await t.balance(buyer.headers)).toBe((3000n * NANO) / 700n);

    // Public result page: only a valid resume token resolves the order.
    const token = orderResumeToken(VAULT, created.order.id);
    const resolved = await call<PublicOrderStatus>("POST", "/api/v1/payments/public/orders/resolve", JSON_HEADERS, { token });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ id: created.order.id, status: "paid", amountMinor: 3000 });
    expect(JSON.stringify(resolved.body)).not.toContain("verify@prov.test");
    expect((await call("POST", "/api/v1/payments/public/orders/resolve", JSON_HEADERS, { token: `${token.slice(0, -2)}xx` })).status).toBe(404);

    // Sweeper: an expired order the provider reports paid is fulfilled, the others are persisted as expired.
    const late = await order(buyer.headers, { amount: "30", provider: "easypay", method: "alipay" });
    const dead = await order(buyer.headers, { amount: "30", provider: "easypay", method: "alipay" });
    const manual = await config({ manual: { enabled: true, instructions: "bank" } }).then(() => order(buyer.headers, { amount: "7", provider: "manual" }));
    for (const o of [late, dead, manual]) await t.expire(o.order.id);
    paid.add(late.order.id);
    const swept = await call<PaymentSweepResult>("POST", "/api/v1/admin/payments/orders/sweep", admin);
    expect(swept.body).toEqual({ recovered: 1, expired: 2, refundsSettled: 0 });
    expect((await t.getOrder(buyer.headers, late.order.id)).status).toBe("paid");
    expect((await t.getOrder(buyer.headers, dead.order.id)).status).toBe("expired");
    const expiredList = await call<{ total: number }>("GET", "/api/v1/admin/payments/orders?status=expired", admin);
    expect(expiredList.body.total).toBe(2);
    expect((await call<PaymentSweepResult>("POST", "/api/v1/admin/payments/orders/sweep", admin)).body).toEqual({ recovered: 0, expired: 0, refundsSettled: 0 });
    // A late notification for an expired order still delivers.
    paid.add(dead.order.id);
    expect((await t.easypayNotify(dead.order, "k3001", "3001")).body).toBe("success");
    expect((await t.getOrder(buyer.headers, dead.order.id)).status).toBe("paid");
  });
});

describe("gateway refunds and refund requests", () => {
  it("refunds through the gateway in full or in part, handles failures, force and user requests", async () => {
    const t = await bootstrap();
    const { call, admin, register, instance, config, order, refund } = t;
    const paid = new Set<string>();
    const gwState: { refundFail: { msg: string } | null } = { refundFail: null };
    easypayGateway(t.gw, "https://epa.test", { paid, get refundFail() { return gwState.refundFail; } });
    const inst = await instance({ provider: "easypay", name: "EP", config: { apiUrl: "https://epa.test", pid: "4001" }, secrets: { key: "k4001" } });
    await call("PATCH", "/api/v1/admin/settings", admin, { affiliateEnabled: true, affiliateRebateBps: 1000 });
    await config({ minorPerUsd: 700 });
    const referrer = await register("ref@prov.test");
    const aff = await call<{ inviteCode: string }>("GET", "/api/v1/user/affiliate", referrer.headers);
    const buyer = await register("refund@prov.test", { affCode: aff.body.inviteCode });
    const credit = (3000n * NANO) / 700n;
    const rebate = credit / 10n;
    const payOrder = async () => {
      const o = (await order(buyer.headers, { amount: "30", provider: "easypay", method: "alipay" })).order;
      expect((await t.easypayNotify(o, "k4001", "4001")).body).toBe("success");
      return o;
    };

    // Full refund through EasyPay: the credit and the rebate come back.
    const full = await payOrder();
    expect(await t.balance(buyer.headers)).toBe(credit);
    const r1 = await refund(full.id, { reason: "duplicate" });
    expect(r1.status).toBe(200);
    expect(r1.body.outcome).toBe("refunded");
    expect(r1.body.order).toMatchObject({ status: "refunded", refundAmountMinor: 3000, refundReason: "duplicate", refundReclaimedNanoUsd: credit.toString() });
    const refundCall = lastCall(t.gw.calls, (cl) => cl.url.includes("act=refund"))!;
    expect(t.gw.form(refundCall.body)).toMatchObject({ out_trade_no: full.id, money: "30.00", pid: "4001" });
    expect(await t.balance(buyer.headers)).toBe(0n);
    expect(await t.balance(referrer.headers)).toBe(0n);
    expect((await refund(full.id)).status).toBe(409);

    // A third of an order: a third of the credit and of the rebate.
    const part = await payOrder();
    const r2 = await refund(part.id, { amount: "10" });
    expect(r2.body.outcome).toBe("refunded");
    expect(r2.body.order.status).toBe("partially_refunded");
    expect(await t.balance(buyer.headers)).toBe(credit - (credit * 1000n) / 3000n);
    expect(await t.balance(referrer.headers)).toBe(rebate - (rebate * 1000n) / 3000n);
    const refAff = await call<{ rebateTotalNanoUsd: string }>("GET", "/api/v1/user/affiliate", referrer.headers);
    expect(refAff.body.rebateTotalNanoUsd).toBe((rebate - (rebate * 1000n) / 3000n).toString());
    expect((await refund(part.id, { amount: "5" })).status).toBe(409);
    expect((await refund(part.id, { amount: "31" })).status).toBe(409);

    // The gateway refuses: refund_failed, nothing taken back; a retry succeeds.
    const refused = await payOrder();
    const before = await t.balance(buyer.headers);
    gwState.refundFail = { msg: "商户余额不足" };
    const r3 = await refund(refused.id, { amount: "40" });
    expect(r3.status).toBe(400);
    const r4 = await refund(refused.id);
    expect(r4.body.outcome).toBe("failed");
    expect(r4.body.order.status).toBe("refund_failed");
    expect(r4.body.order.refundError).toContain("商户余额不足");
    expect(await t.balance(buyer.headers)).toBe(before);
    // EasyPay cannot be asked about refunds.
    gwState.refundFail = null;
    const retried = await refund(refused.id, { reclaim: false });
    expect(retried.body.outcome).toBe("refunded");
    expect(await t.balance(buyer.headers)).toBe(before);

    // Spent balance: reclaiming needs force, then only what is left is taken.
    const spent = await payOrder();
    const now = await t.balance(buyer.headers);
    await t.spend(buyer.id, now - credit / 2n);
    const left = await t.balance(buyer.headers);
    expect(left).toBe(credit / 2n);
    expect(left).toBeLessThan(credit);
    const needsForce = await refund(spent.id);
    expect(needsForce.status).toBe(409);
    expect(needsForce.body).toMatchObject({ error: "refund_requires_force", balanceNanoUsd: left.toString(), reclaimNanoUsd: credit.toString() });
    expect((await t.getOrder(buyer.headers, spent.id)).status).toBe("paid");
    const forced = await refund(spent.id, { force: true });
    expect(forced.body.outcome).toBe("refunded");
    expect(forced.body.order.refundReclaimedNanoUsd).toBe(left.toString());
    expect(await t.balance(buyer.headers)).toBe(0n);

    // Refund requests: off by default, then on per instance; balance must still cover the top-up.
    const req = await payOrder();
    expect((await t.getOrder(buyer.headers, req.id)).canRequestRefund).toBe(false);
    const denied = await call<{ error: string }>("POST", `/api/v1/user/orders/${req.id}/refund-request`, buyer.headers, { reason: "changed my mind" });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toBe("user_refund_disabled");
    await call("PUT", `/api/v1/admin/payments/providers/${inst.id}`, admin, { allowUserRefund: true });
    expect((await call<PaymentOptions>("GET", "/api/v1/user/payments/options", buyer.headers)).body.userRefundEnabled).toBe(true);
    expect((await t.getOrder(buyer.headers, req.id)).canRequestRefund).toBe(true);
    expect((await call("POST", `/api/v1/user/orders/${req.id}/refund-request`, referrer.headers, { reason: "x" })).status).toBe(404);
    expect((await call("POST", `/api/v1/user/orders/${req.id}/refund-request`, buyer.headers, { reason: "" })).status).toBe(400);
    const requested = await call<{ order: PaymentOrderItem }>("POST", `/api/v1/user/orders/${req.id}/refund-request`, buyer.headers, { reason: "changed my mind" });
    expect(requested.status).toBe(200);
    expect(requested.body.order).toMatchObject({ status: "refund_requested", refundRequestReason: "changed my mind", canRequestRefund: false });
    expect(requested.body.order.refundRequestedAtIso).toBeTruthy();
    expect((await call("POST", `/api/v1/user/orders/${req.id}/refund-request`, buyer.headers, { reason: "again" })).status).toBe(409);
    const queue = await call<{ items: PaymentOrderItem[] }>("GET", "/api/v1/admin/payments/orders?status=refund_requested", admin);
    expect(queue.body.items.map((o) => o.id)).toEqual([req.id]);
    const audits = await call<{ items: AuditLogItem[] }>("GET", "/api/v1/admin/audit-logs?pageSize=50", admin);
    expect(audits.body.items.some((i) => i.route === "/api/v1/user/orders/:id/refund-request" && i.targetId === req.id)).toBe(true);
    // Rejected: back to paid. Requested again and approved: refunded through the gateway with the payer's reason.
    const rejected = await call<{ order: PaymentOrderItem }>("POST", `/api/v1/admin/payments/orders/${req.id}/action`, admin, { action: "reject_refund" });
    expect(rejected.body.order.status).toBe("paid");
    await call("POST", `/api/v1/user/orders/${req.id}/refund-request`, buyer.headers, { reason: "really" });
    const approved = await refund(req.id);
    expect(approved.body.outcome).toBe("refunded");
    expect(approved.body.order).toMatchObject({ status: "refunded", refundReason: "really" });
    // A top-up partly spent can no longer be requested back.
    const spent2 = await payOrder();
    await t.spend(buyer.id, NANO);
    const tooLate = await call<{ message: string }>("POST", `/api/v1/user/orders/${spent2.id}/refund-request`, buyer.headers, { reason: "x" });
    expect(tooLate.status).toBe(409);

    // Recording a refund made elsewhere skips the gateway.
    const recorded = await payOrder();
    const callsBefore = t.gw.calls.length;
    const rec = await refund(recorded.id, { viaProvider: false, reclaim: false });
    expect(rec.body.outcome).toBe("refunded");
    expect(t.gw.calls.length).toBe(callsBefore);
    // Gateway refunds disabled on the instance: only recording is possible.
    await call("PUT", `/api/v1/admin/payments/providers/${inst.id}`, admin, { refundEnabled: false });
    const blocked = await payOrder();
    const unavailable = await call<{ error: string }>("POST", `/api/v1/admin/payments/orders/${blocked.id}/refund`, admin, { viaProvider: true });
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error).toBe("refund_unavailable");

    const dash = await call<{ totals: { refundedOrders: number; paidOrders: number; revenueMinor: number } }>("GET", "/api/v1/admin/payments/dashboard?days=7", admin);
    // refunded: full, refused (retried), spent, req, recorded = 5, partially: part = 1.
    expect(dash.body.totals.refundedOrders).toBe(6);
    // Still earning: part (¥20 kept), spent2, blocked.
    expect(dash.body.totals.paidOrders).toBe(3);
    expect(dash.body.totals.revenueMinor).toBe(2000 + 3000 + 3000);
  });

  it("settles pending Stripe refunds by query and refunds subscription days in proportion", async () => {
    const t = await bootstrap();
    const { call, admin, register, config, order, refund } = t;
    let refundState = "pending";
    t.gw.on("https://api.stripe.com/v1/checkout/sessions", (u, _b, init) => {
      if (init.method === "POST" && u.pathname.endsWith("/expire")) return json({ id: u.pathname.split("/")[4], status: "expired" });
      if (init.method === "POST") return json({ id: "cs_test_9", url: "https://checkout.stripe.test/cs_test_9" });
      return json({ id: "cs_test_9", status: "complete", payment_status: "paid", amount_total: 2000, currency: "usd", payment_intent: "pi_9" });
    });
    t.gw.on("https://api.stripe.com/v1/refunds", (u, _b, init) =>
      init.method === "POST" ? json({ id: "re_9", status: "pending" }) : json({ id: u.pathname.split("/").pop(), status: refundState }),
    );
    await config({
      currency: "USD",
      minorPerUsd: 100,
      stripe: { enabled: true, secretKey: "sk_test_providers", webhookSecret: "whsec_providers" },
    });
    const group = (await call<{ group: { id: string } }>("POST", "/api/v1/admin/groups", admin, { name: "sub-prov", platform: "anthropic", subscriptionType: "subscription" })).body.group;
    const plan = (
      await call<{ item: PaymentPlan }>("POST", "/api/v1/admin/payments/plans", admin, {
        name: "Monthly",
        kind: "subscription",
        price: "20",
        currency: "USD",
        groupId: group.id,
        validityDays: 30,
      })
    ).body.item;
    const buyer = await register("stripe-sub@prov.test");
    const created = await order(buyer.headers, { planId: plan.id, provider: "stripe" });
    expect(created.order.providerTradeNo).toBe("cs_test_9");
    const session = t.gw.calls.find((cl) => cl.url === "https://api.stripe.com/v1/checkout/sessions" && cl.method === "POST")!;
    expect(new URLSearchParams(session.body).get("expires_at")).toMatch(/^\d+$/);
    expect(new URLSearchParams(session.body).get("success_url")).toContain("token=");

    // The webhook never came: the result page's check finds the payment.
    const verified = await call<OrderVerifyResult>("POST", `/api/v1/user/orders/${created.order.id}/verify`, buyer.headers);
    expect(verified.body).toMatchObject({ providerStatus: "paid", recovered: true });
    expect(verified.body.order.providerTradeNo).toBe("pi_9");
    const subs = async () => (await call<{ items: { expiresAtIso: string; status: string }[] }>("GET", "/api/v1/user/subscriptions", buyer.headers)).body.items;
    const daysLeft = async () => (Date.parse((await subs())[0]!.expiresAtIso) - Date.now()) / 86_400_000;
    expect(await daysLeft()).toBeGreaterThan(29.9);

    // Half refunded: pending at Stripe, nothing taken back until it settles.
    const r = await refund(created.order.id, { amount: "10" });
    expect(r.body.outcome).toBe("pending");
    expect(r.body.order).toMatchObject({ status: "refund_pending", providerRefundId: "re_9", refundAmountMinor: 1000 });
    // A second click while it is pending is refused (re-sending is for refunds stuck over a minute).
    expect((await refund(created.order.id, { amount: "10" })).status).toBe(409);
    const refundPost = lastCall(t.gw.calls, (cl) => cl.url === "https://api.stripe.com/v1/refunds")!;
    expect(new URLSearchParams(refundPost.body).get("payment_intent")).toBe("pi_9");
    expect(new URLSearchParams(refundPost.body).get("amount")).toBe("1000");
    expect(refundPost.headers.get("idempotency-key")).toBe(`refund-${created.order.id}-1000`);
    expect(await daysLeft()).toBeGreaterThan(29.9);
    let q = await call<AdminRefundResult>("POST", `/api/v1/admin/payments/orders/${created.order.id}/refund/query`, admin);
    expect(q.body.outcome).toBe("pending");
    refundState = "succeeded";
    q = await call<AdminRefundResult>("POST", `/api/v1/admin/payments/orders/${created.order.id}/refund/query`, admin);
    expect(q.body.outcome).toBe("refunded");
    expect(q.body.order.status).toBe("partially_refunded");
    // 15 of the 30 days went back with the money.
    expect(await daysLeft()).toBeLessThan(15.01);
    expect(await daysLeft()).toBeGreaterThan(14.9);
    expect((await call("POST", `/api/v1/admin/payments/orders/${created.order.id}/refund/query`, admin)).status).toBe(409);

    // Cancelling an unpaid Stripe order expires its checkout session.
    t.gw.on("https://api.stripe.com/v1/checkout/sessions/cs_test_9", (_u, _b, init) =>
      init.method === "POST" ? json({ id: "cs_test_9", status: "expired" }) : json({ id: "cs_test_9", status: "open", payment_status: "unpaid", amount_total: 2000, currency: "usd" }),
    );
    const unpaid = await order(buyer.headers, { amount: "20", provider: "stripe" });
    const cancelled = await call<{ order: PaymentOrderItem }>("POST", `/api/v1/user/orders/${unpaid.order.id}/cancel`, buyer.headers);
    expect(cancelled.body.order.status).toBe("cancelled");
    expect(t.gw.calls.some((cl) => cl.url.endsWith("/checkout/sessions/cs_test_9/expire") && cl.method === "POST")).toBe(true);

    // A pending refund left by a lost answer is settled by the sweeper (refund_pending older than a minute).
    const other = await order(buyer.headers, { amount: "20", provider: "stripe" });
    t.gw.on("https://api.stripe.com/v1/checkout/sessions/cs_test_9", () => json({ id: "cs_test_9", status: "complete", payment_status: "paid", amount_total: 2000, currency: "usd", payment_intent: "pi_10" }));
    await call("POST", `/api/v1/user/orders/${other.order.id}/verify`, buyer.headers);
    refundState = "pending";
    expect((await refund(other.order.id)).body.outcome).toBe("pending");
    const sql = (t.store as unknown as { sql?: postgres.Sql }).sql;
    if (sql) await sql`UPDATE commerce.payment_orders SET updated_at = NOW() - INTERVAL '2 minutes' WHERE id = ${other.order.id}`;
    else (t.store.payments as unknown as { orders: Map<string, { updatedAtMs: number }> }).orders.get(other.order.id)!.updatedAtMs -= 120_000;
    refundState = "failed";
    const swept = await call<PaymentSweepResult>("POST", "/api/v1/admin/payments/orders/sweep", admin);
    expect(swept.body.refundsSettled).toBe(1);
    expect((await t.getOrder(buyer.headers, other.order.id)).status).toBe("refund_failed");
    expect((await call<{ order: PaymentOrderItem }>("POST", `/api/v1/admin/payments/orders/${other.order.id}/action`, admin, { action: "reject_refund" })).body.order.status).toBe("paid");

    // Stripe webhooks still verify against the configured endpoint secret.
    const payload = JSON.stringify({ type: "payment_intent.created", data: { object: {} } });
    const sig = await stripeSignatureHeader(payload, "whsec_providers");
    expect((await call("POST", "/webhooks/payment/stripe", { "Content-Type": "application/json", "Stripe-Signature": sig }, payload)).status).toBe(200);
    expect((await call("POST", "/webhooks/payment/stripe", { "Content-Type": "application/json", "Stripe-Signature": await stripeSignatureHeader(payload, "whsec_x") }, payload)).status).toBe(400);
  });
});

describe("official Alipay", () => {
  it("creates QR and cashier trades, verifies RSA2 notifications and refunds", async () => {
    const t = await bootstrap();
    const { call, register, instance, config, order, refund } = t;
    const tradeStatus = new Map<string, string>();
    t.gw.on("https://openapi-sandbox.dl.alipaydev.com/gateway.do", (_u, body) => {
      const p = t.gw.form(body);
      // Every request is signed with the app key.
      const verifier = createVerify("RSA-SHA256").update(alipaySignContent(p), "utf8");
      if (!verifier.verify({ key: Buffer.from(ALIPAY_APP.publicKeyDer), format: "der", type: "spki" }, p.sign!, "base64")) return json({ error: "bad sign" }, 400);
      const biz = JSON.parse(p.biz_content!) as Record<string, string>;
      const node = `${p.method!.replace(/\./g, "_")}_response`;
      let payload: Record<string, unknown>;
      if (p.method === "alipay.trade.precreate") payload = { code: "10000", msg: "Success", out_trade_no: biz.out_trade_no, qr_code: `https://qr.alipay.com/${biz.out_trade_no}` };
      else if (p.method === "alipay.trade.query") {
        const s = tradeStatus.get(biz.out_trade_no!);
        payload = s ? { code: "10000", msg: "Success", trade_status: s, total_amount: "30.00", trade_no: `ALI-${biz.out_trade_no}` } : { code: "40004", msg: "Business Failed", sub_code: "ACQ.TRADE_NOT_EXIST" };
      } else if (p.method === "alipay.trade.refund") payload = { code: "10000", msg: "Success", fund_change: "Y", refund_fee: biz.refund_amount };
      else payload = { code: "10000", msg: "Success" };
      const nodeJson = JSON.stringify(payload);
      return new Response(`{"${node}":${nodeJson},"sign":"${rsaSign(nodeJson, ALIPAY_PLATFORM.privateKey)}"}`, { status: 200 });
    });
    const inst = await instance({
      provider: "alipay",
      name: "Alipay",
      config: { appId: "2021000000000001", alipayPublicKey: ALIPAY_PLATFORM.publicKey, sandbox: true, modes: ["precreate", "page", "wap"] },
      secrets: { privateKey: ALIPAY_APP.privateKey },
    });
    expect(inst.ready).toBe(true);
    await config({ minorPerUsd: 700 });
    const buyer = await register("alipay@prov.test");
    const options = await call<PaymentOptions>("GET", "/api/v1/user/payments/options", buyer.headers);
    expect(options.body.channels.map((c) => c.provider)).toEqual(["alipay"]);

    const desktop = await order(buyer.headers, { amount: "30", provider: "alipay" });
    expect(desktop.checkout).toMatchObject({ flow: "qrcode", qrCode: `https://qr.alipay.com/${desktop.order.id}`, appLink: null });
    const phone = await order(buyer.headers, { amount: "30", provider: "alipay", device: "mobile" });
    expect(phone.checkout.flow).toBe("redirect");
    const wap = new URL(phone.payUrl!);
    expect(wap.searchParams.get("method")).toBe("alipay.trade.wap.pay");
    expect(wap.searchParams.get("notify_url")).toBe("https://pay.example.com/webhooks/payment/alipay");

    // Notifications: only Alipay's signature over the exact fields counts.
    const notify = (o: PaymentOrderItem, overrides: Record<string, string> = {}, key = ALIPAY_PLATFORM.privateKey) => {
      const params: Record<string, string> = {
        app_id: "2021000000000001",
        out_trade_no: o.id,
        trade_no: `ALI-${o.id}`,
        trade_status: "TRADE_SUCCESS",
        total_amount: "30.00",
        notify_time: "2026-11-22 12:00:00",
        charset: "utf-8",
        ...overrides,
      };
      const signed = { ...params, sign_type: "RSA2", sign: rsaSign(alipaySignContent(params, ["sign", "sign_type"]), key) };
      return call<string>("POST", "/webhooks/payment/alipay", { "Content-Type": "application/x-www-form-urlencoded" }, new URLSearchParams(signed).toString());
    };
    expect((await notify(desktop.order)).status).toBe(200);
    expect((await t.getOrder(buyer.headers, desktop.order.id)).status).toBe("paid");
    expect((await notify(phone.order, {}, pemPair().privateKey)).status).toBe(400);
    expect((await notify(phone.order, { total_amount: "0.01" })).status).toBe(400);
    expect((await notify(phone.order, { app_id: "2099" })).status).toBe(400);
    expect((await t.getOrder(buyer.headers, phone.order.id)).status).toBe("pending");

    // Missed notification: the trade query recovers it.
    tradeStatus.set(phone.order.id, "TRADE_SUCCESS");
    const verified = await call<OrderVerifyResult>("POST", `/api/v1/user/orders/${phone.order.id}/verify`, buyer.headers);
    expect(verified.body).toMatchObject({ providerStatus: "paid", recovered: true });

    const r = await refund(desktop.order.id, { amount: "15", reason: "partial" });
    expect(r.body.outcome).toBe("refunded");
    expect(r.body.order).toMatchObject({ status: "partially_refunded", providerRefundId: `${desktop.order.id}R1500` });
    const refundReq = lastCall(t.gw.calls, (cl) => t.gw.form(cl.body).method === "alipay.trade.refund")!;
    expect(JSON.parse(t.gw.form(refundReq.body).biz_content!)).toMatchObject({ out_trade_no: desktop.order.id, refund_amount: "15.00", out_request_no: `${desktop.order.id}R1500` });

    // A forged gateway answer (wrong signer) is never trusted.
    const forged = await order(buyer.headers, { amount: "30", provider: "alipay" });
    t.gw.on("https://openapi-sandbox.dl.alipaydev.com/gateway.do", (_u, body) => {
      const p = t.gw.form(body);
      const nodeJson = JSON.stringify({ code: "10000", trade_status: "TRADE_SUCCESS", total_amount: "30.00" });
      return new Response(`{"${p.method!.replace(/\./g, "_")}_response":${nodeJson},"sign":"${rsaSign(nodeJson, pemPair().privateKey)}"}`);
    });
    const check = await call<OrderVerifyResult>("POST", `/api/v1/user/orders/${forged.order.id}/verify`, buyer.headers);
    expect(check.body.providerStatus).toBe("unknown");
    expect((await t.getOrder(buyer.headers, forged.order.id)).status).toBe("pending");
  });
});

describe("official WeChat Pay", () => {
  it("pays by Native QR and JSAPI after the payment OAuth, verifies v3 notifications and settles refunds", async () => {
    const t = await bootstrap();
    const { call, admin, register, instance, config, order, refund } = t;
    const publicKeyId = "PUB_KEY_ID_0114232134912410000000000000";
    let refundStatus = "PROCESSING";
    const signedJson = (payload: Record<string, unknown>, status = 200) => {
      const text = JSON.stringify(payload);
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(8).toString("hex");
      return new Response(text, {
        status,
        headers: {
          "Content-Type": "application/json",
          "Wechatpay-Timestamp": ts,
          "Wechatpay-Nonce": nonce,
          "Wechatpay-Serial": publicKeyId,
          "Wechatpay-Signature": rsaSign(`${ts}\n${nonce}\n${text}\n`, WX_PLATFORM.privateKey),
        },
      });
    };
    t.gw.on("https://api.mch.weixin.qq.com/", (u, body, init) => {
      // Requests carry the merchant's v3 signature.
      const auth = new Headers(init.headers).get("authorization") ?? "";
      const field = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(auth)?.[1] ?? "";
      const message = `${init.method}\n${u.pathname}${u.search}\n${field("timestamp")}\n${field("nonce_str")}\n${body}\n`;
      if (!createVerify("RSA-SHA256").update(message).verify(WX_MERCHANT.publicKey, field("signature"), "base64") || field("mchid") !== "1900000001") {
        return json({ code: "SIGN_ERROR", message: "bad signature" }, 401);
      }
      if (u.pathname === "/v3/pay/transactions/native") return signedJson({ code_url: "weixin://wxpay/bizpayurl?pr=native1" });
      if (u.pathname === "/v3/pay/transactions/h5") {
        expect(JSON.parse(body).scene_info.h5_info.type).toBe("Wap");
        return signedJson({ h5_url: "https://wx.tenpay.com/cgi-bin/mmpayweb-bin/checkmweb?prepay_id=wxh5" });
      }
      if (u.pathname === "/v3/pay/transactions/jsapi") {
        expect(JSON.parse(body).payer.openid).toBe("o-payer-openid");
        expect(JSON.parse(body).appid).toBe("wx-mp-appid");
        return signedJson({ prepay_id: "wx201410272009395522657a690389285100" });
      }
      if (u.pathname === "/v3/refund/domestic/refunds") return signedJson({ out_refund_no: JSON.parse(body).out_refund_no, status: refundStatus });
      if (u.pathname.startsWith("/v3/refund/domestic/refunds/")) return signedJson({ out_refund_no: u.pathname.split("/").pop(), status: refundStatus });
      if (u.pathname.endsWith("/close")) return new Response(null, { status: 204 });
      return signedJson({ trade_state: "NOTPAY", amount: { total: 3000, currency: "CNY" } });
    });
    t.gw.on("https://api.weixin.qq.com/sns/oauth2/access_token", (u) =>
      u.searchParams.get("code") === "good-code" && u.searchParams.get("secret") === "mp-app-secret" && u.searchParams.get("appid") === "wx-mp-appid"
        ? json({ access_token: "at", openid: "o-payer-openid", scope: "snsapi_base" })
        : json({ errcode: 40029, errmsg: "invalid code" }),
    );
    const badV3 = await call("POST", "/api/v1/admin/payments/providers", admin, {
      provider: "wxpay",
      name: "x",
      config: { appId: "wx-appid", mchId: "1900000001", certSerial: "SERIAL", publicKeyId, publicKey: WX_PLATFORM.publicKey },
      secrets: { apiV3Key: "short" },
    });
    expect(badV3.status).toBe(400);
    const inst = await instance({
      provider: "wxpay",
      name: "WeChat",
      config: {
        appId: "wx-appid",
        mpAppId: "wx-mp-appid",
        mchId: "1900000001",
        certSerial: "MERCHANT_SERIAL",
        publicKeyId,
        publicKey: WX_PLATFORM.publicKey,
        modes: ["native", "h5", "jsapi"],
      },
      secrets: { privateKey: WX_MERCHANT.privateKey, apiV3Key: WX_APIV3, mpAppSecret: "mp-app-secret" },
    });
    expect(inst.secretsSet).toEqual({ privateKey: true, apiV3Key: true, mpAppSecret: true });
    await config({ minorPerUsd: 700 });
    const buyer = await register("wechat@prov.test");

    const native = await order(buyer.headers, { amount: "30", provider: "wxpay" });
    expect(native.checkout).toMatchObject({ flow: "qrcode", qrCode: "weixin://wxpay/bizpayurl?pr=native1" });
    const h5 = await order(buyer.headers, { amount: "30", provider: "wxpay", device: "mobile" });
    expect(h5.checkout.flow).toBe("redirect");
    const h5Url = new URL(h5.payUrl!);
    expect(h5Url.searchParams.get("prepay_id")).toBe("wxh5");
    expect(h5Url.searchParams.get("redirect_url")).toContain(`/payment/result?order=${h5.order.id}`);

    // Inside WeChat: OAuth first, then JSAPI with the payer's openid.
    const needAuth = await call<WechatOAuthRequired>("POST", "/api/v1/user/orders", buyer.headers, { amount: "30", provider: "wxpay", device: "wechat" });
    expect(needAuth.status).toBe(409);
    expect(needAuth.body.error).toBe("wechat_oauth_required");
    const authorize = new URL(needAuth.body.authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe("https://open.weixin.qq.com/connect/oauth2/authorize");
    expect(authorize.searchParams.get("appid")).toBe("wx-mp-appid");
    expect(authorize.searchParams.get("scope")).toBe("snsapi_base");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://pay.example.com/payment/wechat/callback");
    const state = authorize.searchParams.get("state")!;
    const intruder = await register("intruder@prov.test");
    expect((await call("POST", "/api/v1/user/payments/wechat/oauth", intruder.headers, { code: "good-code", state })).status).toBe(400);
    expect((await call("POST", "/api/v1/user/payments/wechat/oauth", buyer.headers, { code: "bad-code", state })).status).toBe(502);
    const exchanged = await call<WechatOAuthExchangeResponse>("POST", "/api/v1/user/payments/wechat/oauth", buyer.headers, { code: "good-code", state });
    expect(exchanged.status).toBe(200);
    const jsapi = await order(buyer.headers, { amount: "30", provider: "wxpay", device: "wechat", wechatResumeToken: exchanged.body.wechatResumeToken });
    expect(jsapi.checkout.flow).toBe("jsapi");
    const p = jsapi.checkout.jsapi!;
    expect(p).toMatchObject({ appId: "wx-mp-appid", package: "prepay_id=wx201410272009395522657a690389285100", signType: "RSA" });
    expect(createVerify("RSA-SHA256").update(`${p.appId}\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`).verify(WX_MERCHANT.publicKey, p.paySign, "base64")).toBe(true);
    // The token is bound to its payer.
    expect((await call("POST", "/api/v1/user/orders", intruder.headers, { amount: "30", provider: "wxpay", device: "wechat", wechatResumeToken: exchanged.body.wechatResumeToken })).status).toBe(400);

    // v3 notification: signed by the platform key, resource sealed with the APIv3 key.
    const notify = (o: PaymentOrderItem, opts: { total?: number; signer?: string; apiV3?: string } = {}) => {
      const tx = JSON.stringify({ mchid: "1900000001", appid: "wx-appid", out_trade_no: o.id, transaction_id: `42000${o.id.slice(-6)}`, trade_state: "SUCCESS", amount: { total: opts.total ?? 3000, currency: "CNY" } });
      const iv = randomBytes(6).toString("hex");
      const cipher = createCipheriv("aes-256-gcm", Buffer.from(opts.apiV3 ?? WX_APIV3), Buffer.from(iv));
      cipher.setAAD(Buffer.from("transaction"));
      const ct = Buffer.concat([cipher.update(tx, "utf8"), cipher.final(), cipher.getAuthTag()]).toString("base64");
      const text = JSON.stringify({ id: "EV-1", event_type: "TRANSACTION.SUCCESS", resource_type: "encrypt-resource", resource: { algorithm: "AEAD_AES_256_GCM", ciphertext: ct, nonce: iv, associated_data: "transaction" } });
      expect(wxpayDecryptResource(opts.apiV3 ?? WX_APIV3, { ciphertext: ct, nonce: iv, associated_data: "transaction" })).toBe(tx);
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomBytes(8).toString("hex");
      return call<{ code?: string }>(
        "POST",
        "/webhooks/payment/wxpay",
        {
          "Content-Type": "application/json",
          "Wechatpay-Timestamp": ts,
          "Wechatpay-Nonce": nonce,
          "Wechatpay-Serial": publicKeyId,
          "Wechatpay-Signature": rsaSign(`${ts}\n${nonce}\n${text}\n`, opts.signer ?? WX_PLATFORM.privateKey),
        },
        text,
      );
    };
    expect((await notify(native.order, { signer: pemPair().privateKey })).status).toBe(400);
    expect((await notify(native.order, { apiV3: "ffffffffffffffffffffffffffffffff" })).status).toBe(400);
    expect((await notify(native.order, { total: 1 })).status).toBe(400);
    const ok = await notify(native.order);
    expect(ok.status).toBe(204);
    expect((await t.getOrder(buyer.headers, native.order.id)).status).toBe("paid");
    expect((await notify(native.order)).status).toBe(204);
    expect(await t.balance(buyer.headers)).toBe((3000n * NANO) / 700n);

    // Refund: PROCESSING → pending, then the query (or the sweeper) settles it.
    const r = await refund(native.order.id);
    expect(r.body.outcome).toBe("pending");
    expect(r.body.order.providerRefundId).toBe(`${native.order.id}R3000`);
    const sent = lastCall(t.gw.calls, (cl) => cl.url.endsWith("/v3/refund/domestic/refunds"))!;
    expect(JSON.parse(sent.body)).toMatchObject({ out_trade_no: native.order.id, amount: { refund: 3000, total: 3000, currency: "CNY" } });
    refundStatus = "SUCCESS";
    const settled = await call<AdminRefundResult>("POST", `/api/v1/admin/payments/orders/${native.order.id}/refund/query`, admin);
    expect(settled.body.outcome).toBe("refunded");
    expect(settled.body.order.status).toBe("refunded");
    expect(await t.balance(buyer.headers)).toBe(0n);

    // Cancelling an unpaid Native order closes it at WeChat Pay.
    const cancelled = await call<{ order: PaymentOrderItem }>("POST", `/api/v1/user/orders/${jsapi.order.id}/cancel`, buyer.headers);
    expect(cancelled.body.order.status).toBe("cancelled");
    expect(t.gw.calls.some((cl) => cl.url.endsWith(`/v3/pay/transactions/out-trade-no/${jsapi.order.id}/close`))).toBe(true);
  });
});

describe("Airwallex", () => {
  it("creates payment intents, verifies webhook signatures and refunds", async () => {
    clearAirwallexTokens();
    const t = await bootstrap();
    const { call, register, instance, config, order, refund } = t;
    let logins = 0;
    t.gw.on("https://api-demo.airwallex.com/api/v1/authentication/login", (_u, _b, init) => {
      const h = new Headers(init.headers);
      if (h.get("x-client-id") !== "awx-client" || h.get("x-api-key") !== "awx-api-key") return json({ message: "unauthorized" }, 401);
      logins++;
      return json({ token: "awx-token", expires_at: new Date(Date.now() + 30 * 60_000).toISOString() });
    });
    t.gw.on("https://api-demo.airwallex.com/api/v1/pa/", (u, body, init) => {
      if (new Headers(init.headers).get("authorization") !== "Bearer awx-token") return json({ message: "no token" }, 401);
      if (u.pathname.endsWith("/payment_intents/create")) {
        const b = JSON.parse(body);
        return json({ id: `int_${b.merchant_order_id}`, client_secret: "awx-client-secret", status: "REQUIRES_PAYMENT_METHOD", request_id: b.request_id });
      }
      if (u.pathname.endsWith("/refunds/create")) return json({ id: "rfd_1", status: "SETTLED" });
      return json({ id: "x", status: "SUCCEEDED" });
    });
    const inst = await instance({
      provider: "airwallex",
      name: "Airwallex",
      config: { clientId: "awx-client", env: "demo", currency: "USD", countryCode: "US" },
      secrets: { apiKey: "awx-api-key", webhookSecret: "awx-webhook-secret" },
    });
    expect(inst.ready).toBe(true);
    await config({ currency: "USD", minorPerUsd: 100 });
    const buyer = await register("awx@prov.test");
    const created = await order(buyer.headers, { amount: "25", provider: "airwallex" });
    expect(created.checkout).toMatchObject({
      flow: "airwallex",
      airwallex: { intentId: `int_${created.order.id}`, clientSecret: "awx-client-secret", currency: "USD", countryCode: "US", env: "demo" },
    });
    expect(created.order.providerTradeNo).toBe(`int_${created.order.id}`);
    const second = await order(buyer.headers, { amount: "25", provider: "airwallex" });
    expect(logins).toBe(1);
    const intents = t.gw.calls.filter((cl) => cl.url.endsWith("/payment_intents/create")).map((cl) => JSON.parse(cl.body).request_id as string);
    expect(new Set(intents).size).toBe(2);
    expect(intents[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const hook = (o: PaymentOrderItem, opts: { amount?: number; secret?: string; ts?: number } = {}) => {
      const text = JSON.stringify({
        name: "payment_intent.succeeded",
        data: { object: { id: `int_${o.id}`, merchant_order_id: o.id, amount: opts.amount ?? 25, currency: "USD", status: "SUCCEEDED" } },
      });
      const ts = String(opts.ts ?? Date.now());
      return call("POST", "/webhooks/payment/airwallex", { "Content-Type": "application/json", "x-timestamp": ts, "x-signature": airwallexWebhookSignature(text, ts, opts.secret ?? "awx-webhook-secret") }, text);
    };
    expect((await hook(created.order, { secret: "other" })).status).toBe(400);
    expect((await hook(created.order, { ts: Date.now() - 10 * 60_000 })).status).toBe(400);
    expect((await hook(created.order, { amount: 1 })).status).toBe(400);
    expect((await hook(created.order)).status).toBe(200);
    expect((await t.getOrder(buyer.headers, created.order.id)).status).toBe("paid");
    expect(await t.balance(buyer.headers)).toBe(25n * NANO);
    // Unrelated events are acknowledged once verified.
    const other = JSON.stringify({ name: "payment_intent.created", data: { object: {} } });
    const ts = String(Date.now());
    expect((await call("POST", "/webhooks/payment/airwallex", { "x-timestamp": ts, "x-signature": airwallexWebhookSignature(other, ts, "awx-webhook-secret") }, other)).status).toBe(200);

    const r = await refund(created.order.id);
    expect(r.body).toMatchObject({ outcome: "refunded", order: { status: "refunded", providerRefundId: "rfd_1" } });
    const sent = JSON.parse(lastCall(t.gw.calls, (cl) => cl.url.endsWith("/refunds/create"))!.body);
    expect(sent).toMatchObject({ payment_intent_id: `int_${created.order.id}`, amount: 25 });
    expect(await t.balance(buyer.headers)).toBe(0n);
    void second;
    void call;
  });
});
