import { z } from "zod";

export const ClashSubscriptionSourceKindSchema = z.enum(["url", "inline"]);
export type ClashSubscriptionSourceKind = z.infer<typeof ClashSubscriptionSourceKindSchema>;

export const ClientHelloPresetSchema = z.enum([
  "auto",
  "custom_wire",
  "claude_bun_21",
  "codex_rustls",
  "antigravity_ide",
  "bun_default",
  "chrome_auto",
  "chrome_131",
  "firefox_auto",
  "safari_auto",
  "ios_auto",
  "edge_auto",
  "randomized",
  "claude_cli",
]);
export type ClientHelloPreset = z.infer<typeof ClientHelloPresetSchema>;

export const ClashRuntimeStatusSchema = z.object({
  mode: z.string(),
  ready: z.boolean(),
  version: z.string(),
  configHash: z.string(),
  activeListeners: z.number().int().nonnegative(),
  activeProxies: z.number().int().nonnegative(),
  lastReconciledAtIso: z.string().nullable(),
  lastError: z.string().optional(),
});
export type ClashRuntimeStatus = z.infer<typeof ClashRuntimeStatusSchema>;

export const ClashSubscriptionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  sourceKind: ClashSubscriptionSourceKindSchema,
  sourceUrl: z.string().optional(),
  userAgent: z.string(),
  excludeRegex: z.string(),
  enabled: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: z.string(),
  lastNodeCount: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type ClashSubscription = z.infer<typeof ClashSubscriptionSchema>;

export const CreateClashSubscriptionRequestSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  sourceKind: ClashSubscriptionSourceKindSchema.default("url"),
  sourceUrl: z.string().trim().min(1),
  userAgent: z.string().trim().max(120).default("clash.meta"),
  excludeRegex: z.string().max(256).default("剩余流量|到期时间|官网"),
  autoSync: z.boolean().default(true),
});
export type CreateClashSubscriptionRequest = z.infer<typeof CreateClashSubscriptionRequestSchema>;

export const ClashSyncResultSchema = z.object({
  subscription: ClashSubscriptionSchema,
  format: z.string(),
  totalNodes: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  skippedByDropGuard: z.boolean(),
  configHash: z.string(),
  activeListeners: z.number().int().nonnegative(),
  reconcileApplied: z.boolean(),
});
export type ClashSyncResult = z.infer<typeof ClashSyncResultSchema>;

export const ClashProbeRequestSchema = z.object({
  nodeIds: z.array(z.string().min(1)).default([]),
  verifyExitIp: z.boolean().default(true),
});
export type ClashProbeRequest = z.infer<typeof ClashProbeRequestSchema>;

export const ClashProbeResultSchema = z.object({
  nodeId: z.string().min(1),
  name: z.string(),
  success: z.boolean(),
  exitIp: z.string(),
  latencyMs: z.number().int().nonnegative(),
  healthStatus: z.string(),
  driftUnconfirmed: z.boolean(),
  error: z.string().optional(),
});
export type ClashProbeResult = z.infer<typeof ClashProbeResultSchema>;

const Uint16ArraySchema = z.array(z.number().int().min(0).max(65535)).max(256);
const Uint8ArraySchema = z.array(z.number().int().min(0).max(255)).max(64);

export const TlsProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  clientHelloPreset: z.string(),
  ja3Fingerprint: z.string().default(""),
  ja4Fingerprint: z.string().default(""),
  alpnProtocols: z.array(z.string()).default(["h2", "http/1.1"]),
  userAgentTemplate: z.string().default(""),
  enableGrease: z.boolean().default(false),
  cipherSuites: Uint16ArraySchema.default([]),
  curves: Uint16ArraySchema.default([]),
  pointFormats: Uint8ArraySchema.default([]),
  signatureAlgorithms: Uint16ArraySchema.default([]),
  supportedVersions: Uint16ArraySchema.default([]),
  keyShareGroups: Uint16ArraySchema.default([]),
  pskModes: Uint8ArraySchema.default([]),
  extensions: Uint16ArraySchema.default([]),
  osHint: z.string().default(""),
  builtIn: z.boolean().default(false),
});
export type TlsProfile = z.infer<typeof TlsProfileSchema>;

export const CreateTlsProfileRequestSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(512).default(""),
  clientHelloPreset: ClientHelloPresetSchema.default("chrome_auto"),
  ja3Fingerprint: z.string().max(512).default(""),
  ja4Fingerprint: z.string().max(128).default(""),
  alpnProtocols: z.array(z.string().min(1)).min(1).default(["h2", "http/1.1"]),
  userAgentTemplate: z.string().max(512).default(""),
  enableGrease: z.boolean().default(false),
  cipherSuites: Uint16ArraySchema.default([]),
  curves: Uint16ArraySchema.default([]),
  pointFormats: Uint8ArraySchema.default([]),
  signatureAlgorithms: Uint16ArraySchema.default([]),
  supportedVersions: Uint16ArraySchema.default([]),
  keyShareGroups: Uint16ArraySchema.default([]),
  pskModes: Uint8ArraySchema.default([]),
  extensions: Uint16ArraySchema.default([]),
  osHint: z.string().trim().max(32).default(""),
});
export type CreateTlsProfileRequest = z.infer<typeof CreateTlsProfileRequestSchema>;

export const UpdateTlsProfileRequestSchema = CreateTlsProfileRequestSchema.omit({ id: true }).partial().extend({
  name: z.string().trim().min(1).max(100).optional(),
});
export type UpdateTlsProfileRequest = z.infer<typeof UpdateTlsProfileRequestSchema>;

export const AccountExitBindingSchema = z.object({
  accountId: z.string().min(1),
  nodeId: z.string().min(1),
  utlsProfileId: z.string().default(""),
  isShadowFollower: z.boolean().default(false),
  boundExitIp: z.string().default(""),
});
export type AccountExitBinding = z.infer<typeof AccountExitBindingSchema>;

export const BindAccountExitRequestSchema = z.object({
  accountId: z.string().trim().min(1),
  nodeId: z.string().trim().min(1),
  utlsProfileId: z.string().trim().optional(),
  isShadowFollower: z.boolean().default(false),
});
export type BindAccountExitRequest = z.infer<typeof BindAccountExitRequestSchema>;

export const ClashOutboundTestRequestSchema = z.object({
  accountId: z.string().trim().min(1),
  utlsProfileId: z.string().trim().optional(),
  targetUrl: z.string().trim().url().optional(),
});
export type ClashOutboundTestRequest = z.infer<typeof ClashOutboundTestRequestSchema>;

export const ClashOutboundTestResponseSchema = z.object({
  accountId: z.string(),
  nodeId: z.string(),
  proxySlotId: z.string(),
  exitIp: z.string(),
  statusCode: z.number().int(),
  tlsVersion: z.string(),
  negotiatedAlpn: z.string(),
  latencyMs: z.number().int().nonnegative(),
  bodySnippet: z.string(),
});
export type ClashOutboundTestResponse = z.infer<typeof ClashOutboundTestResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Static IP proxies (IP management)                                          */
/* -------------------------------------------------------------------------- */

/**
 * A static IP proxy (SOCKS5 / HTTP / HTTPS) joins the exit pool as a single-node inline
 * subscription, so it gets a mihomo listener, exit-IP probing and account binding like any
 * other exit, and stays behind the fail-closed Clash egress. These ids mark such sources.
 */
export const STATIC_IP_SUBSCRIPTION_PREFIX = "ip-";

export function isStaticIpSubscription(subscriptionId: string): boolean {
  return subscriptionId.startsWith(STATIC_IP_SUBSCRIPTION_PREFIX);
}

export const StaticIpProtocolSchema = z.enum(["socks5", "http", "https"]);
export type StaticIpProtocol = z.infer<typeof StaticIpProtocolSchema>;

export interface StaticIpProxy {
  protocol: StaticIpProtocol;
  host: string;
  port: number;
  username: string;
  password: string;
}

export type StaticIpParseError = "empty" | "bad_protocol" | "bad_host" | "bad_port" | "bad_format";

const PROTOCOL_ALIASES: Record<string, StaticIpProtocol> = {
  socks5: "socks5",
  socks5h: "socks5",
  socks: "socks5",
  http: "http",
  https: "https",
};

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function validHost(host: string): boolean {
  if (host.includes(":")) return /^[0-9a-f:.]+$/i.test(host); // IPv6 (brackets already stripped)
  // All-numeric dotted names must be real IPv4 addresses (999.1.1.1 is a typo, not a host).
  if (/^[\d.]+$/.test(host)) return IPV4.test(host);
  return HOSTNAME.test(host);
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

/** `[v6]:port` or `host:port` → parts; `null` when there is no port. */
function splitHostPort(raw: string): { host: string; port: string } | null {
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(raw);
  if (v6) return { host: v6[1]!, port: v6[2]! };
  const idx = raw.lastIndexOf(":");
  if (idx <= 0) return null;
  return { host: raw.slice(0, idx), port: raw.slice(idx + 1) };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * One proxy per line, in the shapes proxy sellers hand out:
 * `socks5://user:pass@host:port`, `http://host:port`, `user:pass@host:port`,
 * `host:port:user:pass` and `host:port`. Bare lines use `defaultProtocol`.
 */
export function parseStaticIpLine(
  line: string,
  defaultProtocol: StaticIpProtocol = "socks5",
): { ok: true; proxy: StaticIpProxy } | { ok: false; error: StaticIpParseError } {
  let rest = line.trim();
  if (!rest) return { ok: false, error: "empty" };

  let protocol = defaultProtocol;
  const scheme = /^([a-z0-9]+):\/\//i.exec(rest);
  if (scheme) {
    const key = scheme[1]!.toLowerCase();
    const alias = Object.prototype.hasOwnProperty.call(PROTOCOL_ALIASES, key) ? PROTOCOL_ALIASES[key] : undefined;
    if (!alias) return { ok: false, error: "bad_protocol" };
    protocol = alias;
    rest = rest.slice(scheme[0].length).replace(/\/+$/, "");
  }

  let username = "";
  let password = "";
  let hostPort = rest;
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    const auth = rest.slice(0, at);
    hostPort = rest.slice(at + 1);
    const colon = auth.indexOf(":");
    username = safeDecode(colon >= 0 ? auth.slice(0, colon) : auth);
    password = safeDecode(colon >= 0 ? auth.slice(colon + 1) : "");
  } else if (!scheme && !hostPort.startsWith("[")) {
    // host:port:user:pass (passwords may contain colons).
    const parts = rest.split(":");
    if (parts.length >= 4) {
      hostPort = `${parts[0]}:${parts[1]}`;
      username = parts[2]!;
      password = parts.slice(3).join(":");
    } else if (parts.length === 3) {
      return { ok: false, error: "bad_format" };
    }
  }

  const split = splitHostPort(hostPort);
  if (!split) return { ok: false, error: "bad_port" };
  const host = split.host.trim();
  if (!validHost(host)) return { ok: false, error: "bad_host" };
  const port = parsePort(split.port.trim());
  if (port === null) return { ok: false, error: "bad_port" };
  return { ok: true, proxy: { protocol, host, port, username, password } };
}

/** Stable identity for duplicate checks: same endpoint and user is the same proxy. */
export function staticIpKey(proxy: Pick<StaticIpProxy, "host" | "port" | "username">): string {
  return `${proxy.host.toLowerCase()}:${proxy.port}:${proxy.username}`;
}

/** `host:port`, bracketing IPv6. */
export function staticIpAddress(proxy: Pick<StaticIpProxy, "host" | "port">): string {
  return proxy.host.includes(":") ? `[${proxy.host}]:${proxy.port}` : `${proxy.host}:${proxy.port}`;
}

/**
 * The inline Clash YAML for one static proxy. Values are JSON strings, which YAML reads as
 * double-quoted scalars, so credentials with `:`, `#` or quotes survive intact.
 */
export function staticIpClashYaml(proxy: StaticIpProxy, name: string): string {
  const lines = [
    "proxies:",
    `  - name: ${JSON.stringify(name)}`,
    `    type: ${proxy.protocol === "socks5" ? "socks5" : "http"}`,
    `    server: ${JSON.stringify(proxy.host)}`,
    `    port: ${proxy.port}`,
  ];
  if (proxy.username) lines.push(`    username: ${JSON.stringify(proxy.username)}`);
  if (proxy.password) lines.push(`    password: ${JSON.stringify(proxy.password)}`);
  if (proxy.protocol === "https") lines.push("    tls: true");
  if (proxy.protocol === "socks5") lines.push("    udp: true");
  return `${lines.join("\n")}\n`;
}

/** Reads back what `staticIpClashYaml` wrote (protocol, endpoint, user; never the password). */
export function readStaticIpClashYaml(yaml: string): Omit<StaticIpProxy, "password"> & { hasPassword: boolean } | null {
  const field = (key: string): string | null => {
    const m = new RegExp(`^\\s*${key}: (.+)$`, "m").exec(yaml);
    if (!m) return null;
    const raw = m[1]!.trim();
    try {
      return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
    } catch {
      return raw;
    }
  };
  const type = field("type");
  const host = field("server");
  const port = Number(field("port"));
  if (!type || !host || !Number.isInteger(port)) return null;
  const protocol: StaticIpProtocol = type === "socks5" ? "socks5" : field("tls") === "true" ? "https" : "http";
  return { protocol, host, port, username: field("username") ?? "", hasPassword: field("password") !== null };
}
