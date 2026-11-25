import type {
  AccountAuthKind,
  AccountStatus,
  AccountUsageSummaryItem,
  ExecutionMode,
  UpstreamAccount,
} from "@slipgate/contracts";
import type { Tone } from "../../../lib/format";
import type { IconName } from "../../ui/icons";

export const ACCOUNT_STATUSES: AccountStatus[] = ["active", "paused", "cooldown", "expired"];
export const EXECUTION_MODES: ExecutionMode[] = ["stealth_http", "direct_api", "vm_slot"];
export const AUTH_KINDS: AccountAuthKind[] = ["oauth", "setup_token", "api_key", "vm_cli_seed"];

export const MODE_ICON: Record<ExecutionMode, IconName> = {
  stealth_http: "shield",
  direct_api: "plug",
  vm_slot: "server",
};

const DAY_MS = 86_400_000;
/** Expiry within this window is flagged as "expiring soon". */
export const EXPIRING_SOON_MS = 7 * DAY_MS;

/** Quick cooldown presets (hours) for the row menu and bulk bar. */
export const COOLDOWN_PRESETS_HOURS = [1, 5, 24, 168] as const;

export type ExpiryState = "none" | "ok" | "soon" | "expired";

export function expiryState(acc: Pick<UpstreamAccount, "expiresAtIso">, nowMs: number): ExpiryState {
  if (!acc.expiresAtIso) return "none";
  const at = Date.parse(acc.expiresAtIso);
  if (!Number.isFinite(at)) return "none";
  if (at <= nowMs) return "expired";
  return at - nowMs <= EXPIRING_SOON_MS ? "soon" : "ok";
}

export const EXPIRY_TONE: Record<ExpiryState, Tone> = {
  none: "neutral",
  ok: "neutral",
  soon: "warning",
  expired: "danger",
};

/** Schedulable right now (what the data plane will route to). */
export function isSchedulable(acc: Pick<UpstreamAccount, "effectiveStatus">): boolean {
  return acc.effectiveStatus === "active";
}

/* ---------------- Filters ---------------- */

/** Group-filter value (and `?groupId=` query) for accounts without a group; real ids start with `grp_`. */
export const UNGROUPED_FILTER = "ungrouped";

/** Whether an account passes the group filter (`"all"`, `UNGROUPED_FILTER` or a group id). */
export function matchesGroupFilter(acc: Pick<UpstreamAccount, "groupId">, filter: string): boolean {
  if (filter === "all") return true;
  return acc.groupId === (filter === UNGROUPED_FILTER ? "" : filter);
}

export type AttentionFilter = "failed_test" | "expiring" | "never_tested";
export type StatusFilter = "all" | AccountStatus | AttentionFilter;
export const ATTENTION_FILTERS: AttentionFilter[] = ["failed_test", "expiring", "never_tested"];

export function matchesStatusFilter(acc: UpstreamAccount, filter: StatusFilter, nowMs: number): boolean {
  switch (filter) {
    case "all":
      return true;
    case "failed_test":
      return acc.lastTest?.ok === false;
    case "never_tested":
      return acc.lastTest === null && acc.executionMode !== "vm_slot";
    case "expiring": {
      const state = expiryState(acc, nowMs);
      return state === "soon" || state === "expired";
    }
    default:
      return acc.effectiveStatus === filter;
  }
}

export function isStatusFilter(value: unknown): value is StatusFilter {
  return (
    value === "all" ||
    (typeof value === "string" &&
      ((ACCOUNT_STATUSES as string[]).includes(value) || (ATTENTION_FILTERS as string[]).includes(value)))
  );
}

/* ---------------- Sorting ---------------- */

export type SortKey =
  | "priority"
  | "name"
  | "status"
  | "usage"
  | "today"
  | "lastTest"
  | "lastUsed"
  | "expires"
  | "created";
export type SortDir = "asc" | "desc";
export interface SortState {
  key: SortKey;
  dir: SortDir;
}

export const SORT_KEYS: SortKey[] = ["priority", "name", "status", "usage", "today", "lastTest", "lastUsed", "expires", "created"];

/** Direction a column sorts in on first click (big numbers / recent first). */
export const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  priority: "asc",
  name: "asc",
  status: "asc",
  usage: "desc",
  today: "desc",
  lastTest: "desc",
  lastUsed: "desc",
  expires: "asc",
  created: "desc",
};

export function isSortState(value: unknown): value is SortState {
  const v = value as SortState | null;
  return !!v && SORT_KEYS.includes(v.key) && (v.dir === "asc" || v.dir === "desc");
}

const STATUS_RANK: Record<AccountStatus, number> = { active: 0, cooldown: 1, paused: 2, expired: 3 };

function timeOrNull(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Comparator for the account list. Missing values (never used, no expiry...) always sort
 * last regardless of direction; ties fall back to priority, then name.
 */
export function compareAccounts(
  a: UpstreamAccount,
  b: UpstreamAccount,
  sort: SortState,
  today: ReadonlyMap<string, AccountUsageSummaryItem>,
): number {
  const sign = sort.dir === "asc" ? 1 : -1;
  const nullable = (x: number | null, y: number | null): number | null => {
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * sign;
  };
  let primary: number | null;
  switch (sort.key) {
    case "name":
      primary = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) * sign;
      break;
    case "status":
      primary = (STATUS_RANK[a.effectiveStatus] - STATUS_RANK[b.effectiveStatus]) * sign;
      break;
    case "usage":
      primary = (Math.max(a.window5hUsedBps, a.window7dUsedBps) - Math.max(b.window5hUsedBps, b.window7dUsedBps)) * sign;
      break;
    case "today":
      primary = ((today.get(a.id)?.requests ?? 0) - (today.get(b.id)?.requests ?? 0)) * sign;
      break;
    case "lastTest":
      primary = nullable(timeOrNull(a.lastTest?.atIso), timeOrNull(b.lastTest?.atIso));
      break;
    case "lastUsed":
      primary = nullable(timeOrNull(a.lastUsedAtIso), timeOrNull(b.lastUsedAtIso));
      break;
    case "expires":
      primary = nullable(timeOrNull(a.expiresAtIso), timeOrNull(b.expiresAtIso));
      break;
    case "created":
      primary = ((timeOrNull(a.createdAtIso) ?? 0) - (timeOrNull(b.createdAtIso) ?? 0)) * sign;
      break;
    case "priority":
    default:
      primary = (a.priority - b.priority) * sign;
  }
  if (primary) return primary;
  return a.priority - b.priority || a.name.localeCompare(b.name, undefined, { numeric: true });
}

/* ---------------- Table columns ---------------- */

export type ColumnKey =
  | "group"
  | "platform"
  | "status"
  | "usage"
  | "today"
  | "limits"
  | "lastTest"
  | "lastUsed"
  | "expires"
  | "created";

export const COLUMN_KEYS: ColumnKey[] = [
  "group",
  "platform",
  "status",
  "usage",
  "today",
  "limits",
  "lastTest",
  "lastUsed",
  "expires",
  "created",
];

export const DEFAULT_COLUMNS: ColumnKey[] = ["group", "platform", "status", "usage", "today", "limits", "lastTest", "expires"];

/** The column header that sorts by each column, when sortable. */
export const COLUMN_SORT: Partial<Record<ColumnKey | "name", SortKey>> = {
  name: "name",
  status: "status",
  usage: "usage",
  today: "today",
  limits: "priority",
  lastTest: "lastTest",
  lastUsed: "lastUsed",
  expires: "expires",
  created: "created",
};

export function isColumnList(value: unknown): value is ColumnKey[] {
  return Array.isArray(value) && value.every((v) => (COLUMN_KEYS as unknown[]).includes(v));
}

/* ---------------- Dates for form inputs ---------------- */

/** ISO instant → value for `<input type="date">` in local time. */
export function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `<input type="date">` value → end of that local day as ISO (a plan "valid through" date). */
export function dateInputToIso(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Today + `days` as a date-input value. */
export function dateInputFromNow(days: number, nowMs = Date.now()): string {
  return isoToDateInput(new Date(nowMs + days * DAY_MS).toISOString());
}

/** ISO instant → value for `<input type="datetime-local">` in local time. */
export function isoToDatetimeInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${isoToDateInput(iso)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `<input type="datetime-local">` value (local time) → ISO, or null when empty/invalid. */
export function datetimeInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
