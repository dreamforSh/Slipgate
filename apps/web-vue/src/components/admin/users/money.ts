/**
 * Exact USD ⇄ nano-USD helpers for admin money inputs (balances, subscription caps).
 * Values cross the wire as nano-USD integer strings; people type USD decimals.
 */

const NANO_PER_USD = 1_000_000_000n;

/** Same shape the contracts accept (UsdAmountSchema): up to 12 integer and 9 fractional digits. */
export const USD_INPUT_RE = /^\$?\d{1,12}(?:\.\d{1,9})?$/;

/** HTML `pattern` twin of USD_INPUT_RE (no `$`; native validation in forms). */
export const USD_INPUT_PATTERN = "[0-9]{1,12}(\\.[0-9]{1,9})?";

/** "12.5" / "$0.000001" → nano BigInt; null when the text is not a valid amount. */
export function parseUsdToNano(text: string): bigint | null {
  const value = text.trim();
  if (!USD_INPUT_RE.test(value)) return null;
  const [whole, frac = ""] = value.replace(/^\$/, "").split(".");
  return BigInt(whole) * NANO_PER_USD + BigInt(frac.padEnd(9, "0"));
}

/** Nano-USD string → plain decimal for an input ("12500000000" → "12.5"). Negative values keep the sign. */
export function nanoToUsdInput(nano: string | bigint | null | undefined): string {
  let n: bigint;
  try {
    n = typeof nano === "bigint" ? nano : BigInt(nano || "0");
  } catch {
    return "0";
  }
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = abs / NANO_PER_USD;
  const frac = (abs % NANO_PER_USD).toString().padStart(9, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Normalised USD text for a request body ("$05.50" → "5.5"); null when invalid. */
export function normalizeUsdInput(text: string): string | null {
  const nano = parseUsdToNano(text);
  return nano === null ? null : nanoToUsdInput(nano);
}
