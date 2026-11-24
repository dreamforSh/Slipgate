import { z } from "zod";
import { AdminStepUpSchema } from "./step_up.ts";

export const SystemUpdateModeSchema = z.enum(["release", "dev"]);
export type SystemUpdateMode = z.infer<typeof SystemUpdateModeSchema>;

export const SystemUpdateChannelSchema = z.enum(["stable", "dev"]);
export type SystemUpdateChannel = z.infer<typeof SystemUpdateChannelSchema>;

export const DevSyncStrategySchema = z.enum(["auto", "release", "git"]);
export type DevSyncStrategy = z.infer<typeof DevSyncStrategySchema>;

export const SystemUpdateStateSchema = z.enum([
  "idle",
  "checking",
  "downloading",
  "applying",
  "reloading_planes",
  "rolling_back",
  "error",
  "failed",
]);
export type SystemUpdateState = z.infer<typeof SystemUpdateStateSchema>;

export const SystemUpdateProgressSchema = z.object({
  stage: z.string(),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  percent: z.number().min(0).max(100),
});
export type SystemUpdateProgress = z.infer<typeof SystemUpdateProgressSchema>;

export const SystemUpdateComponentSchema = z.object({
  name: z.enum(["edge", "core", "bff", "guestd", "webui"]),
  status: z.enum([
    "running",
    "stopped",
    "degraded",
    "pending",
    "staged",
    "embedded",
    "overridden",
    "unknown",
  ]),
  binaryPath: z.string().nullable().default(null),
  overridden: z.boolean().default(false),
  restartRequired: z.boolean().default(false),
  pid: z.number().int().nonnegative().default(0),
  lastError: z.string().nullable().default(null),
});
export type SystemUpdateComponent = z.infer<typeof SystemUpdateComponentSchema>;

export const SystemUpdateHistoryEntrySchema = z.object({
  id: z.string(),
  action: z.enum(["apply", "rollback"]),
  fromVersion: z.string(),
  toVersion: z.string(),
  fromCommit: z.string(),
  toCommit: z.string(),
  tag: z.string().nullable().default(null),
  channel: SystemUpdateChannelSchema.default("stable"),
  strategy: z.string(),
  bundleDir: z.string().nullable().default(null),
  rollbackAvailable: z.boolean().default(false),
  succeeded: z.boolean(),
  error: z.string().nullable().default(null),
  createdAtIso: z.string(),
});
export type SystemUpdateHistoryEntry = z.infer<typeof SystemUpdateHistoryEntrySchema>;

export const SystemUpdatePreviousReleaseSchema = z.object({
  id: z.string(),
  version: z.string(),
  commit: z.string(),
  tag: z.string().nullable().default(null),
});
export type SystemUpdatePreviousRelease = z.infer<typeof SystemUpdatePreviousReleaseSchema>;

export const SystemReleaseItemSchema = z.object({
  tag: z.string(),
  name: z.string(),
  version: z.string(),
  commit: z.string().nullable().default(null),
  channel: SystemUpdateChannelSchema,
  prerelease: z.boolean(),
  publishedAtIso: z.string().nullable().default(null),
  htmlUrl: z.string().nullable().default(null),
  body: z.string().default(""),
  assetName: z.string().nullable().default(null),
  assetSizeBytes: z.number().int().nonnegative().nullable().default(null),
  current: z.boolean().default(false),
  installable: z.boolean().default(false),
});
export type SystemReleaseItem = z.infer<typeof SystemReleaseItemSchema>;

export const SystemReleasesResponseSchema = z.object({
  repo: z.string(),
  currentVersion: z.string(),
  currentCommit: z.string(),
  standalone: z.boolean().default(false),
  fetchedAtIso: z.string().nullable().default(null),
  releases: z.array(SystemReleaseItemSchema).default([]),
});
export type SystemReleasesResponse = z.infer<typeof SystemReleasesResponseSchema>;

export const SystemUpdateStatusSchema = z.object({
  mode: SystemUpdateModeSchema,
  channel: SystemUpdateChannelSchema.default("stable"),
  standalone: z.boolean().default(false),
  strategy: DevSyncStrategySchema,
  resolvedStrategy: z.enum(["release", "git"]),
  repo: z.string(),
  branch: z.string(),
  version: z.string(),
  activeCommit: z.string(),
  remoteCommit: z.string().nullable(),
  remoteVersion: z.string().nullable().default(null),
  remoteTag: z.string().nullable().default(null),
  releaseName: z.string().nullable().default(null),
  releaseNotes: z.string().nullable().default(null),
  releaseUrl: z.string().nullable().default(null),
  publishedAtIso: z.string().nullable().default(null),
  assetName: z.string().nullable().default(null),
  assetSizeBytes: z.number().int().nonnegative().nullable().default(null),
  updateAvailable: z.boolean(),
  autoSyncEnabled: z.boolean(),
  intervalSeconds: z.number().int().nonnegative(),
  state: SystemUpdateStateSchema,
  progress: SystemUpdateProgressSchema.nullable().default(null),
  reloadCount: z.number().int().nonnegative(),
  webUiOverridden: z.boolean(),
  edgeBinaryStaged: z.boolean(),
  edgeBinaryPath: z.string().nullable().default(null),
  guestdUpdated: z.boolean().default(false),
  githubTokenConfigured: z.boolean().default(false),
  allowReleaseApply: z.boolean().default(true),
  canRollback: z.boolean().default(false),
  previousRelease: SystemUpdatePreviousReleaseSchema.nullable().default(null),
  components: z.array(SystemUpdateComponentSchema).default([]),
  history: z.array(SystemUpdateHistoryEntrySchema).default([]),
  lastCheckedAtIso: z.string().nullable(),
  lastUpdatedAtIso: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type SystemUpdateStatus = z.infer<typeof SystemUpdateStatusSchema>;

export const TriggerUpdateSyncRequestSchema = z.object({
  checkOnly: z.boolean().default(false),
  channel: SystemUpdateChannelSchema.optional(),
  targetTag: z.string().trim().min(1).max(128).optional(),
  force: z.boolean().default(false),
  confirm: AdminStepUpSchema.optional(),
});
export type TriggerUpdateSyncRequest = z.infer<typeof TriggerUpdateSyncRequestSchema>;

export const UpdateSystemConfigRequestSchema = z.object({
  channel: SystemUpdateChannelSchema.optional(),
  autoSyncEnabled: z.boolean().optional(),
  intervalSeconds: z.number().int().min(30).max(86400).optional(),
  strategy: DevSyncStrategySchema.optional(),
});
export type UpdateSystemConfigRequest = z.infer<typeof UpdateSystemConfigRequestSchema>;

export const RollbackUpdateRequestSchema = z.object({
  releaseId: z.string().trim().min(1).max(128).optional(),
  confirm: AdminStepUpSchema.optional(),
});
export type RollbackUpdateRequest = z.infer<typeof RollbackUpdateRequestSchema>;
