import type { ChannelMonitor, ChannelMonitorRun } from "@slipgate/contracts";
import { probeAccount, type ProbeTarget } from "../autotest.ts";
import { logger } from "../logging/logger.ts";
import {
  statusFromProbe,
  type ChannelMonitorProbeFn,
} from "../store/channel_monitors_types.ts";
import type { ControlStore } from "../store/types.ts";

export interface ChannelMonitorServiceOptions {
  store: ControlStore;
  probeTarget: () => ProbeTarget | null;
  syncDataPlane: () => Promise<void>;
  probeMonitor?: ChannelMonitorProbeFn;
  tickIntervalMs?: number;
}

const activeServices = new Set<ChannelMonitorService>();

export function stopChannelMonitorServices(): void {
  for (const svc of activeServices) svc.stop();
}

const RUN_RETENTION_MS = 7 * 86_400_000;
const MAX_CONCURRENCY = 3;

export class ChannelMonitorService {
  private readonly store: ControlStore;
  private readonly probeTarget: () => ProbeTarget | null;
  private readonly syncDataPlane: () => Promise<void>;
  private readonly probeFn?: ChannelMonitorProbeFn;
  private readonly tickIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastPruneAtMs = 0;

  constructor(opts: ChannelMonitorServiceOptions) {
    this.store = opts.store;
    this.probeTarget = opts.probeTarget;
    this.syncDataPlane = opts.syncDataPlane;
    this.probeFn = opts.probeMonitor;
    this.tickIntervalMs = opts.tickIntervalMs ?? 30_000;
    activeServices.add(this);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        logger.warn("channel-monitor", "scheduled probe tick failed", { error: err });
      });
    }, this.tickIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    activeServices.delete(this);
  }

  async runProbe(monitorId: string): Promise<{ monitor: ChannelMonitor; run: ChannelMonitorRun } | null> {
    const monitor = await this.store.channelMonitors.getMonitor(monitorId);
    if (!monitor) return null;

    let ok = false;
    let latencyMs = 0;
    let usedModel = monitor.model;
    let message = "";

    const started = Date.now();
    try {
      if (this.probeFn) {
        const res = await this.probeFn(monitor);
        ok = Boolean(res.ok);
        latencyMs = Math.max(0, Math.round(res.latencyMs));
        usedModel = res.model || monitor.model;
        message = res.message || "";
      } else {
        const target = this.probeTarget();
        if (!target) {
          ok = false;
          latencyMs = 0;
          message = "Network service unavailable in standalone mode";
        } else {
          await this.syncDataPlane().catch(() => undefined);
          const res = await probeAccount(target, monitor.accountId, monitor.model);
          ok = res.ok;
          latencyMs = Math.max(0, Math.round(res.durationMs));
          usedModel = res.model || monitor.model;
          message = res.message || "";
        }
      }
    } catch (err) {
      ok = false;
      latencyMs = Math.max(0, Date.now() - started);
      message = err instanceof Error ? err.message : String(err);
    }

    const status = statusFromProbe(ok, latencyMs, monitor.degradedLatencyMs);
    return this.store.channelMonitors.recordRun(monitor.id, {
      status,
      ok,
      latencyMs,
      model: usedModel,
      errorMessage: ok ? "" : message.slice(0, 500),
      checkedAtIso: new Date().toISOString(),
    });
  }

  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let ran = 0;
    try {
      const nowMs = Date.now();
      const monitors = await this.store.channelMonitors.listMonitors({ enabledOnly: true });
      const due = monitors.filter((m) => {
        if (!m.lastCheckedAtIso) return true;
        return nowMs - Date.parse(m.lastCheckedAtIso) >= m.intervalSeconds * 1000;
      });
      for (let i = 0; i < due.length; i += MAX_CONCURRENCY) {
        const chunk = due.slice(i, i + MAX_CONCURRENCY);
        await Promise.all(
          chunk.map(async (m) => {
            await this.runProbe(m.id);
            ran++;
          }),
        );
      }
      if (nowMs - this.lastPruneAtMs >= 3_600_000) {
        this.lastPruneAtMs = nowMs;
        await this.store.channelMonitors.pruneRunsBefore(new Date(nowMs - RUN_RETENTION_MS).toISOString());
      }
    } finally {
      this.ticking = false;
    }
    return ran;
  }
}
