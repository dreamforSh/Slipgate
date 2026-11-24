import type {
  AffiliateAccountItem,
  AffiliateRebateItem,
  AffiliateWithdrawalItem,
  AffiliateWithdrawalStatus,
  OrderListQuery,
  PaymentCheckout,
  PaymentCurrency,
  PaymentDashboard,
  PaymentOrderItem,
  PaymentPlan,
  PaymentPlanKind,
  PaymentProvider,
} from "@slipgate/contracts";
import type { PaymentInstanceStore } from "./payment_providers_types.ts";

export interface PlanInput {
  name: string;
  description: string;
  kind: PaymentPlanKind;
  priceMinor: number;
  currency: PaymentCurrency;
  creditNano: bigint;
  groupId: string | null;
  validityDays: number | null;
  badge: string;
  enabled: boolean;
  sortOrder: number;
}

export interface OrderInput {
  userId: string;
  kind: PaymentPlanKind;
  planId: string | null;
  planName: string;
  provider: PaymentProvider;
  method: string | null;
  amountMinor: number;
  currency: PaymentCurrency;
  creditNano: bigint;
  groupId: string | null;
  validityDays: number | null;
  expiresAtIso: string;
  /** Provider instance chosen by the load balancer; null = the built-in EasyPay / Stripe block or manual. */
  providerInstanceId?: string | null;
  /** Atomic cap checks enforced inside createOrder so concurrent requests cannot pierce pending or daily limits. */
  maxPendingOrders?: number;
  merchantUsageKey?: string | null;
  merchantDailyLimitMinor?: number;
  dayStartIso?: string;
}

/** What the gateway handed back for a new order (see PaymentOrderItem.checkout). */
export interface OrderPaymentPatch {
  payUrl: string | null;
  qrCode: string | null;
  checkout: PaymentCheckout | null;
  /** Kept when null. */
  providerTradeNo: string | null;
}

export interface RefundInput {
  /** Fiat minor units, 1..order amount. */
  amountMinor: number;
  reason: string;
  /** Take back the same share of what the order delivered (balance or subscription days). */
  reclaim: boolean;
  /** Accept a balance smaller than the share to reclaim (only what is there is taken). */
  force: boolean;
}

export type BeginRefundResult =
  | { order: PaymentOrderItem; requiresForce?: undefined }
  | { order?: undefined; requiresForce: { balanceNano: bigint; reclaimNano: bigint } };

/** Statuses an admin refund may start from (refund_pending = re-send or settle a stuck one). */
export const REFUNDABLE_STATUSES = ["paid", "partially_refunded", "refund_requested", "refund_failed", "refund_pending"] as const;

export interface RebatePolicy {
  enabled: boolean;
  /** Basis points of the credited balance paid to the payer's referrer. */
  bps: number;
  /** Where top-up rebates are credited: user's main API wallet or dedicated commission pool. */
  creditMode?: "wallet" | "commission_pool";
}

export interface FulfillResult {
  order: PaymentOrderItem;
  /** True when this call marked the order paid; false for a duplicate notification. */
  fulfilled: boolean;
  /**
   * True when this call delivered the balance or subscription (first payment, or a retry of a
   * delivery that failed earlier). A paid order that still cannot be delivered carries
   * `order.deliveryError` instead.
   */
  delivered: boolean;
}

/**
 * Payment persistence: plans, orders and their fulfilment (balance credit or subscription
 * grant plus the referrer's rebate, all in one transaction), the admin dashboard and the
 * provider configuration blob (secrets arrive already encrypted by the BFF).
 */
export interface PaymentsStore {
  /** Provider instances (merchant accounts) the load balancer picks from. */
  readonly instances: PaymentInstanceStore;

  getConfigBlob(): Promise<Record<string, unknown> | null>;
  saveConfigBlob(blob: Record<string, unknown>): Promise<void>;

  /**
   * `includeDisabled` = the admin view (every plan). The purchase view (false) lists enabled
   * plans that can be delivered: a subscription plan whose group was deleted or switched to
   * balance billing is left out.
   */
  listPlans(includeDisabled: boolean): Promise<PaymentPlan[]>;
  getPlan(id: string): Promise<PaymentPlan | null>;
  createPlan(input: PlanInput): Promise<PaymentPlan>;
  updatePlan(id: string, input: PlanInput): Promise<PaymentPlan>;
  deletePlan(id: string): Promise<void>;

  /** Subscription orders are refused (conflict) unless their group exists and is subscription-billed. */
  createOrder(input: OrderInput): Promise<PaymentOrderItem>;
  setOrderPayment(id: string, patch: OrderPaymentPatch): Promise<void>;
  getOrder(id: string): Promise<PaymentOrderItem | null>;
  listOrders(query: OrderListQuery): Promise<{ items: PaymentOrderItem[]; total: number }>;
  countPendingOrders(userId: string): Promise<number>;
  /**
   * Idempotent: marks a pending/expired order paid and delivers it exactly once. Money that
   * arrived is never refused: when a subscription order's group is gone or no longer
   * subscription-billed the order is still marked paid, with `deliveryError` set, and a later
   * call retries the delivery.
   */
  fulfillOrder(id: string, providerTradeNo: string | null, rebate: RebatePolicy): Promise<FulfillResult>;
  /** Pending orders only; `userId` restricts to the owner. */
  cancelOrder(id: string, userId?: string): Promise<PaymentOrderItem>;
  /**
   * A full, record-only refund of a paid or refund_requested order (beginRefund + completeRefund
   * with force): reverses the referrer's rebate and, with `reclaim`, takes back what was
   * delivered.
   */
  refundOrder(id: string, reclaim: boolean): Promise<PaymentOrderItem>;

  /**
   * Today's order volume per instance and channel type, fiat minor units: keys are
   * `<instance id>|<type>` (`builtin:<provider>|<type>` for the built-in blocks), the type being
   * the EasyPay method or the provider. Counts unexpired pending orders and paid ones not fully
   * refunded, created since `sinceIso`.
   */
  instanceUsage(sinceIso: string): Promise<Record<string, number>>;

  /**
   * The payer asks for a paid top-up to be refunded: paid recharge orders of `userId` only, and
   * only while their available balance still covers what the order credited (conflict
   * otherwise). Moves the order to refund_requested with the time and reason.
   */
  requestRefund(id: string, userId: string, reason: string): Promise<PaymentOrderItem>;
  /** refund_requested or refund_failed back to paid (the refund fields are cleared). */
  rejectRefund(id: string): Promise<PaymentOrderItem>;
  /**
   * Claims a refund (status in REFUNDABLE_STATUSES → refund_pending) and records its amount,
   * reason and options; nothing is taken back yet. When `reclaim` would take more than the
   * payer's available balance and `force` is off, nothing changes and `requiresForce` says by
   * how much.
   */
  beginRefund(id: string, input: RefundInput): Promise<BeginRefundResult>;
  /** Records the gateway's refund id and/or a transient error; the order stays refund_pending. */
  noteRefundPending(id: string, providerRefundId: string | null, error: string | null): Promise<PaymentOrderItem>;
  /**
   * Settles a refund_pending order in one transaction: the referrer's rebate is reversed in
   * proportion (`rebate-refund:<order>`) and, when the refund reclaims, the same share of the
   * credited balance (`refund:<order>`, at most the available balance) or of the subscription
   * days is taken back. Status becomes refunded or partially_refunded.
   */
  completeRefund(id: string, providerRefundId: string | null): Promise<PaymentOrderItem>;
  /**
   * What a provider refund notification reconciles against: the refunded total committed so far
   * (a pending or failed attempt not included) and the provider refund ids already applied.
   * completeRefund records its providerRefundId there, and completing an already applied refund
   * again (its notification and its own gateway answer, or a redelivery) is a no-op.
   */
  getRefundLedger(id: string): Promise<{ committedMinor: number; appliedRefundIds: string[] } | null>;
  /** refund_pending → refund_failed with the gateway's error; nothing was taken back. */
  failRefund(id: string, error: string): Promise<PaymentOrderItem>;

  /**
   * Work for the sweeper, oldest first: `expired` = pending orders past their deadline,
   * `refund_pending` = refunds awaiting the gateway (last touched more than a minute ago).
   */
  listDueOrders(kind: "expired" | "refund_pending", limit: number): Promise<PaymentOrderItem[]>;
  /** Persists `expired` for a pending order past its deadline; false when it changed meanwhile. */
  markOrderExpired(id: string): Promise<boolean>;

  dashboard(days: number, currency: PaymentCurrency): Promise<PaymentDashboard>;
  listRebates(beneficiaryId: string | null, limit: number): Promise<AffiliateRebateItem[]>;
  rebateTotal(beneficiaryId: string): Promise<bigint>;

  /* ---- Affiliate accounts, custom rates, wallet transfers & withdrawals (Lane C3) ---- */
  getAffiliateAccount(userId: string, defaultBps: number): Promise<AffiliateAccountItem>;
  listAffiliateAccounts(defaultBps: number, search?: string): Promise<AffiliateAccountItem[]>;
  setAffiliateCustomRate(userId: string, customRebateBps: number | null, defaultBps: number): Promise<AffiliateAccountItem>;
  transferAffiliateToWallet(
    userId: string,
    amountNano: bigint,
  ): Promise<{ withdrawal: AffiliateWithdrawalItem; affiliateBalanceNanoUsd: string; walletBalanceNanoUsd: string }>;
  requestAffiliateWithdrawal(
    userId: string,
    amountNano: bigint,
    payoutMethod: string,
    payoutAccount: string,
    notes: string,
  ): Promise<AffiliateWithdrawalItem>;
  listAffiliateWithdrawals(filter: {
    userId?: string;
    status?: AffiliateWithdrawalStatus;
    limit?: number;
  }): Promise<AffiliateWithdrawalItem[]>;
  reviewAffiliateWithdrawal(
    id: string,
    action: "approve" | "mark_paid" | "reject",
    reviewerId: string,
    reviewNote: string,
  ): Promise<AffiliateWithdrawalItem>;
}
