import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  AdminOrderActionRequestSchema,
  AdminRefundRequestSchema,
  CreateOrderRequestSchema,
  DEFAULT_PAYMENT_CONFIG,
  fiatToMinor,
  OrderListQuerySchema,
  PAID_ORDER_STATUSES,
  parseUsdToNano,
  ResolveOrderRequestSchema,
  UpdatePaymentConfigRequestSchema,
  UpsertPaymentPlanRequestSchema,
  UserRefundRequestSchema,
  WechatOAuthExchangeRequestSchema,
  type CreateOrderResponse,
  type PaymentCheckout,
  type PaymentOptions,
  type PaymentOrderItem,
  type PublicOrderStatus,
  type WechatOAuthExchangeResponse,
  type WechatOAuthRequired,
} from "@slipgate/contracts";
import { WindowLimiter } from "../insights.ts";
import type { AuthEnv } from "../middleware/auth.ts";
import { airwallexVerifyWebhook } from "../payments/airwallex.ts";
import { alipayVerifyNotification } from "../payments/alipay.ts";
import { alipayCreds, channelType, createCheckout, wxpayCreds, wxpayJsapiReady, type Merchant } from "../payments/gateway.ts";
import { decimalToMinor, errorText, parseJsonObject, str } from "../payments/http.ts";
import { easypayVerify, stripeVerifySignature } from "../payments/providers.ts";
import { CNY_ONLY_PROVIDERS, PaymentService } from "../payments/service.ts";
import {
  orderFromResumeToken,
  orderResumeToken,
  readWechatResumeToken,
  verifyWechatOAuthState,
  WECHAT_RESUME_TTL_SEC,
  wechatOAuthState,
  wechatResumeToken,
} from "../payments/tokens.ts";
import { wechatOAuthAuthorizeUrl, wechatOAuthOpenid, wxpayDecryptResource, wxpayJsapiAppId, wxpaySignatureHeaders, wxpayVerifySignature } from "../payments/wxpay.ts";
import { clientAddress, clientIp, safeRequestOrigin } from "../security/client_ip.ts";
import type { OrderInput, PlanInput } from "../store/payments_types.ts";
import { StoreError, type ControlStore } from "../store/types.ts";
import { registerPaymentProviderRoutes } from "./payment_providers.ts";

export interface PaymentRouteContext {
  store: ControlStore;
  vaultSecret: string;
  syncDataPlane: () => Promise<void>;
  /** Plugin hook fired once per fulfilled order. */
  onOrderPaid?: (order: PaymentOrderItem) => Promise<void>;
  /** Overridable for tests: every payment gateway call goes through it. */
  fetchImpl?: typeof fetch;
  /** Run the expiry / refund sweeper every minute (the server entrypoint only). */
  startSchedulers?: boolean;
}

type App = Hono<AuthEnv>;

const SWEEP_INTERVAL_MS = 60_000;

function bad(issues: z.ZodIssue[]): never {
  const message = issues
    .slice(0, 3)
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
  throw new StoreError("bad_request", message || "Invalid request");
}

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) bad(parsed.error.issues);
  return parsed.data;
}

function requestOrigin(c: Context): string {
  return safeRequestOrigin(c);
}

/** The payer's address for gateways that want it (H5 / API payments); empty when unknown. */
const payerIp = (c: Context) => {
  const ip = clientAddress(c);
  return ip === "unknown" ? "" : ip;
};

const tooMany = (c: Context) => c.json({ error: "rate_limited", message: "Too many requests; try again in a minute" }, 429);

export function registerPaymentRoutes(app: App, ctx: PaymentRouteContext): PaymentService {
  const { store, vaultSecret } = ctx;
  const payments = store.payments;
  const service = new PaymentService(ctx);
  const verifyLimiter = new WindowLimiter(20, 60_000);
  const publicLimiter = new WindowLimiter(30, 60_000);
  const oauthLimiter = new WindowLimiter(10, 60_000);

  async function callbackBase(c: Context, callbackBaseUrl: string): Promise<string> {
    if (callbackBaseUrl) return callbackBaseUrl.replace(/\/+$/, "");
    const settings = await store.ops.getSettings();
    if (/^https?:\/\//i.test(settings.apiBaseUrl)) return settings.apiBaseUrl.replace(/\/+$/, "");
    return requestOrigin(c);
  }

  /* ---------------- Config (secrets encrypted at rest, never returned) ---------------- */

  app.get("/api/v1/admin/payments/config", async (c) => c.json((await service.loadConfig()).config));

  app.patch("/api/v1/admin/payments/config", async (c) => {
    const req = await body(c, UpdatePaymentConfigRequestSchema);
    const blob = (await payments.getConfigBlob()) ?? {};
    const ep = { ...((blob.easypay ?? {}) as Record<string, unknown>) };
    const st = { ...((blob.stripe ?? {}) as Record<string, unknown>) };
    const manual = { ...((blob.manual ?? {}) as Record<string, unknown>) };
    const { easypay, stripe, manual: manualPatch, ...top } = req;
    if (easypay) {
      const { key, ...rest } = easypay;
      Object.assign(ep, rest);
      if (key !== undefined) ep.keyEnc = key ? await service.seal(key) : "";
    }
    if (stripe) {
      const { secretKey, webhookSecret, ...rest } = stripe;
      Object.assign(st, rest);
      if (secretKey !== undefined) st.secretKeyEnc = secretKey ? await service.seal(secretKey) : "";
      if (webhookSecret !== undefined) st.webhookSecretEnc = webhookSecret ? await service.seal(webhookSecret) : "";
    }
    if (manualPatch) Object.assign(manual, manualPatch);
    const next = { ...blob, ...top, easypay: ep, stripe: st, manual };
    const min = Number(next.minAmountMinor ?? DEFAULT_PAYMENT_CONFIG.minAmountMinor);
    const max = Number(next.maxAmountMinor ?? DEFAULT_PAYMENT_CONFIG.maxAmountMinor);
    if (min > max) throw new StoreError("bad_request", "Minimum amount exceeds the maximum");
    await payments.saveConfigBlob(next);
    return c.json((await service.loadConfig()).config);
  });

  registerPaymentProviderRoutes(app, service);

  /* ---------------- Plans ---------------- */

  function planInput(req: z.infer<typeof UpsertPaymentPlanRequestSchema>): PlanInput {
    let credit = 0n;
    if (req.kind === "recharge") {
      try {
        credit = parseUsdToNano(req.creditUsd ?? "0");
      } catch {
        throw new StoreError("bad_request", "Invalid credit amount");
      }
      if (credit <= 0n) throw new StoreError("bad_request", "Credit must be positive");
    }
    return {
      name: req.name,
      description: req.description,
      kind: req.kind,
      priceMinor: fiatToMinor(req.price),
      currency: req.currency,
      creditNano: credit,
      groupId: req.kind === "subscription" ? (req.groupId ?? null) : null,
      validityDays: req.kind === "subscription" ? (req.validityDays ?? null) : null,
      badge: req.badge,
      enabled: req.enabled,
      sortOrder: req.sortOrder,
    };
  }

  app.get("/api/v1/admin/payments/plans", async (c) => c.json({ items: await payments.listPlans(true) }));
  app.post("/api/v1/admin/payments/plans", async (c) => {
    const req = await body(c, UpsertPaymentPlanRequestSchema);
    return c.json({ item: await payments.createPlan(planInput(req)) }, 201);
  });
  app.put("/api/v1/admin/payments/plans/:id", async (c) => {
    const req = await body(c, UpsertPaymentPlanRequestSchema);
    return c.json({ item: await payments.updatePlan(c.req.param("id"), planInput(req)) });
  });
  app.delete("/api/v1/admin/payments/plans/:id", async (c) => {
    await payments.deletePlan(c.req.param("id"));
    return c.json({ deleted: true });
  });

  /* ---------------- Orders (admin) ---------------- */

  app.get("/api/v1/admin/payments/orders", async (c) => {
    const parsed = OrderListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) bad(parsed.error.issues);
    return c.json(await payments.listOrders(parsed.data));
  });

  app.post("/api/v1/admin/payments/orders/sweep", async (c) => c.json(await service.sweep()));

  app.post("/api/v1/admin/payments/orders/:id/action", async (c) => {
    const id = c.req.param("id");
    const req = await body(c, AdminOrderActionRequestSchema);
    let order: PaymentOrderItem;
    if (req.action === "mark_paid") order = (await service.fulfill(id, req.providerTradeNo ?? "manual")).order;
    else if (req.action === "cancel") order = await service.cancelOrder(id);
    else if (req.action === "reject_refund") order = await payments.rejectRefund(id);
    else {
      order = await payments.refundOrder(id, req.reclaimBalance);
      await ctx.syncDataPlane();
    }
    return c.json({ order });
  });

  app.post("/api/v1/admin/payments/orders/:id/refund", async (c) => {
    const req = await body(c, AdminRefundRequestSchema);
    const amountMinor = req.amount ? fiatToMinor(req.amount) : null;
    if (amountMinor !== null && amountMinor <= 0) throw new StoreError("bad_request", "Refund amount must be positive");
    const out = await service.adminRefund(c.req.param("id"), {
      amountMinor,
      reason: req.reason,
      reclaim: req.reclaim,
      force: req.force,
      viaProvider: req.viaProvider,
    });
    if ("requiresForce" in out) return c.json(out.requiresForce, 409);
    if ("unavailable" in out) return c.json({ error: "refund_unavailable", message: out.unavailable }, 409);
    return c.json(out.result);
  });

  app.post("/api/v1/admin/payments/orders/:id/refund/query", async (c) => {
    const out = await service.settleRefund(c.req.param("id"));
    if ("unsupported" in out) return c.json({ error: "refund_query_unsupported", message: out.unsupported }, 409);
    return c.json(out.result);
  });

  app.post("/api/v1/admin/payments/orders/:id/verify", async (c) => {
    const order = await payments.getOrder(c.req.param("id"));
    if (!order) throw new StoreError("not_found", "Order not found");
    return c.json(await service.verifyOrder(order));
  });

  app.get("/api/v1/admin/payments/dashboard", async (c) => {
    const days = Math.max(1, Math.min(365, Number.parseInt(c.req.query("days") ?? "30", 10) || 30));
    const { config } = await service.loadConfig();
    return c.json(await payments.dashboard(days, config.currency));
  });

  app.get("/api/v1/admin/affiliates/rebates", async (c) => {
    return c.json({ items: await payments.listRebates(c.req.query("userId") || null, 200) });
  });

  /* ---------------- Purchase (signed-in users) ---------------- */

  app.get("/api/v1/user/payments/options", async (c) => {
    const loaded = await service.loadConfig();
    const { config } = loaded;
    let channels: PaymentOptions["channels"] = [];
    let userRefundEnabled = false;
    if (config.enabled) {
      const merchants = await service.merchants(loaded);
      channels = service.channels(loaded, merchants, await service.usageToday());
      userRefundEnabled = service.userRefundOffered(loaded, merchants);
    }
    const options: PaymentOptions = {
      enabled: config.enabled,
      currency: config.currency,
      customAmountEnabled: config.customAmountEnabled,
      minorPerUsd: config.minorPerUsd,
      minAmountMinor: config.minAmountMinor,
      maxAmountMinor: config.maxAmountMinor,
      channels,
      plans: config.enabled ? await payments.listPlans(false) : [],
      manualInstructions: config.manual.enabled ? config.manual.instructions : "",
      userRefundEnabled,
    };
    return c.json(options);
  });

  app.post("/api/v1/user/orders", async (c) => {
    const claims = c.get("authUser");
    const req = await body(c, CreateOrderRequestSchema);
    const loaded = await service.loadConfig();
    const { config } = loaded;
    if (!config.enabled) throw new StoreError("forbidden", "Online payment is not enabled");

    // Which merchants could take it (manual transfers need none).
    let cands: Merchant[] = [];
    const type = channelType(req.provider, req.method ?? null);
    if (req.provider === "manual") {
      if (!config.manual.enabled) throw new StoreError("bad_request", "That payment method is not available");
    } else {
      if (req.provider === "easypay" && !req.method) throw new StoreError("bad_request", "That payment method is not available");
      cands = service.candidates(await service.merchants(loaded), req.provider, type, null);
      if (cands.length === 0) throw new StoreError("bad_request", "That payment method is not available");
    }
    if ((await payments.countPendingOrders(claims.sub)) >= config.maxPendingOrders) {
      throw new StoreError("conflict", "Too many unpaid orders; pay or cancel one first");
    }

    let input: Omit<OrderInput, "providerInstanceId">;
    const expiresAtIso = new Date(Date.now() + config.orderTimeoutMinutes * 60_000).toISOString();
    const method = req.provider === "easypay" ? (req.method ?? null) : null;
    if (req.planId) {
      const plan = await payments.getPlan(req.planId);
      if (!plan || !plan.enabled) throw new StoreError("not_found", "Plan not found");
      input = {
        userId: claims.sub,
        kind: plan.kind,
        planId: plan.id,
        planName: plan.name,
        provider: req.provider,
        method,
        amountMinor: plan.priceMinor,
        currency: plan.currency,
        creditNano: BigInt(plan.creditNanoUsd),
        groupId: plan.groupId,
        validityDays: plan.validityDays,
        expiresAtIso,
      };
    } else {
      if (!config.customAmountEnabled) throw new StoreError("forbidden", "Custom amounts are not accepted");
      const amountMinor = fiatToMinor(req.amount ?? "0");
      if (amountMinor < config.minAmountMinor || amountMinor > config.maxAmountMinor) {
        throw new StoreError("bad_request", "Amount is outside the allowed range");
      }
      input = {
        userId: claims.sub,
        kind: "recharge",
        planId: null,
        planName: "",
        provider: req.provider,
        method,
        amountMinor,
        currency: config.currency,
        creditNano: (BigInt(amountMinor) * 1_000_000_000n) / BigInt(config.minorPerUsd),
        groupId: null,
        validityDays: null,
        expiresAtIso,
      };
    }
    const label: Record<string, string> = { easypay: "EasyPay", alipay: "Alipay", wxpay: "WeChat Pay" };
    if (CNY_ONLY_PROVIDERS.has(req.provider) && input.currency !== "CNY") {
      throw new StoreError("bad_request", `${label[req.provider] ?? req.provider} only accepts CNY`);
    }

    // Pick the merchant: limits are enforced on every order, plan purchases included.
    let merchant: Merchant | null = null;
    let openid: string | null = null;
    if (req.provider !== "manual") {
      if (req.provider === "airwallex") {
        cands = service.candidates(cands, "airwallex", type, input.currency);
        if (cands.length === 0) throw new StoreError("bad_request", `Airwallex does not accept ${input.currency} here`);
      }
      const usage = await service.usageToday();
      if (req.provider === "wxpay" && req.device === "wechat") {
        // Inside WeChat: JSAPI needs the payer's openid from the payment OAuth first.
        const jsapi = cands.filter(wxpayJsapiReady);
        if (req.wechatResumeToken) {
          const token = readWechatResumeToken(vaultSecret, claims.sub, req.wechatResumeToken);
          if (!token) return c.json({ error: "wechat_oauth_expired", message: "The WeChat authorization expired; please try again" }, 400);
          merchant = jsapi.find((m) => m.id === token.instanceId) ?? null;
          if (merchant && !PaymentService.fits(merchant, type, input.amountMinor, usage)) merchant = null;
          openid = merchant ? token.openid : null;
          if (!merchant) return c.json({ error: "payment_limit_exceeded", message: "WeChat Pay cannot take this order right now; try another method" }, 409);
        } else if (jsapi.length > 0) {
          const m = service.pick(jsapi, type, input.amountMinor, usage, config.loadBalanceStrategy);
          if (!m) return c.json({ error: "payment_limit_exceeded", message: "WeChat Pay has reached its limit for this amount today; try another method" }, 409);
          const creds = wxpayCreds(m);
          const base = await callbackBase(c, config.callbackBaseUrl);
          const required: WechatOAuthRequired = {
            error: "wechat_oauth_required",
            message: "Authorize WeChat to pay inside WeChat",
            authorizeUrl: wechatOAuthAuthorizeUrl(wxpayJsapiAppId(creds), `${base}/payment/wechat/callback`, wechatOAuthState(vaultSecret, claims.sub, m.id!)),
          };
          return c.json(required, 409);
        }
      }
      merchant ??= service.pick(cands, type, input.amountMinor, usage, config.loadBalanceStrategy);
      if (!merchant) {
        return c.json({ error: "payment_limit_exceeded", message: "This payment method has reached its limit for this amount; try another method or amount" }, 409);
      }
    }

    const order = await payments.createOrder({ ...input, providerInstanceId: merchant?.id ?? null });
    const empty: PaymentCheckout = { flow: "manual", payUrl: null, qrCode: null, appLink: null, jsapi: null, airwallex: null };
    let checkout = empty;
    let tradeNo: string | null = null;
    if (merchant) {
      const base = await callbackBase(c, config.callbackBaseUrl);
      const returnUrl = `${base}/payment/result?order=${encodeURIComponent(order.id)}&token=${encodeURIComponent(orderResumeToken(vaultSecret, order.id))}`;
      try {
        const r = await createCheckout(
          merchant,
          {
            id: order.id,
            amountMinor: order.amountMinor,
            currency: order.currency,
            subject: order.planName || `Balance top-up ${order.id.slice(-6)}`,
            email: claims.email,
            method: order.method,
            providerTradeNo: null,
            expiresAtIso: order.expiresAtIso,
          },
          { notifyUrl: `${base}/webhooks/payment/${merchant.provider}`, returnUrl, device: req.device, clientIp: payerIp(c), openid, fetch: service.fetch },
        );
        checkout = r.checkout;
        tradeNo = r.tradeNo;
      } catch (err) {
        await payments.cancelOrder(order.id).catch(() => undefined);
        return c.json({ error: "payment_provider_error", message: errorText(err) }, 502);
      }
    }
    // Kept so a pending order can be paid again later (QR shown again, redirect reopened).
    await payments.setOrderPayment(order.id, { payUrl: checkout.payUrl, qrCode: checkout.qrCode, checkout, providerTradeNo: tradeNo });
    const response: CreateOrderResponse = {
      order: { ...order, payUrl: checkout.payUrl, qrCode: checkout.qrCode, checkout, providerTradeNo: tradeNo ?? order.providerTradeNo },
      payUrl: checkout.payUrl,
      qrCode: checkout.qrCode,
      checkout,
    };
    return c.json(response, 201);
  });

  app.get("/api/v1/user/orders", async (c) => {
    const parsed = OrderListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) bad(parsed.error.issues);
    const page = await payments.listOrders({ ...parsed.data, userId: c.get("authUser").sub });
    return c.json({ ...page, items: await service.decorateForPayer(page.items) });
  });

  async function ownOrder(c: Context<AuthEnv>): Promise<PaymentOrderItem> {
    const order = await payments.getOrder(c.req.param("id") ?? "");
    if (!order || order.userId !== c.get("authUser").sub) throw new StoreError("not_found", "Order not found");
    return order;
  }

  app.get("/api/v1/user/orders/:id", async (c) => {
    const [order] = await service.decorateForPayer([await ownOrder(c)]);
    return c.json({ order });
  });

  app.post("/api/v1/user/orders/:id/cancel", async (c) => {
    return c.json({ order: await service.cancelOrder(c.req.param("id"), c.get("authUser").sub) });
  });

  /** The payer's "I have paid" / result-page check: asks the provider about a pending order. */
  app.post("/api/v1/user/orders/:id/verify", async (c) => {
    const order = await ownOrder(c);
    if (!verifyLimiter.allow(`user:${order.userId}`)) return tooMany(c);
    const result =
      order.status === "pending" || order.status === "expired"
        ? await service.verifyOrder(order)
        : { order, providerStatus: PAID_ORDER_STATUSES.includes(order.status) ? ("paid" as const) : ("unknown" as const), recovered: false, message: null };
    const [decorated] = await service.decorateForPayer([result.order]);
    return c.json({ ...result, order: decorated });
  });

  app.post("/api/v1/user/orders/:id/refund-request", async (c) => {
    const req = await body(c, UserRefundRequestSchema);
    const claims = c.get("authUser");
    const order = await ownOrder(c);
    const loaded = await service.loadConfig();
    const instances = new Map((await payments.instances.listInstances()).map((r) => [r.id, r]));
    if (order.status === "paid" && order.kind === "recharge" && !service.userRefundAllowed(order, loaded, instances)) {
      return c.json({ error: "user_refund_disabled", message: "Refunds cannot be requested for this order" }, 403);
    }
    const updated = await payments.requestRefund(order.id, claims.sub, req.reason);
    try {
      await store.ops.recordAudit({
        actorId: claims.sub,
        actorEmail: claims.email,
        actorRole: claims.role,
        method: "POST",
        route: "/api/v1/user/orders/:id/refund-request",
        path: c.req.path,
        targetId: order.id,
        statusCode: 200,
        ip: clientAddress(c),
        userAgent: (c.req.header("user-agent") ?? "").slice(0, 300),
        durationMs: 0,
        requestBody: JSON.stringify({ reason: req.reason.slice(0, 500) }),
      });
    } catch (err) {
      console.warn(`[slipgate-bff] audit write failed: ${errorText(err)}`);
    }
    const [decorated] = await service.decorateForPayer([updated]);
    return c.json({ order: decorated });
  });

  /** WeChat payment OAuth: exchanges the code for the payer's openid (JSAPI inside WeChat). */
  app.post("/api/v1/user/payments/wechat/oauth", async (c) => {
    const claims = c.get("authUser");
    if (!oauthLimiter.allow(`user:${claims.sub}`)) return tooMany(c);
    const req = await body(c, WechatOAuthExchangeRequestSchema);
    const instanceId = verifyWechatOAuthState(vaultSecret, claims.sub, req.state);
    if (!instanceId) return c.json({ error: "wechat_oauth_expired", message: "The WeChat authorization expired; please try again" }, 400);
    const rec = await payments.instances.getInstance(instanceId);
    const m = rec ? await service.instanceMerchant(rec) : null;
    if (!m || !m.enabled || !wxpayJsapiReady(m)) throw new StoreError("conflict", "WeChat Pay inside WeChat is no longer available");
    const creds = wxpayCreds(m);
    let openid: string;
    try {
      openid = await wechatOAuthOpenid(wxpayJsapiAppId(creds), creds.mpAppSecret, req.code, service.fetch);
    } catch (err) {
      return c.json({ error: "wechat_oauth_failed", message: errorText(err) }, 502);
    }
    const res: WechatOAuthExchangeResponse = {
      wechatResumeToken: wechatResumeToken(vaultSecret, claims.sub, instanceId, openid),
      expiresInSec: WECHAT_RESUME_TTL_SEC,
    };
    return c.json(res);
  });

  /* ---------------- Public recovery (signed resume token from the return URL) ---------------- */

  app.post("/api/v1/payments/public/orders/resolve", async (c) => {
    if (!publicLimiter.allow(`resolve:${clientIp(c)}`)) return tooMany(c);
    const req = await body(c, ResolveOrderRequestSchema);
    const orderId = orderFromResumeToken(vaultSecret, req.token);
    let order = orderId ? await payments.getOrder(orderId) : null;
    if (!order) throw new StoreError("not_found", "Order not found");
    if ((order.status === "pending" || order.status === "expired") && verifyLimiter.allow(`order:${order.id}`)) {
      order = (await service.verifyOrder(order)).order;
    }
    const out: PublicOrderStatus = {
      id: order.id,
      status: order.status,
      kind: order.kind,
      planName: order.planName,
      provider: order.provider,
      amountMinor: order.amountMinor,
      currency: order.currency,
      createdAtIso: order.createdAtIso,
      paidAtIso: order.paidAtIso,
      expiresAtIso: order.expiresAtIso,
    };
    return c.json(out);
  });

  /* ---------------- Provider notifications (public, signature-verified) ---------------- */

  /** The order a notification names, and the merchant whose credentials must verify it. */
  async function notified(orderId: string, provider: string): Promise<{ order: PaymentOrderItem; merchant: Merchant } | null> {
    const order = orderId ? await payments.getOrder(orderId) : null;
    if (!order || order.provider !== provider) return null;
    const merchant = await service.merchantFor(order);
    return merchant ? { order, merchant } : null;
  }

  const easypayNotify = async (c: Context) => {
    let params: Record<string, string> = { ...c.req.query() };
    if (c.req.method === "POST") {
      const form = await c.req.parseBody().catch(() => ({}));
      for (const [k, v] of Object.entries(form)) if (typeof v === "string") params[k] = v;
    }
    params = Object.fromEntries(Object.entries(params).filter(([, v]) => typeof v === "string"));
    const found = await notified(params.out_trade_no ?? "", "easypay");
    if (!found) return c.text("fail", 404);
    const key = found.merchant.secrets.key ?? "";
    if (!key || !easypayVerify(params, key) || params.pid !== String(found.merchant.config.pid ?? "")) return c.text("fail", 400);
    if (params.trade_status !== "TRADE_SUCCESS") return c.text("success");
    if (!/^\d+(\.\d{1,2})?$/.test(params.money ?? "") || fiatToMinor(params.money!) !== found.order.amountMinor) {
      return c.text("fail", 400);
    }
    await service.fulfill(found.order.id, params.trade_no ?? null);
    return c.text("success");
  };
  app.get("/webhooks/payment/easypay", easypayNotify);
  app.post("/webhooks/payment/easypay", easypayNotify);

  app.post("/webhooks/payment/stripe", async (c) => {
    const raw = await c.req.text();
    const event = parseJsonObject(raw) as { type?: string; data?: { object?: Record<string, unknown> } } | null;
    if (!event) return c.json({ error: "invalid_payload" }, 400);
    const session = event.data?.object ?? {};
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const orderId = str(metadata.order_id) || str(session.client_reference_id);
    const found = await notified(orderId, "stripe");
    // Events of other kinds (or orders) are acknowledged once any configured endpoint secret verifies them.
    const secrets = found
      ? [found.merchant.secrets.webhookSecret ?? ""]
      : (await service.merchants(await service.loadConfig())).filter((m) => m.provider === "stripe").map((m) => m.secrets.webhookSecret ?? "");
    const signature = c.req.header("stripe-signature") ?? "";
    let verified = false;
    for (const s of secrets) if (s && (await stripeVerifySignature(raw, signature, s))) verified = true;
    if (!verified) return c.json({ error: "invalid_signature" }, 400);
    const paidEvent =
      (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") &&
      session.payment_status === "paid";
    if (!paidEvent) return c.json({ received: true });
    if (!found) return c.json({ error: "unknown_order" }, 404);
    if (Number(session.amount_total) !== found.order.amountMinor || str(session.currency).toUpperCase() !== found.order.currency) {
      return c.json({ error: "amount_mismatch" }, 400);
    }
    await service.fulfill(found.order.id, str(session.payment_intent) || str(session.id) || null);
    return c.json({ received: true });
  });

  app.post("/webhooks/payment/alipay", async (c) => {
    const raw = await c.req.text();
    const params = Object.fromEntries(new URLSearchParams(raw));
    const found = await notified(params.out_trade_no ?? "", "alipay");
    if (!found) return c.text("fail", 404);
    let creds;
    try {
      creds = alipayCreds(found.merchant);
    } catch {
      return c.text("fail", 400);
    }
    if (!alipayVerifyNotification(params, creds.alipayPublicKey) || params.app_id !== creds.appId) return c.text("fail", 400);
    const status = params.trade_status ?? "";
    if (status !== "TRADE_SUCCESS" && status !== "TRADE_FINISHED") return c.text("success");
    if (decimalToMinor(params.total_amount) !== found.order.amountMinor) return c.text("fail", 400);
    await service.fulfill(found.order.id, params.trade_no || null);
    return c.text("success");
  });

  app.post("/webhooks/payment/wxpay", async (c) => {
    const raw = await c.req.text();
    const fail = (status: 400 | 404, message: string) => c.json({ code: "FAIL", message }, status);
    const headers = wxpaySignatureHeaders(c.req.raw.headers);
    const notification = parseJsonObject(raw);
    const resource = (notification?.resource ?? null) as { ciphertext?: string; nonce?: string; associated_data?: string } | null;
    if (!notification || !resource?.ciphertext || !resource.nonce) return fail(400, "invalid notification");
    // The order is inside the encrypted resource: find the merchant by the signing key's ID.
    const merchants = (await service.merchants(await service.loadConfig())).filter(
      (m) => m.provider === "wxpay" && m.id !== null && m.config.publicKeyId === headers.serial,
    );
    for (const m of merchants) {
      let creds;
      try {
        creds = wxpayCreds(m);
      } catch {
        continue;
      }
      if (!wxpayVerifySignature(creds, headers, raw)) continue;
      let tx: Record<string, unknown> | null;
      try {
        tx = parseJsonObject(wxpayDecryptResource(creds.apiV3Key, { ciphertext: resource.ciphertext, nonce: resource.nonce, associated_data: resource.associated_data }));
      } catch {
        continue;
      }
      if (!tx) return fail(400, "invalid resource");
      if (str(notification.event_type) !== "TRANSACTION.SUCCESS" || str(tx.trade_state) !== "SUCCESS") return c.body(null, 204);
      const order = await payments.getOrder(str(tx.out_trade_no));
      if (!order || order.provider !== "wxpay" || order.providerInstanceId !== m.id) return fail(404, "unknown order");
      if (str(tx.mchid) !== creds.mchId) return fail(400, "merchant mismatch");
      const amount = (tx.amount ?? {}) as Record<string, unknown>;
      if (amount.total !== order.amountMinor || (str(amount.currency) && str(amount.currency) !== order.currency)) return fail(400, "amount mismatch");
      await service.fulfill(order.id, str(tx.transaction_id) || null);
      return c.body(null, 204);
    }
    return fail(400, "signature verification failed");
  });

  app.post("/webhooks/payment/airwallex", async (c) => {
    const raw = await c.req.text();
    const ts = c.req.header("x-timestamp") ?? "";
    const sig = c.req.header("x-signature") ?? "";
    const event = parseJsonObject(raw);
    if (!event) return c.json({ error: "invalid_payload" }, 400);
    const intent = ((event.data as Record<string, unknown> | undefined)?.object ?? {}) as Record<string, unknown>;
    const found = await notified(str(intent.merchant_order_id), "airwallex");
    const secrets = found
      ? [found.merchant.secrets.webhookSecret ?? ""]
      : (await service.merchants(await service.loadConfig())).filter((m) => m.provider === "airwallex").map((m) => m.secrets.webhookSecret ?? "");
    if (!secrets.some((s) => airwallexVerifyWebhook(raw, ts, sig, s))) return c.json({ error: "invalid_signature" }, 400);
    if (str(event.name) !== "payment_intent.succeeded") return c.json({ received: true });
    if (!found) return c.json({ error: "unknown_order" }, 404);
    if (str(intent.status).toUpperCase() !== "SUCCEEDED") return c.json({ error: "not_succeeded" }, 400);
    if (found.order.providerTradeNo && str(intent.id) !== found.order.providerTradeNo) return c.json({ error: "intent_mismatch" }, 400);
    if (decimalToMinor(intent.amount) !== found.order.amountMinor || str(intent.currency).toUpperCase() !== found.order.currency) {
      return c.json({ error: "amount_mismatch" }, 400);
    }
    await service.fulfill(found.order.id, str(intent.id) || null);
    return c.json({ received: true });
  });

  /* ---------------- Sweeper ---------------- */

  if (ctx.startSchedulers) {
    const timer = setInterval(() => {
      service.sweep().catch((err) => console.warn(`[slipgate-bff] payment sweep failed: ${errorText(err)}`));
    }, SWEEP_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  return service;
}
