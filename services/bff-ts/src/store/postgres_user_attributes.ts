import type postgres from "postgres";
import {
  UserAttributeKeySchema,
  type AdminApiKeyItem,
  type CreateAdminApiKeyRequest,
  type CreateUserAttributeRequest,
  type UpdateUserAttributeRequest,
  type UserAttributeDefinition,
  type UserAttributeType,
  type UserAttributeValueItem,
} from "@slipgate/contracts";
import { StoreError } from "./types.ts";
import {
  validateAttributeValue,
  type AdminApiKeyLookupRecord,
  type UserAttributesStore,
} from "./user_attributes_types.ts";

type Sql = ReturnType<typeof postgres>;
const pgCode = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;

export const PG_USER_ATTRIBUTES_SCHEMA_SQL = `
ALTER TABLE commerce.users
    ADD COLUMN IF NOT EXISTS managed_group_ids TEXT[] NOT NULL DEFAULT '{}'::text[];

CREATE TABLE IF NOT EXISTS commerce.user_attribute_definitions (
    id          TEXT PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type        TEXT NOT NULL CHECK (type IN ('text', 'number', 'select', 'multiselect', 'date', 'url')),
    options     TEXT[] NOT NULL DEFAULT '{}'::text[],
    required    BOOLEAN NOT NULL DEFAULT FALSE,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_user_attr_defs_order
    ON commerce.user_attribute_definitions (sort_order, created_at);

CREATE TABLE IF NOT EXISTS commerce.user_attribute_values (
    user_id      TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    attribute_id TEXT NOT NULL REFERENCES commerce.user_attribute_definitions(id) ON DELETE CASCADE,
    value        TEXT NOT NULL DEFAULT '',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, attribute_id)
);

CREATE INDEX IF NOT EXISTS idx_commerce_user_attr_vals_attr
    ON commerce.user_attribute_values (attribute_id);

CREATE TABLE IF NOT EXISTS commerce.admin_api_keys (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES commerce.users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,
    key_hash     TEXT NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commerce_admin_api_keys_user
    ON commerce.admin_api_keys (user_id, created_at DESC);
`;

interface AttrDefRow {
  id: string;
  key: string;
  name: string;
  description: string;
  type: UserAttributeType;
  options: string[];
  required: boolean;
  enabled: boolean;
  sortOrder: number;
  createdAtIso: string;
  updatedAtIso: string;
}

interface AttrValueRow {
  attributeId: string;
  key: string;
  name: string;
  description: string;
  type: UserAttributeType;
  options: string[];
  required: boolean;
  enabled: boolean;
  sortOrder: number;
  value: string | null;
  updatedAtIso: string | null;
}

function toDef(r: AttrDefRow): UserAttributeDefinition {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    type: r.type,
    options: Array.isArray(r.options) ? [...r.options] : [],
    required: r.required,
    enabled: r.enabled,
    sortOrder: r.sortOrder,
    createdAtIso: r.createdAtIso,
    updatedAtIso: r.updatedAtIso,
  };
}

export class PostgresUserAttributesStore implements UserAttributesStore {
  constructor(private readonly sql: Sql) {}

  async listDefinitions(options?: { onlyEnabled?: boolean }): Promise<UserAttributeDefinition[]> {
    const rows = await this.sql<AttrDefRow[]>`
      SELECT id, key, name, description, type, options, required, enabled,
             sort_order AS "sortOrder",
             created_at::text AS "createdAtIso",
             updated_at::text AS "updatedAtIso"
        FROM commerce.user_attribute_definitions
       WHERE (${!options?.onlyEnabled}::boolean OR enabled = TRUE)
       ORDER BY sort_order ASC, created_at ASC, key ASC
    `;
    return rows.map(toDef);
  }

  async createDefinition(input: CreateUserAttributeRequest): Promise<UserAttributeDefinition> {
    const key = UserAttributeKeySchema.parse(input.key);
    const id = `attr_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    try {
      const rows = await this.sql<AttrDefRow[]>`
        INSERT INTO commerce.user_attribute_definitions
          (id, key, name, description, type, options, required, enabled, sort_order)
        VALUES
          (${id}, ${key}, ${input.name.trim()}, ${input.description.trim()}, ${input.type},
           ${input.options}, ${input.required}, ${input.enabled}, ${input.sortOrder})
        RETURNING id, key, name, description, type, options, required, enabled,
                  sort_order AS "sortOrder",
                  created_at::text AS "createdAtIso",
                  updated_at::text AS "updatedAtIso"
      `;
      return toDef(rows[0]);
    } catch (err) {
      if (pgCode(err) === "23505") {
        throw new StoreError("conflict", `Attribute key "${key}" already exists`);
      }
      throw err;
    }
  }

  async updateDefinition(id: string, input: UpdateUserAttributeRequest): Promise<UserAttributeDefinition> {
    const rows = await this.sql<AttrDefRow[]>`
      SELECT id, key, name, description, type, options, required, enabled,
             sort_order AS "sortOrder",
             created_at::text AS "createdAtIso",
             updated_at::text AS "updatedAtIso"
        FROM commerce.user_attribute_definitions
       WHERE id = ${id}
       LIMIT 1
    `;
    const existing = rows[0];
    if (!existing) throw new StoreError("not_found", `Attribute not found: ${id}`);
    const nextType = input.type ?? existing.type;
    const nextOptions = input.options !== undefined ? input.options : existing.options;
    if ((nextType === "select" || nextType === "multiselect") && nextOptions.length === 0) {
      throw new StoreError("bad_request", "Select attributes require at least one option");
    }
    const updated = await this.sql<AttrDefRow[]>`
      UPDATE commerce.user_attribute_definitions
         SET name = ${input.name !== undefined ? input.name.trim() : existing.name},
             description = ${input.description !== undefined ? input.description.trim() : existing.description},
             type = ${nextType},
             options = ${nextOptions},
             required = ${input.required !== undefined ? input.required : existing.required},
             enabled = ${input.enabled !== undefined ? input.enabled : existing.enabled},
             sort_order = ${input.sortOrder !== undefined ? input.sortOrder : existing.sortOrder},
             updated_at = NOW()
       WHERE id = ${id}
      RETURNING id, key, name, description, type, options, required, enabled,
                sort_order AS "sortOrder",
                created_at::text AS "createdAtIso",
                updated_at::text AS "updatedAtIso"
    `;
    return toDef(updated[0]);
  }

  async deleteDefinition(id: string): Promise<void> {
    const res = await this.sql`DELETE FROM commerce.user_attribute_definitions WHERE id = ${id}`;
    if (res.count === 0) {
      throw new StoreError("not_found", `Attribute not found: ${id}`);
    }
  }

  async listUserValues(
    userId: string,
    options?: { onlyEnabled?: boolean },
    tx: Sql = this.sql,
  ): Promise<UserAttributeValueItem[]> {
    const userRows = await tx<{ id: string }[]>`SELECT id FROM commerce.users WHERE id = ${userId} LIMIT 1`;
    if (!userRows[0]) {
      throw new StoreError("not_found", `User not found: ${userId}`);
    }
    const rows = await tx<AttrValueRow[]>`
      SELECT d.id AS "attributeId",
             d.key,
             d.name,
             d.description,
             d.type,
             d.options,
             d.required,
             d.enabled,
             d.sort_order AS "sortOrder",
             v.value,
             v.updated_at::text AS "updatedAtIso"
        FROM commerce.user_attribute_definitions d
        LEFT JOIN commerce.user_attribute_values v
          ON v.attribute_id = d.id AND v.user_id = ${userId}
       WHERE (${!options?.onlyEnabled}::boolean OR d.enabled = TRUE)
       ORDER BY d.sort_order ASC, d.created_at ASC, d.key ASC
    `;
    return rows.map((r) => ({
      attributeId: r.attributeId,
      key: r.key,
      name: r.name,
      description: r.description,
      type: r.type,
      options: Array.isArray(r.options) ? [...r.options] : [],
      required: r.required,
      enabled: r.enabled,
      sortOrder: r.sortOrder,
      value: r.value ?? "",
      updatedAtIso: r.updatedAtIso ?? null,
    }));
  }

  async setUserValues(
    userId: string,
    values: Record<string, string>,
    options?: { isAdmin?: boolean },
  ): Promise<UserAttributeValueItem[]> {
    return this.sql.begin(async (rawTx) => {
      const tx = rawTx as unknown as Sql;
      const userRows = await tx<{ id: string }[]>`SELECT id FROM commerce.users WHERE id = ${userId} FOR UPDATE`;
      if (!userRows[0]) {
        throw new StoreError("not_found", `User not found: ${userId}`);
      }
      const rawDefs = await tx<AttrDefRow[]>`
        SELECT id, key, name, description, type, options, required, enabled,
               sort_order AS "sortOrder",
               created_at::text AS "createdAtIso",
               updated_at::text AS "updatedAtIso"
          FROM commerce.user_attribute_definitions
      `;
      const defs = rawDefs.map(toDef);
      const defMap = new Map(defs.map((d) => [d.id, d]));

      const validated = new Map<string, string>();
      for (const [attrId, rawVal] of Object.entries(values)) {
        const def = defMap.get(attrId);
        if (!def) {
          throw new StoreError("bad_request", `Unknown attribute: ${attrId}`);
        }
        if (!options?.isAdmin && !def.enabled) {
          throw new StoreError("bad_request", `Attribute "${def.name}" is disabled`);
        }
        validated.set(attrId, validateAttributeValue(def, rawVal));
      }

      if (!options?.isAdmin) {
        const existingRows = await tx<{ attributeId: string; value: string }[]>`
          SELECT attribute_id AS "attributeId", value
            FROM commerce.user_attribute_values
           WHERE user_id = ${userId}
        `;
        const existingMap = new Map(existingRows.map((r) => [r.attributeId, r.value]));
        for (const def of defs) {
          if (!def.enabled || !def.required) continue;
          const effective = validated.has(def.id) ? validated.get(def.id)! : (existingMap.get(def.id) ?? "");
          if (effective === "") {
            throw new StoreError("bad_request", `Required attribute "${def.name}" cannot be empty`);
          }
        }
      }

      for (const [attrId, val] of validated.entries()) {
        if (val === "") {
          await tx`
            DELETE FROM commerce.user_attribute_values
             WHERE user_id = ${userId} AND attribute_id = ${attrId}
          `;
        } else {
          await tx`
            INSERT INTO commerce.user_attribute_values (user_id, attribute_id, value, updated_at)
            VALUES (${userId}, ${attrId}, ${val}, NOW())
            ON CONFLICT (user_id, attribute_id)
            DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
          `;
        }
      }

      return this.listUserValues(userId, { onlyEnabled: !options?.isAdmin }, tx);
    });
  }

  async listAdminApiKeys(userId?: string): Promise<AdminApiKeyItem[]> {
    return this.sql<AdminApiKeyItem[]>`
      SELECT id,
             user_id AS "userId",
             name,
             key_prefix AS "keyPrefix",
             expires_at::text AS "expiresAtIso",
             last_used_at::text AS "lastUsedAtIso",
             revoked_at::text AS "revokedAtIso",
             created_at::text AS "createdAtIso"
        FROM commerce.admin_api_keys
       WHERE (${userId ?? null}::text IS NULL OR user_id = ${userId ?? null})
       ORDER BY created_at DESC
    `;
  }

  async createAdminApiKey(
    userId: string,
    input: CreateAdminApiKeyRequest,
    hashed: { keyPrefix: string; keyHash: string },
  ): Promise<AdminApiKeyItem> {
    const userRows = await this.sql<{ id: string }[]>`SELECT id FROM commerce.users WHERE id = ${userId} LIMIT 1`;
    if (!userRows[0]) throw new StoreError("not_found", `User not found: ${userId}`);
    const id = `admkey_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const expiresAt =
      input.expiresInDays && input.expiresInDays > 0
        ? new Date(Date.now() + input.expiresInDays * 86_400_000).toISOString()
        : null;
    const rows = await this.sql<AdminApiKeyItem[]>`
      INSERT INTO commerce.admin_api_keys (id, user_id, name, key_prefix, key_hash, expires_at)
      VALUES (${id}, ${userId}, ${input.name.trim()}, ${hashed.keyPrefix}, ${hashed.keyHash}, ${expiresAt}::timestamptz)
      RETURNING id,
                user_id AS "userId",
                name,
                key_prefix AS "keyPrefix",
                expires_at::text AS "expiresAtIso",
                last_used_at::text AS "lastUsedAtIso",
                revoked_at::text AS "revokedAtIso",
                created_at::text AS "createdAtIso"
    `;
    return rows[0];
  }

  async revokeAdminApiKey(id: string, actorUserId?: string): Promise<AdminApiKeyItem> {
    const rows = await this.sql<AdminApiKeyItem[]>`
      UPDATE commerce.admin_api_keys
         SET revoked_at = COALESCE(revoked_at, NOW())
       WHERE id = ${id}
         AND (${actorUserId ?? null}::text IS NULL OR user_id = ${actorUserId ?? null})
      RETURNING id,
                user_id AS "userId",
                name,
                key_prefix AS "keyPrefix",
                expires_at::text AS "expiresAtIso",
                last_used_at::text AS "lastUsedAtIso",
                revoked_at::text AS "revokedAtIso",
                created_at::text AS "createdAtIso"
    `;
    if (!rows[0]) {
      throw new StoreError("not_found", `Admin API key not found: ${id}`);
    }
    return rows[0];
  }

  async findActiveAdminApiKeyByHash(keyHash: string): Promise<AdminApiKeyLookupRecord | null> {
    const rows = await this.sql<AdminApiKeyLookupRecord[]>`
      SELECT id,
             user_id AS "userId",
             name,
             key_prefix AS "keyPrefix",
             expires_at::text AS "expiresAtIso",
             revoked_at::text AS "revokedAtIso"
        FROM commerce.admin_api_keys
       WHERE key_hash = ${keyHash}
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
       LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async touchAdminApiKeyLastUsed(id: string): Promise<void> {
    await this.sql`
      UPDATE commerce.admin_api_keys SET last_used_at = NOW() WHERE id = ${id}
    `;
  }
}
