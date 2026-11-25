import {
  DEFAULT_PAYMENT_CONFIG,
  MAX_FIAT_MINOR,
  PAID_ORDER_STATUSES,
  PAYMENT_INSTANCE_CONFIG_SCHEMAS,
  PAYMENT_INSTANCE_REQUIRED_SECRETS,
  PAYMENT_INSTANCE_SECRET_FIELDS,
  PaymentConfigSchema,
  type AdminRefundResult,
  type LoadBalanceStrategy,
  type OrderVerifyResult,
  type PaymentChannel,
  type PaymentConfig,
  type PaymentCurrency,
  type PaymentInstanceProvider,
  type PaymentOrderItem,
  type PaymentProviderInstance,
  type PaymentSweepResult,
  type RefundRequiresForce,
} from "@slipgate/contracts";
import { decryptSecret, encryptSecret } from "../security/crypto.ts";
import type { PaymentInstanceRecord } from "../store/payment_providers_types.ts";
import type { FulfillResult } from "../store/payments_types.ts";
import { StoreError, type ControlStore } from "../store/types.ts";
import { cancelPayment, channelType, merchantKey, queryPayment, queryRefund, refundPayment, refundRequestNo, supportsRefundQuery, type Merchant } from "./gateway.ts";
import { GatewayError } from "./http.ts";
import type { ProviderPaymentQuery, ProviderRefundResult } from "./providers.ts";

export interface PaymentServiceDeps {
  store: ControlStore;
  vaultSecret: string;
  syncDataPlane: () => Promise<void>;
  /** Plugin hook fired once per fulfilled order. */
  onOrderPaid?: (order: PaymentOrderItem) => Promise<void>;
  /** Overridable for tests: every gateway call goes through it. */
  fetchImpl?: typeof fetch;
}

/** Decrypted secrets of the built-in EasyPay / Stripe blocks. */
export interface BuiltinSecrets {
  easypayKey: string;
  stripeSecretKey: string;
  stripeWebhookSecret: string;
}

export interface LoadedConfig {
  config: PaymentConfig;
  secrets: BuiltinSecrets;
}

/** Provider / channel order of the purchase page. */
const CHANNEL_ORDER: readonly { provider: PaymentInstanceProvider; method: string | null }[] = [
  { provider: "easypay", method: "alipay" },
  { provider: "easypay", method: "wxpay" },
  { provider: "easypay", method: "qqpay" },
  { provider: "stripe", method: null },
  { provider: "alipay", method: null },
  { provider: "wxpay", method: null },
  { provider: "airwallex", method: null },
];

/** Providers that settle in CNY only. */
export const CNY_ONLY_PROVIDERS = new Set(["easypay", "alipay", "wxpay"]);

/** Identity fields that open orders depend on (callbacks, queries, refunds). */
const PROTECTED_CONFIG_FIELDS: Record<PaymentInstanceProvider, readonly string[]> = {
  easypay: ["apiUrl", "pid"],
  stripe: [],
  alipay: ["appId", "alipayPublicKey", "sandbox"],
  wxpay: ["appId", "mpAppId", "mchId", "certSerial", "publicKeyId", "publicKey"],
  airwallex: ["clientId", "accountId", "env", "currency"],
};

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => Number.parseInt(x, 16)));

export const startOfUtcDayIso = (nowMs = Date.now()) => new Date(Math.floor(nowMs / 86_400_000) * 86_400_000).toISOString();

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class PaymentService {
  /** Round-robin position per channel. */
  private readonly rotation = new Map<string, number>();
  private sweeping: Promise<PaymentSweepResult> | null = null;

  constructor(private readonly deps: PaymentServiceDeps) {}

  get store(): ControlStore {
    return this.deps.store;
  }

  /**
   * The fetch every gateway call uses. Without an injected one this must be the global `fetch`
   * itself: gatewayFetch only routes that one through the SSRF guard.
   */
  get fetch(): typeof fetch {
    return this.deps.fetchImpl ?? fetch;
  }

  /* ---------------- Secrets ---------------- */

  async seal(secret: string): Promise<string> {
    return toHex(await encryptSecret(secret, this.deps.vaultSecret));
  }

  async open(hex: unknown): Promise<string> {
    if (typeof hex !== "string" || !hex) return "";
    try {
      return await decryptSecret(fromHex(hex), this.deps.vaultSecret);
    } catch {
      return "";
    }
  }

  /* ---------------- Config ---------------- */

  async loadConfig(): Promise<LoadedConfig> {
    const blob = (await this.deps.store.payments.getConfigBlob()) ?? {};
    const ep = (blob.easypay ?? {}) as Record<string, unknown>;
    const st = (blob.stripe ?? {}) as Record<string, unknown>;
    const secrets: BuiltinSecrets = {
      easypayKey: await this.open(ep.keyEnc),
      stripeSecretKey: await this.open(st.secretKeyEnc),
      stripeWebhookSecret: await this.open(st.webhookSecretEnc),
    };
    // Limits saved before MAX_FIAT_MINOR existed are clamped instead of failing the whole parse
    // (which would silently fall back to the defaults and switch payments off).
    const clampMinor = (v: unknown) => (typeof v === "number" && v > MAX_FIAT_MINOR ? MAX_FIAT_MINOR : v);
    const candidate = {
      ...DEFAULT_PAYMENT_CONFIG,
      ...blob,
      minAmountMinor: clampMinor(blob.minAmountMinor ?? DEFAULT_PAYMENT_CONFIG.minAmountMinor),
      maxAmountMinor: clampMinor(blob.maxAmountMinor ?? DEFAULT_PAYMENT_CONFIG.maxAmountMinor),
      easypay: { ...DEFAULT_PAYMENT_CONFIG.easypay, ...ep, keySet: Boolean(secrets.easypayKey) },
      stripe: {
        ...DEFAULT_PAYMENT_CONFIG.stripe,
        ...st,
        secretKeySet: Boolean(secrets.stripeSecretKey),
        webhookSecretSet: Boolean(secrets.stripeWebhookSecret),
      },
      manual: { ...DEFAULT_PAYMENT_CONFIG.manual, ...((blob.manual ?? {}) as object) },
    };
    const parsed = PaymentConfigSchema.safeParse(candidate);
    return { config: parsed.success ? parsed.data : DEFAULT_PAYMENT_CONFIG, secrets };
  }

  /* ---------------- Merchants (built-in blocks + instances) ---------------- */

  private builtinMerchants({ config, secrets }: LoadedConfig): Merchant[] {
    const ep = config.easypay;
    const easypayConfig = { apiUrl: ep.apiUrl, pid: ep.pid };
    return [
      {
        id: null,
        provider: "easypay",
        name: "EasyPay",
        enabled: ep.enabled,
        ready: PAYMENT_INSTANCE_CONFIG_SCHEMAS.easypay.safeParse(easypayConfig).success && Boolean(secrets.easypayKey),
        config: easypayConfig,
        secrets: { key: secrets.easypayKey },
        supportedTypes: [...ep.methods],
        paymentMode: ep.mode,
        refundEnabled: ep.refundEnabled,
        allowUserRefund: ep.allowUserRefund,
        limits: {},
        sortOrder: -1,
      },
      {
        id: null,
        provider: "stripe",
        name: "Stripe",
        enabled: config.stripe.enabled,
        ready: Boolean(secrets.stripeSecretKey),
        config: {},
        secrets: { secretKey: secrets.stripeSecretKey, webhookSecret: secrets.stripeWebhookSecret },
        supportedTypes: ["stripe"],
        paymentMode: "",
        refundEnabled: config.stripe.refundEnabled,
        allowUserRefund: config.stripe.allowUserRefund,
        limits: {},
        sortOrder: -1,
      },
    ];
  }

  async instanceSecrets(rec: Pick<PaymentInstanceRecord, "credentialsEnc">): Promise<Record<string, string>> {
    const text = await this.open(rec.credentialsEnc);
    if (!text) return {};
    try {
      const v = JSON.parse(text) as unknown;
      if (!v || typeof v !== "object") return {};
      return Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string" && x !== "")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  /** Whether the configuration parses and every required secret is set. */
  static instanceReady(provider: PaymentInstanceProvider, config: Record<string, unknown>, secrets: Record<string, string>): boolean {
    return (
      PAYMENT_INSTANCE_CONFIG_SCHEMAS[provider].safeParse(config).success &&
      PAYMENT_INSTANCE_REQUIRED_SECRETS[provider].every((k) => Boolean(secrets[k]))
    );
  }

  async instanceMerchant(rec: PaymentInstanceRecord): Promise<Merchant> {
    const secrets = await this.instanceSecrets(rec);
    return {
      id: rec.id,
      provider: rec.provider,
      name: rec.name,
      enabled: rec.enabled,
      ready: PaymentService.instanceReady(rec.provider, rec.config, secrets),
      config: rec.config,
      secrets,
      supportedTypes: rec.supportedTypes,
      paymentMode: rec.paymentMode,
      refundEnabled: rec.refundEnabled,
      allowUserRefund: rec.allowUserRefund,
      limits: rec.limits,
      sortOrder: rec.sortOrder,
    };
  }

  /** Every merchant (built-ins first, then instances by sort order), disabled ones included. */
  async merchants(loaded: LoadedConfig): Promise<Merchant[]> {
    const instances = await this.deps.store.payments.instances.listInstances();
    return [...this.builtinMerchants(loaded), ...(await Promise.all(instances.map((r) => this.instanceMerchant(r))))];
  }

  /** The merchant that took the order (even when disabled since), or null (manual, deleted instance). */
  async merchantFor(order: Pick<PaymentOrderItem, "provider" | "providerInstanceId">, loaded?: LoadedConfig): Promise<Merchant | null> {
    if (order.provider === "manual") return null;
    if (order.providerInstanceId) {
      const rec = await this.deps.store.payments.instances.getInstance(order.providerInstanceId);
      return rec && rec.provider === order.provider ? this.instanceMerchant(rec) : null;
    }
    if (order.provider !== "easypay" && order.provider !== "stripe") return null;
    return this.builtinMerchants(loaded ?? (await this.loadConfig())).find((m) => m.provider === order.provider) ?? null;
  }

  /** Enabled, ready merchants serving `provider` / channel `type` for an order in `currency`. */
  candidates(merchants: Merchant[], provider: string, type: string, currency: PaymentCurrency | null): Merchant[] {
    return merchants.filter((m) => {
      if (m.provider !== provider || !m.enabled || !m.ready) return false;
      if (!m.supportedTypes.includes(type)) return false;
      if (provider === "airwallex" && currency) {
        const want = typeof m.config.currency === "string" ? m.config.currency : "";
        if (want && want !== currency) return false;
      }
      return true;
    });
  }

  /** Whether `m` can take an order of `amountMinor` on channel `type` given today's usage. */
  static fits(m: Merchant, type: string, amountMinor: number, usage: Record<string, number>): boolean {
    const l = m.limits[type];
    if (!l) return true;
    if (l.singleMinMinor > 0 && amountMinor < l.singleMinMinor) return false;
    if (l.singleMaxMinor > 0 && amountMinor > l.singleMaxMinor) return false;
    const used = usage[`${merchantKey(m)}|${type}`] ?? 0;
    return !(l.dailyLimitMinor > 0 && used + amountMinor > l.dailyLimitMinor);
  }

  /**
   * Picks the merchant for an order: candidates whose limits fit the amount, then round-robin or
   * the least volume today. Null when none fits (the order is refused, never sent over a limit).
   */
  pick(cands: Merchant[], type: string, amountMinor: number, usage: Record<string, number>, strategy: LoadBalanceStrategy): Merchant | null {
    const fit = cands.filter((m) => PaymentService.fits(m, type, amountMinor, usage));
    if (fit.length === 0) return null;
    if (strategy === "least-amount") {
      return fit.reduce((best, m) => ((usage[`${merchantKey(m)}|${type}`] ?? 0) < (usage[`${merchantKey(best)}|${type}`] ?? 0) ? m : best));
    }
    const key = `${fit[0]!.provider}|${type}`;
    const at = this.rotation.get(key) ?? 0;
    this.rotation.set(key, (at + 1) % 1_000_000);
    return fit[at % fit.length]!;
  }

  /** The purchase page's channels, limits aggregated over the merchants serving each. */
  channels(loaded: LoadedConfig, merchants: Merchant[], usage: Record<string, number>): PaymentChannel[] {
    const out: PaymentChannel[] = [];
    for (const ch of CHANNEL_ORDER) {
      const type = channelType(ch.provider, ch.method);
      const cands = this.candidates(merchants, ch.provider, type, null);
      if (cands.length === 0) continue;
      let singleMin = Number.POSITIVE_INFINITY;
      let singleMax = 0;
      let anyNoMax = false;
      let daily = 0;
      let anyNoDaily = false;
      let remaining = 0;
      let available = false;
      for (const m of cands) {
        const l = m.limits[type];
        const min = l?.singleMinMinor ?? 0;
        const max = l?.singleMaxMinor ?? 0;
        const lim = l?.dailyLimitMinor ?? 0;
        singleMin = Math.min(singleMin, min);
        if (max === 0) anyNoMax = true;
        else singleMax = Math.max(singleMax, max);
        if (lim === 0) {
          anyNoDaily = true;
          available = true;
        } else {
          daily += lim;
          const left = Math.max(0, lim - (usage[`${merchantKey(m)}|${type}`] ?? 0));
          remaining += left;
          if (left > 0) available = true;
        }
      }
      out.push({
        provider: ch.provider,
        method: ch.method,
        available,
        singleMinMinor: Number.isFinite(singleMin) ? singleMin : 0,
        singleMaxMinor: anyNoMax ? 0 : singleMax,
        dailyLimitMinor: anyNoDaily ? 0 : daily,
        dailyRemainingMinor: anyNoDaily ? null : remaining,
      });
    }
    if (loaded.config.manual.enabled) {
      out.push({ provider: "manual", method: null, available: true, singleMinMinor: 0, singleMaxMinor: 0, dailyLimitMinor: 0, dailyRemainingMinor: null });
    }
    return out;
  }

  async usageToday(): Promise<Record<string, number>> {
    return this.deps.store.payments.instanceUsage(startOfUtcDayIso());
  }

  /* ---------------- Refund eligibility for payers ---------------- */

  /** Whether the payer may ask for this order to be refunded. */
  userRefundAllowed(order: PaymentOrderItem, loaded: LoadedConfig, instances: Map<string, PaymentInstanceRecord>): boolean {
    if (order.status !== "paid" || order.kind !== "recharge" || order.deliveryError) return false;
    if (order.provider === "manual") return loaded.config.manual.allowUserRefund;
    if (order.providerInstanceId) return instances.get(order.providerInstanceId)?.allowUserRefund ?? false;
    if (order.provider === "easypay") return loaded.config.easypay.allowUserRefund;
    if (order.provider === "stripe") return loaded.config.stripe.allowUserRefund;
    return false;
  }

  /** Sets canRequestRefund on orders shown to their payer (one config and instance read). */
  async decorateForPayer(orders: PaymentOrderItem[]): Promise<PaymentOrderItem[]> {
    if (orders.length === 0) return orders;
    const loaded = await this.loadConfig();
    const instances = new Map((await this.deps.store.payments.instances.listInstances()).map((r) => [r.id, r]));
    return orders.map((o) => ({ ...o, canRequestRefund: this.userRefundAllowed(o, loaded, instances) }));
  }

  /** Some enabled way to pay lets payers request refunds. */
  userRefundOffered(loaded: LoadedConfig, merchants: Merchant[]): boolean {
    if (loaded.config.manual.enabled && loaded.config.manual.allowUserRefund) return true;
    return merchants.some((m) => m.enabled && m.ready && m.allowUserRefund);
  }

  /* ---------------- Fulfilment & provider checks ---------------- */

  async fulfill(orderId: string, tradeNo: string | null): Promise<FulfillResult> {
    const settings = await this.deps.store.ops.getSettings();
    const result = await this.deps.store.payments.fulfillOrder(orderId, tradeNo, {
      enabled: settings.affiliateEnabled,
      bps: settings.affiliateRebateBps,
      creditMode: settings.affiliateCreditMode,
    });
    if (result.delivered) await this.deps.syncDataPlane();
    if (result.order.deliveryError) {
      console.warn(`[slipgate-bff] order ${orderId} is paid but could not be delivered: ${result.order.deliveryError}`);
    }
    // First payment: deliver the notification fulfillOrder wrote. A repeated provider callback
    // for a paid order also gives notifications that failed earlier their due retry.
    if (result.fulfilled || (PAID_ORDER_STATUSES as readonly string[]).includes(result.order.status)) {
      try {
        await this.deps.onOrderPaid?.(result.order);
      } catch (err) {
        console.warn(`[slipgate-bff] payment notification dispatch failed: ${errMessage(err)}`);
      }
    }
    return result;
  }

  /** Why a provider-reported payment does not match the order, or null. */
  static paymentMismatch(order: Pick<PaymentOrderItem, "amountMinor" | "currency">, q: ProviderPaymentQuery): string | null {
    if (q.amountMinor === null) return "The provider did not report the paid amount";
    if (q.amountMinor !== order.amountMinor) return `The provider reports ${q.amountMinor} paid, the order is ${order.amountMinor}`;
    if (q.currency && q.currency !== order.currency) return `The provider reports a payment in ${q.currency}`;
    return null;
  }

  /**
   * Asks the order's provider whether it was paid; a matching payment fulfils the order (missed
   * notification recovery). Only unpaid orders (pending, expired, cancelled, failed) are checked.
   */
  async verifyOrder(order: PaymentOrderItem): Promise<OrderVerifyResult> {
    const unknown = (message: string | null): OrderVerifyResult => ({ order, providerStatus: "unknown", recovered: false, message });
    if (PAID_ORDER_STATUSES.includes(order.status)) return { order, providerStatus: "paid", recovered: false, message: null };
    if (order.provider === "manual") return unknown("Bank transfers are confirmed by an administrator");
    const m = await this.merchantFor(order);
    if (!m || !m.ready) return unknown("The payment provider of this order is no longer configured");
    let q: ProviderPaymentQuery;
    try {
      q = await queryPayment(m, order, this.fetch);
    } catch (err) {
      return unknown(`Could not reach the payment provider: ${errMessage(err)}`);
    }
    if (q.status !== "paid") return { order, providerStatus: q.status, recovered: false, message: null };
    const mismatch = PaymentService.paymentMismatch(order, q);
    if (mismatch) {
      console.warn(`[slipgate-bff] order ${order.id}: provider reports paid but ${mismatch}`);
      return { order, providerStatus: "paid", recovered: false, message: mismatch };
    }
    const result = await this.fulfill(order.id, q.tradeNo);
    return { order: result.order, providerStatus: "paid", recovered: result.fulfilled, message: null };
  }

  /**
   * Cancels a pending order: when the provider already took the money it is fulfilled instead;
   * otherwise the upstream trade is closed (best effort) and the order cancelled.
   */
  async cancelOrder(orderId: string, userId?: string): Promise<PaymentOrderItem> {
    const order = await this.deps.store.payments.getOrder(orderId);
    if (!order || (userId && order.userId !== userId)) throw new StoreError("not_found", "Order not found");
    if (order.status === "pending" && order.provider !== "manual") {
      const m = await this.merchantFor(order);
      if (m?.ready) {
        try {
          const q = await queryPayment(m, order, this.fetch);
          if (q.status === "paid" && !PaymentService.paymentMismatch(order, q)) return (await this.fulfill(order.id, q.tradeNo)).order;
          await cancelPayment(m, order, this.fetch);
        } catch (err) {
          console.warn(`[slipgate-bff] could not close order ${orderId} at ${m.provider}: ${errMessage(err)}`);
        }
      }
    }
    return this.deps.store.payments.cancelOrder(orderId, userId);
  }

  /* ---------------- Refunds ---------------- */

  /**
   * An admin refund: claims the order (refund_pending), then either records it (viaProvider
   * false, or a manual order) or sends it through the order's merchant. A definitive gateway
   * refusal marks it refund_failed; an unknown outcome leaves it refund_pending for a query.
   */
  async adminRefund(
    orderId: string,
    req: { amountMinor: number | null; reason: string; reclaim: boolean; force: boolean; viaProvider?: boolean },
  ): Promise<{ result: AdminRefundResult } | { requiresForce: RefundRequiresForce } | { unavailable: string }> {
    const payments = this.deps.store.payments;
    const order = await payments.getOrder(orderId);
    if (!order) throw new StoreError("not_found", "Order not found");
    const alreadyRefunded = order.status === "partially_refunded" ? order.refundAmountMinor : 0;
    const amountMinor = req.amountMinor ?? Math.max(0, order.amountMinor - alreadyRefunded);
    const m = await this.merchantFor(order);
    const gatewayCapable = m !== null && m.ready && m.refundEnabled;
    const viaProvider = req.viaProvider ?? gatewayCapable;
    if (viaProvider && !gatewayCapable) {
      return {
        unavailable:
          order.provider === "manual"
            ? "Manual transfers are refunded outside Slipgate; record the refund instead"
            : !m
              ? "The payment provider of this order is no longer configured; record the refund instead"
              : !m.ready
                ? `${m.name} is not fully configured`
                : `Refunds through ${m.name} are disabled`,
      };
    }
    const begun = await payments.beginRefund(orderId, { amountMinor, reason: req.reason, reclaim: req.reclaim, force: req.force });
    if (begun.requiresForce) {
      return {
        requiresForce: {
          error: "refund_requires_force",
          message: "The payer's balance is smaller than what the refund would take back; confirm to take only what is left",
          balanceNanoUsd: begun.requiresForce.balanceNano.toString(),
          reclaimNanoUsd: begun.requiresForce.reclaimNano.toString(),
        },
      };
    }
    if (!viaProvider || !m) {
      const done = await payments.completeRefund(orderId, null);
      await this.deps.syncDataPlane();
      return { result: { order: done, outcome: "refunded", message: null } };
    }
    return { result: await this.sendRefund(begun.order, m) };
  }

  private async sendRefund(order: PaymentOrderItem, m: Merchant): Promise<AdminRefundResult> {
    let r: ProviderRefundResult;
    try {
      r = await refundPayment(m, order, order.refundAmountMinor, order.refundReason ?? "", this.fetch);
    } catch (err) {
      if (err instanceof GatewayError && err.definitive) return this.applyRefundResult(order, m, { status: "failed", refundId: null, message: err.message });
      // Unknown outcome: keep it pending so a query (or the sweeper) finds out what happened.
      const id = m.provider === "alipay" || m.provider === "wxpay" ? refundRequestNo(order.id, order.refundAmountMinor) : null;
      const pending = await this.deps.store.payments.noteRefundPending(order.id, id, errMessage(err));
      return { order: pending, outcome: "pending", message: errMessage(err) };
    }
    return this.applyRefundResult(order, m, r);
  }

  private async applyRefundResult(order: PaymentOrderItem, m: Merchant, r: ProviderRefundResult): Promise<AdminRefundResult> {
    const payments = this.deps.store.payments;
    if (r.status === "success") {
      const done = await payments.completeRefund(order.id, r.refundId);
      await this.deps.syncDataPlane();
      return { order: done, outcome: "refunded", message: null };
    }
    if (r.status === "failed") {
      const message = r.message ?? `${m.name} refused the refund`;
      return { order: await payments.failRefund(order.id, message), outcome: "failed", message };
    }
    return { order: await payments.noteRefundPending(order.id, r.refundId, null), outcome: "pending", message: "The gateway is still processing the refund" };
  }

  /** Asks the gateway about a refund_pending order and settles it when it has an answer. */
  async settleRefund(orderId: string): Promise<{ result: AdminRefundResult } | { unsupported: string }> {
    const order = await this.deps.store.payments.getOrder(orderId);
    if (!order) throw new StoreError("not_found", "Order not found");
    if (order.status !== "refund_pending") throw new StoreError("conflict", "Only pending refunds can be checked");
    const m = await this.merchantFor(order);
    if (!m || !m.ready) return { unsupported: "The payment provider of this order is no longer configured" };
    if (!supportsRefundQuery(m.provider)) return { unsupported: `${m.name} cannot report a refund's status; check its merchant console, then record or send the refund again` };
    let r: ProviderRefundResult;
    try {
      r = await queryRefund(m, order, this.fetch);
    } catch (err) {
      return { result: { order, outcome: "pending", message: errMessage(err) } };
    }
    return { result: await this.applyRefundResult(order, m, r) };
  }

  /**
   * Reconciles a provider refund notification (Stripe charge.refunded, WeChat Pay REFUND.SUCCESS,
   * Airwallex refund.settled) idempotently against local wallet/rebate state. A cumulative
   * notification (Stripe) applies what goes beyond the committed refunds; a delta notification is
   * one provider refund and is applied once per refund id, since providers redeliver and a refund
   * started here is also completed by its own gateway answer or the sweeper.
   */
  async reconcileExternalRefund(
    orderId: string,
    opts: { cumulativeRefundedMinor?: number; deltaRefundMinor?: number; providerRefundId?: string | null },
  ): Promise<PaymentOrderItem | null> {
    const payments = this.deps.store.payments;
    const order = await payments.getOrder(orderId);
    if (!order) return null;
    if (order.status === "refunded") return order;
    const ledger = await payments.getRefundLedger(orderId);
    if (!ledger) return null;
    const delta = opts.cumulativeRefundedMinor === undefined;
    if (delta && opts.providerRefundId && ledger.appliedRefundIds.includes(opts.providerRefundId)) return order;
    if (order.status === "refund_pending") {
      const done = await payments.completeRefund(order.id, opts.providerRefundId ?? null);
      await this.deps.syncDataPlane();
      return done;
    }
    if (
      order.status !== "paid" &&
      order.status !== "partially_refunded" &&
      order.status !== "refund_requested" &&
      order.status !== "refund_failed"
    ) {
      return order;
    }
    const already = ledger.committedMinor;
    const remaining = order.amountMinor - already;
    if (remaining <= 0) return order;
    const rawDelta = delta ? (opts.deltaRefundMinor ?? 0) : opts.cumulativeRefundedMinor! - already;
    if (!Number.isFinite(rawDelta) || rawDelta <= 0) return order;
    const amountMinor = Math.min(Math.round(rawDelta), remaining);
    await payments.beginRefund(order.id, {
      amountMinor,
      reason: "provider_webhook_refund",
      reclaim: true,
      force: true,
    });
    const done = await payments.completeRefund(order.id, opts.providerRefundId ?? null);
    await this.deps.syncDataPlane();
    return done;
  }

  /* ---------------- Sweeper ---------------- */

  /**
   * Pending orders past their deadline: a provider that reports them paid fulfils them,
   * otherwise the upstream trade is closed and `expired` persisted. Pending refunds are asked
   * about. Bounded per run; concurrent calls share one run.
   */
  sweep(): Promise<PaymentSweepResult> {
    if (!this.sweeping) {
      this.sweeping = this.sweepOnce().finally(() => {
        this.sweeping = null;
      });
    }
    return this.sweeping;
  }

  private async sweepOnce(): Promise<PaymentSweepResult> {
    const payments = this.deps.store.payments;
    const result: PaymentSweepResult = { recovered: 0, expired: 0, refundsSettled: 0 };
    const due = await payments.listDueOrders("expired", 50);
    const loaded = due.length > 0 ? await this.loadConfig() : null;
    for (const order of due) {
      try {
        const m = order.provider === "manual" ? null : await this.merchantFor(order, loaded ?? undefined);
        if (m?.ready) {
          let q: ProviderPaymentQuery | null = null;
          try {
            q = await queryPayment(m, order, this.fetch);
          } catch (err) {
            console.warn(`[slipgate-bff] expiry check of order ${order.id} failed: ${errMessage(err)}`);
          }
          if (q?.status === "paid" && !PaymentService.paymentMismatch(order, q)) {
            if ((await this.fulfill(order.id, q.tradeNo)).fulfilled) result.recovered++;
            continue;
          }
          if (q && q.status !== "paid") await cancelPayment(m, order, this.fetch).catch(() => undefined);
        }
        if (await payments.markOrderExpired(order.id)) result.expired++;
      } catch (err) {
        console.warn(`[slipgate-bff] expiring order ${order.id} failed: ${errMessage(err)}`);
      }
    }
    for (const order of await payments.listDueOrders("refund_pending", 20)) {
      if (!supportsRefundQuery(order.provider)) continue;
      try {
        const settled = await this.settleRefund(order.id);
        if ("result" in settled && settled.result.outcome !== "pending") result.refundsSettled++;
      } catch (err) {
        console.warn(`[slipgate-bff] refund check of order ${order.id} failed: ${errMessage(err)}`);
      }
    }
    return result;
  }

  /* ---------------- Admin view of instances ---------------- */

  toAdminInstance(rec: PaymentInstanceRecord, secrets: Record<string, string>, usage: Record<string, number>): PaymentProviderInstance {
    let today = 0;
    for (const [k, v] of Object.entries(usage)) if (k.startsWith(`${rec.id}|`)) today += v;
    return {
      id: rec.id,
      provider: rec.provider,
      name: rec.name,
      enabled: rec.enabled,
      sortOrder: rec.sortOrder,
      supportedTypes: rec.supportedTypes,
      paymentMode: rec.paymentMode,
      refundEnabled: rec.refundEnabled,
      allowUserRefund: rec.allowUserRefund,
      limits: rec.limits,
      config: rec.config,
      secretsSet: Object.fromEntries(PAYMENT_INSTANCE_SECRET_FIELDS[rec.provider].map((f) => [f, Boolean(secrets[f])])),
      ready: PaymentService.instanceReady(rec.provider, rec.config, secrets),
      todayUsageMinor: today,
      createdAtIso: rec.createdAtIso,
      updatedAtIso: rec.updatedAtIso,
    };
  }

  /** Identity fields or secrets differ (refused while the instance has open orders). */
  static protectedChange(
    provider: PaymentInstanceProvider,
    before: { config: Record<string, unknown>; secrets: Record<string, string> },
    after: { config: Record<string, unknown>; secrets: Record<string, string> },
  ): boolean {
    for (const f of PROTECTED_CONFIG_FIELDS[provider]) {
      if (JSON.stringify(before.config[f] ?? null) !== JSON.stringify(after.config[f] ?? null)) return true;
    }
    for (const f of PAYMENT_INSTANCE_SECRET_FIELDS[provider]) {
      if (f === "mpAppSecret") continue; // only used to read openids, never for a payment
      if ((before.secrets[f] ?? "") !== (after.secrets[f] ?? "")) return true;
    }
    return false;
  }
}
