import { createHash } from "node:crypto";
import { ssrfSafeFetch } from "../security/ssrf.ts";

/**
 * Shared plumbing of the payment gateway clients: bounded response bodies, timeouts and an error
 * type that says whether the gateway gave a definitive answer.
 */

export const GATEWAY_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1 << 20;

/**
 * A gateway call that failed. `definitive` = the gateway answered and refused (a refund attempt
 * can be marked failed); otherwise the outcome is unknown (network error, timeout, 5xx) and the
 * caller must ask the gateway again before concluding anything.
 */
export class GatewayError extends Error {
  constructor(
    message: string,
    readonly definitive: boolean,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** One line, at most `max` characters, for error messages and logs. */
export function summarize(text: string, max = 300): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return "<empty>";
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** Reads at most 1 MiB of the body as text. */
export async function readText(res: Response): Promise<string> {
  const buf = new Uint8Array(await res.arrayBuffer());
  return new TextDecoder().decode(buf.byteLength > MAX_RESPONSE_BYTES ? buf.subarray(0, MAX_RESPONSE_BYTES) : buf);
}

/** fetch with the gateway timeout; network failures become non-definitive GatewayErrors. */
export async function gatewayFetch(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<{ status: number; text: string; headers: Headers }> {
  let res: Response;
  try {
    const reqInit = { ...init, signal: init.signal ?? AbortSignal.timeout(GATEWAY_TIMEOUT_MS) };
    res = fetchImpl === fetch ? await ssrfSafeFetch(url, reqInit, fetchImpl) : await fetchImpl(url, reqInit);
  } catch (err) {
    throw new GatewayError(`Network error: ${err instanceof Error ? err.message : String(err)}`, false);
  }
  return { status: res.status, text: await readText(res), headers: res.headers };
}

/** HTTP status of a refusal the gateway made on purpose (4xx), as opposed to an outage (5xx). */
export const isDefinitiveStatus = (status: number) => status >= 400 && status < 500;

export function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** "12.5" / "12.50" / 12.5 → 1250; null when not a non-negative amount with at most 2 decimals. */
export function decimalToMinor(v: unknown): number | null {
  const text = typeof v === "number" ? (Number.isFinite(v) ? v.toFixed(2) : "") : str(v).trim();
  const m = /^(\d{1,12})(?:\.(\d{1,2})\d*)?$/.exec(text);
  if (!m) return null;
  // Extra decimals beyond cents must be zeros ("70.000" is fine, "70.005" is not an amount we sent).
  if (/\.\d{2}[1-9]/.test(text)) return null;
  return Number.parseInt(m[1]!, 10) * 100 + Number.parseInt(((m[2] ?? "") + "00").slice(0, 2), 10);
}

/** Deterministic RFC 4122 v4-shaped id from the parts (idempotent gateway request ids). */
export function deterministicUuid(...parts: string[]): string {
  const h = createHash("sha256").update(parts.join("\u0000")).digest();
  h[6] = (h[6]! & 0x0f) | 0x40;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function timingSafeEqualText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
