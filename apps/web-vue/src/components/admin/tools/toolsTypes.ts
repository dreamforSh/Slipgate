import { i18n } from "../../../i18n";

/* ---------------- Plugins (GET /api/v1/admin/plugins) ---------------- */

/** A configurable field a plugin declares (mirrors `PluginSettingField` in the plugin SDK). */
export interface PluginSettingField {
  key: string;
  label: string;
  description?: string;
  /** Stored encrypted; the console only learns whether a value is set. */
  secret?: boolean;
  placeholder?: string;
}

export interface PluginItem {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  hooks: string[];
  settings: PluginSettingField[];
  /** Saved values of non-secret fields; secret fields are always "". */
  config: Record<string, string>;
  secretsSet: Record<string, boolean>;
}

export interface PluginListResponse {
  items: PluginItem[];
}

export interface PluginPatchResponse {
  item?: PluginItem;
}

/** Hook that the "send test event" button exercises. */
export const TESTABLE_HOOK = "onPaymentSettled";

/* ---------------- Scheduled account tests (GET /api/v1/admin/account-autotest) ---------------- */

export interface AutoTestConfig {
  enabled: boolean;
  intervalMinutes: number;
  concurrency: number;
  groupIds: string[];
  model: string;
}

export interface AutoTestStatus {
  running: boolean;
  lastRunAtIso: string | null;
  lastRunTested: number;
  lastRunFailed: number;
  lastError: string | null;
  nextRunAtIso: string | null;
}

export interface AutoTestResponse {
  config: AutoTestConfig;
  status: AutoTestStatus;
}

export const INTERVAL_PRESETS = [5, 15, 30, 60, 180, 360, 720, 1440] as const;
export const CONCURRENCY_MAX = 5;

/** 5 → "5 分钟", 180 → "3 小时" (whole hours only; otherwise minutes). */
export function formatInterval(minutes: number): string {
  const t = i18n.global.t;
  if (minutes >= 60 && minutes % 60 === 0) return t("adminTools.monitor.schedule.hours", { n: minutes / 60 });
  return t("adminTools.monitor.schedule.minutes", { n: minutes });
}

/** Reads a File as text with a size cap (bytes); rejects with "too_large" past it. */
export function readTextFile(file: File, maxBytes: number): Promise<string> {
  if (file.size > maxBytes) return Promise.reject(new Error("too_large"));
  return file.text();
}

/** 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
