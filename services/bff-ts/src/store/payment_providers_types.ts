import type { PaymentChannelLimit, PaymentInstanceProvider } from "@slipgate/contracts";

/**
 * A stored payment provider instance (one merchant account of a gateway). `credentialsEnc` is the
 * AES-GCM (vault secret) ciphertext, hex, of the JSON map of its write-only secrets; it never
 * leaves the BFF.
 */
export interface PaymentInstanceRecord {
  id: string;
  provider: PaymentInstanceProvider;
  name: string;
  enabled: boolean;
  sortOrder: number;
  supportedTypes: string[];
  paymentMode: string;
  refundEnabled: boolean;
  allowUserRefund: boolean;
  limits: Record<string, PaymentChannelLimit>;
  config: Record<string, unknown>;
  credentialsEnc: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export type PaymentInstanceInput = Omit<PaymentInstanceRecord, "id" | "createdAtIso" | "updatedAtIso">;

/** Order statuses that still need their instance's credentials (callbacks, queries, refunds). */
export const OPEN_INSTANCE_ORDER_STATUSES = ["pending", "refund_requested", "refund_pending", "refund_failed"] as const;

export interface PaymentInstanceStore {
  /** Every instance, by sortOrder then creation. */
  listInstances(): Promise<PaymentInstanceRecord[]>;
  getInstance(id: string): Promise<PaymentInstanceRecord | null>;
  createInstance(input: PaymentInstanceInput): Promise<PaymentInstanceRecord>;
  /** Replaces every field (the route merges a partial update first). */
  updateInstance(id: string, input: PaymentInstanceInput): Promise<PaymentInstanceRecord>;
  /** Refused (conflict) while orders in OPEN_INSTANCE_ORDER_STATUSES reference the instance. */
  deleteInstance(id: string): Promise<void>;
  /** Orders in OPEN_INSTANCE_ORDER_STATUSES that reference the instance. */
  countOpenOrders(id: string): Promise<number>;
  /** sortOrder becomes 10, 20, … in the given order; unknown ids are ignored. */
  reorderInstances(ids: string[]): Promise<void>;
}

export function newInstanceId(): string {
  // Letters and digits only: the id travels in the WeChat OAuth `state` (a-zA-Z0-9, ≤128 bytes).
  return `ppi${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}
