import type { Context } from "hono";

/**
 * The client address every rate limiter and the audit log key on.
 *
 * X-Forwarded-For / X-Real-IP are only honoured when the TCP peer is a trusted proxy, and the
 * forwarded chain is read from the right: each trusted proxy appends the address it saw, so the
 * right-most entry that is not a trusted proxy is the real client. Everything to its left was sent
 * by the client and is ignored (taking the left-most entry, as before, let any caller pick a fresh
 * rate-limit bucket per request).
 *
 * Trusted proxies come from SLIPGATE_TRUSTED_PROXIES (comma or space separated IPs / CIDRs, or
 * "none"). The default trusts loopback and private ranges: as deployed, slipgate-net's edge reaches
 * the BFF over loopback inside the same container, and a reverse proxy in front of the edge shows up
 * as a Docker bridge gateway (172.16/12, or 192.168/16 once Docker's default pools run out of
 * 172.x networks). Set the variable to exactly your proxies when the default does not fit:
 *  - edge port published on all interfaces, so clients can reach it directly (Docker's userland
 *    proxy, used for IPv6 and hairpin connections, also shows up as the bridge gateway): list only
 *    your reverse proxy's address, e.g. "127.0.0.0/8, ::1, 172.18.0.1", or bind the port to
 *    127.0.0.1 behind the proxy (the documented deployment);
 *  - behind a CDN: add the CDN's published edge ranges, or every user shares the CDN edge's bucket;
 *  - behind a load balancer on another private network: add its address (when it does not append
 *    X-Forwarded-For, all of its clients share one bucket either way).
 *
 * Rate limits key on clientIp(), which buckets an IPv6 client by its /64 (one subscriber routinely
 * holds a whole /64, so per-address keys would let it rotate into fresh buckets); the audit log
 * records the exact address from clientAddress().
 */

const DEFAULT_TRUSTED_PROXIES = "127.0.0.0/8, ::1/128, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7";
/** Forwarded chains are never this long; a longer header is cut to its right end. */
const MAX_HOPS = 32;
/** IPv6 clients share one rate-limit bucket per prefix of this length. */
const IPV6_BUCKET_PREFIX = 64;

interface Cidr {
  v6: boolean;
  base: bigint;
  mask: bigint;
}

interface ParsedIp {
  v6: boolean;
  value: bigint;
  /** Canonical text (IPv4-mapped IPv6 collapses to IPv4). */
  text: string;
}

function parseIpv4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseIpv6(text: string): { value: bigint; mappedV4: bigint | null } | null {
  let head = text;
  let tailV4: bigint | null = null;
  const lastColon = text.lastIndexOf(":");
  if (text.includes(".")) {
    tailV4 = parseIpv4(text.slice(lastColon + 1));
    if (tailV4 === null) return null;
    head = `${text.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const left = toGroups(halves[0]!);
  const right = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? left.length !== 8 : missing < 1) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(g, 16));
  }
  if (tailV4 !== null) value = (value & ~0xffffffffn) | tailV4;
  const mapped = value >> 32n === 0xffffn ? value & 0xffffffffn : null;
  return { value, mappedV4: mapped };
}

function v4Text(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => String((value >> s) & 0xffn)).join(".");
}

/** An address as proxies write it: bare, "[v6]", "[v6]:port" or "v4:port". */
export function parseIp(raw: string | null | undefined): ParsedIp | null {
  let text = (raw ?? "").trim();
  if (!text || text.length > 64) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) text = bracketed[1]!;
  else if (/^[\d.]+:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":"));
  text = text.replace(/%.*$/, ""); // IPv6 zone id
  const v4 = parseIpv4(text);
  if (v4 !== null) return { v6: false, value: v4, text: v4Text(v4) };
  if (!text.includes(":")) return null;
  const v6 = parseIpv6(text);
  if (!v6) return null;
  if (v6.mappedV4 !== null) return { v6: false, value: v6.mappedV4, text: v4Text(v6.mappedV4) };
  return { v6: true, value: v6.value, text: text.toLowerCase() };
}

/** "a.b.c.d", "a.b.c.d/n", "v6" or "v6/n"; null when malformed. */
export function parseCidr(raw: string): Cidr | null {
  const [addr, bits, ...rest] = raw.trim().split("/");
  if (rest.length > 0 || !addr) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const width = ip.v6 ? 128 : 32;
  const prefix = bits === undefined ? width : /^\d{1,3}$/.test(bits) ? Number(bits) : -1;
  if (prefix < 0 || prefix > width) return null;
  const all = (1n << BigInt(width)) - 1n;
  const mask = prefix === 0 ? 0n : (all << BigInt(width - prefix)) & all;
  return { v6: ip.v6, base: ip.value & mask, mask };
}

export function parseTrustedProxies(spec: string | undefined): Cidr[] {
  const text = (spec ?? "").trim();
  if (text.toLowerCase() === "none") return [];
  const list: Cidr[] = [];
  for (const item of (text || DEFAULT_TRUSTED_PROXIES).split(/[\s,]+/)) {
    if (!item) continue;
    const cidr = parseCidr(item);
    if (cidr) list.push(cidr);
    else console.warn(`[slipgate-bff] SLIPGATE_TRUSTED_PROXIES: ignoring malformed entry "${item}"`);
  }
  return list;
}

function trusted(ip: ParsedIp, proxies: Cidr[]): boolean {
  return proxies.some((c) => c.v6 === ip.v6 && (ip.value & c.mask) === c.base);
}

/**
 * The client address given the TCP peer and the forwarding headers it sent. "unknown" when the
 * peer address is not known (no socket, e.g. in-process requests): headers are never trusted then.
 */
export function resolveClientIp(
  peer: string | null | undefined,
  forwardedFor: string | null | undefined,
  realIp: string | null | undefined,
  proxies: Cidr[],
): string {
  const peerIp = parseIp(peer);
  if (!peerIp) return "unknown";
  if (!trusted(peerIp, proxies)) return peerIp.text;
  const hops = (forwardedFor ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .slice(-MAX_HOPS);
  if (hops.length === 0) return parseIp(realIp)?.text ?? peerIp.text;
  // Walk from the peer outwards: the first hop that is not a trusted proxy is the client.
  let nearest = peerIp;
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = parseIp(hops[i]);
    // A garbled entry was not written by a trusted proxy: stop at the last address that was.
    if (!hop) return nearest.text;
    if (!trusted(hop, proxies)) return hop.text;
    nearest = hop;
  }
  // Every hop is a trusted (internal) address: the request started inside the trusted network.
  return nearest.text;
}

let cachedSpec: string | undefined;
let cachedProxies: Cidr[] = parseTrustedProxies(undefined);

function trustedProxies(): Cidr[] {
  const spec = process.env.SLIPGATE_TRUSTED_PROXIES;
  if (spec !== cachedSpec) {
    cachedSpec = spec;
    cachedProxies = parseTrustedProxies(spec);
  }
  return cachedProxies;
}

/** The TCP peer address: Bun.serve passes its Server as the fetch env, which knows the socket. */
function peerAddress(c: Context): string | null {
  try {
    const env = c.env as
      | { requestIP?: (req: Request) => { address?: string } | null; server?: { requestIP?: (req: Request) => { address?: string } | null } }
      | undefined;
    const server = env && typeof env.requestIP === "function" ? env : env?.server;
    if (!server || typeof server.requestIP !== "function") return null;
    return server.requestIP(c.req.raw)?.address ?? null;
  } catch {
    return null;
  }
}

/**
 * The rate-limit bucket of an address from resolveClientIp: IPv4 (and IPv4-mapped IPv6) as is, IPv6
 * as its /64 network ("2001:db8:0:1::/64"). Anything unparsable ("unknown") is returned unchanged.
 */
export function rateLimitBucket(address: string): string {
  const ip = parseIp(address);
  if (!ip?.v6) return ip?.text ?? address;
  const groups: string[] = [];
  for (let i = 0; i < IPV6_BUCKET_PREFIX / 16; i++) groups.push(((ip.value >> BigInt(112 - 16 * i)) & 0xffffn).toString(16));
  return `${groups.join(":")}::/${IPV6_BUCKET_PREFIX}`;
}

/** The request's exact client address (see the module comment); "unknown" when there is no socket peer. */
export function clientAddress(c: Context): string {
  return resolveClientIp(peerAddress(c), c.req.header("x-forwarded-for"), c.req.header("x-real-ip"), trustedProxies());
}

/** The request's client as every rate limiter keys it: clientAddress(), with IPv6 bucketed by /64. */
export function clientIp(c: Context): string {
  return rateLimitBucket(clientAddress(c));
}

function sanitizeHostAuthority(raw: string | undefined): string | null {
  const host = (raw ?? "").trim();
  if (!host || host.length > 255) return null;
  if (/[/\\?#@\s\r\n]/.test(host)) return null;
  try {
    const parsed = new URL(`http://${host}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return parsed.host;
  } catch {
    return null;
  }
}

/**
 * Whether X-Forwarded-Host / X-Forwarded-Proto on this request came from a trusted reverse proxy
 * (or an in-process Hono test call with no socket peer). Untrusted direct TCP peers cannot spoof
 * forwarded host/scheme headers to poison OAuth redirect_uri or payment callback URLs.
 */
export function trustsForwardedHeaders(c: Context): boolean {
  const peer = peerAddress(c);
  if (!peer) return true;
  const parsed = parseIp(peer);
  return parsed ? trusted(parsed, trustedProxies()) : false;
}

/** Safe external origin (`http(s)://host[:port]`) derived from forwarded headers (when trusted) or `c.req.url`. */
export function safeRequestOrigin(c: Context): string {
  const reqUrl = new URL(c.req.url);
  const trustForwarded = trustsForwardedHeaders(c);
  const rawProto = trustForwarded ? c.req.header("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() : undefined;
  const proto = rawProto === "https" || rawProto === "http" ? rawProto : reqUrl.protocol.replace(":", "") === "https" ? "https" : "http";
  const forwardedHost = trustForwarded ? sanitizeHostAuthority(c.req.header("x-forwarded-host")?.split(",")[0]) : null;
  const directHost = sanitizeHostAuthority(c.req.header("host"));
  const host = forwardedHost ?? directHost ?? reqUrl.host;
  return `${proto}://${host}`;
}
