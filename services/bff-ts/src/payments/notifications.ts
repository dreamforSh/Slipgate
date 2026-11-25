import { PAYMENT_NOTIFICATION_MAX_ATTEMPTS, type PaymentNotification } from "@slipgate/contracts";
import type { PluginContext, PluginRegistry } from "@slipgate/plugin-sdk";
import { paymentEventId, type PaymentEventDelivery, type PaymentEventRecord, type PaymentsStore } from "../store/payments_types.ts";
import { StoreError } from "../store/types.ts";

/**
 * Payment notification delivery. A paid order's `payment.settled` event is written by
 * fulfillOrder in the transaction that marks the order paid, so a crash or a failing plugin can
 * no longer lose it. Each subscribed plugin is delivered on its own: a failure is retried with
 * backoff (PAYMENT_NOTIFICATION_MAX_ATTEMPTS, then the event waits for a manual replay) without
 * holding back or repeating the plugins that already have it. Replaying only re-sends the
 * notification: the order's delivery, credit and rebates are never touched here.
 */

/** Wait before automatic attempt n+1 (the last value repeats). */
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000];

export interface PaymentNotifierDeps {
  payments: PaymentsStore;
  registry: PluginRegistry;
  context: () => Omit<PluginContext, "config">;
  now?: () => number;
}

export class PaymentNotifier {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: PaymentNotifierDeps) {}

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Delivers one order's notification to the plugins that are due (after fulfilment, or a duplicate callback). */
  async dispatchOrder(orderId: string): Promise<PaymentNotification | null> {
    const [event] = await this.deps.payments.listPaymentEvents({ orderId, limit: 1 });
    if (!event) return null;
    return toNotification(await this.dispatch(event));
  }

  /** Delivers every due notification (the periodic sweep). */
  async dispatchDue(limit = 50): Promise<number> {
    const due = await this.deps.payments.listPaymentEvents({ dueBeforeIso: new Date(this.nowMs()).toISOString(), limit });
    for (const event of due) await this.dispatch(event);
    return due.length;
  }

  /** Re-arms one plugin (or all) and delivers again; the order itself is not touched. */
  async replay(orderId: string, plugin?: string): Promise<PaymentNotification> {
    const [event] = await this.deps.payments.listPaymentEvents({ orderId, limit: 1 });
    if (!event) throw new StoreError("not_found", "This order has no payment notification");
    const targets = plugin ? [plugin] : Array.from(new Set([...Object.keys(event.deliveries), ...this.deps.registry.paymentSubscribers()]));
    for (const name of targets) {
      event.deliveries[name] = { status: "pending", attempts: 0, lastError: null, nextAttemptAtIso: null, deliveredAtIso: null };
    }
    event.status = "pending";
    event.nextRetryAtIso = new Date(this.nowMs()).toISOString();
    await this.deps.payments.savePaymentEvent(event);
    return toNotification(await this.dispatch(event, true));
  }

  async list(query: { status?: PaymentEventRecord["status"]; orderId?: string; limit: number }): Promise<PaymentNotification[]> {
    return (await this.deps.payments.listPaymentEvents(query)).map(toNotification);
  }

  private async dispatch(event: PaymentEventRecord, force = false): Promise<PaymentEventRecord> {
    if (this.inFlight.has(event.id)) return event;
    this.inFlight.add(event.id);
    try {
      const nowMs = this.nowMs();
      const order = await this.deps.payments.getOrder(event.orderId);
      const subscribers = this.deps.registry.paymentSubscribers();
      if (order) {
        const payload = { orderId: order.id, userId: order.userId, provider: order.provider, amountNanoUsd: order.creditNanoUsd };
        for (const name of subscribers) {
          const d = event.deliveries[name] ?? { status: "pending", attempts: 0, lastError: null, nextAttemptAtIso: null, deliveredAtIso: null };
          if (d.status === "delivered" || d.attempts >= PAYMENT_NOTIFICATION_MAX_ATTEMPTS) continue;
          if (!force && d.nextAttemptAtIso && Date.parse(d.nextAttemptAtIso) > nowMs) continue;
          event.deliveries[name] = await this.deliver(name, payload, d, nowMs);
        }
      }
      settle(event, order ? subscribers : [], nowMs);
      await this.deps.payments.savePaymentEvent(event);
      return event;
    } finally {
      this.inFlight.delete(event.id);
    }
  }

  private async deliver(
    name: string,
    payload: { orderId: string; userId: string; provider: string; amountNanoUsd: string },
    d: PaymentEventDelivery,
    nowMs: number,
  ): Promise<PaymentEventDelivery> {
    try {
      await this.deps.registry.deliverPaymentSettled({ ...this.deps.context() }, payload, name);
      return { status: "delivered", attempts: d.attempts + 1, lastError: null, nextAttemptAtIso: null, deliveredAtIso: new Date(nowMs).toISOString() };
    } catch (err) {
      const attempts = d.attempts + 1;
      const waitMs = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
      return {
        status: "failed",
        attempts,
        lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        nextAttemptAtIso: attempts >= PAYMENT_NOTIFICATION_MAX_ATTEMPTS ? null : new Date(nowMs + waitMs).toISOString(),
        deliveredAtIso: null,
      };
    }
  }
}

/**
 * The event's own status from its subscribers' deliveries: dispatched once every current
 * subscriber has it (or there is none / the order is gone), dead_letter when what is left has run
 * out of attempts, else pending until the earliest retry.
 */
function settle(event: PaymentEventRecord, subscribers: string[], nowMs: number): void {
  const open = subscribers.map((n) => event.deliveries[n]).filter((d): d is PaymentEventDelivery => !!d && d.status !== "delivered");
  const missing = subscribers.some((n) => !event.deliveries[n]);
  event.attempts = Object.values(event.deliveries).reduce((sum, d) => sum + d.attempts, 0);
  if (open.length === 0 && !missing) {
    event.status = "dispatched";
    event.dispatchedAtIso ??= new Date(nowMs).toISOString();
    event.nextRetryAtIso = new Date(nowMs).toISOString();
    return;
  }
  const retries = open.filter((d) => d.attempts < PAYMENT_NOTIFICATION_MAX_ATTEMPTS && d.nextAttemptAtIso).map((d) => Date.parse(d.nextAttemptAtIso!));
  if (retries.length === 0 && !missing) {
    event.status = "dead_letter";
    event.nextRetryAtIso = new Date(nowMs).toISOString();
    return;
  }
  event.status = "pending";
  event.nextRetryAtIso = new Date(missing ? nowMs : Math.min(...retries)).toISOString();
}

export function toNotification(e: PaymentEventRecord): PaymentNotification {
  return {
    id: e.id,
    orderId: e.orderId,
    status: e.status,
    attempts: e.attempts,
    nextRetryAtIso: e.status === "pending" ? e.nextRetryAtIso : null,
    createdAtIso: e.createdAtIso,
    dispatchedAtIso: e.dispatchedAtIso,
    deliveries: Object.entries(e.deliveries)
      .map(([plugin, d]) => ({ plugin, ...d }))
      .sort((a, b) => a.plugin.localeCompare(b.plugin)),
  };
}

export { paymentEventId };
