import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import { formatUsd, type Tone } from "../../../lib/format";

/** Mirrors `source` after it has been quiet for `ms` (search boxes driving server queries). */
export function useDebounced<T>(source: Ref<T>, ms = 320): Ref<T> {
  const out = ref(source.value) as Ref<T>;
  let timer: number | undefined;
  watch(source, (value) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => (out.value = value), ms);
  });
  onBeforeUnmount(() => window.clearTimeout(timer));
  return out;
}

/** Classes for list rows/cards that rise in one after another (off under reduced motion). */
export const STAGGER_CLASS = "animate-slide-up [animation-fill-mode:both] motion-reduce:animate-none";

/** Inline delay for the i-th staggered item, capped so long lists do not lag. */
export function stagger(index: number, stepMs = 24, cap = 12): { animationDelay: string } {
  return { animationDelay: `${Math.min(index, cap) * stepMs}ms` };
}

/** ISO instant → value for `<input type="datetime-local">` in local time. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value → ISO with offset (UTC), or null when empty/invalid. */
export function localInputToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isPast(iso: string | null | undefined, nowMs = Date.now()): boolean {
  if (!iso) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at <= nowMs;
}

/* ---------------- Expiry presets (redeem codes, bulk expiry) ---------------- */

export type ExpiryPreset = "never" | "1" | "7" | "30" | "custom";

export const EXPIRY_PRESETS: ExpiryPreset[] = ["never", "1", "7", "30", "custom"];

/**
 * Resolves a preset to an ISO instant. `undefined` means the custom value is missing or not
 * in the future (the caller shows a validation error); `null` means "never expires".
 */
export function resolveExpiry(preset: ExpiryPreset, customLocal: string): string | null | undefined {
  if (preset === "never") return null;
  if (preset === "custom") {
    const iso = localInputToIso(customLocal);
    return iso && Date.parse(iso) > Date.now() ? iso : undefined;
  }
  return new Date(Date.now() + Number(preset) * 86_400_000).toISOString();
}

/* ---------------- Money input ---------------- */

/** "$12.50" / " 3 " → "12.50" / "3"; null when not a positive USD amount the API accepts. */
export function normalizeUsdInput(text: string, allowZero = false): string | null {
  const v = text.trim().replace(/^\$/, "");
  if (!/^\d{1,12}(?:\.\d{1,9})?$/.test(v)) return null;
  if (!allowZero && Number(v) <= 0) return null;
  return v;
}

/** nano-USD string → plain decimal for an input box ("12.5"). */
export function nanoToUsdInput(nano: string): string {
  try {
    const n = BigInt(nano);
    const neg = n < 0n;
    const abs = neg ? -n : n;
    const whole = abs / 1_000_000_000n;
    const frac = (abs % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
    return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
  } catch {
    return "";
  }
}

/** formatUsd that keeps sub-dollar precision for negative amounts too ("-$0.42"). */
export function formatUsdAny(nano: string | null | undefined): string {
  const v = nano ?? "0";
  return v.startsWith("-") ? `-${formatUsd(v.slice(1))}` : formatUsd(v);
}

/** "+$1.00" / "−$0.0042" for ledger deltas. */
export function formatUsdDelta(nano: string): string {
  return nano.startsWith("-") ? `−${formatUsd(nano.slice(1))}` : `+${formatUsd(nano)}`;
}

/* ---------------- Misc ---------------- */

export type AnnouncementEditorMode = "create" | "edit" | "duplicate";

/** First `keep` characters followed by an ellipsis. */
export function maskCode(code: string, keep = 8): string {
  return code.length > keep ? `${code.slice(0, keep)}…` : code;
}

export function httpStatusTone(code: number): Tone {
  if (code >= 500) return "danger";
  if (code >= 400) return "warning";
  if (code >= 300) return "info";
  if (code >= 200) return "success";
  return "neutral";
}

export function methodTone(method: string): Tone {
  switch (method.toUpperCase()) {
    case "POST":
      return "success";
    case "PUT":
      return "info";
    case "PATCH":
      return "violet";
    case "DELETE":
      return "danger";
    default:
      return "neutral";
  }
}
