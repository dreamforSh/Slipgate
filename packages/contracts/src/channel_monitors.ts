import { z } from "zod";

/**
 * Channel Monitors, Probe History & Public Matrix (Lane O3).
 *
 * Active periodic synthetic probes bound to non-VM upstream accounts (using the Go DataPlane's
 * isolated persona/uTLS probe path), plus a scrubbed public availability matrix.
 *
 * Pure ESM/Zod leaf module (no Node/Bun APIs).
 */

export const CHANNEL_MONITOR_STATUSES = ["unknown", "up", "degraded", "down"] as const;
export const ChannelMonitorStatusSchema = z.enum(CHANNEL_MONITOR_STATUSES);
export type ChannelMonitorStatus = z.infer<typeof ChannelMonitorStatusSchema>;

export const ChannelMonitorRunSchema = z.object({
  id: z.string(),
  monitorId: z.string(),
  status: z.enum(["up", "degraded", "down"]),
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  model: z.string(),
  errorMessage: z.string(),
  checkedAtIso: z.string(),
});
export type ChannelMonitorRun = z.infer<typeof ChannelMonitorRunSchema>;

export const PublicChannelMonitorRunSchema = z.object({
  status: z.enum(["up", "degraded", "down"]),
  latencyMs: z.number().int().nonnegative(),
  checkedAtIso: z.string(),
});
export type PublicChannelMonitorRun = z.infer<typeof PublicChannelMonitorRunSchema>;

export const ChannelMonitorSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  accountId: z.string(),
  accountName: z.string().default(""),
  groupId: z.string(),
  groupName: z.string().default(""),
  platform: z.string(),
  model: z.string(),
  intervalSeconds: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  degradedLatencyMs: z.number().int().positive(),
  enabled: z.boolean(),
  isPublic: z.boolean(),
  sortOrder: z.number().int(),
  lastStatus: ChannelMonitorStatusSchema,
  lastLatencyMs: z.number().int().nonnegative(),
  lastError: z.string(),
  lastCheckedAtIso: z.string().nullable(),
  uptime24hPct: z.number().min(0).max(100).nullable().default(null),
  recentRuns: z.array(PublicChannelMonitorRunSchema).default([]),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type ChannelMonitor = z.infer<typeof ChannelMonitorSchema>;

export const CreateChannelMonitorRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(400).default(""),
  accountId: z.string().trim().min(1).max(128),
  model: z.string().trim().max(160).default(""),
  intervalSeconds: z.coerce.number().int().min(30).max(86_400).default(300),
  timeoutMs: z.coerce.number().int().min(1000).max(120_000).default(30_000),
  degradedLatencyMs: z.coerce.number().int().min(100).max(120_000).default(8_000),
  enabled: z.boolean().default(true),
  isPublic: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(-10_000).max(10_000).default(0),
});
export type CreateChannelMonitorRequest = z.infer<typeof CreateChannelMonitorRequestSchema>;

export const UpdateChannelMonitorRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(400).optional(),
  accountId: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().max(160).optional(),
  intervalSeconds: z.coerce.number().int().min(30).max(86_400).optional(),
  timeoutMs: z.coerce.number().int().min(1000).max(120_000).optional(),
  degradedLatencyMs: z.coerce.number().int().min(100).max(120_000).optional(),
  enabled: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(-10_000).max(10_000).optional(),
});
export type UpdateChannelMonitorRequest = z.infer<typeof UpdateChannelMonitorRequestSchema>;

export const ChannelMonitorRunsResponseSchema = z.object({
  monitorId: z.string(),
  items: z.array(ChannelMonitorRunSchema),
});
export type ChannelMonitorRunsResponse = z.infer<typeof ChannelMonitorRunsResponseSchema>;

export const PublicChannelMonitorItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  platform: z.string(),
  model: z.string(),
  lastStatus: ChannelMonitorStatusSchema,
  lastLatencyMs: z.number().int().nonnegative(),
  lastCheckedAtIso: z.string().nullable(),
  uptime24hPct: z.number().min(0).max(100).nullable(),
  recentRuns: z.array(PublicChannelMonitorRunSchema),
});
export type PublicChannelMonitorItem = z.infer<typeof PublicChannelMonitorItemSchema>;

export const PublicChannelMonitorsStatusResponseSchema = z.object({
  generatedAtIso: z.string(),
  items: z.array(PublicChannelMonitorItemSchema),
});
export type PublicChannelMonitorsStatusResponse = z.infer<typeof PublicChannelMonitorsStatusResponseSchema>;
