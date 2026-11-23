import {
  newInstanceId,
  type PaymentInstanceInput,
  type PaymentInstanceRecord,
  type PaymentInstanceStore,
} from "./payment_providers_types.ts";
import { StoreError } from "./types.ts";

const bySortOrder = (a: PaymentInstanceRecord, b: PaymentInstanceRecord) =>
  a.sortOrder - b.sortOrder || (a.createdAtIso < b.createdAtIso ? -1 : a.createdAtIso > b.createdAtIso ? 1 : a.id < b.id ? -1 : 1);

/** In-memory provider instances; `openOrders` counts the orders that still need an instance. */
export class MemoryPaymentInstanceStore implements PaymentInstanceStore {
  private readonly rows = new Map<string, PaymentInstanceRecord>();

  constructor(private readonly openOrders: (instanceId: string) => number) {}

  /** Name lookup for order rows (null once the instance was deleted). */
  nameOf(id: string | null): string | null {
    return id ? (this.rows.get(id)?.name ?? null) : null;
  }

  async listInstances() {
    return Array.from(this.rows.values())
      .sort(bySortOrder)
      .map((r) => structuredClone(r));
  }

  async getInstance(id: string) {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }

  async createInstance(input: PaymentInstanceInput) {
    const now = new Date().toISOString();
    const rec: PaymentInstanceRecord = { ...structuredClone(input), id: newInstanceId(), createdAtIso: now, updatedAtIso: now };
    this.rows.set(rec.id, rec);
    return structuredClone(rec);
  }

  async updateInstance(id: string, input: PaymentInstanceInput) {
    const rec = this.rows.get(id);
    if (!rec) throw new StoreError("not_found", "Payment provider not found");
    // The provider of an instance never changes (its orders and credentials depend on it).
    Object.assign(rec, structuredClone(input), { provider: rec.provider, updatedAtIso: new Date().toISOString() });
    return structuredClone(rec);
  }

  async deleteInstance(id: string) {
    if (!this.rows.has(id)) throw new StoreError("not_found", "Payment provider not found");
    const open = this.openOrders(id);
    if (open > 0) {
      throw new StoreError("conflict", `This provider still has ${open} open order(s); disable it instead and delete it once they are settled`);
    }
    this.rows.delete(id);
  }

  async countOpenOrders(id: string) {
    return this.openOrders(id);
  }

  async reorderInstances(ids: string[]) {
    let order = 10;
    const now = new Date().toISOString();
    for (const id of new Set(ids)) {
      const rec = this.rows.get(id);
      if (!rec) continue;
      rec.sortOrder = order;
      rec.updatedAtIso = now;
      order += 10;
    }
  }
}
