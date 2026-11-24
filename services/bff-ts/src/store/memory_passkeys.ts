import type { PasskeyItem } from "@slipgate/contracts";
import type { CreatePasskeyInput, PasskeyStore, StoredPasskeyRecord } from "./passkeys_types.ts";
import { StoreError } from "./types.ts";

function toItem(r: StoredPasskeyRecord): PasskeyItem {
  return {
    id: r.id,
    credentialId: r.credentialId,
    deviceName: r.deviceName,
    transports: [...r.transports],
    backedUp: r.backedUp,
    lastUsedAtIso: r.lastUsedAtIso,
    createdAtIso: r.createdAtIso,
  };
}

export class MemoryPasskeyStore implements PasskeyStore {
  private readonly items = new Map<string, StoredPasskeyRecord>();

  async listByUser(userId: string): Promise<PasskeyItem[]> {
    return Array.from(this.items.values())
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso))
      .map(toItem);
  }

  async listAuthCredentials(userId?: string): Promise<StoredPasskeyRecord[]> {
    return Array.from(this.items.values())
      .filter((r) => !userId || r.userId === userId)
      .map((r) => ({ ...r, transports: [...r.transports], publicKeySpki: new Uint8Array(r.publicKeySpki) }));
  }

  async findByCredentialId(credentialId: string): Promise<StoredPasskeyRecord | null> {
    for (const r of this.items.values()) {
      if (r.credentialId === credentialId) {
        return { ...r, transports: [...r.transports], publicKeySpki: new Uint8Array(r.publicKeySpki) };
      }
    }
    return null;
  }

  async create(input: CreatePasskeyInput): Promise<PasskeyItem> {
    for (const r of this.items.values()) {
      if (r.credentialId === input.credentialId) {
        throw new StoreError("conflict", "This passkey is already registered");
      }
    }
    const rec: StoredPasskeyRecord = {
      id: `pk_${crypto.randomUUID()}`,
      userId: input.userId,
      credentialId: input.credentialId,
      publicKeySpki: new Uint8Array(input.publicKeySpki),
      algorithm: input.algorithm,
      signCount: input.signCount,
      transports: [...input.transports],
      deviceName: input.deviceName,
      backedUp: input.backedUp,
      lastUsedAtIso: null,
      createdAtIso: new Date().toISOString(),
    };
    this.items.set(rec.id, rec);
    return toItem(rec);
  }

  async rename(userId: string, passkeyId: string, deviceName: string): Promise<PasskeyItem> {
    const rec = this.items.get(passkeyId);
    if (!rec || rec.userId !== userId) throw new StoreError("not_found", "Passkey not found");
    rec.deviceName = deviceName;
    return toItem(rec);
  }

  async delete(userId: string, passkeyId: string): Promise<boolean> {
    const rec = this.items.get(passkeyId);
    if (!rec || rec.userId !== userId) return false;
    return this.items.delete(passkeyId);
  }

  async touchUsage(passkeyId: string, signCount: number, backedUp: boolean): Promise<void> {
    const rec = this.items.get(passkeyId);
    if (!rec) return;
    rec.signCount = signCount;
    rec.backedUp = backedUp;
    rec.lastUsedAtIso = new Date().toISOString();
  }
}
