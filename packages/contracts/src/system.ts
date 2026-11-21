import { z } from "zod";

export const SystemUpdateModeSchema = z.enum(["release", "dev"]);
export type SystemUpdateMode = z.infer<typeof SystemUpdateModeSchema>;

export const DevSyncStrategySchema = z.enum(["auto", "release", "git"]);
export type DevSyncStrategy = z.infer<typeof DevSyncStrategySchema>;

export const SystemUpdateStateSchema = z.enum([
  "idle",
  "checking",
  "downloading",
  "applying",
  "reloading_planes",
  "error",
]);
export type SystemUpdateState = z.infer<typeof SystemUpdateStateSchema>;

export const SystemUpdateStatusSchema = z.object({
  mode: SystemUpdateModeSchema,
  strategy: DevSyncStrategySchema,
  resolvedStrategy: z.enum(["release", "git"]),
  repo: z.string(),
  branch: z.string(),
  version: z.string(),
  activeCommit: z.string(),
  remoteCommit: z.string().nullable(),
  updateAvailable: z.boolean(),
  autoSyncEnabled: z.boolean(),
  intervalSeconds: z.number().int().nonnegative(),
  state: SystemUpdateStateSchema,
  reloadCount: z.number().int().nonnegative(),
  webUiOverridden: z.boolean(),
  edgeBinaryStaged: z.boolean(),
  lastCheckedAtIso: z.string().nullable(),
  lastUpdatedAtIso: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type SystemUpdateStatus = z.infer<typeof SystemUpdateStatusSchema>;

export const TriggerUpdateSyncRequestSchema = z.object({
  checkOnly: z.boolean().default(false),
});
export type TriggerUpdateSyncRequest = z.infer<typeof TriggerUpdateSyncRequestSchema>;
