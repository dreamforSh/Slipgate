import type {
  ChannelMonitor,
  ChannelMonitorRun,
  ChannelMonitorStatus,
  CreateChannelMonitorRequest,
  PublicChannelMonitorRun,
  UpdateChannelMonitorRequest,
} from "@slipgate/contracts";

export const MEMORY_CHANNEL_MONITOR_RUNS_LIMIT = 20_000;
export const MONITOR_SPARKBAR_POINTS = 24;

export interface ChannelMonitorProbeOutcome {
  ok: boolean;
  latencyMs: number;
  model: string;
  message: string;
}

export type ChannelMonitorProbeFn = (monitor: ChannelMonitor) => Promise<ChannelMonitorProbeOutcome>;

export interface CreateMonitorRecordInput extends CreateChannelMonitorRequest {
  groupId: string;
  platform: string;
}

export interface UpdateMonitorRecordPatch extends UpdateChannelMonitorRequest {
  groupId?: string;
  platform?: string;
}

export interface RecordMonitorRunInput {
  status: "up" | "degraded" | "down";
  ok: boolean;
  latencyMs: number;
  model: string;
  errorMessage: string;
  checkedAtIso: string;
}

export interface MonitorHistorySummary {
  uptime24hPct: number | null;
  recentRuns: PublicChannelMonitorRun[];
}

export function summarizeMonitorRuns(
  runs: Pick<ChannelMonitorRun, "status" | "ok" | "latencyMs" | "checkedAtIso">[],
  limit = MONITOR_SPARKBAR_POINTS,
): MonitorHistorySummary {
  if (runs.length === 0) return { uptime24hPct: null, recentRuns: [] };
  const okCount = runs.filter((r) => r.ok).length;
  const uptime24hPct = Number(((okCount / runs.length) * 100).toFixed(2));
  // Caller provides newest-first or chronological; normalize ascending chronological slice.
  const asc = [...runs].sort((a, b) => Date.parse(a.checkedAtIso) - Date.parse(b.checkedAtIso));
  const recentRuns: PublicChannelMonitorRun[] = asc.slice(-limit).map((r) => ({
    status: r.status,
    latencyMs: r.latencyMs,
    checkedAtIso: r.checkedAtIso,
  }));
  return { uptime24hPct, recentRuns };
}

export function statusFromProbe(ok: boolean, latencyMs: number, degradedLatencyMs: number): "up" | "degraded" | "down" {
  if (!ok) return "down";
  return latencyMs >= degradedLatencyMs ? "degraded" : "up";
}

export function normalizeMonitorStatus(s: string): ChannelMonitorStatus {
  if (s === "up" || s === "degraded" || s === "down") return s;
  return "unknown";
}

export interface ChannelMonitorStore {
  listMonitors(opts?: { publicOnly?: boolean; enabledOnly?: boolean }): Promise<ChannelMonitor[]>;
  getMonitor(id: string): Promise<ChannelMonitor | null>;
  createMonitor(input: CreateMonitorRecordInput): Promise<ChannelMonitor>;
  updateMonitor(id: string, patch: UpdateMonitorRecordPatch): Promise<ChannelMonitor | null>;
  deleteMonitor(id: string): Promise<boolean>;
  recordRun(monitorId: string, run: RecordMonitorRunInput): Promise<{ monitor: ChannelMonitor; run: ChannelMonitorRun } | null>;
  listRuns(monitorId: string, limit: number): Promise<ChannelMonitorRun[]>;
  listRecentRunsBatch(monitorIds: string[], sinceIso: string): Promise<Map<string, ChannelMonitorRun[]>>;
  pruneRunsBefore(cutoffIso: string): Promise<number>;
}
