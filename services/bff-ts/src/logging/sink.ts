import type { SystemLogInsert, SystemLogStore } from "../store/system_logs_types.ts";
import { rawConsole } from "./logger.ts";

/**
 * Bounded, batched, asynchronous writer of system-log rows (Linksyncx OpsSystemLogSink).
 *
 * `enqueue` is O(1) and never waits: a full queue drops the entry and counts it (back-pressure). A
 * timer flushes up to `batchSize` rows per insert, `flushIntervalMs` after the first queued entry
 * (at once when a batch is full). A failed insert counts its rows as failed and opens a backoff
 * window (2 s doubling to 60 s) during which flushed batches are dropped rather than retried:
 * logs are best-effort observability and must not hold pool connections while the database is
 * struggling. At most one failure line per window goes to stderr (never back into the logger).
 */

export interface SystemLogSinkOptions {
  capacity?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  now?: () => number;
}

export interface SystemLogSinkCounters {
  queueDepth: number;
  queueCapacity: number;
  droppedCount: number;
  writeFailedCount: number;
  writtenCount: number;
  avgWriteDelayMs: number;
  lastError: string;
  lastFlushAtIso: string | null;
}

export const SYSTEM_LOG_QUEUE_CAPACITY = 5_000;
export const SYSTEM_LOG_BATCH_SIZE = 200;
export const SYSTEM_LOG_FLUSH_INTERVAL_MS = 1_000;
export const SYSTEM_LOG_BACKOFF_BASE_MS = 2_000;
export const SYSTEM_LOG_BACKOFF_MAX_MS = 60_000;

export class SystemLogSink {
  private queue: SystemLogInsert[] = [];
  private readonly capacity: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private stopped = false;
  private failures = 0;
  private suppressedUntil = 0;
  private dropped = 0;
  private writeFailed = 0;
  private written = 0;
  private writtenBatches = 0;
  private totalDelayMs = 0;
  private lastError = "";
  private lastFlushAtMs: number | null = null;

  constructor(
    private readonly store: SystemLogStore,
    options: SystemLogSinkOptions = {},
  ) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? SYSTEM_LOG_QUEUE_CAPACITY));
    this.batchSize = Math.max(1, Math.floor(options.batchSize ?? SYSTEM_LOG_BATCH_SIZE));
    this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? SYSTEM_LOG_FLUSH_INTERVAL_MS);
    this.backoffBaseMs = Math.max(1, options.backoffBaseMs ?? SYSTEM_LOG_BACKOFF_BASE_MS);
    this.backoffMaxMs = Math.max(this.backoffBaseMs, options.backoffMaxMs ?? SYSTEM_LOG_BACKOFF_MAX_MS);
    this.now = options.now ?? Date.now;
  }

  /** True when the next entry would be dropped (callers skip building it). */
  get full(): boolean {
    return this.stopped || this.queue.length >= this.capacity;
  }

  /** Counts entries discarded before reaching the queue (e.g. the full check above). */
  countDropped(n = 1): void {
    this.dropped += n;
  }

  /** Queues one row; false (and counted) when the queue is full or the sink stopped. */
  enqueue(row: SystemLogInsert): boolean {
    if (this.full) {
      this.dropped++;
      return false;
    }
    this.queue.push(row);
    this.schedule();
    return true;
  }

  /** Backoff after the `failures`-th consecutive failed insert: base doubling up to the max. */
  backoffFor(failures: number): number {
    let backoff = this.backoffBaseMs;
    for (let i = 1; i < failures && backoff < this.backoffMaxMs; i++) backoff *= 2;
    return Math.min(backoff, this.backoffMaxMs);
  }

  private schedule(): void {
    if (this.timer || this.flushing || this.stopped) return;
    const delay = this.queue.length >= this.batchSize ? 0 : this.flushIntervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Writes everything queued so far (joins a flush in progress). Never throws. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flushing ??= this.drain().finally(() => {
      this.flushing = null;
      if (this.queue.length > 0) this.schedule();
    });
    return this.flushing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      await this.writeBatch(batch);
    }
  }

  private async writeBatch(batch: SystemLogInsert[]): Promise<void> {
    const started = this.now();
    if (started < this.suppressedUntil) {
      this.dropped += batch.length;
      return;
    }
    try {
      const inserted = await this.store.insertSystemLogs(batch);
      this.failures = 0;
      this.suppressedUntil = 0;
      this.written += inserted;
      this.writtenBatches++;
      this.totalDelayMs += Math.max(0, this.now() - started);
      this.lastError = "";
      this.lastFlushAtMs = this.now();
    } catch (err) {
      this.failures++;
      const backoff = this.backoffFor(this.failures);
      this.suppressedUntil = this.now() + backoff;
      this.writeFailed += batch.length;
      this.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      rawConsole.warn(
        `${new Date().toISOString()} WARN  [system-log] sink flush failed: ${this.lastError} (batch=${batch.length} failures=${this.failures} backoff=${backoff}ms)`,
      );
    }
  }

  /** Stops accepting entries and writes what is queued (process shutdown). */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.flush();
  }

  counters(): SystemLogSinkCounters {
    return {
      queueDepth: this.queue.length,
      queueCapacity: this.capacity,
      droppedCount: this.dropped,
      writeFailedCount: this.writeFailed,
      writtenCount: this.written,
      avgWriteDelayMs: this.writtenBatches > 0 ? Math.round(this.totalDelayMs / this.writtenBatches) : 0,
      lastError: this.lastError,
      lastFlushAtIso: this.lastFlushAtMs === null ? null : new Date(this.lastFlushAtMs).toISOString(),
    };
  }
}
