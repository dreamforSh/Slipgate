<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import {
  ExecutionModeSchema,
  ProviderSchema,
  accountSupportsPrivacy,
  isPrivacyApplied,
  type AccountAuthKind,
  type AccountBulkResult,
  type AccountPrivacyMode,
  type AccountTestScheduleItem,
  type AccountUsageSummaryItem,
  type AccountUsageSummaryResponse,
  type ExecutionMode,
  type GroupItem,
  type Provider,
  type SetAccountPrivacyResponse,
  type UpdateAccountRequest,
  type UpstreamAccount,
} from "@slipgate/contracts";
import AccountTestModal from "../../components/admin/AccountTestModal.vue";
import AccountBatchTestModal from "../../components/admin/accounts/AccountBatchTestModal.vue";
import AccountBulkEditModal from "../../components/admin/accounts/AccountBulkEditModal.vue";
import AccountCard from "../../components/admin/accounts/AccountCard.vue";
import AccountExportModal from "../../components/admin/accounts/AccountExportModal.vue";
import AccountFormModal from "../../components/admin/accounts/AccountFormModal.vue";
import AccountImportModal from "../../components/admin/accounts/AccountImportModal.vue";
import AccountRowMenu from "../../components/admin/accounts/AccountRowMenu.vue";
import AccountStatsDrawer from "../../components/admin/accounts/AccountStatsDrawer.vue";
import AccountTable from "../../components/admin/accounts/AccountTable.vue";
import AccountTestScheduleModal from "../../components/admin/accounts/AccountTestScheduleModal.vue";
import AccountExitModal from "../../components/admin/accounts/AccountExitModal.vue";
import CliFingerprintModal from "../../components/admin/accounts/CliFingerprintModal.vue";
import {
  ACCOUNT_STATUSES,
  ATTENTION_FILTERS,
  AUTH_KINDS,
  COLUMN_KEYS,
  COOLDOWN_PRESETS_HOURS,
  DEFAULT_COLUMNS,
  EXECUTION_MODES,
  PRIVACY_FILTERS,
  SORT_DEFAULT_DIR,
  SORT_KEYS,
  UNGROUPED_FILTER,
  compareAccounts,
  expiryState,
  isColumnList,
  isSchedulable,
  isSortState,
  isStatusFilter,
  matchesGroupFilter,
  matchesStatusFilter,
  type ColumnKey,
  type SortKey,
  type SortState,
  type StatusFilter,
} from "../../components/admin/accounts/accountDisplay";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiDropdown from "../../components/ui/UiDropdown.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { useNow } from "../../composables/useNow";
import { usePersistentState } from "../../composables/usePersistentState";
import { accountStatusLabel, executionModeLabel, formatNumber, formatRelative, formatTokens, formatUsd, PROVIDER_OPTIONS } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import UiSelect from "../../components/ui/UiSelect.vue";
import { exitAvailability, modeUsesExit, useExitPool } from "../../components/admin/accounts/exitPool";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const groups = ref<GroupItem[]>([]);
const accounts = ref<UpstreamAccount[]>([]);
const todayUsage = ref<ReadonlyMap<string, AccountUsageSummaryItem>>(new Map());
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const toast = useFeedbackToasts(errorMessage);
const now = useNow(30_000);

/* ---------------- Exit proxies (slipgate-net bindings) ---------------- */

const exitPool = useExitPool();
/** Bindings are real only with slipgate-net attached; standalone samples must not drive warnings. */
const exitReady = computed(() => exitPool.loaded && !exitPool.standalone && !exitPool.failed);
const hasExit = (accountId: string) => exitPool.bindingByAccount.has(accountId);
const exitBindingOf = (acc: UpstreamAccount) => exitPool.bindingByAccount.get(acc.id) ?? null;
const exitNodeOf = (acc: UpstreamAccount) => {
  const b = exitBindingOf(acc);
  return b ? exitPool.nodeById.get(b.nodeId) ?? null : null;
};
/** Exit-routed accounts (HTTP direct / VM slot) without an exit: slipgate-net refuses their traffic. */
const missingExitAccounts = computed(() =>
  exitReady.value ? accounts.value.filter((a) => modeUsesExit(a.executionMode) && !hasExit(a.id)) : [],
);
const exitAssigning = ref(false);

/** Give each account its own free healthy exit (fastest first); reports how many got one. */
async function assignExits(targets: UpstreamAccount[]) {
  if (!targets.length || exitAssigning.value) return;
  exitAssigning.value = true;
  try {
    const free = exitPool.nodes
      .filter((n) => exitAvailability(n, null) === "ok")
      .sort((a, b) => (a.latencyMs || 1e9) - (b.latencyMs || 1e9))
      .map((n) => n.nodeId);
    let bound = 0;
    for (const acc of targets) {
      const nodeId = free.shift();
      if (!nodeId) break;
      if (!(await exitPool.bind(acc.id, nodeId, ""))) bound += 1;
    }
    if (bound > 0) toast.success(t("accounts.exit.assigned", { n: bound }));
    if (bound < targets.length) toast.warning(t("accounts.exit.assignShort", { n: targets.length - bound }));
    await exitPool.load();
  } finally {
    exitAssigning.value = false;
  }
}

/* ---------------- View preferences (per browser) ---------------- */

type ViewMode = "table" | "card";
const PAGE_SIZES = [20, 50, 100] as const;
const CARD_PAGE_SIZE = 18; // fills complete rows in the 1 / 2 / 3-column grid
const AUTO_REFRESH_OPTIONS = [0, 15, 30, 60, 300] as const;

const viewMode = usePersistentState<ViewMode>(
  "slipgate.accounts.view",
  "table",
  (v): v is ViewMode => v === "table" || v === "card",
);
const columns = usePersistentState<ColumnKey[]>("slipgate.accounts.columns", [...DEFAULT_COLUMNS], isColumnList);
// Column lists saved before the exit column existed get it once (it can still be hidden afterwards).
try {
  const MIGRATED = "slipgate.accounts.columns.exit";
  if (!localStorage.getItem(MIGRATED)) {
    if (!columns.value.includes("exit")) {
      const at = columns.value.indexOf("platform");
      const next = [...columns.value];
      next.splice(at >= 0 ? at + 1 : next.length, 0, "exit");
      columns.value = next;
    }
    localStorage.setItem(MIGRATED, "1");
  }
} catch {
  // Storage unavailable: the default list already includes the column.
}
const sort = usePersistentState<SortState>("slipgate.accounts.sort", { key: "priority", dir: "asc" }, isSortState);
const pageSize = usePersistentState<number>("slipgate.accounts.pageSize", 20, (v): v is number =>
  (PAGE_SIZES as readonly unknown[]).includes(v),
);
const autoRefreshSec = usePersistentState<number>("slipgate.accounts.autoRefresh", 0, (v): v is number =>
  (AUTO_REFRESH_OPTIONS as readonly unknown[]).includes(v),
);

const viewOptions = computed(() => [
  { value: "table" as const, label: t("accounts.view.table") },
  { value: "card" as const, label: t("accounts.view.card") },
]);

function toggleColumn(key: ColumnKey) {
  const set = new Set(columns.value);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  columns.value = COLUMN_KEYS.filter((k) => set.has(k));
}

function setSort(key: SortKey) {
  sort.value = sort.value.key === key ? { key, dir: sort.value.dir === "asc" ? "desc" : "asc" } : { key, dir: SORT_DEFAULT_DIR[key] };
}

function autoRefreshLabel(sec: number) {
  if (sec === 0) return t("accounts.autoRefresh.off");
  return sec < 60 ? t("accounts.autoRefresh.seconds", { n: sec }) : t("accounts.autoRefresh.minutes", { n: sec / 60 });
}

/* ---------------- Filters (mirrored into the URL) ---------------- */

function queryString(key: string): string {
  const v = route.query[key];
  return typeof v === "string" ? v : "";
}
const parseProvider = (v: string): "all" | Provider => (ProviderSchema.safeParse(v).success ? (v as Provider) : "all");
const parseMode = (v: string): "all" | ExecutionMode =>
  ExecutionModeSchema.safeParse(v).success ? (v as ExecutionMode) : "all";

const search = ref(queryString("q"));
const debouncedSearch = ref(search.value.trim());
const platformFilter = ref<"all" | Provider>(parseProvider(queryString("platform")));
const groupFilter = ref<string>(queryString("groupId") || "all");
const statusFilter = ref<StatusFilter>(isStatusFilter(queryString("status")) ? (queryString("status") as StatusFilter) : "all");
const modeFilter = ref<"all" | ExecutionMode>(parseMode(queryString("mode")));
const parseAuthKind = (v: string): "all" | AccountAuthKind =>
  (AUTH_KINDS as string[]).includes(v) ? (v as AccountAuthKind) : "all";
const typeFilter = ref<"all" | AccountAuthKind>(parseAuthKind(queryString("type")));

let searchTimer: number | undefined;
watch(search, (value) => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => (debouncedSearch.value = value.trim()), 200);
});

// Links from other pages (e.g. a group's "accounts" link) update the filters in place.
watch(
  () => route.query,
  () => {
    groupFilter.value = queryString("groupId") || "all";
    platformFilter.value = parseProvider(queryString("platform"));
    const status = queryString("status");
    statusFilter.value = isStatusFilter(status) ? status : "all";
    modeFilter.value = parseMode(queryString("mode"));
    typeFilter.value = parseAuthKind(queryString("type"));
    const q = queryString("q");
    if (q !== debouncedSearch.value) {
      search.value = q;
      debouncedSearch.value = q;
    }
  },
);

watch([debouncedSearch, platformFilter, groupFilter, statusFilter, modeFilter, typeFilter], ([q, platform, groupId, status, mode, type]) => {
  const query: Record<string, string> = {};
  if (q) query.q = q;
  if (platform !== "all") query.platform = platform;
  if (groupId !== "all") query.groupId = groupId;
  if (status !== "all") query.status = status;
  if (mode !== "all") query.mode = mode;
  if (type !== "all") query.type = type;
  const current = JSON.stringify(route.query);
  if (current !== JSON.stringify(query)) void router.replace({ query });
});

const hasFilters = computed(
  () =>
    !!debouncedSearch.value ||
    platformFilter.value !== "all" ||
    groupFilter.value !== "all" ||
    statusFilter.value !== "all" ||
    modeFilter.value !== "all" ||
    typeFilter.value !== "all",
);

function clearFilters() {
  search.value = "";
  debouncedSearch.value = "";
  platformFilter.value = "all";
  groupFilter.value = "all";
  statusFilter.value = "all";
  modeFilter.value = "all";
  typeFilter.value = "all";
}

const searchHaystack = computed(
  () =>
    new Map(
      accounts.value.map((a) => [
        a.id,
        [a.name, a.notes, a.id, a.credentialPreview, a.groupName || t("accounts.ungrouped")].join("\n").toLowerCase(),
      ]),
    ),
);

/** Every filter except the access mode (the segmented control shows counts per mode). */
const baseFiltered = computed(() => {
  const q = debouncedSearch.value.toLowerCase();
  const nowMs = now.value;
  return accounts.value.filter((a) => {
    if (platformFilter.value !== "all" && a.platform !== platformFilter.value) return false;
    if (typeFilter.value !== "all" && a.authKind !== typeFilter.value) return false;
    if (!matchesGroupFilter(a, groupFilter.value)) return false;
    if (!matchesStatusFilter(a, statusFilter.value, nowMs, exitReady.value ? hasExit : undefined)) return false;
    return !q || (searchHaystack.value.get(a.id) ?? "").includes(q);
  });
});

const filteredAccounts = computed(() => {
  const list =
    modeFilter.value === "all" ? [...baseFiltered.value] : baseFiltered.value.filter((a) => a.executionMode === modeFilter.value);
  return list.sort((a, b) => compareAccounts(a, b, sort.value, todayUsage.value));
});

const modeOptions = computed(() => {
  const count = (m: ExecutionMode) => baseFiltered.value.filter((a) => a.executionMode === m).length;
  return [
    { value: "all" as const, label: t("common.all"), count: baseFiltered.value.length },
    ...EXECUTION_MODES.map((m) => ({ value: m, label: executionModeLabel(m), count: count(m) })),
  ];
});

/* ---------------- Pagination ---------------- */

const page = ref(1);
const effectivePageSize = computed(() => (viewMode.value === "card" ? CARD_PAGE_SIZE : pageSize.value));
const pageCount = computed(() => Math.max(1, Math.ceil(filteredAccounts.value.length / effectivePageSize.value)));
const pagedAccounts = computed(() =>
  filteredAccounts.value.slice((page.value - 1) * effectivePageSize.value, page.value * effectivePageSize.value),
);

watch([debouncedSearch, platformFilter, groupFilter, statusFilter, modeFilter, typeFilter, effectivePageSize], () => {
  page.value = 1;
});
watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});

/* ---------------- Selection ---------------- */

const selected = ref<Set<string>>(new Set());
const selectedAccounts = computed(() => accounts.value.filter((a) => selected.value.has(a.id)));
const selectedIds = computed(() => selectedAccounts.value.map((a) => a.id));
const selectedOauth = computed(() => selectedAccounts.value.filter((a) => a.authKind === "oauth"));
const selectedPrivacy = computed(() => selectedAccounts.value.filter((a) => accountSupportsPrivacy(a)));
const selectedMissingExit = computed(() =>
  exitReady.value ? selectedAccounts.value.filter((a) => modeUsesExit(a.executionMode) && !hasExit(a.id)) : [],
);
const allPageSelected = computed(
  () => pagedAccounts.value.length > 0 && pagedAccounts.value.every((a) => selected.value.has(a.id)),
);
const somePageSelected = computed(() => !allPageSelected.value && pagedAccounts.value.some((a) => selected.value.has(a.id)));
const allFilteredSelected = computed(
  () => filteredAccounts.value.length > 0 && filteredAccounts.value.every((a) => selected.value.has(a.id)),
);

function togglePage() {
  const next = new Set(selected.value);
  const select = !allPageSelected.value;
  for (const a of pagedAccounts.value) {
    if (select) next.add(a.id);
    else next.delete(a.id);
  }
  selected.value = next;
}

function toggleOne(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}

function selectAllFiltered() {
  selected.value = new Set([...selected.value, ...filteredAccounts.value.map((a) => a.id)]);
}

function clearSelection() {
  selected.value = new Set();
}

/* ---------------- Stats ---------------- */

const schedulableAccounts = computed(() => accounts.value.filter(isSchedulable));
const totalWeight = computed(() => schedulableAccounts.value.reduce((s, a) => s + a.tierMultiplier, 0));
const totalConcurrency = computed(() => schedulableAccounts.value.reduce((s, a) => s + a.maxConcurrency, 0));
const todayTotals = computed(() => {
  let requests = 0;
  let tokens = 0;
  let cost = 0n;
  for (const item of todayUsage.value.values()) {
    requests += item.requests;
    tokens += item.inputTokens + item.outputTokens;
    cost += BigInt(item.costNanoUsd);
  }
  return { requests, tokens, cost: cost.toString() };
});
const expiringSoon = computed(() => accounts.value.filter((a) => expiryState(a, now.value) === "soon").length);
const expiredCount = computed(() => accounts.value.filter((a) => a.effectiveStatus === "expired").length);
const failedTests = computed(() => accounts.value.filter((a) => a.lastTest?.ok === false).length);
const cooldownCount = computed(() => accounts.value.filter((a) => a.effectiveStatus === "cooldown").length);
const accountNames = computed(() => new Map(accounts.value.map((a) => [a.id, a.name])));

function filterBy(status: StatusFilter) {
  statusFilter.value = statusFilter.value === status ? "all" : status;
}

/* ---------------- Loading ---------------- */

/* ---------------- Scheduled tests and CLI fingerprints ---------------- */

const testSchedules = ref<Map<string, AccountTestScheduleItem>>(new Map());
/** Enabled schedules → interval (minutes), for the list indicators. */
const scheduledMinutes = computed(
  () => new Map([...testSchedules.value.values()].filter((s) => s.enabled).map((s) => [s.accountId, s.intervalMinutes])),
);
const scheduleOpen = ref(false);
const scheduleAccount = ref<UpstreamAccount | null>(null);
function openSchedule(acc: UpstreamAccount) {
  scheduleAccount.value = acc;
  scheduleOpen.value = true;
}
const cliOpen = ref(false);

/** Quick exit change from the list (exit cell click or row menu). */
const exitOpen = ref(false);
const exitAccount = ref<UpstreamAccount | null>(null);
function openExit(acc: UpstreamAccount) {
  exitAccount.value = acc;
  exitOpen.value = true;
}

async function refreshPool(silent = false) {
  if (!silent) {
    loading.value = true;
    errorMessage.value = null;
  }
  try {
    const tz = new Date().getTimezoneOffset();
    const [gRes, aRes, uRes, sRes] = await Promise.all([
      auth.apiFetch("/api/v1/admin/groups"),
      auth.apiFetch("/api/v1/admin/accounts"),
      auth.apiFetch(`/api/v1/admin/accounts/usage-today?tz=${tz}`).catch(() => null),
      auth.apiFetch("/api/v1/admin/account-test-schedules").catch(() => null),
      // Best-effort like usage: without slipgate-net the exit column just reads "—".
      exitPool.load(),
    ]);
    if (gRes.ok) groups.value = ((await gRes.json()) as { groups: GroupItem[] }).groups;
    if (aRes.ok) {
      accounts.value = ((await aRes.json()) as { accounts: UpstreamAccount[] }).accounts;
      const ids = new Set(accounts.value.map((a) => a.id));
      const kept = [...selected.value].filter((id) => ids.has(id));
      if (kept.length !== selected.value.size) selected.value = new Set(kept);
    } else if (!silent) {
      errorMessage.value = t("accounts.errors.loadFailed");
    }
    // Usage columns are best-effort: an older backend without the endpoint just shows "—".
    if (uRes?.ok) {
      const body = (await uRes.json()) as AccountUsageSummaryResponse;
      todayUsage.value = new Map(body.items.map((i) => [i.accountId, i]));
    }
    if (sRes?.ok) {
      const body = (await sRes.json()) as { items: AccountTestScheduleItem[] };
      testSchedules.value = new Map(body.items.map((i) => [i.accountId, i]));
    }
  } catch (err) {
    if (!silent) errorMessage.value = err instanceof Error ? err.message : t("accounts.errors.loadFailed");
  } finally {
    loading.value = false;
  }
}

/* ---------------- Auto refresh ---------------- */

const bulkBusy = ref(false);
let autoTimer: number | undefined;
function scheduleAutoRefresh() {
  window.clearInterval(autoTimer);
  if (autoRefreshSec.value > 0) {
    autoTimer = window.setInterval(() => {
      if (!document.hidden && !bulkBusy.value) void refreshPool(true);
    }, autoRefreshSec.value * 1000);
  }
}
watch(autoRefreshSec, scheduleAutoRefresh);
onBeforeUnmount(() => {
  window.clearInterval(autoTimer);
  window.clearTimeout(searchTimer);
});

/* ---------------- Row actions ---------------- */

const busyIds = ref<Set<string>>(new Set());

function setBusy(id: string, busy: boolean) {
  const next = new Set(busyIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

/** PATCH one account and splice the server's copy into the list; `null` on failure. */
async function patchAccount(
  acc: UpstreamAccount,
  patch: UpdateAccountRequest,
  fallback: string,
): Promise<UpstreamAccount | null> {
  setBusy(acc.id, true);
  try {
    const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      errorMessage.value = data.message ?? fallback;
      return null;
    }
    const { account } = (await res.json()) as { account: UpstreamAccount };
    accounts.value = accounts.value.map((a) => (a.id === account.id ? account : a));
    return account;
  } finally {
    setBusy(acc.id, false);
  }
}

/** Report what the scheduler will actually do: a lapsed subscription stays off after "enable". */
function reportScheduling(account: UpstreamAccount) {
  if (account.effectiveStatus === "active") toast.success(t("accounts.toast.resumed"));
  else if (account.effectiveStatus === "expired") toast.warning(t("accounts.status.renewHint"));
  else if (account.effectiveStatus === "paused") toast.success(t("accounts.toast.paused"));
}

async function toggleAccountStatus(acc: UpstreamAccount) {
  const pause = acc.effectiveStatus === "active";
  const updated = await patchAccount(acc, { status: pause ? "paused" : "active" }, t("accounts.errors.updateStatus"));
  if (updated) reportScheduling(updated);
}

/** Inline priority edits save at once; the list re-sorts when priority is the sort key. */
async function setPriority(acc: UpstreamAccount, priority: number) {
  if (priority === acc.priority) return;
  const updated = await patchAccount(acc, { priority }, t("accounts.errors.updateAccount"));
  if (updated) toast.success(t("accounts.priority.saved", { name: updated.name, n: updated.priority }));
}

/* ---------------- OAuth token refresh (slipgate-net renews and persists it) ---------------- */

const refreshingTokens = ref(false);

async function refreshOne(acc: UpstreamAccount): Promise<{ ok: true; expiresAtUnixMs: number } | { ok: false; message: string }> {
  setBusy(acc.id, true);
  try {
    const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}/oauth/refresh`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as { message?: string; expiresAtUnixMs?: number };
    if (!res.ok) return { ok: false, message: data.message ?? t("accounts.refresh.failed") };
    return { ok: true, expiresAtUnixMs: data.expiresAtUnixMs ?? 0 };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : t("accounts.refresh.failed") };
  } finally {
    setBusy(acc.id, false);
  }
}

async function refreshToken(acc: UpstreamAccount) {
  const result = await refreshOne(acc);
  if (!result.ok) {
    toast.error(t("accounts.refresh.failedFor", { name: acc.name, message: result.message }));
    return;
  }
  toast.success(
    result.expiresAtUnixMs
      ? t("accounts.refresh.doneUntil", { name: acc.name, time: formatRelative(new Date(result.expiresAtUnixMs).toISOString()) })
      : t("accounts.refresh.done", { name: acc.name }),
  );
  await refreshPool(true);
}

/** Selected OAuth accounts, one after another (each refresh talks to the provider). */
async function bulkRefreshTokens() {
  const targets = selectedOauth.value;
  if (!targets.length || refreshingTokens.value) return;
  refreshingTokens.value = true;
  try {
    let ok = 0;
    const failures: string[] = [];
    for (const acc of targets) {
      const result = await refreshOne(acc);
      if (result.ok) ok += 1;
      else failures.push(`${acc.name}: ${result.message}`);
    }
    if (ok) toast.success(t("accounts.refresh.bulkDone", { n: ok }));
    if (failures.length) toast.error(t("accounts.refresh.bulkFailed", { n: failures.length, first: failures[0] }));
    await refreshPool(true);
  } finally {
    refreshingTokens.value = false;
  }
}

/* ---------------- Set privacy ---------------- */

const settingPrivacy = ref(false);

type PrivacyOutcome = { ok: true; mode: AccountPrivacyMode; message: string } | { ok: false; message: string };

async function setPrivacyOne(acc: UpstreamAccount): Promise<PrivacyOutcome> {
  setBusy(acc.id, true);
  try {
    const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}/privacy`, { method: "POST" });
    const data = (await res.json().catch(() => ({}))) as Partial<SetAccountPrivacyResponse> & { message?: string };
    if (!res.ok || !data.mode) return { ok: false, message: data.message ?? t("accounts.privacy.failed") };
    return { ok: true, mode: data.mode, message: data.message ?? "" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : t("accounts.privacy.failed") };
  } finally {
    setBusy(acc.id, false);
  }
}

/** Toast text for one outcome; `applied` tells success from a provider refusal. */
function privacyToast(acc: UpstreamAccount, out: PrivacyOutcome): { applied: boolean; text: string } {
  if (!out.ok) return { applied: false, text: t("accounts.privacy.failedFor", { name: acc.name, message: out.message }) };
  const reason = out.message || t("accounts.privacy.noReason");
  return {
    applied: isPrivacyApplied(out.mode),
    text: t(`accounts.privacy.result.${out.mode}`, { name: acc.name, message: reason }),
  };
}

async function setPrivacy(acc: UpstreamAccount) {
  const toastView = privacyToast(acc, await setPrivacyOne(acc));
  if (toastView.applied) toast.success(toastView.text);
  else toast.error(toastView.text);
  await refreshPool(true);
}

/** Selected ChatGPT / Codex and Antigravity OAuth accounts, one after another. */
async function bulkSetPrivacy() {
  const targets = selectedPrivacy.value;
  if (!targets.length || settingPrivacy.value) return;
  settingPrivacy.value = true;
  try {
    let ok = 0;
    const failures: string[] = [];
    for (const acc of targets) {
      const toastView = privacyToast(acc, await setPrivacyOne(acc));
      if (toastView.applied) ok += 1;
      else failures.push(toastView.text);
    }
    if (ok) toast.success(t("accounts.privacy.bulkDone", { n: ok }));
    if (failures.length) toast.error(t("accounts.privacy.bulkFailed", { n: failures.length, first: failures[0] }));
    await refreshPool(true);
  } finally {
    settingPrivacy.value = false;
  }
}

async function resumeAccount(acc: UpstreamAccount) {
  const updated = await patchAccount(acc, { status: "active" }, t("accounts.errors.updateStatus"));
  if (updated) reportScheduling(updated);
}

/**
 * A cooldown is only a deadline: the stored status is left alone, so a paused or manually
 * expired account stays off instead of waking up when the deadline passes.
 */
function cooldownPatch(hours: number): UpdateAccountRequest {
  return {
    cooldownUntilIso: new Date(Date.now() + hours * 3_600_000).toISOString(),
    cooldownReason: t("accounts.cooldown.reason"),
  };
}

async function cooldownAccount(acc: UpstreamAccount, hours: number) {
  const patch = cooldownPatch(hours);
  const updated = await patchAccount(acc, patch, t("accounts.errors.updateStatus"));
  if (updated?.effectiveStatus === "cooldown") {
    toast.success(t("accounts.toast.cooldown", { time: formatRelative(patch.cooldownUntilIso ?? null) }));
  }
}

async function removeAccount(acc: UpstreamAccount) {
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${encodeURIComponent(acc.id)}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    errorMessage.value = data.message ?? t("accounts.errors.deleteAccount");
    return;
  }
  toast.success(t("accounts.toast.deleted"));
  const next = new Set(selected.value);
  next.delete(acc.id);
  selected.value = next;
  await refreshPool(true);
}

/* ---------------- Bulk actions ---------------- */

function reportBulk(result: AccountBulkResult) {
  const message = t("accounts.bulk.result", { success: result.success, failed: result.failed });
  if (result.failed > 0) toast.warning(message);
  else toast.success(message);
}

async function runBulk(path: string, body: Record<string, unknown>, keepSelection = false) {
  const ids = selectedIds.value;
  if (!ids.length) return;
  bulkBusy.value = true;
  const total: AccountBulkResult = { success: 0, failed: 0, results: [] };
  try {
    // The bulk endpoints take at most 500 ids per call.
    for (let offset = 0; offset < ids.length; offset += 500) {
      const res = await auth.apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, accountIds: ids.slice(offset, offset + 500) }),
      });
      const data = (await res.json().catch(() => ({}))) as AccountBulkResult & { message?: string };
      if (!res.ok) {
        errorMessage.value = data.message ?? t("accounts.bulk.failed");
        break;
      }
      total.success += data.success;
      total.failed += data.failed;
      total.results.push(...data.results);
    }
    if (total.results.length) reportBulk(total);
    if (!keepSelection) clearSelection();
    await refreshPool(true);
  } finally {
    bulkBusy.value = false;
  }
}

const bulkSetStatus = (status: "active" | "paused") =>
  runBulk("/api/v1/admin/accounts/bulk-update", { patch: { status } }, true);
const bulkCooldown = (hours: number) =>
  runBulk("/api/v1/admin/accounts/bulk-update", { patch: cooldownPatch(hours) }, true);
const bulkDelete = () => runBulk("/api/v1/admin/accounts/batch-delete", {});

async function onBulkEdited(result: AccountBulkResult) {
  reportBulk(result);
  await refreshPool(true);
}

/* ---------------- Dialogs ---------------- */

const formOpen = ref(false);
const formAccount = ref<UpstreamAccount | null>(null);
const formTemplate = ref<UpstreamAccount | null>(null);
/** The edit form was opened from "Re-authorize". */
const formReauth = ref(false);

function openCreate() {
  formAccount.value = null;
  formTemplate.value = null;
  formReauth.value = false;
  formOpen.value = true;
}
function openEdit(acc: UpstreamAccount) {
  formAccount.value = acc;
  formTemplate.value = null;
  formReauth.value = false;
  formOpen.value = true;
}
/** Re-authorize: the edit form opened at its credentials (OAuth sign-in replaces the stored credential). */
function openReauth(acc: UpstreamAccount) {
  formAccount.value = acc;
  formTemplate.value = null;
  formReauth.value = true;
  formOpen.value = true;
}

async function resetQuota(acc: UpstreamAccount) {
  const updated = await patchAccount(acc, { resetQuota: true }, t("accounts.quota.resetFailed"));
  if (updated) toast.success(t("accounts.quota.resetDone", { name: acc.name }));
}
function openDuplicate(acc: UpstreamAccount) {
  formAccount.value = null;
  formTemplate.value = acc;
  formReauth.value = false;
  formOpen.value = true;
}

/** Group preselected in the add / import dialogs: the filtered group, otherwise none (ungrouped). */
const defaultGroupId = computed(() => (groups.value.some((g) => g.id === groupFilter.value) ? groupFilter.value : ""));

const statsOpen = ref(false);
const statsAccountId = ref<string | null>(null);
const statsAccount = computed(() => accounts.value.find((a) => a.id === statsAccountId.value) ?? null);
function openStats(acc: UpstreamAccount) {
  statsAccountId.value = acc.id;
  statsOpen.value = true;
}

const testOpen = ref(false);
const testTarget = ref<UpstreamAccount | null>(null);
function openTest(acc: UpstreamAccount) {
  if (acc.executionMode === "vm_slot") return;
  testTarget.value = acc;
  testOpen.value = true;
}

const batchTestOpen = ref(false);
const batchTestTargets = ref<UpstreamAccount[]>([]);
function openBatchTest(targets: UpstreamAccount[]) {
  batchTestTargets.value = targets;
  batchTestOpen.value = true;
}
const failedAccounts = computed(() => accounts.value.filter((a) => a.lastTest?.ok === false && a.executionMode !== "vm_slot"));
const untestedAccounts = computed(() => accounts.value.filter((a) => a.lastTest === null && a.executionMode !== "vm_slot"));

const bulkEditOpen = ref(false);
const importOpen = ref(false);
const exportOpen = ref(false);
const exportIds = ref<string[]>([]);
function openExport(ids: string[]) {
  exportIds.value = ids;
  exportOpen.value = true;
}

const menuOpen = ref(false);
const menuAccount = ref<UpstreamAccount | null>(null);
const menuAnchor = ref<HTMLElement | null>(null);
function openMenu(acc: UpstreamAccount, anchor: HTMLElement) {
  if (menuOpen.value && menuAccount.value?.id === acc.id) {
    menuOpen.value = false;
    return;
  }
  menuAccount.value = acc;
  menuAnchor.value = anchor;
  menuOpen.value = true;
}

onMounted(() => {
  void refreshPool();
  scheduleAutoRefresh();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.accounts')">
      <template #actions>
        <div class="flex items-center">
          <button
            type="button"
            class="btn btn-secondary rounded-r-none"
            :disabled="loading"
            :title="t('common.refresh')"
            @click="refreshPool()"
          >
            <UiIcon name="refresh" :size="15" :spin="loading" />
            {{ t("common.refresh") }}
          </button>
          <UiDropdown width-class="w-44">
            <template #trigger="{ toggle, open }">
              <button
                type="button"
                class="btn btn-secondary -ml-px rounded-l-none px-2"
                aria-haspopup="menu"
                :aria-expanded="open"
                :title="`${t('accounts.autoRefresh.label')}: ${autoRefreshLabel(autoRefreshSec)}`"
                :aria-label="t('accounts.autoRefresh.label')"
                @click="toggle"
              >
                <span v-if="autoRefreshSec" class="font-mono text-2xs text-accent">{{ autoRefreshSec < 60 ? `${autoRefreshSec}s` : `${autoRefreshSec / 60}m` }}</span>
                <UiIcon name="chevron-down" :size="13" />
              </button>
            </template>
            <template #default="{ close }">
              <p class="eyebrow px-2.5 pb-1 pt-1.5">{{ t("accounts.autoRefresh.label") }}</p>
              <button
                v-for="sec in AUTO_REFRESH_OPTIONS"
                :key="sec"
                type="button"
                role="menuitemradio"
                :aria-checked="autoRefreshSec === sec"
                class="menu-item justify-between"
                :class="autoRefreshSec === sec ? '!text-accent' : ''"
                @click="autoRefreshSec = sec; close()"
              >
                {{ autoRefreshLabel(sec) }}
                <UiIcon v-if="autoRefreshSec === sec" name="check" :size="14" />
              </button>
            </template>
          </UiDropdown>
        </div>

        <UiDropdown width-class="w-64">
          <template #trigger="{ toggle, open }">
            <button type="button" class="btn btn-secondary" aria-haspopup="menu" :aria-expanded="open" @click="toggle">
              <UiIcon name="more" :size="15" />
              {{ t("accounts.actions.more") }}
            </button>
          </template>
          <template #default="{ close }">
            <button type="button" role="menuitem" class="menu-item" @click="importOpen = true; close()">
              <UiIcon name="upload" :size="14" />
              {{ t("accounts.actions.import") }}
            </button>
            <button type="button" role="menuitem" class="menu-item" @click="openExport([]); close()">
              <UiIcon name="download" :size="14" />
              {{ t("accounts.actions.export") }}
            </button>
            <button type="button" role="menuitem" class="menu-item" @click="cliOpen = true; close()">
              <UiIcon name="fingerprint" :size="14" />
              {{ t("accounts.cli.menu") }}
            </button>
            <div class="my-1 border-t border-line/70" />
            <button
              type="button"
              role="menuitem"
              class="menu-item disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!failedAccounts.length"
              @click="openBatchTest(failedAccounts); close()"
            >
              <UiIcon name="refresh" :size="14" />
              <span class="flex-1">{{ t("accounts.actions.retestFailed") }}</span>
              <span class="font-mono text-2xs text-fg-subtle">{{ failedAccounts.length }}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              class="menu-item disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!untestedAccounts.length"
              @click="openBatchTest(untestedAccounts); close()"
            >
              <UiIcon name="play" :size="14" />
              <span class="flex-1">{{ t("accounts.actions.testUntested") }}</span>
              <span class="font-mono text-2xs text-fg-subtle">{{ untestedAccounts.length }}</span>
            </button>
          </template>
        </UiDropdown>

        <button type="button" class="btn btn-primary" @click="openCreate">
          <UiIcon name="plus" :size="15" />
          {{ t("accounts.actions.addAccount") }}
        </button>
      </template>
    </PageHeader>

    <!-- Stats -->
    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        :label="t('accounts.stats.schedulable')"
        :value="`${schedulableAccounts.length} / ${accounts.length}`"
        :hint="t('accounts.stats.schedulableHint', { weight: totalWeight, concurrency: totalConcurrency })"
        icon="users"
        tone="success"
      />
      <StatCard
        :label="t('accounts.stats.todayRequests')"
        :value="formatNumber(todayTotals.requests)"
        :hint="t('accounts.stats.todayHint', { tokens: formatTokens(todayTotals.tokens), cost: formatUsd(todayTotals.cost) })"
        icon="activity"
        tone="info"
      />
      <div
        role="button"
        tabindex="0"
        class="cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        :class="statusFilter === 'expiring' ? 'ring-2 ring-warning/40' : ''"
        :aria-pressed="statusFilter === 'expiring'"
        :title="t('accounts.stats.filterHint')"
        @click="filterBy('expiring')"
        @keydown.enter.prevent="filterBy('expiring')"
        @keydown.space.prevent="filterBy('expiring')"
      >
        <StatCard
          class="h-full"
          :label="t('accounts.stats.expiring')"
          :value="expiringSoon"
          :hint="t('accounts.stats.expiringHint', { expired: expiredCount })"
          icon="calendar"
          :tone="expiringSoon || expiredCount ? 'warning' : 'neutral'"
        />
      </div>
      <div
        role="button"
        tabindex="0"
        class="cursor-pointer rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        :class="statusFilter === 'failed_test' ? 'ring-2 ring-danger/40' : ''"
        :aria-pressed="statusFilter === 'failed_test'"
        :title="t('accounts.stats.filterHint')"
        @click="filterBy('failed_test')"
        @keydown.enter.prevent="filterBy('failed_test')"
        @keydown.space.prevent="filterBy('failed_test')"
      >
        <StatCard
          class="h-full"
          :label="t('accounts.stats.failedTests')"
          :value="failedTests"
          :hint="t('accounts.stats.failedHint', { cooldown: cooldownCount })"
          icon="alert"
          :tone="failedTests > 0 ? 'danger' : 'neutral'"
        />
      </div>
    </div>

    <UiCard icon="users" :title="t('accounts.list.title')" flush>
      <template #actions>
        <!-- Four options with counts outgrow a phone screen: scroll instead of overflowing the card. -->
        <div class="scrollbar-hide max-w-full overflow-x-auto">
          <SegmentedControl v-model="modeFilter" :options="modeOptions" />
        </div>
        <SegmentedControl v-model="viewMode" :options="viewOptions" />
        <UiDropdown v-if="viewMode === 'table'" width-class="w-52">
          <template #trigger="{ toggle, open }">
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-sm"
              aria-haspopup="menu"
              :aria-expanded="open"
              :title="t('accounts.view.columns')"
              :aria-label="t('accounts.view.columns')"
              @click="toggle"
            >
              <UiIcon name="columns" :size="15" />
            </button>
          </template>
          <p class="eyebrow px-2.5 pb-1 pt-1.5">{{ t("accounts.view.columns") }}</p>
          <label v-for="key in COLUMN_KEYS" :key="key" class="menu-item cursor-pointer">
            <input type="checkbox" class="checkbox" :checked="columns.includes(key)" @change="toggleColumn(key)" />
            {{ t(`accounts.columns.${key}`) }}
          </label>
          <div class="my-1 border-t border-line/70" />
          <button type="button" class="menu-item" @click="columns = [...DEFAULT_COLUMNS]">
            <UiIcon name="refresh" :size="14" />
            {{ t("accounts.view.resetColumns") }}
          </button>
        </UiDropdown>
      </template>

      <!-- Filters -->
      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[13rem] flex-1">
          <UiIcon
            name="search"
            :size="14"
            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            v-model="search"
            type="search"
            class="input input-sm pl-8"
            :placeholder="t('accounts.filters.search')"
            :aria-label="t('common.search')"
          />
        </label>
        <UiSelect v-model="platformFilter" class="select input-sm w-auto min-w-[9rem]" :aria-label="t('accounts.form.platform')">
          <option value="all">{{ t("accounts.filters.allPlatforms") }}</option>
          <option v-for="p in PROVIDER_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
        </UiSelect>
        <UiSelect v-model="groupFilter" class="select input-sm w-auto min-w-[9rem]" :aria-label="t('accounts.form.group')">
          <option value="all">{{ t("accounts.filters.allGroups") }}</option>
          <option :value="UNGROUPED_FILTER">{{ t("accounts.ungrouped") }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </UiSelect>
        <UiSelect v-model="typeFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('accounts.filters.allTypes')">
          <option value="all">{{ t("accounts.filters.allTypes") }}</option>
          <option v-for="k in AUTH_KINDS" :key="k" :value="k">{{ t(`accounts.authKinds.${k}`) }}</option>
        </UiSelect>
        <UiSelect v-model="statusFilter" class="select input-sm w-auto min-w-[9rem]" :aria-label="t('common.status')">
          <option value="all">{{ t("accounts.filters.allStatuses") }}</option>
          <optgroup :label="t('accounts.filters.statusGroup')">
            <option v-for="s in ACCOUNT_STATUSES" :key="s" :value="s">{{ accountStatusLabel(s) }}</option>
          </optgroup>
          <optgroup :label="t('accounts.filters.attentionGroup')">
            <option v-for="f in ATTENTION_FILTERS" :key="f" :value="f">{{ t(`accounts.filters.attention.${f}`) }}</option>
          </optgroup>
          <optgroup :label="t('accounts.filters.privacyGroup')">
            <option v-for="f in PRIVACY_FILTERS" :key="f" :value="f">{{ t(`accounts.filters.privacy.${f}`) }}</option>
          </optgroup>
        </UiSelect>
        <div v-if="viewMode === 'card'" class="flex items-center gap-1">
          <UiSelect v-model="sort.key" class="select input-sm w-auto" :aria-label="t('accounts.sort.label')">
            <option v-for="k in SORT_KEYS" :key="k" :value="k">{{ t(`accounts.sort.${k}`) }}</option>
          </UiSelect>
          <button
            type="button"
            class="btn btn-secondary btn-icon btn-sm"
            :title="sort.dir === 'asc' ? t('accounts.sort.asc') : t('accounts.sort.desc')"
            :aria-label="t('accounts.sort.toggle')"
            @click="sort = { key: sort.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' }"
          >
            <UiIcon :name="sort.dir === 'asc' ? 'arrow-up' : 'arrow-down'" :size="13" />
          </button>
        </div>
        <button v-if="hasFilters" type="button" class="btn btn-ghost btn-sm" @click="clearFilters">
          <UiIcon name="x" :size="13" />
          {{ t("accounts.filters.clear") }}
        </button>
        <label
          v-if="viewMode === 'card' && pagedAccounts.length > 0"
          class="ml-auto inline-flex cursor-pointer select-none items-center gap-2 whitespace-nowrap rounded-md px-1.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
        >
          <input type="checkbox" class="checkbox" :checked="allPageSelected" :indeterminate="somePageSelected" @change="togglePage" />
          {{ t("accounts.card.selectPage") }}
        </label>
      </div>

      <!-- Bulk actions -->
      <div
        v-if="selected.size > 0"
        class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/70 bg-accent/[0.06] px-5 py-2.5"
      >
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span class="font-medium text-fg">{{ t("accounts.bulk.selected", { count: selected.size }) }}</span>
          <button
            v-if="!allFilteredSelected && filteredAccounts.length > selected.size"
            type="button"
            class="cursor-pointer text-xs font-medium text-accent hover:underline"
            @click="selectAllFiltered"
          >
            {{ t("accounts.bulk.selectAllFiltered", { count: filteredAccounts.length }) }}
          </button>
          <button type="button" class="cursor-pointer text-xs text-fg-muted hover:text-fg" @click="clearSelection">
            {{ t("accounts.bulk.clear") }}
          </button>
        </div>
        <div class="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy" @click="openBatchTest(selectedAccounts)">
            <UiIcon name="play" :size="13" />
            {{ t("accounts.bulk.test") }}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy" @click="bulkSetStatus('active')">
            <UiIcon name="check" :size="13" />
            {{ t("accounts.bulk.enable") }}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy" @click="bulkSetStatus('paused')">
            <UiIcon name="pause" :size="13" />
            {{ t("accounts.bulk.pause") }}
          </button>
          <UiDropdown width-class="w-40">
            <template #trigger="{ toggle, open }">
              <button
                type="button"
                class="btn btn-secondary btn-sm"
                :disabled="bulkBusy"
                aria-haspopup="menu"
                :aria-expanded="open"
                @click="toggle"
              >
                <UiIcon name="clock" :size="13" />
                {{ t("accounts.bulk.cooldown") }}
                <UiIcon name="chevron-down" :size="12" />
              </button>
            </template>
            <template #default="{ close }">
              <button
                v-for="h in COOLDOWN_PRESETS_HOURS"
                :key="h"
                type="button"
                role="menuitem"
                class="menu-item"
                @click="bulkCooldown(h); close()"
              >
                {{ t(`accounts.cooldown.h${h}`) }}
              </button>
            </template>
          </UiDropdown>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy" @click="bulkEditOpen = true">
            <UiIcon name="sliders" :size="13" />
            {{ t("accounts.bulk.edit") }}
          </button>
          <button
            v-if="selectedOauth.length > 0"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="bulkBusy || refreshingTokens"
            @click="bulkRefreshTokens"
          >
            <UiIcon :name="refreshingTokens ? 'loader' : 'rotate-ccw'" :size="13" :spin="refreshingTokens" />
            {{ t("accounts.refresh.bulk", { n: selectedOauth.length }) }}
          </button>
          <button
            v-if="selectedPrivacy.length > 0"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="bulkBusy || settingPrivacy"
            :title="t('accounts.privacy.bulkHint')"
            @click="bulkSetPrivacy"
          >
            <UiIcon :name="settingPrivacy ? 'loader' : 'shield'" :size="13" :spin="settingPrivacy" />
            {{ t("accounts.privacy.bulk", { n: selectedPrivacy.length }) }}
          </button>
          <button
            v-if="exitReady && selectedMissingExit.length > 0"
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="bulkBusy || exitAssigning"
            @click="assignExits(selectedMissingExit)"
          >
            <UiIcon :name="exitAssigning ? 'loader' : 'network'" :size="13" :spin="exitAssigning" />
            {{ t("accounts.exit.assignSelected", { n: selectedMissingExit.length }) }}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy" @click="openExport(selectedIds)">
            <UiIcon name="download" :size="13" />
            {{ t("accounts.bulk.export") }}
          </button>
          <ConfirmButton size="sm" :label="t('accounts.bulk.delete')" :disabled="bulkBusy" @confirm="bulkDelete" />
        </div>
      </div>

      <!-- Exit-routed accounts without an exit are refused by slipgate-net: surface and fix in place -->
      <div
        v-if="missingExitAccounts.length > 0"
        class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/70 bg-warning/[0.06] px-5 py-2.5 text-sm"
      >
        <UiIcon name="alert" :size="15" class="shrink-0 text-warning" />
        <span class="min-w-0 flex-1 text-fg">{{ t("accounts.exit.banner", { n: missingExitAccounts.length }) }}</span>
        <div class="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :class="statusFilter === 'missing_exit' ? 'text-accent' : ''"
            @click="statusFilter = statusFilter === 'missing_exit' ? 'all' : 'missing_exit'"
          >
            <UiIcon name="filter" :size="13" />
            {{ statusFilter === "missing_exit" ? t("accounts.exit.bannerShowAll") : t("accounts.exit.bannerShow") }}
          </button>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="exitAssigning"
            @click="assignExits(missingExitAccounts)"
          >
            <UiIcon :name="exitAssigning ? 'loader' : 'network'" :size="13" :spin="exitAssigning" />
            {{ t("accounts.exit.assignAll") }}
          </button>
        </div>
      </div>

      <EmptyState
        v-if="filteredAccounts.length === 0"
        icon="users"
        :title="accounts.length === 0 ? t('accounts.list.empty') : t('accounts.list.noMatch')"
      >
        <template v-if="accounts.length === 0">
          <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
            <UiIcon name="plus" :size="14" />
            {{ t("accounts.actions.addAccount") }}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" @click="importOpen = true">
            <UiIcon name="upload" :size="14" />
            {{ t("accounts.actions.import") }}
          </button>
        </template>
        <button v-else-if="hasFilters" type="button" class="btn btn-secondary btn-sm" @click="clearFilters">
          {{ t("accounts.filters.clear") }}
        </button>
      </EmptyState>

      <AccountTable
        v-else-if="viewMode === 'table'"
        :accounts="pagedAccounts"
        :columns="columns"
        :sort="sort"
        :selected="selected"
        :today="todayUsage"
        :now="now"
        :busy="busyIds"
        :exit-pool="exitPool"
        :exit-ready="exitReady"
        :scheduled="scheduledMinutes"
        @exit="openExit"
        @toggle-select="toggleOne"
        @toggle-page="togglePage"
        @sort="setSort"
        @filter-group="groupFilter = $event || UNGROUPED_FILTER"
        @toggle-status="toggleAccountStatus"
        @resume="resumeAccount"
        @test="openTest"
        @edit="openEdit"
        @stats="openStats"
        @menu="openMenu"
        @priority="setPriority"
      />

      <div v-else class="grid gap-4 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-3">
        <AccountCard
          v-for="acc in pagedAccounts"
          :key="acc.id"
          :account="acc"
          :selected="selected.has(acc.id)"
          :today="todayUsage.get(acc.id) ?? null"
          :now="now"
          :busy="busyIds.has(acc.id)"
          :exit-binding="exitBindingOf(acc)"
          :exit-node="exitNodeOf(acc)"
          :exit-ready="exitReady"
          :scheduled-minutes="scheduledMinutes.get(acc.id) ?? null"
          @exit="openExit(acc)"
          @toggle-select="toggleOne(acc.id)"
          @filter-group="groupFilter = $event || UNGROUPED_FILTER"
          @toggle-status="toggleAccountStatus(acc)"
          @resume="resumeAccount(acc)"
          @test="openTest(acc)"
          @edit="openEdit(acc)"
          @stats="openStats(acc)"
          @menu="openMenu(acc, $event)"
          @priority="setPriority(acc, $event)"
        />
      </div>

      <template v-if="filteredAccounts.length > 0" #footer>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-3">
            <span class="text-xs text-fg-muted">
              {{ t("accounts.pagination.summary", { page, pages: pageCount, total: filteredAccounts.length }) }}
            </span>
            <UiSelect
              v-if="viewMode === 'table'"
              v-model.number="pageSize"
              class="select input-sm w-auto"
              :aria-label="t('accounts.list.pageSize', { n: pageSize })"
            >
              <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ t("accounts.list.pageSize", { n }) }}</option>
            </UiSelect>
          </div>
          <div v-if="pageCount > 1" class="flex items-center gap-1.5">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="page <= 1" @click="page -= 1">
              <UiIcon name="chevron-right" :size="13" class="rotate-180" />
              {{ t("accounts.pagination.prev") }}
            </button>
            <button type="button" class="btn btn-secondary btn-sm" :disabled="page >= pageCount" @click="page += 1">
              {{ t("accounts.pagination.next") }}
              <UiIcon name="chevron-right" :size="13" />
            </button>
          </div>
        </div>
      </template>
    </UiCard>

    <AccountRowMenu
      v-model:open="menuOpen"
      :account="menuAccount"
      :anchor="menuAnchor"
      @test="openTest"
      @stats="openStats"
      @edit="openEdit"
      @duplicate="openDuplicate"
      @cooldown="cooldownAccount"
      @resume="resumeAccount"
      @refresh="refreshToken"
      @privacy="setPrivacy"
      @reauth="openReauth"
      @reset-quota="resetQuota"
      @schedule="openSchedule"
      @exit="openExit"
      :schedule="menuAccount ? (testSchedules.get(menuAccount.id) ?? null) : null"
      :exit-ready="exitReady"
      @delete="removeAccount"
    />

    <AccountFormModal
      v-model:open="formOpen"
      :account="formAccount"
      :template="formTemplate"
      :groups="groups"
      :default-group-id="defaultGroupId"
      :account-names="accountNames"
      :exit-pool="exitPool"
      :reauth="formReauth"
      @saved="refreshPool(true)"
    />
    <AccountStatsDrawer v-model:open="statsOpen" :account="statsAccount" :now="now" />
    <AccountTestScheduleModal
      v-model:open="scheduleOpen"
      :account="scheduleAccount"
      :schedule="scheduleAccount ? (testSchedules.get(scheduleAccount.id) ?? null) : null"
      @changed="refreshPool(true)"
    />
    <CliFingerprintModal v-model:open="cliOpen" />
    <AccountExitModal v-model:open="exitOpen" :account="exitAccount" :pool="exitPool" @saved="refreshPool(true)" />
    <AccountTestModal v-model:open="testOpen" :account="testTarget" @tested="refreshPool(true)" />
    <AccountBatchTestModal v-model:open="batchTestOpen" :accounts="batchTestTargets" @finished="refreshPool(true)" />
    <AccountBulkEditModal v-model:open="bulkEditOpen" :accounts="selectedAccounts" :groups="groups" @done="onBulkEdited" />
    <AccountImportModal
      v-model:open="importOpen"
      :groups="groups"
      :default-group-id="defaultGroupId"
      :account-names="accountNames"
      @imported="refreshPool(true)"
    />
    <AccountExportModal v-model:open="exportOpen" :selected-ids="exportIds" :total-count="accounts.length" />
  </div>
</template>
