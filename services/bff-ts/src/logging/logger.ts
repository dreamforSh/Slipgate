import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import { SYSTEM_LOG_LEVEL_RANK, type RuntimeLogConfig, type SystemLogLevel } from "@slipgate/contracts";
import { redactLogContext, redactLogText } from "../insights.ts";
import { baselineRuntimeLogConfig } from "./runtime_config.ts";

/**
 * Structured logging for slipgate-bff.
 *
 * `logger.warn("component", "message", { field: value })` prints one line to the console and, for
 * entries worth keeping (warnings and errors, `audit*` components, and `http.access` when the
 * runtime config persists access logs), hands the event to the system-log destination of the
 * current request's app (or the process default the server registers), which redacts it and queues
 * it for a batched insert. Entries written before the server registers its default (startup) are
 * held, at most PENDING_LOG_EVENTS_MAX of them, and handed over when it does. Logging never throws
 * and never waits on the database.
 *
 * Existing `console.warn` / `console.error` call sites are captured by `installConsoleCapture()`
 * (server entrypoint only): their output is printed unchanged and stored like logger entries, with
 * a leading `[tag]` read as the component.
 */

export type LogFields = Record<string, unknown>;

/** One emitted entry, with the request context merged in; redaction happens at the destination. */
export interface LogEvent {
  timeMs: number;
  level: SystemLogLevel;
  component: string;
  message: string;
  fields: LogFields;
  requestId: string;
  clientRequestId: string;
  userId: string | null;
  /** Calling source location (when the runtime config records callers). */
  caller: string | null;
  /** Stack trace for error entries (when the runtime config attaches them). */
  stack: string | null;
}

/** Where stored entries go: the system-log service of one app. */
export interface LogDestination {
  /** Effective runtime config (level, sampling, caller, stack traces, access logs). */
  runtimeConfig(): RuntimeLogConfig;
  /** Sampling decision for a non-audit entry (counts what it skips). */
  sample(level: SystemLogLevel, component: string, message: string): boolean;
  /** Queues an entry for storage; returns false when it was dropped. Never throws. */
  accept(event: LogEvent): boolean;
}

/** Per-request context: correlation ids and the app's destination. */
export interface RequestLogContext {
  requestId: string;
  clientRequestId: string;
  method: string;
  path: string;
  /** Resolved when an entry is written (the session is checked after the context starts). */
  userId: () => string | null;
  destination: LogDestination | null;
  /** Set once the request's failure was logged, so the access middleware does not log it twice. */
  errorLogged: boolean;
}

const requestContext = new AsyncLocalStorage<RequestLogContext>();
let defaultDestination: LogDestination | null = null;
let fallbackConfig: RuntimeLogConfig | null = null;

/** The console methods as they were before capture (the logger and the sink print through these). */
export const rawConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

export function runWithRequestLog<T>(ctx: RequestLogContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

export function currentRequestLog(): RequestLogContext | undefined {
  return requestContext.getStore();
}

/**
 * Store-worthy entries written before any destination exists (the server's startup: weak-secret
 * warnings, store or plugin init failures), kept until the first default destination is set.
 */
export const PENDING_LOG_EVENTS_MAX = 200;
let pending: LogEvent[] = [];
let pendingDropped = 0;

function holdPending(event: LogEvent): void {
  if (pending.length >= PENDING_LOG_EVENTS_MAX) {
    pendingDropped++;
    return;
  }
  pending.push(event);
}

/**
 * The destination for entries written outside any request (the server's app). Setting one hands
 * it the entries held since startup, filtered by its runtime config.
 */
export function setDefaultLogDestination(dest: LogDestination | null): void {
  defaultDestination = dest;
  if (!dest || (pending.length === 0 && pendingDropped === 0)) return;
  const held = pending;
  const dropped = pendingDropped;
  pending = [];
  pendingDropped = 0;
  try {
    const cfg = dest.runtimeConfig();
    for (const event of held) {
      if (passesLevel(event.level, event.component, cfg.level) && shouldStore(event.level, event.component, cfg.persistAccessLogs)) {
        dest.accept(event);
      }
    }
    if (dropped > 0) {
      dest.accept({
        timeMs: Date.now(),
        level: "warn",
        component: "system-log",
        message: `${dropped} log entries written before startup finished were not kept (limit ${PENDING_LOG_EVENTS_MAX})`,
        fields: { dropped },
        requestId: "",
        clientRequestId: "",
        userId: null,
        caller: null,
        stack: null,
      });
    }
  } catch {
    // Logging must never break the server start.
  }
}

export function getDefaultLogDestination(): LogDestination | null {
  return defaultDestination;
}

function destinationNow(): LogDestination | null {
  return requestContext.getStore()?.destination ?? defaultDestination;
}

function configOf(dest: LogDestination | null): RuntimeLogConfig {
  if (dest) return dest.runtimeConfig();
  fallbackConfig ??= baselineRuntimeLogConfig(process.env);
  return fallbackConfig;
}

export function isAuditComponent(component: string): boolean {
  return component.toLowerCase().includes("audit");
}

export function isAccessComponent(component: string): boolean {
  return component.toLowerCase().includes("http.access");
}

/**
 * Whether an entry is stored (Linksyncx OpsSystemLogSink.shouldIndex): warnings and errors always,
 * audit components always, access entries only while access logs are persisted.
 */
export function shouldStore(level: SystemLogLevel, component: string, persistAccessLogs: boolean): boolean {
  if (SYSTEM_LOG_LEVEL_RANK[level] >= SYSTEM_LOG_LEVEL_RANK.warn) return true;
  if (isAccessComponent(component)) return persistAccessLogs;
  return isAuditComponent(component);
}

/** Whether `level` passes the runtime minimum level; audit entries always do. */
export function passesLevel(level: SystemLogLevel, component: string, min: SystemLogLevel): boolean {
  return isAuditComponent(component) || SYSTEM_LOG_LEVEL_RANK[level] >= SYSTEM_LOG_LEVEL_RANK[min];
}

/** Per second and key: the first `initial` entries, then every `thereafter`-th (zap's sampler). */
export class LogSampler {
  private second = 0;
  private counts = new Map<string, number>();
  sampledOut = 0;

  allow(key: string, initial: number, thereafter: number, nowMs = Date.now()): boolean {
    const second = Math.floor(nowMs / 1000);
    if (second !== this.second || this.counts.size >= 10_000) {
      this.second = second;
      this.counts = new Map();
    }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n <= initial || (n - initial) % Math.max(1, thereafter) === 0) return true;
    this.sampledOut++;
    return false;
  }
}

const fallbackSampler = new LogSampler();

const LOGGER_FRAME = /[\\/]logging[\\/]logger\.ts|node:|native/;

/** First stack frame outside this module ("file:line:col"), or null. */
function callerOf(stack: string | undefined): string | null {
  if (!stack) return null;
  for (const line of stack.split("\n").slice(1)) {
    if (LOGGER_FRAME.test(line)) continue;
    const m = /\(?((?:[A-Za-z]:)?[^():\s]+:\d+:\d+)\)?\s*$/.exec(line.trim());
    if (m?.[1]) {
      const file = m[1].replace(/\\/g, "/");
      const at = file.lastIndexOf("/src/");
      return at >= 0 ? file.slice(at + 1) : file;
    }
  }
  return null;
}

/** Stack frames below the logger itself (for error entries logged without an Error). */
function callSiteStack(stack: string | undefined): string | null {
  if (!stack) return null;
  const frames = stack
    .split("\n")
    .slice(1)
    .filter((l) => !LOGGER_FRAME.test(l))
    .slice(0, 12);
  return frames.length ? frames.map((l) => l.trim()).join("\n") : null;
}

/** Errors become `{ error: message }` plus a separate stack; other values pass unchanged. */
function normalizeFields(fields: LogFields | undefined): { fields: LogFields; errorStack: string | null } {
  if (!fields) return { fields: {}, errorStack: null };
  const out: LogFields = {};
  let errorStack: string | null = null;
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      out[k] = v.message || v.name;
      errorStack ??= v.stack ?? null;
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return { fields: out, errorStack };
}

function stringField(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

interface EmitOptions {
  /** False for captured console calls (already printed by the original method). */
  print?: boolean;
  /** Stack of an Error passed to a captured console call. */
  errorStack?: string | null;
  /** Explicit destination (a service logging about itself), instead of the request's / default one. */
  destination?: LogDestination;
}

/** One console line, redacted like the stored entry (container logs are shipped and kept too). */
function printLine(level: SystemLogLevel, component: string, message: string, fields: LogFields, requestId: string): void {
  let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${component}] ${redactLogText(message)}`;
  if (requestId) line += ` request_id=${requestId}`;
  if (Object.keys(fields).length > 0) {
    try {
      line += ` ${JSON.stringify(redactLogContext(fields), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`;
    } catch {
      // Circular or BigInt-laden fields: the line keeps the message.
    }
  }
  const write = level === "error" ? rawConsole.error : level === "warn" ? rawConsole.warn : level === "debug" ? rawConsole.debug : rawConsole.log;
  write(line);
}

function emit(level: SystemLogLevel, component: string, message: string, rawFields: LogFields | undefined, opts: EmitOptions = {}): void {
  try {
    const comp = component.trim() || "app";
    const ctx = requestContext.getStore();
    const dest = opts.destination ?? ctx?.destination ?? defaultDestination;
    const cfg = configOf(dest);
    if (!passesLevel(level, comp, cfg.level)) return;
    if (cfg.enableSampling && !isAuditComponent(comp)) {
      const allowed = dest
        ? dest.sample(level, comp, message)
        : fallbackSampler.allow(`${level}|${comp}|${message}`, cfg.samplingInitial, cfg.samplingThereafter);
      if (!allowed) return;
    }
    const { fields, errorStack } = normalizeFields(rawFields);
    const requestId = stringField(fields.requestId ?? fields.request_id) || ctx?.requestId || "";
    if (opts.print !== false) printLine(level, comp, message, fields, requestId);
    if (!shouldStore(level, comp, cfg.persistAccessLogs)) return;

    const needStack = level === "error" && cfg.stacktraceLevel === "error";
    const probe = cfg.caller || (needStack && !errorStack && !opts.errorStack) ? new Error().stack : undefined;
    let userId: string | null = stringField(fields.userId ?? fields.user_id) || null;
    if (!userId && ctx) {
      try {
        userId = ctx.userId();
      } catch {
        userId = null;
      }
    }
    if (ctx) {
      fields.method ??= ctx.method;
      fields.path ??= ctx.path;
    }
    const event: LogEvent = {
      timeMs: Date.now(),
      level,
      component: comp,
      message,
      fields,
      requestId,
      clientRequestId: stringField(fields.clientRequestId ?? fields.client_request_id) || ctx?.clientRequestId || "",
      userId,
      caller: cfg.caller ? callerOf(probe) : null,
      stack: needStack ? (opts.errorStack ?? errorStack ?? callSiteStack(probe)) : null,
    };
    // Before the server registers its destination (startup), the entry waits for it.
    if (dest) dest.accept(event);
    else holdPending(event);
  } catch {
    // Logging must never break the caller.
  }
}

export const logger = {
  debug(component: string, message: string, fields?: LogFields): void {
    emit("debug", component, message, fields);
  },
  info(component: string, message: string, fields?: LogFields): void {
    emit("info", component, message, fields);
  },
  warn(component: string, message: string, fields?: LogFields): void {
    emit("warn", component, message, fields);
  },
  error(component: string, message: string, fields?: LogFields): void {
    emit("error", component, message, fields);
  },
  log(level: SystemLogLevel, component: string, message: string, fields?: LogFields): void {
    emit(level, component, message, fields);
  },
};

/** Logs to a given destination (a service reporting on itself, inside or outside a request). */
export function logTo(dest: LogDestination, level: SystemLogLevel, component: string, message: string, fields?: LogFields): void {
  emit(level, component, message, fields, { destination: dest });
}

/* ------------------------------------------------------------------------------------------ */
/* console.warn / console.error capture                                                       */
/* ------------------------------------------------------------------------------------------ */

const TAG = /^\[([^\]\s]{1,64})\]\s*/;

/** Component and message of a captured console line: "[security] x" reads component "security". */
export function parseConsoleLine(text: string): { component: string; message: string } {
  const m = TAG.exec(text);
  if (!m?.[1]) return { component: "app", message: text };
  const tag = m[1].toLowerCase();
  return { component: tag === "slipgate-bff" ? "app" : tag, message: text.slice(m[0].length) || text };
}

let restoreConsole: (() => void) | null = null;

function captured(level: "warn" | "error", original: (...args: unknown[]) => void) {
  return (...args: unknown[]): void => {
    let text: string;
    try {
      text = format(...args);
    } catch {
      text = args.map(String).join(" ");
    }
    const { component, message } = parseConsoleLine(text);
    const cfg = configOf(destinationNow());
    // The runtime level applies to captured lines too (an "error" level silences console.warn).
    if (!passesLevel(level, component, cfg.level)) return;
    original(...args);
    const err = args.find((a): a is Error => a instanceof Error);
    emit(level, component, message, undefined, { print: false, errorStack: err?.stack ?? null });
  };
}

/** Routes console.warn / console.error through the logger (idempotent); returns the undo. */
export function installConsoleCapture(): () => void {
  if (restoreConsole) return restoreConsole;
  const prevWarn = console.warn;
  const prevError = console.error;
  console.warn = captured("warn", rawConsole.warn);
  console.error = captured("error", rawConsole.error);
  restoreConsole = () => {
    console.warn = prevWarn;
    console.error = prevError;
    restoreConsole = null;
  };
  return restoreConsole;
}
