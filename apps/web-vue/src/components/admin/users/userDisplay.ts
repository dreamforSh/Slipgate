import type { AdminUserItem, UserStatus } from "@slipgate/contracts";
import { formatUsd, type Tone } from "../../../lib/format";

/** formatUsd for signed nano strings (wallets can dip below zero after settlement). */
export function formatSignedUsd(nano: string | null | undefined): string {
  const value = nano ?? "0";
  return value.startsWith("-") ? `−${formatUsd(value.slice(1))}` : formatUsd(value);
}

export const STATUS_TONE: Record<UserStatus, Tone> = {
  active: "success",
  suspended: "danger",
};

/** Name shown in rows and titles: the username, else the email's local part. */
export function displayName(user: Pick<AdminUserItem, "username" | "email">): string {
  return user.username.trim() || user.email.split("@")[0] || user.email;
}

/** One letter for the avatar bubble. */
export function initial(user: Pick<AdminUserItem, "username" | "email">): string {
  return (displayName(user).charAt(0) || "?").toUpperCase();
}

/** Stable avatar tint per user, from the semantic chip palette (never raw colors). */
const AVATAR_TONES = ["icon-chip-accent", "icon-chip-info", "icon-chip-violet", "icon-chip-success", "icon-chip-warning"];
export function avatarTone(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

/**
 * 16-character password from the browser CSPRNG with at least one lower, upper, digit and
 * symbol; ambiguous glyphs (0/O, 1/l/I) are left out so it can be read aloud.
 */
export function generatePassword(length = 16): string {
  const sets = ["abcdefghijkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!#%+-=?@_"];
  const all = sets.join("");
  const rand = new Uint32Array(length + sets.length);
  crypto.getRandomValues(rand);
  const chars = sets.map((set, i) => set[rand[i] % set.length]);
  for (let i = sets.length; i < length; i++) chars.push(all[rand[i] % all.length]);
  // Fisher–Yates so the guaranteed classes are not always up front.
  const order = new Uint32Array(chars.length);
  crypto.getRandomValues(order);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = order[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Row stagger delay, capped so long pages do not wait on the tail. */
export function staggerStyle(index: number, stepMs = 22, maxSteps = 12): { animationDelay: string } {
  return { animationDelay: `${Math.min(index, maxSteps) * stepMs}ms` };
}
