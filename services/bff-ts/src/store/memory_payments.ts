import {
  PAID_ORDER_STATUSES,
  type AffiliateAccountItem,
  type AffiliateRebateItem,
  type AffiliateWithdrawalItem,
  type AffiliateWithdrawalStatus,
  type OrderListQuery,
  type PaymentCheckout,
  type PaymentCurrency,
  type PaymentDashboard,
  type PaymentOrderItem,
  type PaymentOrderStatus,
  type PaymentPlan,
} from "@slipgate/contracts";
import { applyMemoryWalletDelta, MemoryOpsStore, type MemoryCoreState } from "./memory_ops.ts";
import { MemoryPaymentInstanceStore } from "./memory_payment_providers.ts";
import { clampPage, DAY_MS } from "./ops_shared.ts";
import type { OpsStore } from "./ops_types.ts";
import { OPEN_INSTANCE_ORDER_STATUSES } from "./payment_providers_types.ts";
import {
  REFUNDABLE_STATUSES,
  type BeginRefundResult,
  type FulfillResult,
  type OrderInput,
  type OrderPaymentPatch,
  type PaymentsStore,
  type PlanInput,
  type RebatePolicy,
  type RefundInput,
} from "./payments_types.ts";
import { StoreError } from "./types.ts";

interface OrderRecord extends Omit<OrderInput, "creditNano" | "providerInstanceId"> {
  id: string;
  providerInstanceId: string | null;
  creditNano: bigint;
  /** `expired` is stored once the sweeper has checked the provider (derived before that). */
  status: PaymentOrderStatus;
  providerTradeNo: string | null;
  payUrl: string | null;
  qrCode: string | null;
  checkout: PaymentCheckout | null;
  createdAtIso: string;
  updatedAtMs: number;
  paidAtIso: string | null;
  /** Subscription orders: the subscription the payment created or extended. */
  subscriptionId: string | null;
  /** Paid but not delivered (see PaymentOrderItem.deliveryError). */
  deliveryError: string | null;
  refundAmountMinor: number;
  priorRefundAmountMinor: number;
  refundReason: string | null;
  refundError: string | null;
  providerRefundId: string | null;
  /** Provider refund ids completeRefund has applied (see PaymentsStore.getRefundLedger). */
  appliedRefundIds: string[];
  refundReclaim: boolean;
  refundForce: boolean;
  refundReclaimedNano: bigint;
  refundedAtIso: string | null;
  refundRequestedAtIso: string | null;
  refundRequestReason: string | null;
}

interface PlanRecord extends Omit<PlanInput, "creditNano"> {
  id: string;
  creditNano: bigint;
  createdAtIso: string;
}

interface RebateRecord {
  id: string;
  beneficiaryId: string;
  inviteeId: string;
  orderId: string;
  amountNano: bigint;
  creditedTo: "wallet" | "commission_pool";
  /** `reversed` once the order was refunded in full and the rebate taken back. */
  status: "settled" | "reversed";
  createdAtIso: string;
}

interface AffiliateAccountRecord {
  userId: string;
  customRebateBps: number | null;
  balanceNano: bigint;
  totalEarnedNano: bigint;
  totalTransferredNano: bigint;
  totalWithdrawnNano: bigint;
  updatedAtIso: string;
}

interface AffiliateWithdrawalRecord {
  id: string;
  userId: string;
  kind: AffiliateWithdrawalItem["kind"];
  amountNano: bigint;
  status: AffiliateWithdrawalStatus;
  payoutMethod: string;
  payoutAccount: string;
  notes: string;
  reviewNote: string;
  reviewedBy: string | null;
  reviewedAtIso: string | null;
  createdAtIso: string;
}

/** Statuses whose money arrived and was not fully refunded (instance usage, dashboard revenue). */
export const REVENUE_ORDER_STATUSES: readonly PaymentOrderStatus[] = PAID_ORDER_STATUSES.filter((s) => s !== "refunded");

/** `whole` scaled by numerator / denominator, rounded down (all of it when they are equal). */
export function proportion(whole: bigint, numerator: number, denominator: number): bigint {
  if (denominator <= 0 || numerator >= denominator) return whole;
  return (whole * BigInt(Math.max(0, numerator))) / BigInt(denominator);
}

/** A refund_pending order may be sent again (or recorded) once it has waited this long. */
export const REFUND_RESEND_AFTER_MS = 60_000;
export const REFUND_IN_PROGRESS_MESSAGE = "A refund of this order is already in progress; check its status first";

/** Message of a refused user refund request whose top-up was (partly) spent. */
export const REFUND_BALANCE_MESSAGE = "Your balance no longer covers this top-up, so it cannot be refunded";

export function effectiveOrderStatus(status: PaymentOrderStatus, expiresAtIso: string, nowMs = Date.now()): PaymentOrderStatus {
  return status === "pending" && Date.parse(expiresAtIso) <= nowMs ? "expired" : status;
}

/** Revenue descending, then name, so both stores rank ties the same way. */
function byRevenue<T extends { revenueMinor: number }>(name: (row: T) => string) {
  return (a: T, b: T) => b.revenueMinor - a.revenueMinor || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0);
}

export class MemoryPaymentsStore implements PaymentsStore {
  readonly instances: MemoryPaymentInstanceStore;
  private config: Record<string, unknown> | null = null;
  private readonly plans = new Map<string, PlanRecord>();
  private readonly orders = new Map<string, OrderRecord>();
  private readonly rebates: RebateRecord[] = [];
  private readonly affiliateAccounts = new Map<string, AffiliateAccountRecord>();
  private readonly affiliateWithdrawals: AffiliateWithdrawalRecord[] = [];
  /** Per-order tail of the fulfil/refund chain (the Postgres store's row lock). */
  private readonly orderLocks = new Map<string, Promise<void>>();
  /** Per-user affiliate pool lock matching Postgres FOR UPDATE row locking. */
  private readonly affiliateLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly core: Pick<MemoryCoreState, "users" | "wallets" | "idempotencyKeys" | "ledger" | "groups">,
    private readonly ops: OpsStore,
  ) {
    // deleteUser refuses users that orders or rebates still reference, as Postgres does.
    if (ops instanceof MemoryOpsStore) ops.attachPaymentReferences((userId) => this.userReferences(userId));
    const open = new Set<string>(OPEN_INSTANCE_ORDER_STATUSES);
    this.instances = new MemoryPaymentInstanceStore((instanceId) => {
      let n = 0;
      for (const o of this.orders.values()) if (o.providerInstanceId === instanceId && open.has(o.status)) n++;
      return n;
    });
  }

  /** Orders owned by the user and rebates paid to them (any status), like the Postgres FKs. */
  userReferences(userId: string): { orders: number; rebates: number } {
    let orders = 0;
    for (const o of this.orders.values()) if (o.userId === userId) orders++;
    return { orders, rebates: this.rebates.filter((r) => r.beneficiaryId === userId).length };
  }

  async getConfigBlob() {
    return this.config ? structuredClone(this.config) : null;
  }

  async saveConfigBlob(blob: Record<string, unknown>) {
    this.config = structuredClone(blob);
  }

  /* ---------------- Plans ---------------- */

  private toPlan(p: PlanRecord): PaymentPlan {
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      kind: p.kind,
      priceMinor: p.priceMinor,
      currency: p.currency,
      creditNanoUsd: p.creditNano.toString(),
      groupId: p.groupId,
      groupName: p.groupId ? (this.core.groups.get(p.groupId)?.name ?? null) : null,
      validityDays: p.validityDays,
      badge: p.badge,
      enabled: p.enabled,
      sortOrder: p.sortOrder,
      createdAtIso: p.createdAtIso,
    };
  }

  async listPlans(includeDisabled: boolean) {
    return Array.from(this.plans.values())
      .filter((p) => includeDisabled || (p.enabled && (p.kind !== "subscription" || this.subscriptionGroupProblem(p.groupId) === null)))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.priceMinor - b.priceMinor)
      .map((p) => this.toPlan(p));
  }

  async getPlan(id: string) {
    const p = this.plans.get(id);
    return p ? this.toPlan(p) : null;
  }

  /** Why a subscription to this group cannot be granted now (same wording as Postgres), or null. */
  private subscriptionGroupProblem(groupId: string | null): string | null {
    const g = this.core.groups.get(groupId ?? "");
    if (!g) return `Group ${groupId ?? ""} not found`;
    if (g.subscriptionType !== "subscription") return `Group ${g.name} is not subscription-billed`;
    return null;
  }

  private checkPlanGroup(input: PlanInput) {
    if (input.kind !== "subscription") return;
    const g = this.core.groups.get(input.groupId ?? "");
    if (!g) throw new StoreError("not_found", "Group not found");
    if (g.subscriptionType !== "subscription") throw new StoreError("bad_request", "That group is not subscription-billed");
  }

  async createPlan(input: PlanInput) {
    this.checkPlanGroup(input);
    const rec: PlanRecord = { ...input, id: `plan_${crypto.randomUUID()}`, createdAtIso: new Date().toISOString() };
    this.plans.set(rec.id, rec);
    return this.toPlan(rec);
  }

  async updatePlan(id: string, input: PlanInput) {
    const rec = this.plans.get(id);
    if (!rec) throw new StoreError("not_found", "Plan not found");
    this.checkPlanGroup(input);
    Object.assign(rec, input);
    return this.toPlan(rec);
  }

  async deletePlan(id: string) {
    if (!this.plans.delete(id)) throw new StoreError("not_found", "Plan not found");
  }

  /* ---------------- Orders ---------------- */

  private toOrder(o: OrderRecord, nowMs = Date.now()): PaymentOrderItem {
    const status = effectiveOrderStatus(o.status, o.expiresAtIso, nowMs);
    return {
      id: o.id,
      userId: o.userId,
      userEmail: this.core.users.get(o.userId)?.email ?? "",
      kind: o.kind,
      planId: o.planId,
      planName: o.planName,
      provider: o.provider,
      method: o.method,
      status,
      amountMinor: o.amountMinor,
      currency: o.currency,
      creditNanoUsd: o.creditNano.toString(),
      groupId: o.groupId,
      groupName: o.groupId ? (this.core.groups.get(o.groupId)?.name ?? null) : null,
      validityDays: o.validityDays,
      providerTradeNo: o.providerTradeNo,
      payUrl: o.payUrl,
      providerInstanceId: o.providerInstanceId,
      providerInstanceName: this.instances.nameOf(o.providerInstanceId),
      qrCode: o.qrCode,
      // Only an order that can still be paid needs its checkout data.
      checkout: status === "pending" && o.checkout ? structuredClone(o.checkout) : null,
      deliveryError: o.deliveryError,
      createdAtIso: o.createdAtIso,
      paidAtIso: o.paidAtIso,
      expiresAtIso: o.expiresAtIso,
      refundAmountMinor: o.refundAmountMinor,
      refundReason: o.refundReason,
      refundError: o.refundError,
      providerRefundId: o.providerRefundId,
      refundReclaimedNanoUsd: o.refundReclaimedNano.toString(),
      refundedAtIso: o.refundedAtIso,
      refundRequestedAtIso: o.refundRequestedAtIso,
      refundRequestReason: o.refundRequestReason,
      canRequestRefund: false,
    };
  }

  private require(id: string): OrderRecord {
    const o = this.orders.get(id);
    if (!o) throw new StoreError("not_found", "Order not found");
    return o;
  }

  private touch(o: OrderRecord) {
    o.updatedAtMs = Date.now();
  }

  /** Runs `fn` after every earlier fulfil/refund of this order has finished. */
  private async locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.orderLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => gate);
    this.orderLocks.set(id, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.orderLocks.get(id) === tail) this.orderLocks.delete(id);
    }
  }

  async createOrder(input: OrderInput) {
    return this.locked(`create:${input.userId}`, async () => {
      if (!this.core.users.has(input.userId)) throw new StoreError("not_found", "User not found");
      if (input.maxPendingOrders !== undefined && input.maxPendingOrders > 0) {
        if ((await this.countPendingOrders(input.userId)) >= input.maxPendingOrders) {
          throw new StoreError("conflict", "Too many unpaid orders; pay or cancel one first");
        }
      }
      if (
        input.merchantDailyLimitMinor !== undefined &&
        input.merchantDailyLimitMinor > 0 &&
        input.merchantUsageKey &&
        input.dayStartIso
      ) {
        const usage = await this.instanceUsage(input.dayStartIso);
        const used = usage[input.merchantUsageKey] ?? 0;
        if (used + input.amountMinor > input.merchantDailyLimitMinor) {
          throw new StoreError("conflict", "This payment method has reached its limit for this amount; try another method or amount");
        }
      }
      if (input.kind === "subscription" && this.subscriptionGroupProblem(input.groupId)) {
        throw new StoreError("conflict", "This plan cannot be purchased right now");
      }
      const rec: OrderRecord = {
        ...input,
        providerInstanceId: input.providerInstanceId ?? null,
        id: `ord_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        status: "pending",
        providerTradeNo: null,
        payUrl: null,
        qrCode: null,
        checkout: null,
        createdAtIso: new Date().toISOString(),
        updatedAtMs: Date.now(),
        paidAtIso: null,
        subscriptionId: null,
        deliveryError: null,
        refundAmountMinor: 0,
        priorRefundAmountMinor: 0,
        refundReason: null,
        refundError: null,
        providerRefundId: null,
        appliedRefundIds: [],
        refundReclaim: false,
        refundForce: false,
        refundReclaimedNano: 0n,
        refundedAtIso: null,
        refundRequestedAtIso: null,
        refundRequestReason: null,
      };
      this.orders.set(rec.id, rec);
      return this.toOrder(rec);
    });
  }

  async setOrderPayment(id: string, patch: OrderPaymentPatch) {
    const o = this.require(id);
    o.payUrl = patch.payUrl;
    o.qrCode = patch.qrCode;
    o.checkout = patch.checkout ? structuredClone(patch.checkout) : null;
    if (patch.providerTradeNo) o.providerTradeNo = patch.providerTradeNo;
    this.touch(o);
  }

  async getOrder(id: string) {
    const o = this.orders.get(id);
    return o ? this.toOrder(o) : null;
  }

  async listOrders(query: OrderListQuery) {
    const now = Date.now();
    const q = query.search?.toLowerCase();
    const filtered = Array.from(this.orders.values())
      .map((o) => this.toOrder(o, now))
      .filter((o) => {
        if (query.status && o.status !== query.status) return false;
        if (query.provider && o.provider !== query.provider) return false;
        if (query.userId && o.userId !== query.userId) return false;
        if (q && ![o.id, o.userEmail, o.planName, o.providerTradeNo ?? ""].some((v) => v.toLowerCase().includes(q))) return false;
        return true;
      })
      .sort((a, b) => (a.createdAtIso < b.createdAtIso ? 1 : -1));
    const { offset, limit } = clampPage(query.page, query.pageSize);
    return { items: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  async countPendingOrders(userId: string) {
    const now = Date.now();
    let n = 0;
    for (const o of this.orders.values()) {
      if (o.userId === userId && effectiveOrderStatus(o.status, o.expiresAtIso, now) === "pending") n++;
    }
    return n;
  }

  async fulfillOrder(id: string, providerTradeNo: string | null, rebate: RebatePolicy): Promise<FulfillResult> {
    return this.locked(id, async () => {
      const o = this.require(id);
      // Pending, expired, cancelled or failed: money arrived, so deliver what was paid for.
      const firstPayment = !PAID_ORDER_STATUSES.includes(o.status);
      const retry = o.status === "paid" && o.deliveryError !== null;
      if (!firstPayment && !retry) return { order: this.toOrder(o), fulfilled: false, delivered: false };

      let delivered = false;
      if (o.kind === "subscription") {
        // The group may have been deleted or switched to balance billing since the order was
        // placed. The payment is still accepted (refusing it would only make the provider retry
        // forever) and the order is flagged for the admin to redeliver or refund.
        const problem = this.subscriptionGroupProblem(o.groupId);
        if (problem) {
          o.deliveryError = problem;
        } else {
          const sub = await this.ops.assignSubscription(o.userId, o.groupId!, o.validityDays ?? 30, "", `order:${o.id}`);
          o.subscriptionId = sub.id;
          o.deliveryError = null;
          delivered = true;
        }
      } else {
        if (o.creditNano > 0n) applyMemoryWalletDelta(this.core, o.userId, o.creditNano, `order:${o.id}`, "credit", `order:${o.id}`);
        delivered = true;
      }
      this.touch(o);
      if (!firstPayment) return { order: this.toOrder(o), fulfilled: false, delivered };

      o.status = "paid";
      o.paidAtIso = new Date().toISOString();
      if (providerTradeNo) o.providerTradeNo = providerTradeNo;

      if (rebate.enabled && o.kind === "recharge" && o.creditNano > 0n) {
        const referrerId = (await this.ops.getAdminUser(o.userId))?.referrerId;
        if (referrerId && this.core.users.has(referrerId)) {
          await this.withAffiliateLock(referrerId, async () => {
            const acc = this.ensureAffiliateRecord(referrerId);
            const effectiveBps = acc.customRebateBps ?? rebate.bps;
            const amount = effectiveBps > 0 ? (o.creditNano * BigInt(effectiveBps)) / 10_000n : 0n;
            if (amount <= 0n) return;
            const creditMode = rebate.creditMode === "commission_pool" ? "commission_pool" : "wallet";
            if (creditMode === "commission_pool") {
              if (this.rebates.some((r) => r.orderId === o.id)) return;
              acc.balanceNano += amount;
              acc.totalEarnedNano += amount;
              acc.updatedAtIso = new Date().toISOString();
              this.rebates.unshift({
                id: `cms_${crypto.randomUUID()}`,
                beneficiaryId: referrerId,
                inviteeId: o.userId,
                orderId: o.id,
                amountNano: amount,
                creditedTo: "commission_pool",
                status: "settled",
                createdAtIso: new Date().toISOString(),
              });
            } else if (applyMemoryWalletDelta(this.core, referrerId, amount, `rebate:${o.id}`, "credit", `rebate:${o.id}`)) {
              acc.totalEarnedNano += amount;
              acc.updatedAtIso = new Date().toISOString();
              this.rebates.unshift({
                id: `cms_${crypto.randomUUID()}`,
                beneficiaryId: referrerId,
                inviteeId: o.userId,
                orderId: o.id,
                amountNano: amount,
                creditedTo: "wallet",
                status: "settled",
                createdAtIso: new Date().toISOString(),
              });
            }
          });
        }
      }
      return { order: this.toOrder(o), fulfilled: true, delivered };
    });
  }

  async cancelOrder(id: string, userId?: string) {
    const o = this.require(id);
    if (userId && o.userId !== userId) throw new StoreError("not_found", "Order not found");
    if (o.status !== "pending") throw new StoreError("conflict", "Only pending orders can be cancelled");
    o.status = "cancelled";
    this.touch(o);
    return this.toOrder(o);
  }

  /* ---------------- Refunds ---------------- */

  /** Spendable balance: the wallet minus what in-flight requests hold. */
  private available(userId: string): bigint {
    const w = this.core.wallets.get(userId);
    const free = (w?.balanceNano ?? 0n) - (w?.heldNano ?? 0n);
    return free > 0n ? free : 0n;
  }

  async refundOrder(id: string, reclaim: boolean) {
    const o = this.require(id);
    if (o.status !== "paid" && o.status !== "partially_refunded" && o.status !== "refund_requested") {
      throw new StoreError("conflict", "Only paid orders can be refunded");
    }
    const already = o.status === "partially_refunded" ? o.refundAmountMinor : 0;
    await this.beginRefund(id, { amountMinor: o.amountMinor - already, reason: o.refundRequestReason ?? "", reclaim, force: true });
    return this.completeRefund(id, null);
  }

  async instanceUsage(sinceIso: string) {
    const since = Date.parse(sinceIso);
    const now = Date.now();
    const counted = new Set<PaymentOrderStatus>(["pending", ...REVENUE_ORDER_STATUSES]);
    const out: Record<string, number> = {};
    for (const o of this.orders.values()) {
      if (Date.parse(o.createdAtIso) < since) continue;
      if (!counted.has(effectiveOrderStatus(o.status, o.expiresAtIso, now))) continue;
      const key = `${o.providerInstanceId ?? `builtin:${o.provider}`}|${o.method ?? o.provider}`;
      out[key] = (out[key] ?? 0) + o.amountMinor;
    }
    return out;
  }

  async requestRefund(id: string, userId: string, reason: string) {
    return this.locked(id, async () => {
      const o = this.orders.get(id);
      if (!o || o.userId !== userId) throw new StoreError("not_found", "Order not found");
      if (o.status !== "paid") throw new StoreError("conflict", "Only paid orders can be refunded");
      if (o.kind !== "recharge") throw new StoreError("bad_request", "Only balance top-ups can be refunded on request");
      if (this.available(o.userId) < o.creditNano) throw new StoreError("conflict", REFUND_BALANCE_MESSAGE);
      o.status = "refund_requested";
      o.refundRequestedAtIso = new Date().toISOString();
      o.refundRequestReason = reason;
      o.refundError = null;
      this.touch(o);
      return this.toOrder(o);
    });
  }

  async rejectRefund(id: string) {
    return this.locked(id, async () => {
      const o = this.require(id);
      if (o.status !== "refund_requested" && o.status !== "refund_failed") {
        throw new StoreError("conflict", "Only requested or failed refunds can be rejected");
      }
      o.status = o.priorRefundAmountMinor > 0 ? "partially_refunded" : "paid";
      o.refundAmountMinor = o.priorRefundAmountMinor;
      o.refundReason = null;
      o.refundError = null;
      o.providerRefundId = null;
      o.refundReclaim = false;
      o.refundForce = false;
      this.touch(o);
      return this.toOrder(o);
    });
  }

  async beginRefund(id: string, input: RefundInput): Promise<BeginRefundResult> {
    return this.locked(id, async () => {
      const o = this.require(id);
      if (!(REFUNDABLE_STATUSES as readonly string[]).includes(o.status)) {
        throw new StoreError("conflict", "Only paid orders can be refunded");
      }
      // Re-sending a pending refund is for stuck ones only, never a double click.
      if (o.status === "refund_pending" && Date.now() - o.updatedAtMs < REFUND_RESEND_AFTER_MS) {
        throw new StoreError("conflict", REFUND_IN_PROGRESS_MESSAGE);
      }
      const priorMinor =
        o.status === "partially_refunded"
          ? o.refundAmountMinor
          : o.status === "refund_failed" || o.status === "refund_pending"
            ? o.priorRefundAmountMinor
            : 0;
      const remainingMinor = o.amountMinor - priorMinor;
      if (!Number.isInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > remainingMinor) {
        throw new StoreError("bad_request", "Refund amount must be between 0.01 and the remaining refundable amount");
      }
      if (input.reclaim && o.kind === "recharge" && !input.force) {
        const reclaimNano = proportion(o.creditNano, input.amountMinor, o.amountMinor);
        const balanceNano = this.available(o.userId);
        if (balanceNano < reclaimNano) return { requiresForce: { balanceNano, reclaimNano } };
      }
      o.status = "refund_pending";
      o.priorRefundAmountMinor = priorMinor;
      o.refundAmountMinor = input.amountMinor;
      o.refundReason = input.reason || o.refundRequestReason || null;
      o.refundReclaim = input.reclaim;
      o.refundForce = input.force;
      o.refundError = null;
      o.providerRefundId = null;
      this.touch(o);
      return { order: this.toOrder(o) };
    });
  }

  async noteRefundPending(id: string, providerRefundId: string | null, error: string | null) {
    return this.locked(id, async () => {
      const o = this.require(id);
      if (o.status !== "refund_pending") throw new StoreError("conflict", "The refund is no longer pending");
      if (providerRefundId) o.providerRefundId = providerRefundId;
      o.refundError = error;
      this.touch(o);
      return this.toOrder(o);
    });
  }

  async completeRefund(id: string, providerRefundId: string | null) {
    return this.locked(id, async () => {
      const o = this.require(id);
      if (o.status !== "refund_pending") {
        if (providerRefundId && o.appliedRefundIds.includes(providerRefundId)) return this.toOrder(o);
        throw new StoreError("conflict", "The refund is no longer pending");
      }
      const part = o.refundAmountMinor;
      const priorMinor = o.priorRefundAmountMinor;
      const totalRefundedMinor = priorMinor + part;
      const remainingBeforePart = Math.max(1, o.amountMinor - priorMinor);
      const ledgerSuffix = priorMinor > 0 ? `:${totalRefundedMinor}` : "";
      let reclaimed = 0n;
      if (o.refundReclaim && o.kind === "recharge" && o.creditNano > 0n) {
        // The money already went back: take the share of the credit that is still there.
        const want = proportion(o.creditNano, part, o.amountMinor);
        const take = want < this.available(o.userId) ? want : this.available(o.userId);
        if (
          take > 0n &&
          applyMemoryWalletDelta(this.core, o.userId, -take, `refund:${o.id}${ledgerSuffix}`, "adjust", `refund:${o.id}${ledgerSuffix}`)
        ) {
          reclaimed = take;
        }
      }
      // A subscription order with a delivery error never granted anything.
      if (o.refundReclaim && o.kind === "subscription" && o.subscriptionId && o.deliveryError === null) {
        const days = Number(proportion(BigInt(o.validityDays ?? 30), part, o.amountMinor));
        if (days > 0) await this.reclaimSubscription(o.subscriptionId, o.userId, days);
      }
      // The referrer's rebate was earned on money that is going back: always reverse that share.
      const rebate = this.rebates.find((r) => r.orderId === o.id && r.status === "settled");
      if (rebate) {
        const back = proportion(rebate.amountNano, part, remainingBeforePart);
        if (back > 0n) {
          if (rebate.creditedTo === "commission_pool") {
            await this.withAffiliateLock(rebate.beneficiaryId, async () => {
              const acc = this.ensureAffiliateRecord(rebate.beneficiaryId);
              const fromPool = acc.balanceNano > back ? back : acc.balanceNano;
              if (fromPool > 0n) {
                acc.balanceNano -= fromPool;
                acc.updatedAtIso = new Date().toISOString();
              }
              const remainder = back - fromPool;
              if (remainder > 0n) {
                applyMemoryWalletDelta(
                  this.core,
                  rebate.beneficiaryId,
                  -remainder,
                  `rebate-refund:${o.id}${ledgerSuffix}`,
                  "adjust",
                  `rebate-refund:${o.id}${ledgerSuffix}`,
                );
              }
            });
          } else {
            applyMemoryWalletDelta(
              this.core,
              rebate.beneficiaryId,
              -back,
              `rebate-refund:${o.id}${ledgerSuffix}`,
              "adjust",
              `rebate-refund:${o.id}${ledgerSuffix}`,
            );
          }
        }
        if (back >= rebate.amountNano) rebate.status = "reversed";
        else rebate.amountNano -= back;
      }
      o.status = totalRefundedMinor >= o.amountMinor ? "refunded" : "partially_refunded";
      o.refundAmountMinor = totalRefundedMinor;
      o.priorRefundAmountMinor = totalRefundedMinor;
      o.refundedAtIso = new Date().toISOString();
      o.refundReclaimedNano += reclaimed;
      o.refundError = null;
      if (providerRefundId) {
        o.providerRefundId = providerRefundId;
        if (!o.appliedRefundIds.includes(providerRefundId)) o.appliedRefundIds.push(providerRefundId);
      }
      this.touch(o);
      return this.toOrder(o);
    });
  }

  async getRefundLedger(id: string) {
    const o = this.orders.get(id);
    if (!o) return null;
    const committedMinor = o.status === "refunded" || o.status === "partially_refunded" ? o.refundAmountMinor : o.priorRefundAmountMinor;
    return { committedMinor, appliedRefundIds: [...o.appliedRefundIds] };
  }

  async failRefund(id: string, error: string) {
    return this.locked(id, async () => {
      const o = this.require(id);
      if (o.status !== "refund_pending") throw new StoreError("conflict", "The refund is no longer pending");
      o.status = "refund_failed";
      o.refundError = error.slice(0, 500);
      this.touch(o);
      return this.toOrder(o);
    });
  }

  async listDueOrders(kind: "expired" | "refund_pending", limit: number) {
    const now = Date.now();
    const due = Array.from(this.orders.values()).filter((o) =>
      kind === "expired"
        ? o.status === "pending" && Date.parse(o.expiresAtIso) <= now
        : o.status === "refund_pending" && o.updatedAtMs <= now - 60_000,
    );
    due.sort((a, b) => (kind === "expired" ? Date.parse(a.expiresAtIso) - Date.parse(b.expiresAtIso) : a.updatedAtMs - b.updatedAtMs));
    return due.slice(0, Math.max(1, Math.min(500, limit))).map((o) => this.toOrder(o, now));
  }

  async markOrderExpired(id: string) {
    const o = this.orders.get(id);
    if (!o || o.status !== "pending" || Date.parse(o.expiresAtIso) > Date.now()) return false;
    o.status = "expired";
    this.touch(o);
    return true;
  }

  /**
   * Takes `days` back from the subscription the order created or extended: shortened when time
   * would remain, revoked when those days are all that is left. Nothing to do once it has run
   * out or an admin deleted it.
   */
  private async reclaimSubscription(subscriptionId: string, userId: string, days: number) {
    const sub = (await this.ops.listUserSubscriptions(userId)).find((s) => s.id === subscriptionId);
    if (!sub) return;
    const now = Date.now();
    const expiresMs = Date.parse(sub.expiresAtIso);
    if (expiresMs <= now) return;
    if (expiresMs - days * DAY_MS > now) await this.ops.updateSubscription(subscriptionId, "extend", -days);
    else await this.ops.updateSubscription(subscriptionId, "revoke", 0);
  }

  /* ---------------- Dashboard & rebates ---------------- */

  async dashboard(days: number, currency: PaymentCurrency): Promise<PaymentDashboard> {
    const now = Date.now();
    const start = now - days * DAY_MS;
    const dayStart = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;
    const firstDay = dayStart(start) + DAY_MS;
    const series = Array.from({ length: days }, (_, i) => ({ dateIso: new Date(firstDay + i * DAY_MS).toISOString(), orders: 0, revenueMinor: 0 }));
    const providers = new Map<string, { orders: number; revenueMinor: number }>();
    const plans = new Map<string, { orders: number; revenueMinor: number }>();
    const revenueStatuses = new Set(REVENUE_ORDER_STATUSES);
    let paid = 0;
    let revenue = 0;
    let pending = 0;
    let refunded = 0;
    let created = 0;
    let credited = 0n;
    const payers = new Set<string>();
    for (const o of this.orders.values()) {
      if (Date.parse(o.createdAtIso) < start || o.currency !== currency) continue;
      created++;
      const status = effectiveOrderStatus(o.status, o.expiresAtIso, now);
      if (status === "pending") pending++;
      if (status === "refunded" || status === "partially_refunded") refunded++;
      if (!revenueStatuses.has(status)) continue;
      // What the order still brought in: a partial refund keeps the rest.
      const kept = o.amountMinor - (status === "partially_refunded" ? o.refundAmountMinor : 0);
      paid++;
      revenue += kept;
      credited += o.creditNano;
      payers.add(o.userId);
      const idx = Math.floor((dayStart(Date.parse(o.paidAtIso ?? o.createdAtIso)) - firstDay) / DAY_MS);
      const point = series[idx];
      if (point) {
        point.orders++;
        point.revenueMinor += kept;
      }
      const p = providers.get(o.provider) ?? { orders: 0, revenueMinor: 0 };
      p.orders++;
      p.revenueMinor += kept;
      providers.set(o.provider, p);
      const pl = plans.get(o.planName) ?? { orders: 0, revenueMinor: 0 };
      pl.orders++;
      pl.revenueMinor += kept;
      plans.set(o.planName, pl);
    }
    const rebates = this.rebates
      .filter((r) => r.status === "settled" && Date.parse(r.createdAtIso) >= start && this.orders.get(r.orderId)?.currency === currency)
      .reduce((s, r) => s + r.amountNano, 0n);
    return {
      generatedAtIso: new Date(now).toISOString(),
      days,
      currency,
      totals: {
        paidOrders: paid,
        revenueMinor: revenue,
        pendingOrders: pending,
        refundedOrders: refunded,
        creditedNanoUsd: credited.toString(),
        payingUsers: payers.size,
        conversionRate: created ? paid / created : 0,
        rebatesNanoUsd: rebates.toString(),
      },
      series,
      byProvider: [...providers].map(([provider, v]) => ({ provider, ...v })).sort(byRevenue((r) => r.provider)),
      topPlans: [...plans]
        .map(([planName, v]) => ({ planName, ...v }))
        .sort(byRevenue((r) => r.planName))
        .slice(0, 8),
    };
  }

  /** Settled rebates only: one reversed by a refund no longer counts as earned. */
  async listRebates(beneficiaryId: string | null, limit: number): Promise<AffiliateRebateItem[]> {
    return this.rebates
      .filter((r) => r.status === "settled" && (!beneficiaryId || r.beneficiaryId === beneficiaryId))
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        beneficiaryId: r.beneficiaryId,
        beneficiaryEmail: this.core.users.get(r.beneficiaryId)?.email ?? "",
        inviteeEmail: this.core.users.get(r.inviteeId)?.email ?? "",
        orderId: r.orderId,
        amountNanoUsd: r.amountNano.toString(),
        creditedTo: r.creditedTo,
        createdAtIso: r.createdAtIso,
      }));
  }

  async rebateTotal(beneficiaryId: string) {
    return this.rebates.filter((r) => r.status === "settled" && r.beneficiaryId === beneficiaryId).reduce((s, r) => s + r.amountNano, 0n);
  }

  /* ---------------- Affiliate accounts, rates & withdrawals (Lane C3) ---------------- */

  private async withAffiliateLock<T>(userId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.affiliateLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.affiliateLocks.set(userId, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.affiliateLocks.get(userId) === tail) this.affiliateLocks.delete(userId);
    }
  }

  private ensureAffiliateRecord(userId: string): AffiliateAccountRecord {
    let rec = this.affiliateAccounts.get(userId);
    if (!rec) {
      rec = {
        userId,
        customRebateBps: null,
        balanceNano: 0n,
        totalEarnedNano: 0n,
        totalTransferredNano: 0n,
        totalWithdrawnNano: 0n,
        updatedAtIso: this.core.users.get(userId)?.createdAtIso ?? new Date().toISOString(),
      };
      this.affiliateAccounts.set(userId, rec);
    }
    return rec;
  }

  private toAffiliateAccountItem(userId: string, username: string, inviteeCount: number, defaultBps: number): AffiliateAccountItem {
    const u = this.core.users.get(userId);
    const rec = this.affiliateAccounts.get(userId);
    const legacy = this.rebates
      .filter((r) => r.beneficiaryId === userId && r.status !== "reversed")
      .reduce((s, r) => s + r.amountNano, 0n);
    const totalEarned = rec ? (rec.totalEarnedNano > legacy ? rec.totalEarnedNano : legacy) : legacy;
    const customRebateBps = rec?.customRebateBps ?? null;
    return {
      userId,
      email: u?.email ?? "",
      username,
      customRebateBps,
      effectiveRebateBps: customRebateBps ?? defaultBps,
      balanceNanoUsd: (rec?.balanceNano ?? 0n).toString(),
      totalEarnedNanoUsd: totalEarned.toString(),
      totalTransferredNanoUsd: (rec?.totalTransferredNano ?? 0n).toString(),
      totalWithdrawnNanoUsd: (rec?.totalWithdrawnNano ?? 0n).toString(),
      inviteeCount,
      updatedAtIso: rec?.updatedAtIso ?? u?.createdAtIso ?? new Date(0).toISOString(),
    };
  }

  private toWithdrawalItem(w: AffiliateWithdrawalRecord): AffiliateWithdrawalItem {
    return {
      id: w.id,
      userId: w.userId,
      userEmail: this.core.users.get(w.userId)?.email ?? "",
      kind: w.kind,
      amountNanoUsd: w.amountNano.toString(),
      status: w.status,
      payoutMethod: w.payoutMethod,
      payoutAccount: w.payoutAccount,
      notes: w.notes,
      reviewNote: w.reviewNote,
      reviewedBy: w.reviewedBy,
      reviewedAtIso: w.reviewedAtIso,
      createdAtIso: w.createdAtIso,
    };
  }

  async getAffiliateAccount(userId: string, defaultBps: number): Promise<AffiliateAccountItem> {
    const adminUser = await this.ops.getAdminUser(userId);
    if (!adminUser) throw new StoreError("not_found", `User ${userId} not found`);
    const invitees = await this.ops.listInvitees(userId);
    return this.toAffiliateAccountItem(userId, adminUser.username, invitees.length, defaultBps);
  }

  async listAffiliateAccounts(defaultBps: number, search?: string): Promise<AffiliateAccountItem[]> {
    const q = search?.trim().toLowerCase() ?? "";
    const out: { item: AffiliateAccountItem; bal: bigint; earned: bigint; createdAtIso: string }[] = [];
    for (const [id, u] of this.core.users) {
      const adminUser = await this.ops.getAdminUser(id);
      if (!adminUser) continue;
      if (
        q &&
        !u.email.toLowerCase().includes(q) &&
        !adminUser.username.toLowerCase().includes(q) &&
        !id.toLowerCase().includes(q)
      ) {
        continue;
      }
      const invitees = await this.ops.listInvitees(id);
      const item = this.toAffiliateAccountItem(id, adminUser.username, invitees.length, defaultBps);
      out.push({
        item,
        bal: BigInt(item.balanceNanoUsd),
        earned: BigInt(item.totalEarnedNanoUsd),
        createdAtIso: u.createdAtIso,
      });
    }
    out.sort((a, b) => {
      if (b.bal !== a.bal) return b.bal > a.bal ? 1 : -1;
      if (b.earned !== a.earned) return b.earned > a.earned ? 1 : -1;
      return b.createdAtIso.localeCompare(a.createdAtIso);
    });
    return out.slice(0, 200).map((r) => r.item);
  }

  async setAffiliateCustomRate(
    userId: string,
    customRebateBps: number | null,
    defaultBps: number,
  ): Promise<AffiliateAccountItem> {
    if (!this.core.users.has(userId)) throw new StoreError("not_found", `User ${userId} not found`);
    return this.withAffiliateLock(userId, async () => {
      const rec = this.ensureAffiliateRecord(userId);
      rec.customRebateBps = customRebateBps;
      rec.updatedAtIso = new Date().toISOString();
      return this.getAffiliateAccount(userId, defaultBps);
    });
  }

  async transferAffiliateToWallet(
    userId: string,
    amountNano: bigint,
  ): Promise<{ withdrawal: AffiliateWithdrawalItem; affiliateBalanceNanoUsd: string; walletBalanceNanoUsd: string }> {
    if (amountNano <= 0n) throw new StoreError("bad_request", "Transfer amount must be positive");
    if (!this.core.users.has(userId)) throw new StoreError("not_found", `User ${userId} not found`);
    return this.withAffiliateLock(userId, () => {
      const rec = this.affiliateAccounts.get(userId);
      if (!rec || rec.balanceNano < amountNano) {
        throw new StoreError("bad_request", "Insufficient commission balance");
      }
      const now = new Date().toISOString();
      rec.balanceNano -= amountNano;
      rec.totalTransferredNano += amountNano;
      rec.updatedAtIso = now;
      const id = `affw_${crypto.randomUUID()}`;
      applyMemoryWalletDelta(this.core, userId, amountNano, `aff-transfer:${id}`, "credit", `aff-transfer:${id}`);
      const w: AffiliateWithdrawalRecord = {
        id,
        userId,
        kind: "wallet_transfer",
        amountNano,
        status: "paid",
        payoutMethod: "wallet",
        payoutAccount: "",
        notes: "",
        reviewNote: "",
        reviewedBy: null,
        reviewedAtIso: now,
        createdAtIso: now,
      };
      this.affiliateWithdrawals.unshift(w);
      return {
        withdrawal: this.toWithdrawalItem(w),
        affiliateBalanceNanoUsd: rec.balanceNano.toString(),
        walletBalanceNanoUsd: (this.core.wallets.get(userId)?.balanceNano ?? 0n).toString(),
      };
    });
  }

  async requestAffiliateWithdrawal(
    userId: string,
    amountNano: bigint,
    payoutMethod: string,
    payoutAccount: string,
    notes: string,
  ): Promise<AffiliateWithdrawalItem> {
    if (amountNano <= 0n) throw new StoreError("bad_request", "Withdrawal amount must be positive");
    if (!this.core.users.has(userId)) throw new StoreError("not_found", `User ${userId} not found`);
    return this.withAffiliateLock(userId, () => {
      const rec = this.affiliateAccounts.get(userId);
      if (!rec || rec.balanceNano < amountNano) {
        throw new StoreError("bad_request", "Insufficient commission balance");
      }
      const now = new Date().toISOString();
      rec.balanceNano -= amountNano;
      rec.updatedAtIso = now;
      const w: AffiliateWithdrawalRecord = {
        id: `affw_${crypto.randomUUID()}`,
        userId,
        kind: "payout",
        amountNano,
        status: "pending",
        payoutMethod,
        payoutAccount,
        notes,
        reviewNote: "",
        reviewedBy: null,
        reviewedAtIso: null,
        createdAtIso: now,
      };
      this.affiliateWithdrawals.unshift(w);
      return this.toWithdrawalItem(w);
    });
  }

  async listAffiliateWithdrawals(filter: {
    userId?: string;
    status?: AffiliateWithdrawalStatus;
    limit?: number;
  }): Promise<AffiliateWithdrawalItem[]> {
    const limit = Math.max(1, Math.min(500, filter.limit ?? 200));
    return this.affiliateWithdrawals
      .filter((w) => (!filter.userId || w.userId === filter.userId) && (!filter.status || w.status === filter.status))
      .slice(0, limit)
      .map((w) => this.toWithdrawalItem(w));
  }

  async reviewAffiliateWithdrawal(
    id: string,
    action: "approve" | "mark_paid" | "reject",
    reviewerId: string,
    reviewNote: string,
  ): Promise<AffiliateWithdrawalItem> {
    const w = this.affiliateWithdrawals.find((x) => x.id === id);
    if (!w) throw new StoreError("not_found", "Withdrawal request not found");
    if (w.kind !== "payout") throw new StoreError("bad_request", "Wallet transfers cannot be reviewed");
    return this.withAffiliateLock(w.userId, () => {
      if (action === "approve") {
        if (w.status !== "pending") throw new StoreError("conflict", `Withdrawal is already ${w.status}`);
        w.status = "approved";
      } else if (action === "mark_paid") {
        if (w.status !== "pending" && w.status !== "approved") {
          throw new StoreError("conflict", `Withdrawal is already ${w.status}`);
        }
        w.status = "paid";
        const rec = this.ensureAffiliateRecord(w.userId);
        rec.totalWithdrawnNano += w.amountNano;
        rec.updatedAtIso = new Date().toISOString();
      } else {
        if (w.status !== "pending" && w.status !== "approved") {
          throw new StoreError("conflict", `Withdrawal is already ${w.status}`);
        }
        w.status = "rejected";
        const rec = this.ensureAffiliateRecord(w.userId);
        rec.balanceNano += w.amountNano;
        rec.updatedAtIso = new Date().toISOString();
      }
      w.reviewNote = reviewNote;
      w.reviewedBy = reviewerId;
      w.reviewedAtIso = new Date().toISOString();
      return this.toWithdrawalItem(w);
    });
  }
}
