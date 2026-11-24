import type { PasskeyItem } from "@slipgate/contracts";

export interface StoredPasskeyRecord {
  id: string;
  userId: string;
  credentialId: string;
  publicKeySpki: Uint8Array;
  algorithm: number;
  signCount: number;
  transports: string[];
  deviceName: string;
  backedUp: boolean;
  lastUsedAtIso: string | null;
  createdAtIso: string;
}

export interface CreatePasskeyInput {
  userId: string;
  credentialId: string;
  publicKeySpki: Uint8Array;
  algorithm: number;
  signCount: number;
  transports: string[];
  deviceName: string;
  backedUp: boolean;
}

export interface PasskeyStore {
  listByUser(userId: string): Promise<PasskeyItem[]>;
  listAuthCredentials(userId?: string): Promise<StoredPasskeyRecord[]>;
  findByCredentialId(credentialId: string): Promise<StoredPasskeyRecord | null>;
  create(input: CreatePasskeyInput): Promise<PasskeyItem>;
  rename(userId: string, passkeyId: string, deviceName: string): Promise<PasskeyItem>;
  delete(userId: string, passkeyId: string): Promise<boolean>;
  touchUsage(passkeyId: string, signCount: number, backedUp: boolean): Promise<void>;
}
