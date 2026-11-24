import type postgres from "postgres";
import type { PasskeyItem } from "@slipgate/contracts";
import type { CreatePasskeyInput, PasskeyStore, StoredPasskeyRecord } from "./passkeys_types.ts";
import { StoreError } from "./types.ts";

type SqlExecutor = ReturnType<typeof postgres>;

/**
 * Idempotent DDL for WebAuthn passkeys, mirrored by migrations/commerce/0012_passkeys.sql.
 * Applied at startup by PostgresControlStore.init().
 */
export const PG_PASSKEYS_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS commerce;

  CREATE TABLE IF NOT EXISTS commerce.user_passkeys (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
      credential_id   TEXT NOT NULL UNIQUE,
      public_key_spki BYTEA NOT NULL,
      algorithm       INTEGER NOT NULL DEFAULT -7,
      sign_count      BIGINT NOT NULL DEFAULT 0,
      transports      TEXT[] NOT NULL DEFAULT '{}',
      device_name     TEXT NOT NULL DEFAULT 'Passkey',
      backed_up       BOOLEAN NOT NULL DEFAULT FALSE,
      last_used_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_commerce_user_passkeys_user
      ON commerce.user_passkeys (user_id, created_at DESC);
`;

type PasskeyRow = {
  id: string;
  user_id: string;
  credential_id: string;
  public_key_spki: Buffer;
  algorithm: number;
  sign_count: string;
  transports: string[];
  device_name: string;
  backed_up: boolean;
  last_used_at: Date | null;
  created_at: Date;
};

function toIso(val: Date | string | null | undefined): string {
  if (!val) return new Date().toISOString();
  return val instanceof Date ? val.toISOString() : new Date(val).toISOString();
}

function toPasskeyItem(r: PasskeyRow): PasskeyItem {
  return {
    id: r.id,
    credentialId: r.credential_id,
    deviceName: r.device_name,
    transports: Array.isArray(r.transports) ? r.transports : [],
    backedUp: r.backed_up,
    lastUsedAtIso: r.last_used_at ? toIso(r.last_used_at) : null,
    createdAtIso: toIso(r.created_at),
  };
}

function toStoredRecord(r: PasskeyRow): StoredPasskeyRecord {
  return {
    ...toPasskeyItem(r),
    userId: r.user_id,
    publicKeySpki: new Uint8Array(r.public_key_spki),
    algorithm: r.algorithm,
    signCount: Number.parseInt(r.sign_count, 10) || 0,
  };
}

export class PostgresPasskeyStore implements PasskeyStore {
  constructor(private readonly sql: SqlExecutor) {}

  async listByUser(userId: string): Promise<PasskeyItem[]> {
    const rows = await this.sql<PasskeyRow[]>`
      SELECT id, user_id, credential_id, public_key_spki, algorithm, sign_count::text, transports, device_name, backed_up, last_used_at, created_at
      FROM commerce.user_passkeys
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `;
    return rows.map(toPasskeyItem);
  }

  async listAuthCredentials(userId?: string): Promise<StoredPasskeyRecord[]> {
    const rows = userId
      ? await this.sql<PasskeyRow[]>`
          SELECT id, user_id, credential_id, public_key_spki, algorithm, sign_count::text, transports, device_name, backed_up, last_used_at, created_at
          FROM commerce.user_passkeys
          WHERE user_id = ${userId}
          ORDER BY created_at DESC
        `
      : await this.sql<PasskeyRow[]>`
          SELECT id, user_id, credential_id, public_key_spki, algorithm, sign_count::text, transports, device_name, backed_up, last_used_at, created_at
          FROM commerce.user_passkeys
          ORDER BY created_at DESC
          LIMIT 200
        `;
    return rows.map(toStoredRecord);
  }

  async findByCredentialId(credentialId: string): Promise<StoredPasskeyRecord | null> {
    const rows = await this.sql<PasskeyRow[]>`
      SELECT id, user_id, credential_id, public_key_spki, algorithm, sign_count::text, transports, device_name, backed_up, last_used_at, created_at
      FROM commerce.user_passkeys
      WHERE credential_id = ${credentialId}
      LIMIT 1
    `;
    return rows[0] ? toStoredRecord(rows[0]) : null;
  }

  async create(input: CreatePasskeyInput): Promise<PasskeyItem> {
    const id = `pk_${crypto.randomUUID()}`;
    try {
      const rows = await this.sql<PasskeyRow[]>`
        INSERT INTO commerce.user_passkeys (
          id, user_id, credential_id, public_key_spki, algorithm, sign_count, transports, device_name, backed_up
        )
        VALUES (
          ${id}, ${input.userId}, ${input.credentialId}, ${Buffer.from(input.publicKeySpki)},
          ${input.algorithm}, ${input.signCount}, ${this.sql.array(input.transports)},
          ${input.deviceName}, ${input.backedUp}
        )
        RETURNING id, user_id, credential_id, public_key_spki, algorithm, sign_count::text, transports, device_name, backed_up, last_used_at, created_at
      `;
      return toPasskeyItem(rows[0]!);
    } catch (err) {
      if ((err as { code?: string })?.code === "23505") {
        throw new StoreError("conflict", "This passkey is already registered");
      }
      throw err;
    }
  }

  async rename(userId: string, passkeyId: string, deviceName: string): Promise<PasskeyItem> {
    const rows = await this.sql<PasskeyRow[]>`
      UPDATE commerce.user_passkeys
      SET device_name = ${deviceName}
      WHERE id = ${passkeyId} AND user_id = ${userId}
      RETURNING id, user_id, credential_id, public_key_spki, algorithm, sign_count::text, transports, device_name, backed_up, last_used_at, created_at
    `;
    if (rows.length === 0) throw new StoreError("not_found", "Passkey not found");
    return toPasskeyItem(rows[0]!);
  }

  async delete(userId: string, passkeyId: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM commerce.user_passkeys WHERE id = ${passkeyId} AND user_id = ${userId} RETURNING id
    `;
    return rows.length > 0;
  }

  async touchUsage(passkeyId: string, signCount: number, backedUp: boolean): Promise<void> {
    await this.sql`
      UPDATE commerce.user_passkeys
      SET sign_count = ${signCount}, backed_up = ${backedUp}, last_used_at = NOW()
      WHERE id = ${passkeyId}
    `;
  }
}
