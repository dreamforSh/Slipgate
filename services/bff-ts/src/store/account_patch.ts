import type { UpdateAccountRequest } from "@slipgate/contracts";

/** How a patch changes the cooldown columns; `undefined` members leave the column untouched. */
export interface CooldownChange {
  untilIso?: string | null;
  reason?: string;
}

/** Canonical ISO form for storage; passes `undefined` / `null` through. */
export function normalizeIso(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  return new Date(value).toISOString();
}

/**
 * Explicit cooldown values win. Any explicit status change without a deadline resets the
 * cooldown, so "resume" clears it and "cooldown" without a deadline means "until resumed"
 * (a stale, already-elapsed deadline would otherwise read as active again).
 */
export function resolveCooldownChange(req: UpdateAccountRequest): CooldownChange {
  const change: CooldownChange = {};
  if (req.cooldownUntilIso !== undefined) {
    change.untilIso = normalizeIso(req.cooldownUntilIso);
  } else if (req.status !== undefined) {
    change.untilIso = null;
  }
  if (req.cooldownReason !== undefined) {
    change.reason = req.cooldownReason;
  } else if (req.status !== undefined) {
    change.reason = "";
  }
  return change;
}
