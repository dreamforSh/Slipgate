import { hostname } from "node:os";
import type {
  RuntimeLogConfig,
  SystemLogForwarderHealth,
  SystemLogIngestRequest,
  SystemLogLevel,
  SystemLogSinkHealth,
  SystemLogSource,
  UpdateRuntimeLogConfigRequest,
} from "@slipgate/contracts";
import { redactLogContext, redactLogText } from "../insights.ts";
import type { SystemLogInsert, SystemLogStore } from "../store/system_logs_types.ts";
import { StoreError } from "../store/types.ts";
import { LogSampler, logTo, passesLevel, shouldStore, isAuditComponent, type LogDestination, type LogEvent } from "./logger.ts";
import {
  baselineRuntimeLogConfig,
  editableFields,
  mergeRuntimeLogConfig,
  resolveRuntimeLogConfig,
  type EditableRuntimeLogConfig,
} from "./runtime_config.ts";
import { SystemLogSink, type SystemLogSinkOptions } from "./sink.ts";

/**
 * One app's system-log pipeline: runtime config (baseline + saved override), the batched sink,
 * the ingest of slipgate-net's forwarded lines, forwarder health and the retention sweep.
 */

export const SYSTEM_LOG_MESSAGE_MAX = 8_192;
export const SYSTEM_LOG_CONTEXT_MAX = 16_384;
/** Saved-config re-read (other instances' changes) and retention cadence of a started service. */
export const RUNTIME_LOG_CONFIG_REFRESH_MS = 30_000;
export const SYSTEM_LOG_RETENTION_STARTUP_DELAY_MS = 2 * 60_000;
export const SYSTEM_LOG_RETENTION_INTERVAL_MS = 60 * 60_000;
/** Forwarder reports kept (one per host) and how long one stays listed. */
const MAX_FORWARDERS = 32;
const FORWARDER_REPORT_TTL_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
/** Forwarded timestamps further ahead than this are clamped to the receive time. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/** Fields lifted into their own columns (both spellings), removed from the stored context. */
const LIFTED = new Set([
  "requestId",
  "request_id",
  "clientRequestId",
  "client_request_id",
  "userId",
  "user_id",
  "apiKeyId",
  "api_key_id",
  "accountId",
  "account_id",
  "platform",
  "model",
  "component",
]);

function text(v: unknown, max: number): string {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  return s.slice(0, max);
}

function nullableId(v: unknown): string | null {
  return text(v, 64) || null;
}

function stringifyContext(ctx: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(ctx, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)) ?? "{}";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
  if (json.length <= SYSTEM_LOG_CONTEXT_MAX) return json;
  return JSON.stringify({ truncated: true, bytes: json.length, preview: json.slice(0, 2_048) });
}

export function hostName(): string {
  try {
    const h = hostname().trim();
    return h ? h.slice(0, 255) : "unknown";
  } catch {
    return "unknown";
  }
}

interface RowInput {
  timeMs: number;
  level: SystemLogLevel;
  source: SystemLogSource;
  component: string;
  host: string;
  message: string;
  fields: Record<string, unknown>;
  requestId: string;
  clientRequestId: string;
  userId: string | null;
  caller?: string | null;
  stack?: string | null;
}

/** The stored row: column fields lifted, message and context redacted and size-capped. */
export function toSystemLogInsert(input: RowInput): SystemLogInsert {
  const f = input.fields;
  const context: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) if (!LIFTED.has(k)) context[k] = v;
  if (input.caller) context.caller = input.caller;
  if (input.stack) context.stack = input.stack;
  const message = redactLogText(input.message.trim()).slice(0, SYSTEM_LOG_MESSAGE_MAX);
  return {
    createdAtIso: new Date(input.timeMs).toISOString(),
    level: input.level,
    source: input.source,
    component: text(input.component, 128) || "app",
    host: input.host.slice(0, 255),
    message: message || "(empty)",
    requestId: text(input.requestId, 128),
    clientRequestId: text(input.clientRequestId, 128),
    userId: input.userId ? input.userId.slice(0, 64) : null,
    apiKeyId: nullableId(f.apiKeyId ?? f.api_key_id),
    accountId: nullableId(f.accountId ?? f.account_id),
    platform: text(f.platform, 32),
    model: text(f.model, 128),
    contextJson: Object.keys(context).length ? stringifyContext(redactLogContext(context)) : "{}",
  };
}

type ForwarderReport = SystemLogForwarderHealth & { host: string; reportedAtMs: number };

export interface SystemLogServiceOptions {
  env?: Record<string, string | undefined>;
  host?: string;
  sink?: SystemLogSinkOptions;
  now?: () => number;
}

export interface SystemLogIngestOutcome {
  accepted: number;
  filtered: number;
  dropped: number;
}

type TimerHandle = ReturnType<typeof setTimeout>;
function unref<T extends TimerHandle | ReturnType<typeof setInterval>>(t: T): T {
  (t as { unref?: () => void }).unref?.();
  return t;
}

const started = new Set<SystemLogService>();

/** Stops every started service: timers cleared, queued entries written (process shutdown). */
export async function stopSystemLogServices(): Promise<void> {
  await Promise.all([...started].map((s) => s.stop()));
}

export class SystemLogService implements LogDestination {
  readonly host: string;
  readonly sink: SystemLogSink;
  private readonly baseline: RuntimeLogConfig;
  private config: RuntimeLogConfig;
  private readonly sampler = new LogSampler();
  private readonly forwarders = new Map<string, ForwarderReport>();
  private readonly now: () => number;
  private loaded = false;
  private loading: Promise<RuntimeLogConfig> | null = null;
  /** Bumped by every applied save or reset: a re-read started before it must not undo it. */
  private generation = 0;
  private timers: (TimerHandle | ReturnType<typeof setInterval>)[] = [];
  private pruning: Promise<number> | null = null;

  constructor(
    private readonly store: SystemLogStore,
    options: SystemLogServiceOptions = {},
  ) {
    this.host = options.host ?? hostName();
    this.now = options.now ?? Date.now;
    this.baseline = baselineRuntimeLogConfig(options.env ?? process.env);
    this.config = { ...this.baseline };
    this.sink = new SystemLogSink(store, { now: this.now, ...options.sink });
  }

  /* ---------------------------- LogDestination ---------------------------- */

  runtimeConfig(): RuntimeLogConfig {
    return this.config;
  }

  sample(level: SystemLogLevel, component: string, message: string): boolean {
    const cfg = this.config;
    return this.sampler.allow(`${level}|${component}|${message}`, cfg.samplingInitial, cfg.samplingThereafter, this.now());
  }

  accept(event: LogEvent): boolean {
    try {
      if (this.sink.full) {
        this.sink.countDropped();
        return false;
      }
      return this.sink.enqueue(
        toSystemLogInsert({
          timeMs: event.timeMs,
          level: event.level,
          source: "bff",
          component: event.component,
          host: this.host,
          message: event.message,
          fields: event.fields,
          requestId: event.requestId,
          clientRequestId: event.clientRequestId,
          userId: event.userId,
          caller: event.caller,
          stack: event.stack,
        }),
      );
    } catch {
      this.sink.countDropped();
      return false;
    }
  }

  /* ---------------------------- runtime config ---------------------------- */

  /** The effective config, reading the saved override once (retried after a failed read). */
  ensureLoaded(): Promise<RuntimeLogConfig> {
    if (this.loaded) return Promise.resolve(this.config);
    return this.reload();
  }

  /**
   * Re-reads the saved override (a change made through another instance applies here). A save or
   * reset applied here while the read was in flight wins: the read's older result is discarded.
   */
  reload(): Promise<RuntimeLogConfig> {
    this.loading ??= (async () => {
      const generation = this.generation;
      try {
        const saved = await this.store.getRuntimeLogConfig();
        if (generation === this.generation) {
          this.config = resolveRuntimeLogConfig(saved, this.baseline);
          this.loaded = true;
        }
        return this.config;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  /** Applies a config this instance just saved (or reset to). */
  private apply(config: RuntimeLogConfig): void {
    this.generation++;
    this.config = config;
    this.loaded = true;
  }

  /**
   * Merges `patch` over the saved config, saves it and applies it at once. The merge reads the
   * store first (the cache may be up to 30 s old, and another instance may have changed a field
   * this partial update does not touch); if that read fails, the cached config is the base.
   */
  async update(patch: UpdateRuntimeLogConfigRequest, operatorId: string): Promise<RuntimeLogConfig> {
    const old = await this.reload().catch(() => this.ensureLoaded());
    let next: EditableRuntimeLogConfig;
    try {
      next = mergeRuntimeLogConfig(old, patch);
    } catch (err) {
      this.auditFailure(operatorId, old, patch, `validation_failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new StoreError("bad_request", "Invalid runtime log config");
    }
    const doc = { ...next, updatedAtIso: new Date(this.now()).toISOString(), updatedBy: operatorId };
    try {
      await this.store.setRuntimeLogConfig(doc);
    } catch (err) {
      this.auditFailure(operatorId, old, next, `persist_failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    this.apply(resolveRuntimeLogConfig(doc, this.baseline));
    this.auditChange(operatorId, old, this.config, "updated");
    return this.config;
  }

  /** Drops the saved override: the environment baseline applies again. */
  async reset(operatorId: string): Promise<RuntimeLogConfig> {
    const old = await this.ensureLoaded();
    try {
      await this.store.setRuntimeLogConfig(null);
    } catch (err) {
      this.auditFailure(operatorId, old, editableFields(this.baseline), `reset_persist_failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    this.apply({ ...this.baseline });
    const out: RuntimeLogConfig = { ...this.baseline, updatedAtIso: new Date(this.now()).toISOString(), updatedBy: operatorId };
    this.auditChange(operatorId, old, out, "reset");
    return out;
  }

  private auditChange(operatorId: string, old: RuntimeLogConfig, next: RuntimeLogConfig, action: string): void {
    logTo(this, "info", "audit.log_config_change", "runtime log config changed", {
      action,
      operatorId,
      old: editableFields(old),
      new: editableFields(next),
    });
  }

  private auditFailure(operatorId: string, old: RuntimeLogConfig, attempted: unknown, reason: string): void {
    logTo(this, "warn", "audit.log_config_change", "runtime log config change failed", {
      action: "failed",
      operatorId,
      reason,
      old: editableFields(old),
      new: attempted,
    });
  }

  /* ------------------------------- ingest -------------------------------- */

  /**
   * Entries forwarded by slipgate-net (its own and slipgate-core's lines): filtered by the runtime
   * level, sampling and what is worth storing, redacted, then queued like the BFF's own.
   */
  ingest(req: SystemLogIngestRequest): SystemLogIngestOutcome {
    const nowMs = this.now();
    const host = req.host || "unknown";
    if (req.health) this.recordForwarder(host, req.health, nowMs);
    const cfg = this.config;
    let accepted = 0;
    let filtered = 0;
    let dropped = 0;
    for (const entry of req.entries) {
      const component = entry.component || entry.source;
      if (!passesLevel(entry.level, component, cfg.level) || !shouldStore(entry.level, component, cfg.persistAccessLogs)) {
        filtered++;
        continue;
      }
      if (cfg.enableSampling && !isAuditComponent(component) && !this.sample(entry.level, component, entry.message)) {
        filtered++;
        continue;
      }
      if (this.sink.full) {
        this.sink.countDropped();
        dropped++;
        continue;
      }
      let timeMs = entry.timeIso ? Date.parse(entry.timeIso) : nowMs;
      if (!Number.isFinite(timeMs) || timeMs > nowMs + MAX_CLOCK_SKEW_MS) timeMs = nowMs;
      const row = toSystemLogInsert({
        timeMs,
        level: entry.level,
        source: entry.source,
        component,
        host,
        message: entry.message,
        fields: {
          ...(entry.context ?? {}),
          apiKeyId: entry.apiKeyId,
          accountId: entry.accountId,
          platform: entry.platform,
          model: entry.model,
        },
        requestId: entry.requestId,
        clientRequestId: entry.clientRequestId,
        userId: entry.userId || null,
      });
      if (this.sink.enqueue(row)) accepted++;
      else dropped++;
    }
    return { accepted, filtered, dropped };
  }

  private recordForwarder(host: string, health: SystemLogForwarderHealth, nowMs: number): void {
    this.forwarders.delete(host);
    this.forwarders.set(host, { ...health, host, reportedAtMs: nowMs });
    while (this.forwarders.size > MAX_FORWARDERS) {
      const oldest = this.forwarders.keys().next().value;
      if (oldest === undefined) break;
      this.forwarders.delete(oldest);
    }
  }

  health(): SystemLogSinkHealth {
    const nowMs = this.now();
    const forwarders = [...this.forwarders.values()]
      .filter((f) => nowMs - f.reportedAtMs <= FORWARDER_REPORT_TTL_MS)
      .sort((a, b) => b.reportedAtMs - a.reportedAtMs)
      .map(({ reportedAtMs, ...f }) => ({ ...f, source: "net" as const, reportedAtIso: new Date(reportedAtMs).toISOString() }));
    return {
      host: this.host,
      ...this.sink.counters(),
      sampledOutCount: this.sampler.sampledOut,
      forwarders,
    };
  }

  /* ------------------------------ retention ------------------------------ */

  /** Deletes entries older than the retention (bounded batches in the store). Joins a run in flight. */
  prune(): Promise<number> {
    this.pruning ??= (async () => {
      try {
        const cfg = await this.ensureLoaded().catch(() => this.config);
        const cutoff = new Date(this.now() - cfg.retentionDays * DAY_MS).toISOString();
        return await this.store.pruneSystemLogs(cutoff);
      } finally {
        this.pruning = null;
      }
    })();
    return this.pruning;
  }

  private async pruneLogged(): Promise<void> {
    try {
      const deleted = await this.prune();
      if (deleted > 0) logTo(this, "info", "system-log", `retention removed ${deleted} entries`, { deleted });
    } catch (err) {
      logTo(this, "warn", "system-log", "system log retention failed", { error: err });
    }
  }

  /** Server only: periodic config re-read and the hourly retention (timers never hold the process). */
  start(): void {
    if (started.has(this)) return;
    started.add(this);
    this.timers.push(
      unref(
        setInterval(() => {
          void this.reload().catch(() => undefined);
        }, RUNTIME_LOG_CONFIG_REFRESH_MS),
      ),
      unref(
        setTimeout(() => {
          void this.pruneLogged();
          this.timers.push(unref(setInterval(() => void this.pruneLogged(), SYSTEM_LOG_RETENTION_INTERVAL_MS)));
        }, SYSTEM_LOG_RETENTION_STARTUP_DELAY_MS),
      ),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearTimeout(t as TimerHandle);
    this.timers = [];
    started.delete(this);
    await this.sink.stop();
  }
}
