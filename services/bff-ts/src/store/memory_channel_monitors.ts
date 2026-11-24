import type { ChannelMonitor, ChannelMonitorRun, GroupItem, UpstreamAccount } from "@slipgate/contracts";
import {
  MEMORY_CHANNEL_MONITOR_RUNS_LIMIT,
  summarizeMonitorRuns,
  type ChannelMonitorStore,
  type CreateMonitorRecordInput,
  type RecordMonitorRunInput,
  type UpdateMonitorRecordPatch,
} from "./channel_monitors_types.ts";

interface StoredMonitor extends Omit<ChannelMonitor, "accountName" | "groupName" | "uptime24hPct" | "recentRuns"> {}

export interface MemoryChannelMonitorStoreDeps {
  accounts: Map<string, Pick<UpstreamAccount, "name">>;
  groups: Map<string, Pick<GroupItem, "name">>;
}

export class MemoryChannelMonitorStore implements ChannelMonitorStore {
  private readonly monitors = new Map<string, StoredMonitor>();
  private readonly runs: ChannelMonitorRun[] = [];
  private runSeq = 0;

  constructor(private readonly deps: MemoryChannelMonitorStoreDeps) {}

  private hydrate(m: StoredMonitor, runs24h: ChannelMonitorRun[]): ChannelMonitor {
    const summary = summarizeMonitorRuns(runs24h);
    return {
      ...m,
      accountName: this.deps.accounts.get(m.accountId)?.name ?? "",
      groupName: m.groupId ? (this.deps.groups.get(m.groupId)?.name ?? "") : "",
      uptime24hPct: summary.uptime24hPct,
      recentRuns: summary.recentRuns,
    };
  }

  async listMonitors(opts: { publicOnly?: boolean; enabledOnly?: boolean } = {}): Promise<ChannelMonitor[]> {
    const list = [...this.monitors.values()]
      .filter((m) => (!opts.publicOnly || m.isPublic) && (!opts.enabledOnly || m.enabled))
      .sort((a, b) => a.sortOrder - b.sortOrder || Date.parse(b.createdAtIso) - Date.parse(a.createdAtIso));
    if (list.length === 0) return [];
    const sinceIso = new Date(Date.now() - 86_400_000).toISOString();
    const runsByMonitor = await this.listRecentRunsBatch(
      list.map((m) => m.id),
      sinceIso,
    );
    return list.map((m) => this.hydrate(m, runsByMonitor.get(m.id) ?? []));
  }

  async getMonitor(id: string): Promise<ChannelMonitor | null> {
    const m = this.monitors.get(id);
    if (!m) return null;
    const sinceIso = new Date(Date.now() - 86_400_000).toISOString();
    const runsByMonitor = await this.listRecentRunsBatch([id], sinceIso);
    return this.hydrate(m, runsByMonitor.get(id) ?? []);
  }

  async createMonitor(input: CreateMonitorRecordInput): Promise<ChannelMonitor> {
    const id = `mon_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const m: StoredMonitor = {
      id,
      name: input.name,
      description: input.description,
      accountId: input.accountId,
      groupId: input.groupId,
      platform: input.platform,
      model: input.model,
      intervalSeconds: input.intervalSeconds,
      timeoutMs: input.timeoutMs,
      degradedLatencyMs: input.degradedLatencyMs,
      enabled: input.enabled,
      isPublic: input.isPublic,
      sortOrder: input.sortOrder,
      lastStatus: "unknown",
      lastLatencyMs: 0,
      lastError: "",
      lastCheckedAtIso: null,
      createdAtIso: now,
      updatedAtIso: now,
    };
    this.monitors.set(id, m);
    return this.hydrate(m, []);
  }

  async updateMonitor(id: string, patch: UpdateMonitorRecordPatch): Promise<ChannelMonitor | null> {
    const current = this.monitors.get(id);
    if (!current) return null;
    const updated: StoredMonitor = {
      ...current,
      name: patch.name ?? current.name,
      description: patch.description ?? current.description,
      accountId: patch.accountId ?? current.accountId,
      groupId: patch.groupId ?? current.groupId,
      platform: patch.platform ?? current.platform,
      model: patch.model ?? current.model,
      intervalSeconds: patch.intervalSeconds ?? current.intervalSeconds,
      timeoutMs: patch.timeoutMs ?? current.timeoutMs,
      degradedLatencyMs: patch.degradedLatencyMs ?? current.degradedLatencyMs,
      enabled: patch.enabled ?? current.enabled,
      isPublic: patch.isPublic ?? current.isPublic,
      sortOrder: patch.sortOrder ?? current.sortOrder,
      updatedAtIso: new Date().toISOString(),
    };
    this.monitors.set(id, updated);
    return this.getMonitor(id);
  }

  async deleteMonitor(id: string): Promise<boolean> {
    const ok = this.monitors.delete(id);
    if (ok) {
      for (let i = this.runs.length - 1; i >= 0; i--) {
        if (this.runs[i]!.monitorId === id) this.runs.splice(i, 1);
      }
    }
    return ok;
  }

  async recordRun(
    monitorId: string,
    runInput: RecordMonitorRunInput,
  ): Promise<{ monitor: ChannelMonitor; run: ChannelMonitorRun } | null> {
    const current = this.monitors.get(monitorId);
    if (!current) return null;
    const run: ChannelMonitorRun = {
      id: String(++this.runSeq),
      monitorId,
      status: runInput.status,
      ok: runInput.ok,
      latencyMs: runInput.latencyMs,
      model: runInput.model,
      errorMessage: runInput.errorMessage,
      checkedAtIso: runInput.checkedAtIso,
    };
    this.runs.push(run);
    if (this.runs.length > MEMORY_CHANNEL_MONITOR_RUNS_LIMIT) {
      this.runs.splice(0, this.runs.length - MEMORY_CHANNEL_MONITOR_RUNS_LIMIT);
    }
    current.lastStatus = runInput.status;
    current.lastLatencyMs = runInput.latencyMs;
    current.lastError = runInput.errorMessage;
    current.lastCheckedAtIso = runInput.checkedAtIso;
    current.updatedAtIso = new Date().toISOString();
    const monitor = (await this.getMonitor(monitorId))!;
    return { monitor, run: { ...run } };
  }

  async listRuns(monitorId: string, limit: number): Promise<ChannelMonitorRun[]> {
    const clamped = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.runs
      .filter((r) => r.monitorId === monitorId)
      .sort((a, b) => Date.parse(b.checkedAtIso) - Date.parse(a.checkedAtIso) || Number(b.id) - Number(a.id))
      .slice(0, clamped)
      .map((r) => ({ ...r }));
  }

  async listRecentRunsBatch(monitorIds: string[], sinceIso: string): Promise<Map<string, ChannelMonitorRun[]>> {
    const out = new Map<string, ChannelMonitorRun[]>();
    if (monitorIds.length === 0) return out;
    const idSet = new Set(monitorIds);
    const sinceMs = Date.parse(sinceIso);
    for (const r of this.runs) {
      if (!idSet.has(r.monitorId)) continue;
      if (Date.parse(r.checkedAtIso) < sinceMs) continue;
      let arr = out.get(r.monitorId);
      if (!arr) {
        arr = [];
        out.set(r.monitorId, arr);
      }
      arr.push({ ...r });
    }
    return out;
  }

  async pruneRunsBefore(cutoffIso: string): Promise<number> {
    const cutoffMs = Date.parse(cutoffIso);
    let deleted = 0;
    for (let i = this.runs.length - 1; i >= 0; i--) {
      if (Date.parse(this.runs[i]!.checkedAtIso) < cutoffMs) {
        this.runs.splice(i, 1);
        deleted++;
      }
    }
    return deleted;
  }
}
