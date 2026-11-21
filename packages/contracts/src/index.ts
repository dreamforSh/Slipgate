import { z } from "zod";
import { ProviderSchema } from "./pool.ts";

export * from "./iam.ts";
export * from "./pool.ts";
export * from "./apikeys.ts";
export * from "./system.ts";
export * from "./clash.ts";

export const NANO_PER_USD = 1_000_000_000n;

export const ExitHealthStatusSchema = z.enum([
  "unknown",
  "healthy",
  "degraded",
  "circuit_open",
]);
export type ExitHealthStatus = z.infer<typeof ExitHealthStatusSchema>;

export const PlaneHealthSchema = z.object({
  status: z.enum(["ok", "degraded", "down"]),
  service: z.string(),
  version: z.string(),
  runtime: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  planes: z.object({
    net: z.enum(["up", "down", "unknown"]),
    core: z.enum(["up", "down", "unknown"]),
    bff: z.enum(["up", "down"]),
  }),
});
export type PlaneHealth = z.infer<typeof PlaneHealthSchema>;

export const ClashExitNodeSchema = z.object({
  nodeId: z.string().min(1),
  subscriptionId: z.string().min(1),
  name: z.string().min(1),
  proxySlotId: z.string().min(1),
  listenerPort: z.number().int().min(1024).max(65535),
  exitIp: z.string(),
  latencyMs: z.number().int().nonnegative(),
  healthStatus: ExitHealthStatusSchema,
  driftUnconfirmed: z.boolean(),
  boundAccounts: z.number().int().nonnegative(),
  maxAccounts: z.number().int().positive(),
  proxyType: z.string().optional(),
  server: z.string().optional(),
  serverPort: z.number().int().optional(),
  enabled: z.boolean().optional(),
  lastProbedAtIso: z.string().optional(),
  lastError: z.string().optional(),
});
export type ClashExitNode = z.infer<typeof ClashExitNodeSchema>;

export const RouteEndpointSchema = z.enum([
  "any",
  "messages",
  "count_tokens",
  "responses",
  "chat_completions",
  "embeddings",
  "images",
  "gemini",
]);
export type RouteEndpoint = z.infer<typeof RouteEndpointSchema>;

export const CompositeRouteRuleSchema = z.object({
  routeId: z.string().min(1),
  groupId: z.string().min(1),
  publicModel: z.string().min(1),
  matchType: z.enum(["exact", "prefix"]),
  targetPlatform: ProviderSchema,
  upstreamModel: z.string(),
  endpoint: RouteEndpointSchema,
  priority: z.number().int().default(100),
  enabled: z.boolean().default(true),
});
export type CompositeRouteRule = z.infer<typeof CompositeRouteRuleSchema>;

export const RoutePreviewRequestSchema = z.object({
  groupId: z.string().min(1),
  publicModel: z.string().min(1),
  endpoint: RouteEndpointSchema.default("any"),
  rules: z.array(CompositeRouteRuleSchema).default([]),
});
export type RoutePreviewRequest = z.infer<typeof RoutePreviewRequestSchema>;

export const RoutePreviewResponseSchema = z.object({
  matched: z.boolean(),
  targetPlatform: ProviderSchema.nullable(),
  upstreamModel: z.string().nullable(),
  matchedRuleId: z.string().nullable(),
  resolutionSource: z.enum(["explicit_rule", "builtin_detector", "none"]),
});
export type RoutePreviewResponse = z.infer<typeof RoutePreviewResponseSchema>;

export const WalletSummarySchema = z.object({
  userId: z.string().min(1),
  balanceNanoUsd: z.string().regex(/^-?\d+$/),
  heldNanoUsd: z.string().regex(/^\d+$/),
  availableNanoUsd: z.string().regex(/^-?\d+$/),
  formattedAvailableUsd: z.string(),
});
export type WalletSummary = z.infer<typeof WalletSummarySchema>;

export const PromptCleanseModeSchema = z.enum(["zero", "official", "template"]);
export type PromptCleanseMode = z.infer<typeof PromptCleanseModeSchema>;

export const TelemetryModeSchema = z.enum(["enabled", "isolated", "disabled"]);
export type TelemetryMode = z.infer<typeof TelemetryModeSchema>;

export const HypervisorKindSchema = z.enum(["kvm_qemu", "docker_hardened", "macos_native"]);
export type HypervisorKind = z.infer<typeof HypervisorKindSchema>;

export const VmSlotStateSchema = z.enum([
  "provisioning",
  "ready",
  "cooldown_5h",
  "cooldown_7d",
  "draining",
  "stopped",
  "auth_expired",
  "migrating",
]);
export type VmSlotState = z.infer<typeof VmSlotStateSchema>;

export const HardwarePersonaSchema = z.object({
  guestMachineId: z.string().regex(/^(?!0{32})[0-9a-f]{32}$/),
  macAddress: z.string().min(1),
  smbiosUuid: z.string().min(1),
  smbiosSerial: z.string(),
  cpuModel: z.string(),
  cpuCores: z.number().int().positive(),
  timezone: z.string(),
  dohUrl: z.string().optional(),
});
export type HardwarePersona = z.infer<typeof HardwarePersonaSchema>;

export const VmSlotSummarySchema = z.object({
  slotId: z.string().min(1),
  clusterNodeId: z.string().min(1),
  accountId: z.string().min(1),
  clashNodeId: z.string().min(1),
  exitIp: z.string().min(1),
  hypervisorKind: HypervisorKindSchema,
  state: VmSlotStateSchema,
  activeSubagents: z.number().int().nonnegative(),
  maxSubagents: z.number().int().positive(),
  window5hUsedBps: z.number().int().min(0).max(10000),
  window7dUsedBps: z.number().int().min(0).max(10000),
  telemetryMode: TelemetryModeSchema,
  cleanseMode: PromptCleanseModeSchema,
  memoryMiB: z.number().int().min(512),
  persona: HardwarePersonaSchema,
});
export type VmSlotSummary = z.infer<typeof VmSlotSummarySchema>;

export const SlotSeedSnapshotSchema = z.object({
  slotId: z.string().min(1),
  settingsJsonRaw: z.string(),
  customSettingRaw: z.string(),
  rejectClientSettings: z.boolean(),
  rejectClientIdentity: z.boolean(),
  telemetryMode: TelemetryModeSchema,
  telemetryDaemonRunning: z.boolean(),
  syncedAtUnixMs: z.number().int(),
});
export type SlotSeedSnapshot = z.infer<typeof SlotSeedSnapshotSchema>;

export const RiskBanEventSchema = z.object({
  eventId: z.string().min(1),
  subjectKind: z.enum(["device", "session", "api_key", "ip"]),
  strikeLevel: z.number().int().min(1).max(3),
  banDuration: z.enum(["10m", "24h", "permanent"]),
  reason: z.string().min(1),
  ordinaryUpstream400Count: z.number().int().nonnegative(),
  downgradedCount: z.number().int().nonnegative(),
  createdAtIso: z.string(),
});
export type RiskBanEvent = z.infer<typeof RiskBanEventSchema>;

export function formatNanoUsd(nano: bigint): string {
  const negative = nano < 0n;
  const abs = negative ? -nano : nano;
  const whole = abs / NANO_PER_USD;
  const frac = (abs % NANO_PER_USD).toString().padStart(9, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return frac.length > 0 ? `${sign}$${whole}.${frac}` : `${sign}$${whole}.00`;
}

export function parseUsdToNano(input: string): bigint {
  const trimmed = input.trim().replace(/^\$/, "");
  if (!/^-?\d+(?:\.\d{1,9})?$/.test(trimmed)) {
    throw new Error(`Invalid USD decimal string: "${input}"`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart, fracPart = ""] = unsigned.split(".");
  const nano = BigInt(wholePart) * NANO_PER_USD + BigInt(fracPart.padEnd(9, "0"));
  return negative ? -nano : nano;
}
