import {
  UserAttributeKeySchema,
  type AdminApiKeyItem,
  type CreateAdminApiKeyRequest,
  type CreateUserAttributeRequest,
  type UpdateUserAttributeRequest,
  type UserAttributeDefinition,
  type UserAttributeValueItem,
} from "@slipgate/contracts";
import { StoreError } from "./types.ts";
import {
  validateAttributeValue,
  type AdminApiKeyLookupRecord,
  type UserAttributesStore,
} from "./user_attributes_types.ts";

function sortDefs(a: UserAttributeDefinition, b: UserAttributeDefinition): number {
  return a.sortOrder - b.sortOrder || a.createdAtIso.localeCompare(b.createdAtIso) || a.key.localeCompare(b.key);
}

interface InternalAdminApiKey extends AdminApiKeyItem {
  keyHash: string;
}

export class MemoryUserAttributesStore implements UserAttributesStore {
  private readonly defs = new Map<string, UserAttributeDefinition>();
  private readonly values = new Map<string, Map<string, { value: string; updatedAtIso: string }>>();
  private readonly adminApiKeys = new Map<string, InternalAdminApiKey>();

  constructor(private readonly deps: { hasUser: (userId: string) => boolean }) {}

  async listDefinitions(options?: { onlyEnabled?: boolean }): Promise<UserAttributeDefinition[]> {
    return Array.from(this.defs.values())
      .filter((d) => !options?.onlyEnabled || d.enabled)
      .map((d) => ({ ...d, options: [...d.options] }))
      .sort(sortDefs);
  }

  async createDefinition(input: CreateUserAttributeRequest): Promise<UserAttributeDefinition> {
    const key = UserAttributeKeySchema.parse(input.key);
    for (const d of this.defs.values()) {
      if (d.key === key) {
        throw new StoreError("conflict", `Attribute key "${key}" already exists`);
      }
    }
    const now = new Date().toISOString();
    const def: UserAttributeDefinition = {
      id: `attr_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      key,
      name: input.name.trim(),
      description: input.description.trim(),
      type: input.type,
      options: [...input.options],
      required: input.required,
      enabled: input.enabled,
      sortOrder: input.sortOrder,
      createdAtIso: now,
      updatedAtIso: now,
    };
    this.defs.set(def.id, def);
    return { ...def, options: [...def.options] };
  }

  async updateDefinition(id: string, input: UpdateUserAttributeRequest): Promise<UserAttributeDefinition> {
    const existing = this.defs.get(id);
    if (!existing) throw new StoreError("not_found", `Attribute not found: ${id}`);
    const nextType = input.type ?? existing.type;
    const nextOptions = input.options !== undefined ? [...input.options] : [...existing.options];
    if ((nextType === "select" || nextType === "multiselect") && nextOptions.length === 0) {
      throw new StoreError("bad_request", "Select attributes require at least one option");
    }
    const updated: UserAttributeDefinition = {
      ...existing,
      name: input.name !== undefined ? input.name.trim() : existing.name,
      description: input.description !== undefined ? input.description.trim() : existing.description,
      type: nextType,
      options: nextOptions,
      required: input.required !== undefined ? input.required : existing.required,
      enabled: input.enabled !== undefined ? input.enabled : existing.enabled,
      sortOrder: input.sortOrder !== undefined ? input.sortOrder : existing.sortOrder,
      updatedAtIso: new Date().toISOString(),
    };
    this.defs.set(id, updated);
    return { ...updated, options: [...updated.options] };
  }

  async deleteDefinition(id: string): Promise<void> {
    if (!this.defs.delete(id)) {
      throw new StoreError("not_found", `Attribute not found: ${id}`);
    }
    for (const userVals of this.values.values()) {
      userVals.delete(id);
    }
  }

  async listUserValues(userId: string, options?: { onlyEnabled?: boolean }): Promise<UserAttributeValueItem[]> {
    if (!this.deps.hasUser(userId)) {
      throw new StoreError("not_found", `User not found: ${userId}`);
    }
    const defs = await this.listDefinitions(options);
    const saved = this.values.get(userId);
    return defs.map((d) => {
      const entry = saved?.get(d.id);
      return {
        attributeId: d.id,
        key: d.key,
        name: d.name,
        description: d.description,
        type: d.type,
        options: [...d.options],
        required: d.required,
        enabled: d.enabled,
        sortOrder: d.sortOrder,
        value: entry?.value ?? "",
        updatedAtIso: entry?.updatedAtIso ?? null,
      };
    });
  }

  async setUserValues(
    userId: string,
    values: Record<string, string>,
    options?: { isAdmin?: boolean },
  ): Promise<UserAttributeValueItem[]> {
    if (!this.deps.hasUser(userId)) {
      throw new StoreError("not_found", `User not found: ${userId}`);
    }
    const validated = new Map<string, string>();
    for (const [attrId, rawVal] of Object.entries(values)) {
      const def = this.defs.get(attrId);
      if (!def) {
        throw new StoreError("bad_request", `Unknown attribute: ${attrId}`);
      }
      if (!options?.isAdmin && !def.enabled) {
        throw new StoreError("bad_request", `Attribute "${def.name}" is disabled`);
      }
      validated.set(attrId, validateAttributeValue(def, rawVal));
    }

    const existing = this.values.get(userId) ?? new Map<string, { value: string; updatedAtIso: string }>();
    if (!options?.isAdmin) {
      for (const def of this.defs.values()) {
        if (!def.enabled || !def.required) continue;
        const effective = validated.has(def.id) ? validated.get(def.id)! : (existing.get(def.id)?.value ?? "");
        if (effective === "") {
          throw new StoreError("bad_request", `Required attribute "${def.name}" cannot be empty`);
        }
      }
    }

    const now = new Date().toISOString();
    this.values.set(userId, existing);
    for (const [attrId, val] of validated.entries()) {
      if (val === "") {
        existing.delete(attrId);
      } else {
        existing.set(attrId, { value: val, updatedAtIso: now });
      }
    }

    return this.listUserValues(userId, { onlyEnabled: !options?.isAdmin });
  }

  async listAdminApiKeys(userId?: string): Promise<AdminApiKeyItem[]> {
    const out: AdminApiKeyItem[] = [];
    for (const item of this.adminApiKeys.values()) {
      if (userId && item.userId !== userId) continue;
      const { keyHash: _, ...pub } = item;
      out.push({ ...pub });
    }
    return out.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));
  }

  async createAdminApiKey(
    userId: string,
    input: CreateAdminApiKeyRequest,
    hashed: { keyPrefix: string; keyHash: string },
  ): Promise<AdminApiKeyItem> {
    if (!this.deps.hasUser(userId)) {
      throw new StoreError("not_found", `User not found: ${userId}`);
    }
    const nowMs = Date.now();
    const record: InternalAdminApiKey = {
      id: `admkey_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      userId,
      name: input.name.trim(),
      keyPrefix: hashed.keyPrefix,
      keyHash: hashed.keyHash,
      expiresAtIso:
        input.expiresInDays && input.expiresInDays > 0
          ? new Date(nowMs + input.expiresInDays * 86_400_000).toISOString()
          : null,
      lastUsedAtIso: null,
      revokedAtIso: null,
      createdAtIso: new Date(nowMs).toISOString(),
    };
    this.adminApiKeys.set(record.id, record);
    const { keyHash: _, ...pub } = record;
    return { ...pub };
  }

  async revokeAdminApiKey(id: string, actorUserId?: string): Promise<AdminApiKeyItem> {
    const existing = this.adminApiKeys.get(id);
    if (!existing || (actorUserId && existing.userId !== actorUserId)) {
      throw new StoreError("not_found", `Admin API key not found: ${id}`);
    }
    if (!existing.revokedAtIso) {
      existing.revokedAtIso = new Date().toISOString();
    }
    const { keyHash: _, ...pub } = existing;
    return { ...pub };
  }

  async findActiveAdminApiKeyByHash(keyHash: string): Promise<AdminApiKeyLookupRecord | null> {
    const now = Date.now();
    for (const k of this.adminApiKeys.values()) {
      if (k.keyHash !== keyHash) continue;
      if (k.revokedAtIso) return null;
      if (k.expiresAtIso && Date.parse(k.expiresAtIso) <= now) return null;
      return {
        id: k.id,
        userId: k.userId,
        name: k.name,
        keyPrefix: k.keyPrefix,
        expiresAtIso: k.expiresAtIso,
        revokedAtIso: k.revokedAtIso,
      };
    }
    return null;
  }

  async touchAdminApiKeyLastUsed(id: string): Promise<void> {
    const existing = this.adminApiKeys.get(id);
    if (existing) existing.lastUsedAtIso = new Date().toISOString();
  }
}
