import type { ApiKeyItem } from "@slipgate/contracts";
import { nanoToUsdInput, normalizeUsdInput } from "../admin/users/money";

/** Rolling spend windows an API key can cap. */
export type WindowKey = "5h" | "1d" | "7d";
export const WINDOWS: WindowKey[] = ["5h", "1d", "7d"];

export function windowOf(item: ApiKeyItem, w: WindowKey): { used: string; limit: string } {
  switch (w) {
    case "5h":
      return { used: item.usage5hNanoUsd, limit: item.limit5hNanoUsd };
    case "1d":
      return { used: item.usage1dNanoUsd, limit: item.limit1dNanoUsd };
    default:
      return { used: item.usage7dNanoUsd, limit: item.limit7dNanoUsd };
  }
}

function big(nano: string | null | undefined): bigint {
  try {
    return BigInt(nano || "0");
  } catch {
    return 0n;
  }
}

/** True for "0", missing or malformed nano amounts (older servers omit the limit fields). */
export function isZeroNano(nano: string | null | undefined): boolean {
  return big(nano) <= 0n;
}

/** used ÷ limit as a float (can exceed 1); null when the limit is 0 (unlimited). */
export function usageRatio(used: string, limit: string): number | null {
  const l = big(limit);
  if (l <= 0n) return null;
  return Number((big(used) * 10_000n) / l) / 10_000;
}

/** Bar tone: warning from 80%, danger once the cap is reached. */
export function ratioTone(ratio: number | null): "accent" | "warning" | "danger" {
  if (ratio === null) return "accent";
  if (ratio >= 1) return "danger";
  if (ratio >= 0.8) return "warning";
  return "accent";
}

export function hasIpRules(item: ApiKeyItem): boolean {
  return item.ipAllowlist.length > 0 || (item.ipDenylist?.length ?? 0) > 0;
}

export function isExpired(item: Pick<ApiKeyItem, "expiresAtIso">, nowMs: number): boolean {
  if (!item.expiresAtIso) return false;
  const at = Date.parse(item.expiresAtIso);
  return Number.isFinite(at) && at <= nowMs;
}

/* ---------------- USD inputs ---------------- */

/** Nano-USD → the text shown in a limit input ("0" stays "0"). */
export const limitInput = (nano: string | null | undefined): string => nanoToUsdInput(nano ?? "0");

/** Normalised USD text for the API; empty means "0" (unlimited); null when invalid. */
export function usdField(text: string): string | null {
  const v = text.trim();
  if (v === "") return "0";
  return normalizeUsdInput(v);
}

/* ---------------- IP / CIDR lists ---------------- */

function isIpv4(s: string): boolean {
  const parts = s.split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIpv6(s: string): boolean {
  if (!s.includes(":") || !/^[0-9a-fA-F:.]+$/.test(s)) return false;
  let head = s;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    // Embedded IPv4 (::ffff:1.2.3.4) counts as two hextets.
    if (!isIpv4(tail)) return false;
    head = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return false;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const all = [...groups(halves[0] ?? ""), ...(halves.length === 2 ? groups(halves[1] ?? "") : [])];
  if (all.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return false;
  return halves.length === 2 ? all.length <= 7 : all.length === 8;
}

/** One IPv4/IPv6 address or CIDR block (what the contracts accept, checked properly). */
export function isValidIpOrCidr(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 64) return false;
  const [addr = "", prefix, extra] = s.split("/");
  if (extra !== undefined) return false;
  const v4 = isIpv4(addr);
  const v6 = !v4 && isIpv6(addr);
  if (!v4 && !v6) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (v4 ? 32 : 128);
}

export const IP_LIST_MAX = 200;

export interface IpListResult {
  entries: string[];
  invalid: { line: number; value: string }[];
  tooMany: boolean;
}

/** One entry per line (commas also split); blank lines and duplicates are dropped. */
export function parseIpList(text: string): IpListResult {
  const entries: string[] = [];
  const invalid: { line: number; value: string }[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((rawLine, idx) => {
    for (const piece of rawLine.split(",")) {
      const value = piece.trim();
      if (!value) continue;
      if (!isValidIpOrCidr(value)) {
        invalid.push({ line: idx + 1, value });
        continue;
      }
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(value);
    }
  });
  return { entries, invalid, tooMany: entries.length > IP_LIST_MAX };
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a.map((x) => x.toLowerCase()));
  return b.every((x) => set.has(x.toLowerCase()));
}

/* ---------------- Expiry ---------------- */

export type ExpiryPreset = "never" | "7" | "30" | "90" | "custom";
export const EXPIRY_PRESETS: ExpiryPreset[] = ["never", "7", "30", "90", "custom"];

/** ISO → value for <input type="datetime-local"> in local time (minute precision). */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type ExpiryResult = { ok: true; iso: string | null } | { ok: false; reason: "required" | "past" };

/** Resolves a preset (or a custom local datetime) to the ISO the API expects; null = never. */
export function resolveExpiry(preset: ExpiryPreset, customLocal: string, nowMs: number, allowPast = false): ExpiryResult {
  if (preset === "never") return { ok: true, iso: null };
  if (preset !== "custom") return { ok: true, iso: new Date(nowMs + Number(preset) * 86_400_000).toISOString() };
  if (!customLocal) return { ok: false, reason: "required" };
  const at = new Date(customLocal);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: "required" };
  if (!allowPast && at.getTime() <= nowMs) return { ok: false, reason: "past" };
  return { ok: true, iso: at.toISOString() };
}

/** Row stagger delay, capped so long lists do not wait on the tail. */
export function stagger(index: number, stepMs = 28, maxSteps = 10): { animationDelay: string } {
  return { animationDelay: `${Math.min(index, maxSteps) * stepMs}ms` };
}
