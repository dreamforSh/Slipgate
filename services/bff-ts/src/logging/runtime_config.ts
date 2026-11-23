import {
  normalizeSystemLogLevel,
  RUNTIME_LOG_STACKTRACE_LEVELS,
  RuntimeLogConfigSchema,
  type RuntimeLogConfig,
  type UpdateRuntimeLogConfigRequest,
} from "@slipgate/contracts";

/**
 * Runtime log config (Linksyncx ops_log_runtime.go): the environment gives the baseline, an admin
 * can save an override (commerce.portal_settings 'ops_runtime_log_config') and reset back to it.
 *
 * Baseline environment variables (all optional):
 *   SLIPGATE_LOG_LEVEL                  debug | info | warn | error (default info)
 *   SLIPGATE_LOG_PERSIST_ACCESS         store one http.access entry per request (default false)
 *   SLIPGATE_LOG_SAMPLING               per-second sampling (default false)
 *   SLIPGATE_LOG_SAMPLING_INITIAL       default 100
 *   SLIPGATE_LOG_SAMPLING_THEREAFTER    default 100
 *   SLIPGATE_LOG_CALLER                 record the caller location (default true)
 *   SLIPGATE_LOG_STACKTRACE_LEVEL       none | error (default error)
 *   SLIPGATE_SYSTEM_LOG_RETENTION_DAYS  1..3650 (default 30)
 */

type Env = Record<string, string | undefined>;

export const DEFAULT_SYSTEM_LOG_RETENTION_DAYS = 30;

/** The fields an admin edits (the rest is provenance). */
export const EDITABLE_RUNTIME_LOG_FIELDS = [
  "level",
  "persistAccessLogs",
  "enableSampling",
  "samplingInitial",
  "samplingThereafter",
  "caller",
  "stacktraceLevel",
  "retentionDays",
] as const;
export type EditableRuntimeLogConfig = Pick<RuntimeLogConfig, (typeof EDITABLE_RUNTIME_LOG_FIELDS)[number]>;

function envBool(raw: string | undefined, fallback: boolean): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (["1", "t", "true", "yes", "on"].includes(v)) return true;
  if (["0", "f", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** The environment's config (what a reset returns to). */
export function baselineRuntimeLogConfig(env: Env): RuntimeLogConfig {
  const stack = (env.SLIPGATE_LOG_STACKTRACE_LEVEL ?? "").trim().toLowerCase();
  return {
    level: normalizeSystemLogLevel(env.SLIPGATE_LOG_LEVEL) ?? "info",
    persistAccessLogs: envBool(env.SLIPGATE_LOG_PERSIST_ACCESS, false),
    enableSampling: envBool(env.SLIPGATE_LOG_SAMPLING, false),
    samplingInitial: envInt(env.SLIPGATE_LOG_SAMPLING_INITIAL, 100, 1, 100_000),
    samplingThereafter: envInt(env.SLIPGATE_LOG_SAMPLING_THEREAFTER, 100, 1, 100_000),
    caller: envBool(env.SLIPGATE_LOG_CALLER, true),
    stacktraceLevel: (RUNTIME_LOG_STACKTRACE_LEVELS as readonly string[]).includes(stack)
      ? (stack as RuntimeLogConfig["stacktraceLevel"])
      : "error",
    retentionDays: envInt(env.SLIPGATE_SYSTEM_LOG_RETENTION_DAYS, DEFAULT_SYSTEM_LOG_RETENTION_DAYS, 1, 3650),
    source: "baseline",
    updatedAtIso: null,
    updatedBy: null,
  };
}

const fieldSchemas = RuntimeLogConfigSchema.shape;

/**
 * The saved document over the baseline: each valid editable field wins, an invalid or missing one
 * falls back to the baseline (Linksyncx normalizeOpsRuntimeLogConfig), so a hand-edited row can
 * never wedge the logger.
 */
export function resolveRuntimeLogConfig(saved: Record<string, unknown> | null, baseline: RuntimeLogConfig): RuntimeLogConfig {
  if (!saved) return { ...baseline };
  const out: RuntimeLogConfig = { ...baseline, source: "runtime_setting" };
  const target = out as unknown as Record<string, unknown>;
  for (const key of EDITABLE_RUNTIME_LOG_FIELDS) {
    const parsed = fieldSchemas[key].safeParse(saved[key]);
    if (parsed.success) target[key] = parsed.data;
  }
  const updatedAt = saved.updatedAtIso;
  out.updatedAtIso = typeof updatedAt === "string" && !Number.isNaN(Date.parse(updatedAt)) ? updatedAt : null;
  out.updatedBy = typeof saved.updatedBy === "string" && saved.updatedBy ? saved.updatedBy : null;
  return out;
}

/** The editable fields of `current` with `patch` applied, validated as a whole. */
export function mergeRuntimeLogConfig(current: RuntimeLogConfig, patch: UpdateRuntimeLogConfigRequest): EditableRuntimeLogConfig {
  const next: Record<string, unknown> = {};
  for (const key of EDITABLE_RUNTIME_LOG_FIELDS) next[key] = patch[key] ?? current[key];
  return RuntimeLogConfigSchema.pick({
    level: true,
    persistAccessLogs: true,
    enableSampling: true,
    samplingInitial: true,
    samplingThereafter: true,
    caller: true,
    stacktraceLevel: true,
    retentionDays: true,
  }).parse(next);
}

export function editableFields(cfg: RuntimeLogConfig): EditableRuntimeLogConfig {
  const out: Record<string, unknown> = {};
  for (const key of EDITABLE_RUNTIME_LOG_FIELDS) out[key] = cfg[key];
  return out as EditableRuntimeLogConfig;
}
