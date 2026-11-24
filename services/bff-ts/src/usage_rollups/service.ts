import { logger } from "../logging/logger.ts";
import type { ControlStore } from "../store/types.ts";

const activeServices = new Set<UsageRollupService>();

export function stopUsageRollupServices(): void {
  for (const svc of activeServices) svc.stop();
}

export interface UsageRollupServiceOptions {
  store: ControlStore;
  rollupIntervalMs?: number;
  cleanupIntervalMs?: number;
}

export class UsageRollupService {
  private readonly store: ControlStore;
  private readonly rollupIntervalMs: number;
  private readonly cleanupIntervalMs: number;
  private rollupTimer: ReturnType<typeof setInterval> | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: UsageRollupServiceOptions) {
    this.store = opts.store;
    this.rollupIntervalMs = opts.rollupIntervalMs ?? 15 * 60_000;
    this.cleanupIntervalMs = opts.cleanupIntervalMs ?? 6 * 3_600_000;
    activeServices.add(this);
  }

  start(): void {
    if (!this.rollupTimer) {
      this.rollupTimer = setInterval(() => {
        void this.runRollupTick().catch((err) => {
          logger.warn("usage_rollups", "periodic rollup failed", { error: err });
        });
      }, this.rollupIntervalMs);
      if (typeof (this.rollupTimer as { unref?: () => void }).unref === "function") {
        (this.rollupTimer as { unref: () => void }).unref();
      }
    }
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(() => {
        void this.runCleanupTick().catch((err) => {
          logger.warn("usage_rollups", "periodic retention cleanup failed", { error: err });
        });
      }, this.cleanupIntervalMs);
      if (typeof (this.cleanupTimer as { unref?: () => void }).unref === "function") {
        (this.cleanupTimer as { unref: () => void }).unref();
      }
    }
  }

  stop(): void {
    if (this.rollupTimer) {
      clearInterval(this.rollupTimer);
      this.rollupTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    activeServices.delete(this);
  }

  async runRollupTick(): Promise<void> {
    const status = await this.store.usageRollups.getStatus();
    if (!status.rollupEnabled) return;
    const until = new Date();
    const since = new Date(until.getTime() - 48 * 3_600_000);
    await this.store.usageRollups.backfill({
      sinceIso: since.toISOString(),
      untilIso: until.toISOString(),
      granularity: "both",
    });
  }

  async runCleanupTick(): Promise<void> {
    const status = await this.store.usageRollups.getStatus();
    if (!status.rollupEnabled || status.usageRetentionDays <= 0) return;
    await this.store.usageRollups.cleanupUsageLogs({ dryRun: false });
  }
}
