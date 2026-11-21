import { z } from "zod";

export const ClusterNodeDriverKindSchema = z.enum(["local", "ssh"]);
export type ClusterNodeDriverKind = z.infer<typeof ClusterNodeDriverKindSchema>;

export const ClusterNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  driverKind: ClusterNodeDriverKindSchema,
  sshAddr: z.string(),
  sshUser: z.string(),
  hasSSHKey: z.boolean().default(false),
  arch: z.string(),
  kvmCapable: z.boolean(),
  dockerCapable: z.boolean(),
  status: z.string(),
  maxSlots: z.number().int().positive(),
  labels: z.record(z.string(), z.string()).optional(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type ClusterNode = z.infer<typeof ClusterNodeSchema>;

export const CreateClusterNodeRequestSchema = z.object({
  id: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(100),
  driverKind: ClusterNodeDriverKindSchema.default("ssh"),
  sshAddr: z.string().trim().min(1).max(255),
  sshUser: z.string().trim().min(1).max(64).default("root"),
  sshKeyPem: z.string().max(16384).optional(),
  arch: z.enum(["amd64", "arm64"]).default("amd64"),
  kvmCapable: z.boolean().default(false),
  dockerCapable: z.boolean().default(true),
  maxSlots: z.number().int().min(1).max(256).default(16),
});
export type CreateClusterNodeRequest = z.infer<typeof CreateClusterNodeRequestSchema>;

export const ProvisionVmSlotRequestSchema = z.object({
  slotId: z.string().trim().min(1).max(64).optional(),
  clusterNodeId: z.string().trim().min(1).max(64).default("local-node"),
  accountId: z.string().trim().min(1).max(128),
  clashNodeId: z.string().trim().min(1).max(128).optional(),
  hypervisorKind: z.enum(["kvm_qemu", "docker_hardened", "macos_native"]).optional(),
  maxSubagents: z.number().int().min(1).max(64).default(20),
  memoryMiB: z.number().int().min(512).max(131072).default(2048),
  telemetryMode: z.enum(["enabled", "isolated", "disabled"]).default("isolated"),
  cleanseMode: z.enum(["zero", "official", "template"]).default("zero"),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  dohUrl: z.string().trim().max(256).optional(),
  cpuModel: z.string().trim().max(128).optional(),
  cpuCores: z.number().int().min(1).max(128).default(4),
});
export type ProvisionVmSlotRequest = z.infer<typeof ProvisionVmSlotRequestSchema>;

export const UpdateVmSeedRequestSchema = z.object({
  settingsJsonRaw: z.string().optional(),
  customSettingRaw: z.string().optional(),
  proxyEnvRaw: z.string().optional(),
  bootstrapScriptRaw: z.string().optional(),
  rejectClientSettings: z.boolean().optional(),
  rejectClientIdentity: z.boolean().optional(),
});
export type UpdateVmSeedRequest = z.infer<typeof UpdateVmSeedRequestSchema>;

export const UpdateVmTelemetryRequestSchema = z.object({
  telemetryMode: z.enum(["enabled", "isolated", "disabled"]).optional(),
  cleanseMode: z.enum(["zero", "official", "template"]).optional(),
});
export type UpdateVmTelemetryRequest = z.infer<typeof UpdateVmTelemetryRequestSchema>;

export const MigrateVmSlotRequestSchema = z.object({
  targetClusterNodeId: z.string().trim().min(1).optional(),
  targetMemoryMiB: z.number().int().min(512).max(131072).optional(),
});
export type MigrateVmSlotRequest = z.infer<typeof MigrateVmSlotRequestSchema>;

export const VmMigrationJobSchema = z.object({
  id: z.string().min(1),
  slotId: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetNodeId: z.string().min(1),
  targetMemoryMiB: z.number().int().min(512),
  status: z.string().min(1),
  errorMessage: z.string().optional(),
  createdAtIso: z.string(),
  completedAtIso: z.string().optional(),
});
export type VmMigrationJob = z.infer<typeof VmMigrationJobSchema>;

export const VmTerminalTicketResponseSchema = z.object({
  ticket: z.string().min(1),
  slotId: z.string().min(1),
  actor: z.string(),
  wsPath: z.string().startsWith("/ws/admin/vms/terminal/"),
  expiresAtIso: z.string(),
});
export type VmTerminalTicketResponse = z.infer<typeof VmTerminalTicketResponseSchema>;
