import { z } from "zod";

export const ClashSubscriptionSourceKindSchema = z.enum(["url", "inline"]);
export type ClashSubscriptionSourceKind = z.infer<typeof ClashSubscriptionSourceKindSchema>;

export const ClientHelloPresetSchema = z.enum([
  "auto",
  "custom_wire",
  "claude_bun_21",
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
