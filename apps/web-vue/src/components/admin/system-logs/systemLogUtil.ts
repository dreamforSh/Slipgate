import type { SystemLogItem, SystemLogLevel, SystemLogSource } from "@slipgate/contracts";
import { ApiError, errorText } from "../../../lib/api";
import type { Tone } from "../../../lib/format";

/* ---------------- Display ---------------- */

export const LEVEL_TONE: Record<SystemLogLevel, Tone> = {
  debug: "neutral",
  info: "info",
  warn: "warning",
  error: "danger",
};

export const SOURCE_TONE: Record<SystemLogSource, Tone> = {
  bff: "accent",
  net: "violet",
  core: "neutral",
};

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-fg-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  violet: "text-violet",
};

/** Left edge accent of a row, so errors and warnings stand out while scanning. */
export const LEVEL_EDGE: Record<SystemLogLevel, string> = {
  debug: "before:bg-transparent",
  info: "before:bg-transparent",
  warn: "before:bg-warning/70",
  error: "before:bg-danger/80",
};

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "14:03:05.123" in local time (log rows need sub-second order). */
export function formatLogClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** "2026-11-22" in local time. */
export function formatLogDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "2026-11-22 14:03:05" for window bounds and summaries. */
export function formatLogInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatLogDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function scalar(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

export interface HttpSummary {
  method: string;
  path: string;
  status: number | null;
  latencyMs: number | null;
}

/** method/path/status/latency recorded on http and http.access entries. */
export function httpSummary(item: SystemLogItem): HttpSummary | null {
  const c = item.context ?? {};
  const method = scalar(c.method);
  const path = scalar(c.path);
  const status = typeof c.status === "number" ? c.status : null;
  const latencyMs = typeof c.latencyMs === "number" ? c.latencyMs : null;
  if (!method && !path && status === null) return null;
  return { method, path, status, latencyMs };
}

/** The context's error text, when it has one worth showing beside the message. */
export function contextError(item: SystemLogItem): string {
  const c = item.context ?? {};
  const raw = c.error ?? c.err;
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && typeof (raw as { message?: unknown }).message === "string") {
    return String((raw as { message: string }).message).trim();
  }
  return "";
}

export function contextStack(item: SystemLogItem): string {
  const s = item.context?.stack;
  return typeof s === "string" ? s.trim() : "";
}

export function contextCaller(item: SystemLogItem): string {
  return scalar(item.context?.caller);
}

/* ---------------- JSON ---------------- */

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Token colouring for pretty-printed JSON; every fragment is escaped before it is wrapped. */
export function highlightJson(json: string): string {
  const re = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let out = "";
  let last = 0;
  for (const m of json.matchAll(re)) {
    const index = m.index ?? 0;
    const token = m[0];
    out += escapeHtml(json.slice(last, index));
    let cls = "text-info";
    if (token.startsWith('"')) cls = m[2] ? "text-accent" : "text-success";
    else if (token === "true" || token === "false" || token === "null") cls = "text-violet";
    out += `<span class="${cls}">${escapeHtml(token)}</span>`;
    last = index + token.length;
  }
  return out + escapeHtml(json.slice(last));
}

/* ---------------- Ids ---------------- */

/** Row ids are decimal strings; newer rows have larger ids. */
export function compareIds(a: string, b: string): number {
  try {
    const x = BigInt(a);
    const y = BigInt(b);
    return x === y ? 0 : x > y ? 1 : -1;
  } catch {
    return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
  }
}

export function newestId(items: readonly SystemLogItem[]): string | null {
  let best: string | null = null;
  for (const it of items) if (best === null || compareIds(it.id, best) > 0) best = it.id;
  return best;
}

/* ---------------- Filters ---------------- */

/** "" = every level; `min:x` = x and above; `eq:x` = exactly x. */
export type LevelChoice = "" | `min:${SystemLogLevel}` | `eq:${SystemLogLevel}`;

/** Exact-match text filters, in the order the advanced panel shows them. */
export const TEXT_FILTER_KEYS = [
  "component",
  "host",
  "requestId",
  "clientRequestId",
  "userId",
  "apiKeyId",
  "accountId",
  "platform",
  "model",
] as const;
export type TextFilterKey = (typeof TEXT_FILTER_KEYS)[number];

/** Field limits of the contract (SystemLogFilterFields). */
export const TEXT_FILTER_MAX: Record<TextFilterKey | "q", number> = {
  component: 128,
  host: 255,
  requestId: 128,
  clientRequestId: 128,
  userId: 64,
  apiKeyId: 64,
  accountId: 64,
  platform: 32,
  model: 128,
  q: 200,
};

export type TextFilters = Record<TextFilterKey, string>;

export function emptyTextFilters(): TextFilters {
  return Object.fromEntries(TEXT_FILTER_KEYS.map((k) => [k, ""])) as TextFilters;
}

/** Query/body fields for the level choice. */
export function levelParams(choice: LevelChoice): { level?: SystemLogLevel; minLevel?: SystemLogLevel } {
  if (!choice) return {};
  const [mode, value] = choice.split(":") as ["min" | "eq", SystemLogLevel];
  return mode === "min" ? { minLevel: value } : { level: value };
}

/* ---------------- Errors ---------------- */

export interface ErrorInfo {
  /** Localized text for the user. */
  message: string;
  /** X-Request-Id of a failed server call (5xx), to find its own log entries. */
  requestId: string | null;
  /** The server's own (untranslated) text, shown as secondary detail when it adds something. */
  detail: string | null;
}

type Translate = (key: string, named?: Record<string, unknown>) => string;

/**
 * Server error codes of these routes mapped onto this page's copy. The message is always
 * localized: codes without their own copy get the caller's fallback (or the generic server error
 * for 5xx), and the server's raw text, which may be English driver output, becomes `detail`.
 */
export function describeError(err: unknown, t: Translate, fallback: string): ErrorInfo {
  if (err instanceof ApiError) {
    const requestId = err.status >= 500 ? err.requestId : null;
    const info = (message: string, withDetail = true): ErrorInfo => {
      const raw = err.message.trim();
      return { message, requestId, detail: withDetail && raw && raw !== message && raw !== fallback ? raw : null };
    };
    switch (err.code) {
      case "cleanup_filter_required":
        return info(t("systemLogs.errors.cleanupFilterRequired"), false);
      case "cleanup_invalid_range":
        return info(t("systemLogs.errors.invalidRange"), false);
      case "forbidden":
        return info(t("systemLogs.errors.forbidden"), false);
      case "bad_request":
        return info(t("systemLogs.errors.badRequest"));
      default:
        break;
    }
    if (err.status === 403) return info(t("systemLogs.errors.forbidden"), false);
    if (err.status >= 500 || err.code === "internal_error") {
      return info(t(requestId ? "systemLogs.errors.serverWithId" : "systemLogs.errors.server"));
    }
    return info(fallback);
  }
  if (err instanceof TypeError) return { message: t("common.networkError"), requestId: null, detail: null };
  return { message: errorText(err, fallback), requestId: null, detail: null };
}
