import type {
  AdminApiKeyItem,
  CreateAdminApiKeyRequest,
  CreateUserAttributeRequest,
  UpdateUserAttributeRequest,
  UserAttributeDefinition,
  UserAttributeValueItem,
} from "@slipgate/contracts";
import { StoreError } from "./types.ts";

export interface AdminApiKeyLookupRecord {
  id: string;
  userId: string;
  name: string;
  keyPrefix: string;
  expiresAtIso: string | null;
  revokedAtIso: string | null;
}

export interface UserAttributesStore {
  listDefinitions(options?: { onlyEnabled?: boolean }): Promise<UserAttributeDefinition[]>;
  createDefinition(input: CreateUserAttributeRequest): Promise<UserAttributeDefinition>;
  updateDefinition(id: string, input: UpdateUserAttributeRequest): Promise<UserAttributeDefinition>;
  deleteDefinition(id: string): Promise<void>;

  listUserValues(userId: string, options?: { onlyEnabled?: boolean }): Promise<UserAttributeValueItem[]>;
  setUserValues(
    userId: string,
    values: Record<string, string>,
    options?: { isAdmin?: boolean },
  ): Promise<UserAttributeValueItem[]>;

  listAdminApiKeys(userId?: string): Promise<AdminApiKeyItem[]>;
  createAdminApiKey(
    userId: string,
    input: CreateAdminApiKeyRequest,
    hashed: { keyPrefix: string; keyHash: string },
  ): Promise<AdminApiKeyItem>;
  revokeAdminApiKey(id: string, actorUserId?: string): Promise<AdminApiKeyItem>;
  findActiveAdminApiKeyByHash(keyHash: string): Promise<AdminApiKeyLookupRecord | null>;
  touchAdminApiKeyLastUsed(id: string): Promise<void>;
}

/** Validates and canonicalizes a raw user-attribute value against its definition. */
export function validateAttributeValue(def: UserAttributeDefinition, rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.length > 4000) {
    throw new StoreError("bad_request", `Attribute "${def.name}" exceeds maximum length`);
  }
  if (trimmed === "") {
    return "";
  }
  switch (def.type) {
    case "text":
      return trimmed;
    case "number": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) {
        throw new StoreError("bad_request", `Attribute "${def.name}" must be a valid number`);
      }
      return trimmed;
    }
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
      if (!m) {
        throw new StoreError("bad_request", `Attribute "${def.name}" must be an ISO date (YYYY-MM-DD)`);
      }
      const d = new Date(`${trimmed}T00:00:00Z`);
      if (
        Number.isNaN(d.getTime()) ||
        d.getUTCFullYear() !== Number(m[1]) ||
        d.getUTCMonth() + 1 !== Number(m[2]) ||
        d.getUTCDate() !== Number(m[3])
      ) {
        throw new StoreError("bad_request", `Attribute "${def.name}" must be a valid calendar date`);
      }
      return trimmed;
    }
    case "url": {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("bad protocol");
        }
        return parsed.toString();
      } catch {
        throw new StoreError("bad_request", `Attribute "${def.name}" must be a valid http/https URL`);
      }
    }
    case "select": {
      if (!def.options.includes(trimmed)) {
        throw new StoreError("bad_request", `Attribute "${def.name}" must be one of the configured options`);
      }
      return trimmed;
    }
    case "multiselect": {
      let arr: unknown;
      try {
        arr = JSON.parse(trimmed);
      } catch {
        throw new StoreError("bad_request", `Attribute "${def.name}" must be a JSON array of options`);
      }
      if (!Array.isArray(arr) || !arr.every((v) => typeof v === "string")) {
        throw new StoreError("bad_request", `Attribute "${def.name}" must be a JSON array of strings`);
      }
      const allowed = new Set(def.options);
      const unique: string[] = [];
      for (const item of arr) {
        const s = item.trim();
        if (!allowed.has(s)) {
          throw new StoreError("bad_request", `Attribute "${def.name}" contains an unknown option: ${s}`);
        }
        if (!unique.includes(s)) unique.push(s);
      }
      return unique.length > 0 ? JSON.stringify(unique) : "";
    }
  }
}
