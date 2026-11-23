import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound SSRF protection for operator- or plugin-supplied URLs (S3 backup endpoints, payment
 * gateways, webhooks, custom OAuth providers). Blocks loopback, unspecified, RFC1918 private,
 * CGNAT/metadata (169.254.0.0/16, 100.64.0.0/10), IPv6 ULA/link-local, and internal hostnames
 * unless SLIPGATE_ALLOW_PRIVATE_UPSTREAMS=true is explicitly enabled for local development.
 */

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export function allowPrivateUpstreamsFromEnv(): boolean {
  const raw = (process.env.SLIPGATE_ALLOW_PRIVATE_UPSTREAMS ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    nums.push(n);
  }
  return nums as [number, number, number, number];
}

function isBlockedIpv4(octets: [number, number, number, number], allowPrivate: boolean): boolean {
  const [a, b, c] = octets;
  // Always block unspecified (0.0.0.0/8), cloud IMDS / link-local (169.254.0.0/16), multicast/broadcast (224.0.0.0/3).
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  if (allowPrivate) return false;
  // Loopback (127.0.0.0/8)
  if (a === 127) return true;
  // RFC1918 private (10/8, 172.16/12, 192.168/16)
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // CGNAT / Alibaba Cloud IMDS 100.100.100.200 (100.64.0.0/10)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // IETF / TEST-NET / Benchmarking
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

function expandIpv6(raw: string): number[] | null {
  const zoneIdx = raw.indexOf("%");
  const clean = (zoneIdx >= 0 ? raw.slice(0, zoneIdx) : raw).toLowerCase();
  if (!clean) return null;

  // Handle dotted-quad tail (e.g. ::ffff:127.0.0.1)
  let working = clean;
  const lastColon = working.lastIndexOf(":");
  if (lastColon >= 0 && working.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4Octets(working.slice(lastColon + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    working = `${working.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = working.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && missing < 1) return null;

  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

export function isBlockedIpAddress(rawIp: string, allowPrivate = false): boolean {
  const ip = rawIp.trim().replace(/^\[|\]$/g, "");
  const v4 = parseIpv4Octets(ip);
  if (v4) return isBlockedIpv4(v4, allowPrivate);

  const v6 = expandIpv6(ip);
  if (!v6) return true;
  const allZero = v6.every((g) => g === 0);
  if (allZero) return true; // ::
  const isLoopback = v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1;
  if (isLoopback) return !allowPrivate;
  // IPv4-mapped (::ffff:0:0/96) or IPv4-compatible (::/96)
  const isV4Mapped = v6.slice(0, 5).every((g) => g === 0) && (v6[5] === 0xffff || v6[5] === 0);
  if (isV4Mapped) {
    const octets: [number, number, number, number] = [
      (v6[6]! >> 8) & 0xff,
      v6[6]! & 0xff,
      (v6[7]! >> 8) & 0xff,
      v6[7]! & 0xff,
    ];
    return isBlockedIpv4(octets, allowPrivate);
  }
  const first = v6[0]!;
  // Link-local fe80::/10 or multicast ff00::/8 are always blocked.
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (allowPrivate) return false;
  // Unique local fc00::/7 or documentation 2001:db8::/32
  if ((first & 0xfe00) === 0xfc00) return true;
  if (first === 0x2001 && v6[1] === 0x0db8) return true;
  return false;
}

export function isBlockedHostname(rawHost: string, allowPrivate = false): boolean {
  const host = rawHost.trim().replace(/^\[|\]$/g, "").replace(/\.+$/, "").toLowerCase();
  if (!host) return true;
  if (
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host === "metadata" ||
    host === "instance-data"
  ) {
    return true;
  }
  if (!allowPrivate) {
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".internal") ||
      host.endsWith(".local") ||
      host === "host.docker.internal"
    ) {
      return true;
    }
  }
  if (isIP(host) !== 0 || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) {
    return isBlockedIpAddress(host, allowPrivate);
  }
  return false;
}

export interface SafeOutboundOptions {
  allowPrivate?: boolean;
  resolveDns?: boolean;
}

export async function assertSafeOutboundUrl(rawUrl: string, options: SafeOutboundOptions = {}): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("Invalid outbound URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new SsrfBlockedError(`Unsupported outbound URL scheme: ${parsed.protocol}`);
  }
  const allowPrivate = options.allowPrivate ?? allowPrivateUpstreamsFromEnv();
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(host, allowPrivate)) {
    throw new SsrfBlockedError(`Outbound target host "${host}" is not permitted`);
  }
  if (options.resolveDns !== false && !allowPrivate && isIP(host) === 0) {
    let records: { address: string }[];
    try {
      records = await lookup(host, { all: true, verbatim: true });
    } catch (err) {
      throw new SsrfBlockedError(`Failed to resolve outbound host "${host}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (records.length === 0) {
      throw new SsrfBlockedError(`Outbound host "${host}" resolved to no addresses`);
    }
    for (const rec of records) {
      if (isBlockedIpAddress(rec.address, false)) {
        throw new SsrfBlockedError(`Outbound host "${host}" resolved to a restricted address`);
      }
    }
  }
  return parsed;
}

export async function ssrfSafeFetch(
  rawUrl: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
  options: SafeOutboundOptions = {},
): Promise<Response> {
  const resolveDns = options.resolveDns ?? fetchImpl === fetch;
  let currentUrl = (await assertSafeOutboundUrl(rawUrl, { ...options, resolveDns })).toString();
  const maxRedirects = 5;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(currentUrl, { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (!location) return res;
    const nextUrl = new URL(location, currentUrl).toString();
    // Never forward sensitive bodies/methods as POST across redirects beyond 307/308, and validate target.
    currentUrl = (await assertSafeOutboundUrl(nextUrl, { ...options, resolveDns })).toString();
    if (res.status === 301 || res.status === 302 || res.status === 303) {
      init = { ...init, method: "GET", body: undefined };
    }
  }
  throw new SsrfBlockedError("Too many outbound redirects");
}
