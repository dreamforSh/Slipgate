import type { UsageSortBy } from "@slipgate/contracts";

/** Usage table columns (sub2api-style column settings); time is always shown. */
export type UsageColumnKey =
  | "time"
  | "user"
  | "apiKey"
  | "group"
  | "account"
  | "model"
  | "reasoning"
  | "serviceTier"
  | "endpoint"
  | "tokens"
  | "cost"
  | "latency"
  | "status"
  | "requestId";

/** Shown in this order; `admin` columns only on the admin page. */
const COLUMNS: { key: UsageColumnKey; label: string; admin?: boolean; sort?: UsageSortBy }[] = [
  { key: "user", label: "usageLogs.table.user", admin: true },
  { key: "apiKey", label: "usageLogs.table.apiKey" },
  { key: "group", label: "usageLogs.table.group" },
  { key: "account", label: "usageLogs.table.account", admin: true },
  { key: "model", label: "usageLogs.table.model", sort: "model" },
  { key: "reasoning", label: "usageLogs.table.reasoning" },
  { key: "serviceTier", label: "usageLogs.table.serviceTier" },
  { key: "endpoint", label: "usageLogs.table.endpoint" },
  { key: "tokens", label: "usageLogs.table.tokens", sort: "tokens" },
  { key: "cost", label: "usageLogs.table.cost", sort: "cost" },
  { key: "latency", label: "usageLogs.table.latency", sort: "latency" },
  { key: "status", label: "usageLogs.table.status" },
  { key: "requestId", label: "usageLogs.table.requestIdColumn" },
];

/** Hidden until switched on (as in sub2api: reasoning effort and request ids). */
export const USAGE_DEFAULT_HIDDEN: UsageColumnKey[] = ["reasoning", "serviceTier", "requestId"];

/** The columns the picker offers on this page, with their i18n label keys. */
export function usageColumns(mode: "admin" | "user"): { key: UsageColumnKey; labelKey: string; sort?: UsageSortBy }[] {
  return COLUMNS.filter((c) => mode === "admin" || !c.admin).map((c) => ({ key: c.key, labelKey: c.label, sort: c.sort }));
}

const KEYS = new Set<string>(COLUMNS.map((c) => c.key));

export function isUsageColumnList(value: unknown): value is UsageColumnKey[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && KEYS.has(v));
}
