import {
  AnnouncementTargetingSchema,
  type AnnouncementAudience,
  type AnnouncementCondition,
  type AnnouncementTargeting,
} from "@slipgate/contracts";
import type {
  RedeemCodeStatus,
  SubscriptionLimits,
  SubscriptionUsage,
  UsageSummary,
  UserRole,
  UserSubscriptionStatus,
} from "@slipgate/contracts";

export const DAY_MS = 86_400_000;
export const SUBSCRIPTION_WINDOWS_MS = { daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 30 * DAY_MS } as const;

/** Stored redeem state plus expiry → what an admin or user sees. */
export function effectiveRedeemStatus(
  stored: "unused" | "used" | "disabled",
  expiresAtIso: string | null,
  nowMs = Date.now(),
): RedeemCodeStatus {
  if (stored === "unused" && expiresAtIso && Date.parse(expiresAtIso) <= nowMs) return "expired";
  return stored;
}

export function effectiveSubscriptionStatus(
  stored: "active" | "revoked",
  expiresAtIso: string,
  nowMs = Date.now(),
): UserSubscriptionStatus {
  if (stored === "revoked") return "revoked";
  return Date.parse(expiresAtIso) <= nowMs ? "expired" : "active";
}

/** True when any non-zero cap is reached. */
export function subscriptionOverLimit(limits: SubscriptionLimits, usage: SubscriptionUsage): boolean {
  const pairs: [string, string][] = [
    [limits.dailyLimitNanoUsd, usage.dailyNanoUsd],
    [limits.weeklyLimitNanoUsd, usage.weeklyNanoUsd],
    [limits.monthlyLimitNanoUsd, usage.monthlyNanoUsd],
  ];
  return pairs.some(([limit, used]) => {
    const cap = BigInt(limit);
    return cap > 0n && BigInt(used) >= cap;
  });
}

export function audienceMatches(audience: AnnouncementAudience, role: UserRole): boolean {
  if (audience === "all") return true;
  return audience === "admins" ? role === "admin" : role === "user";
}

/**
 * Whether an account with this wallet balance and these active subscription groups meets the
 * announcement's targeting (Linksyncx Targeting.Matches): no groups = no restriction; otherwise an
 * OR across groups, an AND inside each. A group without conditions never matches, so a damaged
 * rule hides the announcement rather than showing it to everyone.
 */
export function targetingMatches(targeting: AnnouncementTargeting, balanceNano: bigint, activeGroupIds: ReadonlySet<string>): boolean {
  if (targeting.anyOf.length === 0) return true;
  return targeting.anyOf.some((group) => group.allOf.length > 0 && group.allOf.every((c) => conditionMatches(c, balanceNano, activeGroupIds)));
}

function conditionMatches(c: AnnouncementCondition, balanceNano: bigint, activeGroupIds: ReadonlySet<string>): boolean {
  if (c.type === "subscription") return c.operator === "in" && c.groupIds.some((id) => activeGroupIds.has(id));
  if (c.type !== "balance") return false;
  let value: bigint;
  try {
    value = BigInt(c.valueNanoUsd);
  } catch {
    return false;
  }
  switch (c.operator) {
    case "gt":
      return balanceNano > value;
    case "gte":
      return balanceNano >= value;
    case "lt":
      return balanceNano < value;
    case "lte":
      return balanceNano <= value;
    case "eq":
      return balanceNano === value;
    default:
      return false;
  }
}

/** Live announcements one feed / mark-read call considers (newest first) before targeting narrows them. */
export const ANNOUNCEMENT_FEED_CANDIDATES = 500;

/** True when the rule needs the account's balance or subscriptions (non-empty targeting). */
export function targetingRestricts(targeting: AnnouncementTargeting): boolean {
  return targeting.anyOf.length > 0;
}

/**
 * A stored targeting document → typed rule. `{}` / null (older rows) = no restriction; anything
 * that no longer parses becomes one empty group, which matches nobody (fail closed) and shows up
 * as an empty group in the editor.
 */
export function storedTargeting(raw: unknown): AnnouncementTargeting {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { anyOf: [{ allOf: [] }] };
    }
  }
  if (value === null || value === undefined) return { anyOf: [] };
  const parsed = AnnouncementTargetingSchema.safeParse(value);
  return parsed.success ? parsed.data : { anyOf: [{ allOf: [] }] };
}

export function announcementLive(startsAtIso: string | null, endsAtIso: string | null, nowMs = Date.now()): boolean {
  if (startsAtIso && Date.parse(startsAtIso) > nowMs) return false;
  if (endsAtIso && Date.parse(endsAtIso) <= nowMs) return false;
  return true;
}

export function emptyUsageSummary(): UsageSummary {
  return {
    requests: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costNanoUsd: "0",
    avgDurationMs: 0,
    avgTtftMs: 0,
  };
}

/** Case-insensitive LIKE-style escape for user search text (PG ILIKE patterns). */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function randomCode(length: number, alphabet = INVITE_ALPHABET): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}

/** Redeem code text: optional PREFIX-, then three blocks of 4 unambiguous characters. */
export function generateRedeemCodeText(prefix: string): string {
  const body = `${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
  return prefix ? `${prefix}-${body}` : body;
}

export function normalizeRedeemCode(code: string): string {
  return code.trim().toUpperCase();
}

export function clampPage(page: number, pageSize: number): { offset: number; limit: number } {
  const limit = Math.max(1, Math.min(200, Math.floor(pageSize)));
  const offset = (Math.max(1, Math.floor(page)) - 1) * limit;
  return { offset, limit };
}
