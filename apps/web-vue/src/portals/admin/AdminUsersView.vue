<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import {
  USER_USAGE_TOTAL_WINDOW_DAYS,
  type AdminStepUp,
  type AdminUserItem,
  type AdminUserListResponse,
  type AdminUserLiveStatsResponse,
  type AdminUserSort,
  type AdminUserUsageStatsResponse,
  type GroupItem,
  type ReplaceUserGroupResponse,
  type UserRole,
  type UserStatus,
} from "@slipgate/contracts";
import AdminStepUpModal from "../../components/admin/AdminStepUpModal.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import BulkDeleteUsersModal from "../../components/admin/users/BulkDeleteUsersModal.vue";
import BulkUserLimitsModal from "../../components/admin/users/BulkUserLimitsModal.vue";
import ColumnPicker from "../../components/admin/users/ColumnPicker.vue";
import GroupChips from "../../components/admin/users/GroupChips.vue";
import ReplaceGroupModal from "../../components/admin/users/ReplaceGroupModal.vue";
import UserDetailDrawer, { type UserDetailTab } from "../../components/admin/users/UserDetailDrawer.vue";
import UserAttributeDefinitionsModal from "../../components/admin/users/UserAttributeDefinitionsModal.vue";
import UserLiveCell from "../../components/admin/users/UserLiveCell.vue";
import UserUsageCell from "../../components/admin/users/UserUsageCell.vue";
import { useLimitText } from "../../components/admin/users/limits";
import UserBalanceModal from "../../components/admin/users/UserBalanceModal.vue";
import UserFormModal from "../../components/admin/users/UserFormModal.vue";
import UserLedgerDrawer from "../../components/admin/users/UserLedgerDrawer.vue";
import UserRowMenu from "../../components/admin/users/UserRowMenu.vue";
import {
  STATUS_TONE,
  avatarTone,
  displayName,
  formatSignedUsd,
  initial,
  staggerStyle,
} from "../../components/admin/users/userDisplay";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { useNow } from "../../composables/useNow";
import { usePersistentState } from "../../composables/usePersistentState";
import { apiJson, errorText, toQuery } from "../../lib/api";
import { formatCompact, formatDateShort, formatDateTime, formatRelative } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import UiSelect from "../../components/ui/UiSelect.vue";

const { t } = useI18n();
const { capText } = useLimitText();
const auth = useAuthStore();
const router = useRouter();
const now = useNow(60_000);

const errorMessage = ref<string | null>(null);
const notice = ref<string | null>(null);
useFeedbackToasts(errorMessage, notice);

const selfId = computed(() => auth.user?.id ?? null);
const isAdmin = computed(() => auth.isAdmin);
const attrDefsOpen = ref(false);

/* ---------------- List state ---------------- */

const items = ref<AdminUserItem[]>([]);
const total = ref(0);
const stats = ref<AdminUserListResponse["stats"] | null>(null);
const loading = ref(false);
const loaded = ref(false);

const page = ref(1);
const pageSize = ref(20);
// Other pages deep-link here with ?search=<email> (orders, rebates, subscriptions).
const route = useRoute();
const initialSearch = typeof route.query.search === "string" ? route.query.search.slice(0, 200) : "";
const search = ref(initialSearch);
const debouncedSearch = ref(initialSearch.trim());
const roleFilter = ref<"" | UserRole>("");
const statusFilter = ref<"" | UserStatus>("");
/** Users granted this exclusive group / owning a key bound to this group. */
const groupFilter = ref(typeof route.query.groupId === "string" ? route.query.groupId.slice(0, 128) : "");
const keyGroupFilter = ref(typeof route.query.apiKeyGroupId === "string" ? route.query.apiKeyGroupId.slice(0, 128) : "");
const sort = ref<AdminUserSort>("created_desc");

const SORTS: AdminUserSort[] = [
  "created_desc",
  "created_asc",
  "login_desc",
  "balance_desc",
  "balance_asc",
  "spent_desc",
  "email_asc",
  "today_cost_desc",
  "total_cost_desc",
  "last_used_desc",
  "last_active_desc",
];
/** Sorts added by lane U1 keep their labels in the userLimits namespace. */
const NEW_SORTS = new Set<AdminUserSort>(["today_cost_desc", "total_cost_desc", "last_used_desc", "last_active_desc"]);

let searchTimer: number | undefined;
watch(search, (value) => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => (debouncedSearch.value = value.trim()), 300);
});
onBeforeUnmount(() => window.clearTimeout(searchTimer));

const hasFilters = computed(
  () =>
    debouncedSearch.value !== "" ||
    roleFilter.value !== "" ||
    statusFilter.value !== "" ||
    groupFilter.value !== "" ||
    keyGroupFilter.value !== "",
);

function resetFilters() {
  search.value = "";
  debouncedSearch.value = "";
  roleFilter.value = "";
  statusFilter.value = "";
  groupFilter.value = "";
  keyGroupFilter.value = "";
}

// Registered before the query watcher so a filter change resets the page in the same flush.
watch([debouncedSearch, roleFilter, statusFilter, groupFilter, keyGroupFilter, sort, pageSize], () => {
  page.value = 1;
});

const query = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  search: debouncedSearch.value,
  role: roleFilter.value,
  status: statusFilter.value,
  sort: sort.value,
  groupId: groupFilter.value,
  apiKeyGroupId: keyGroupFilter.value,
  tz: new Date().getTimezoneOffset(),
}));

let seq = 0;
async function load() {
  const id = ++seq;
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await apiJson<AdminUserListResponse>(`/api/v1/admin/users${toQuery(query.value)}`, {
      fallbackError: t("adminUsers.errors.load"),
    });
    if (id !== seq) return;
    items.value = res.items;
    total.value = res.total;
    stats.value = res.stats;
    loaded.value = true;
    // Keep only selections that are still on screen.
    const visible = new Set(res.items.map((u) => u.id));
    selected.value = new Set([...selected.value].filter((uid) => visible.has(uid)));
    // A delete can leave us past the last page.
    const lastPage = Math.max(1, Math.ceil(res.total / pageSize.value));
    if (page.value > lastPage) page.value = lastPage;
    // Open dialogs follow the fresh rows (caps, grants, key counts).
    if (detailUser.value) detailUser.value = res.items.find((u) => u.id === detailUser.value!.id) ?? detailUser.value;
    void loadFigures(res.items.map((u) => u.id));
  } catch (err) {
    if (id === seq) errorMessage.value = errorText(err, t("adminUsers.errors.load"));
  } finally {
    if (id === seq) loading.value = false;
  }
}

watch(query, () => void load());

/* ---------------- Groups (for the exclusive-group picker) ---------------- */

const allGroups = ref<GroupItem[]>([]);
const exclusiveGroups = computed(() => allGroups.value.filter((g) => g.isExclusive));
const groupNames = computed(() => new Map(allGroups.value.map((g) => [g.id, g.name])));

async function loadGroups() {
  try {
    const res = await apiJson<{ groups: GroupItem[] }>("/api/v1/admin/groups");
    allGroups.value = [...res.groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  } catch (err) {
    errorMessage.value = errorText(err, t("adminUsers.errors.groups"));
  }
}

/* ---------------- Columns ---------------- */

type ColumnKey =
  | "role"
  | "status"
  | "groups"
  | "balance"
  | "usage"
  | "spent"
  | "live"
  | "limits"
  | "apiKeys"
  | "subscriptions"
  | "lastUsed"
  | "lastActive"
  | "lastLogin"
  | "created";
const COLUMN_KEYS: ColumnKey[] = [
  "role",
  "status",
  "groups",
  "balance",
  "usage",
  "spent",
  "live",
  "limits",
  "apiKeys",
  "subscriptions",
  "lastUsed",
  "lastActive",
  "lastLogin",
  "created",
];
const DEFAULT_HIDDEN: ColumnKey[] = ["spent", "limits", "lastActive"];
const hiddenColumns = usePersistentState<ColumnKey[]>(
  "slipgate.adminUsers.hiddenColumns.v1",
  DEFAULT_HIDDEN,
  (v): v is ColumnKey[] => Array.isArray(v) && v.every((k) => (COLUMN_KEYS as unknown[]).includes(k)),
);
const columnOptions = computed(() =>
  COLUMN_KEYS.map((key) => ({ key, label: t(`userLimits.columns.keys.${key}`) })),
);
const hiddenSet = computed(() => new Set(hiddenColumns.value));
const show = (key: ColumnKey) => !hiddenSet.value.has(key);

/* ---------------- Usage and live figures (per page of rows) ---------------- */

const usageById = ref(new Map<string, AdminUserUsageStatsResponse["items"][number]>());
const usageWindow = ref(USER_USAGE_TOTAL_WINDOW_DAYS);
const usageLoading = ref(false);
const liveById = ref(new Map<string, AdminUserLiveStatsResponse["items"][number]>());
const liveOk = ref(false);
const liveLoading = ref(false);
let figuresSeq = 0;
let liveSeq = 0;

async function loadUsage(ids: string[]) {
  const id = ++figuresSeq;
  usageLoading.value = true;
  try {
    const res = await apiJson<AdminUserUsageStatsResponse>(
      `/api/v1/admin/user-stats/usage${toQuery({ userIds: ids.join(","), tz: new Date().getTimezoneOffset() })}`,
    );
    if (id !== figuresSeq) return;
    usageById.value = new Map(res.items.map((it) => [it.userId, it]));
    usageWindow.value = res.windowDays;
  } catch {
    // Figures are decoration: the rows stay usable and the cells keep their placeholder.
  } finally {
    if (id === figuresSeq) usageLoading.value = false;
  }
}

async function loadLive(ids: string[]) {
  const id = ++liveSeq;
  liveLoading.value = true;
  try {
    const res = await apiJson<AdminUserLiveStatsResponse>(`/api/v1/admin/user-stats/live${toQuery({ userIds: ids.join(",") })}`);
    if (id !== liveSeq) return;
    liveById.value = new Map(res.items.map((it) => [it.userId, it]));
    liveOk.value = res.live;
  } catch {
    // Same as usage: keep the last known values.
  } finally {
    if (id === liveSeq) liveLoading.value = false;
  }
}

function loadFigures(ids: string[]) {
  if (!isAdmin.value || ids.length === 0) return;
  if (show("usage")) void loadUsage(ids);
  if (show("live")) void loadLive(ids);
}

// A column switched on loads its figures for the rows on screen.
watch(
  () => [show("usage"), show("live")] as const,
  ([usage, live], [wasUsage, wasLive]) => {
    const ids = items.value.map((u) => u.id);
    if (ids.length === 0) return;
    if (usage && !wasUsage) void loadUsage(ids);
    if (live && !wasLive) void loadLive(ids);
  },
);

// Live concurrency refreshes every 15 s while the column is on and the tab is visible.
const liveTimer = window.setInterval(() => {
  if (!show("live") || document.visibilityState !== "visible" || items.value.length === 0) return;
  void loadLive(items.value.map((u) => u.id));
}, 15_000);
onBeforeUnmount(() => window.clearInterval(liveTimer));

/* ---------------- Selection & bulk status ---------------- */

const selected = ref(new Set<string>());
const selectable = computed(() => items.value.filter((u) => u.id !== selfId.value));
const allSelected = computed(() => selectable.value.length > 0 && selectable.value.every((u) => selected.value.has(u.id)));
const someSelected = computed(() => !allSelected.value && selectable.value.some((u) => selected.value.has(u.id)));

function toggleSelect(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}
function togglePage() {
  selected.value = allSelected.value ? new Set() : new Set(selectable.value.map((u) => u.id));
}

const selectedUsers = computed(() => items.value.filter((u) => selected.value.has(u.id)));
const bulkLimitsOpen = ref(false);
const bulkDeleteOpen = ref(false);

function onBulkLimits() {
  void load();
}
function onBulkDeleted(ids: string[]) {
  selected.value = new Set([...selected.value].filter((id) => !ids.includes(id)));
  void load();
}

const bulkBusy = ref(false);
async function bulkStatus(status: UserStatus) {
  const ids = [...selected.value].filter((id) => id !== selfId.value);
  if (ids.length === 0 || bulkBusy.value) return;
  bulkBusy.value = true;
  errorMessage.value = null;
  notice.value = null;
  try {
    const res = await apiJson<{ changed: number }>("/api/v1/admin/users/batch-status", {
      method: "POST",
      body: { userIds: ids, status },
      fallbackError: t("adminUsers.errors.status"),
    });
    notice.value = t("adminUsers.notice.bulkStatus", { n: res.changed });
    selected.value = new Set();
    await load();
  } catch (err) {
    errorMessage.value = errorText(err, t("adminUsers.errors.status"));
  } finally {
    bulkBusy.value = false;
  }
}

/* ---------------- Row actions ---------------- */

const busyIds = ref(new Set<string>());
function setBusy(id: string, busy: boolean) {
  const next = new Set(busyIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

/* Changes that could take an account over ask for the admin's password (and code) first. */
const stepUpOpen = ref(false);
const stepUpTitle = ref("");
let stepUpAction: (confirm: AdminStepUp) => Promise<void> = async () => undefined;
function askStepUp(title: string, action: (confirm: AdminStepUp) => Promise<void>) {
  stepUpTitle.value = title;
  stepUpAction = action;
  stepUpOpen.value = true;
}
function runStepUp(confirm: AdminStepUp) {
  return stepUpAction(confirm);
}

async function applyStatus(u: AdminUserItem, status: UserStatus, confirm?: AdminStepUp) {
  await apiJson(`/api/v1/admin/users/${encodeURIComponent(u.id)}`, {
    method: "PATCH",
    body: confirm ? { status, confirm } : { status },
    fallbackError: t("adminUsers.errors.status"),
  });
  notice.value =
    status === "active" ? t("adminUsers.notice.activated", { email: u.email }) : t("adminUsers.notice.suspended", { email: u.email });
  await load();
}

async function toggleStatus(u: AdminUserItem) {
  if (u.id === selfId.value) return;
  const status: UserStatus = u.status === "active" ? "suspended" : "active";
  errorMessage.value = null;
  notice.value = null;
  if (u.role === "admin") {
    askStepUp(t("security.stepUp.titles.adminStatus"), (confirm) => applyStatus(u, status, confirm));
    return;
  }
  setBusy(u.id, true);
  try {
    await applyStatus(u, status);
  } catch (err) {
    errorMessage.value = errorText(err, t("adminUsers.errors.status"));
  } finally {
    setBusy(u.id, false);
  }
}

async function deleteUser(u: AdminUserItem) {
  if (u.id === selfId.value) return;
  errorMessage.value = null;
  notice.value = null;
  setBusy(u.id, true);
  try {
    await apiJson(`/api/v1/admin/users/${encodeURIComponent(u.id)}`, {
      method: "DELETE",
      fallbackError: t("adminUsers.errors.delete"),
    });
    notice.value = t("adminUsers.notice.deleted", { email: u.email });
    await load();
  } catch (err) {
    errorMessage.value = errorText(err, t("adminUsers.errors.delete"));
  } finally {
    setBusy(u.id, false);
  }
}

function resetTotp(u: AdminUserItem) {
  if (!u.totpEnabled) return;
  errorMessage.value = null;
  notice.value = null;
  askStepUp(t("security.stepUp.titles.totpReset"), async (confirm) => {
    await apiJson(`/api/v1/admin/users/${encodeURIComponent(u.id)}/totp/reset`, {
      method: "POST",
      body: { confirm },
      fallbackError: t("adminUsers.errors.totpReset"),
    });
    notice.value = t("adminUsers.notice.totpReset", { email: u.email });
    if (u.id === selfId.value && auth.user) auth.user.totpEnabled = false;
    await load();
  });
}

function viewUsage(u: AdminUserItem) {
  void router.push({ path: "/admin/usage", query: { userId: u.id } });
}

/* ---------------- Modals, drawers, menu ---------------- */

const formOpen = ref(false);
const editing = ref<AdminUserItem | null>(null);
const balanceOpen = ref(false);
const ledgerOpen = ref(false);
const target = ref<AdminUserItem | null>(null);

/** Caps, live status, per-group rates and keys of one user. */
const detailOpen = ref(false);
const detailTab = ref<UserDetailTab>("limits");
const detailUser = ref<AdminUserItem | null>(null);
function openDetail(u: AdminUserItem, tab: UserDetailTab) {
  detailUser.value = u;
  detailTab.value = tab;
  detailOpen.value = true;
}

const replaceOpen = ref(false);
const replaceUser = ref<AdminUserItem | null>(null);
function openReplace(u: AdminUserItem) {
  replaceUser.value = u;
  replaceOpen.value = true;
}
function onReplaced(_res: ReplaceUserGroupResponse) {
  void load();
}

const menuOpen = ref(false);
const menuUser = ref<AdminUserItem | null>(null);
const menuAnchor = ref<HTMLElement | null>(null);

function openCreate() {
  editing.value = null;
  formOpen.value = true;
}
function openEdit(u: AdminUserItem) {
  editing.value = u;
  formOpen.value = true;
}
function openBalance(u: AdminUserItem) {
  target.value = u;
  balanceOpen.value = true;
}
function openLedger(u: AdminUserItem) {
  target.value = u;
  ledgerOpen.value = true;
}
function openKeys(u: AdminUserItem) {
  openDetail(u, "keys");
}
function openMenu(u: AdminUserItem, ev: MouseEvent) {
  const anchor = ev.currentTarget as HTMLElement;
  if (menuOpen.value && menuUser.value?.id === u.id) {
    menuOpen.value = false;
    return;
  }
  menuUser.value = u;
  menuAnchor.value = anchor;
  menuOpen.value = true;
}

function onSaved(user: AdminUserItem, created: boolean) {
  notice.value = created
    ? t("adminUsers.notice.created", { email: user.email })
    : t("adminUsers.notice.saved", { email: user.email });
  void load();
}

function onAdjusted(user: AdminUserItem, balanceNanoUsd: string, deltaNanoUsd: string) {
  notice.value =
    deltaNanoUsd === "0"
      ? t("adminUsers.notice.balanceUnchanged")
      : t("adminUsers.notice.balance", { email: user.email, amount: formatSignedUsd(balanceNanoUsd) });
  void load();
}

/* ---------------- Display helpers ---------------- */

const sortOptions = computed(() =>
  SORTS.map((value) => ({
    value,
    label: NEW_SORTS.has(value) ? t(`userLimits.sorts.${value}`) : t(`adminUsers.filters.sorts.${value}`),
  })),
);

function isSelf(u: AdminUserItem) {
  return u.id === selfId.value;
}

onMounted(() => {
  void load();
  void loadGroups();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.users')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button v-if="isAdmin" type="button" class="btn btn-secondary" @click="attrDefsOpen = true">
          <UiIcon name="sliders" :size="15" />
          {{ t("adminUsers.attributes.manage") }}
        </button>
        <button v-if="isAdmin" type="button" class="btn btn-primary" @click="openCreate">
          <UiIcon name="user-plus" :size="15" />
          {{ t("adminUsers.actions.create") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-5">
      <StatCard
        class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
        :label="t('adminUsers.stats.total')"
        :value="stats ? formatCompact(stats.total) : '—'"
        icon="users"
        tone="accent"
      />
      <StatCard
        class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
        :style="staggerStyle(1, 40)"
        :label="t('adminUsers.stats.admins')"
        :value="stats ? formatCompact(stats.admins) : '—'"
        icon="crown"
        tone="violet"
      />
      <StatCard
        class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
        :style="staggerStyle(2, 40)"
        :label="t('adminUsers.stats.suspended')"
        :value="stats ? formatCompact(stats.suspended) : '—'"
        icon="pause"
        :tone="stats && stats.suspended > 0 ? 'danger' : 'neutral'"
      />
      <StatCard
        class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
        :style="staggerStyle(3, 40)"
        :label="t('adminUsers.stats.newLast7d')"
        :value="stats ? formatCompact(stats.newLast7d) : '—'"
        icon="trending-up"
        tone="success"
      />
      <StatCard
        class="col-span-2 animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none sm:col-span-1"
        :style="staggerStyle(4, 40)"
        :label="t('adminUsers.stats.balance')"
        :value="stats ? formatSignedUsd(stats.balanceNanoUsd) : '—'"
        icon="wallet"
        tone="info"
        mono
      />
    </div>

    <UiCard icon="users" :title="t('adminUsers.list.title')" flush>
      <template #actions>
        <span v-if="loaded" class="font-mono text-xs tabular-nums text-fg-subtle">{{ formatCompact(total) }}</span>
      </template>

      <!-- Toolbar -->
      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span class="sr-only">{{ t("common.search") }}</span>
          <UiIcon
            name="search"
            :size="14"
            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input
            v-model="search"
            type="search"
            class="input input-sm pl-8"
            :placeholder="t('adminUsers.filters.searchPlaceholder')"
          />
        </label>
        <UiSelect v-model="roleFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('adminUsers.table.role')">
          <option value="">{{ t("adminUsers.filters.allRoles") }}</option>
          <option v-if="isAdmin" value="admin">{{ t("adminUsers.roles.admin") }}</option>
          <option value="group_manager">{{ t("adminUsers.roles.group_manager") }}</option>
          <option value="user">{{ t("adminUsers.roles.user") }}</option>
        </UiSelect>
        <UiSelect
          v-model="statusFilter"
          class="select input-sm w-auto min-w-[8rem]"
          :aria-label="t('adminUsers.table.status')"
        >
          <option value="">{{ t("adminUsers.filters.allStatuses") }}</option>
          <option value="active">{{ t("adminUsers.statuses.active") }}</option>
          <option value="suspended">{{ t("adminUsers.statuses.suspended") }}</option>
        </UiSelect>
        <UiSelect
          v-model="groupFilter"
          class="select input-sm w-auto min-w-[8rem] max-w-[12rem]"
          :class="groupFilter ? '!border-accent/50 text-accent' : ''"
          :aria-label="t('userLimits.filters.group')"
          :title="t('userLimits.filters.groupHint')"
        >
          <option value="">{{ t("userLimits.filters.allGroups") }}</option>
          <option v-for="g in exclusiveGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </UiSelect>
        <UiSelect
          v-model="keyGroupFilter"
          class="select input-sm w-auto min-w-[8rem] max-w-[12rem]"
          :class="keyGroupFilter ? '!border-accent/50 text-accent' : ''"
          :aria-label="t('userLimits.filters.keyGroup')"
          :title="t('userLimits.filters.keyGroupHint')"
        >
          <option value="">{{ t("userLimits.filters.allKeyGroups") }}</option>
          <option v-for="g in allGroups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </UiSelect>
        <button v-if="hasFilters" type="button" class="btn btn-ghost btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="13" />
          {{ t("adminUsers.filters.clear") }}
        </button>
        <label class="flex items-center gap-1.5 sm:ml-auto">
          <UiIcon name="arrow-down" :size="13" class="text-fg-subtle" />
          <span class="sr-only">{{ t("adminUsers.filters.sort") }}</span>
          <UiSelect v-model="sort" class="select input-sm w-auto min-w-[9.5rem]">
            <option v-for="opt in sortOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </UiSelect>
        </label>
        <ColumnPicker v-model:hidden="hiddenColumns" :columns="columnOptions" :defaults="DEFAULT_HIDDEN" />
      </div>

      <!-- Bulk bar -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        leave-active-class="transition duration-150 ease-in"
        enter-from-class="-translate-y-1 opacity-0"
        leave-to-class="-translate-y-1 opacity-0"
      >
        <div
          v-if="selected.size > 0"
          class="flex flex-wrap items-center gap-2 border-b border-accent/20 bg-accent/[0.05] px-5 py-2.5"
        >
          <span class="text-xs font-medium text-accent">{{ t("adminUsers.bulk.selected", { n: selected.size }) }}</span>
          <div class="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" class="btn btn-primary btn-sm" :disabled="bulkBusy" @click="bulkLimitsOpen = true">
              <UiIcon name="gauge" :size="13" />
              {{ t("userLimits.bulk.action") }}
            </button>
            <button type="button" class="btn btn-success btn-sm" :disabled="bulkBusy" @click="bulkStatus('active')">
              <UiIcon :name="bulkBusy ? 'loader' : 'play'" :size="13" :spin="bulkBusy" />
              {{ t("adminUsers.bulk.activate") }}
            </button>
            <button type="button" class="btn btn-danger btn-sm" :disabled="bulkBusy" @click="bulkStatus('suspended')">
              <UiIcon :name="bulkBusy ? 'loader' : 'pause'" :size="13" :spin="bulkBusy" />
              {{ t("adminUsers.bulk.suspend") }}
            </button>
            <button type="button" class="btn btn-danger btn-sm" :disabled="bulkBusy" @click="bulkDeleteOpen = true">
              <UiIcon name="trash" :size="13" />
              {{ t("userLimits.bulkDelete.action") }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="bulkBusy" @click="selected = new Set()">
              <UiIcon name="x" :size="13" />
              {{ t("adminUsers.bulk.clear") }}
            </button>
          </div>
        </div>
      </Transition>

      <!-- First load skeleton -->
      <div v-if="!loaded && loading" class="divide-y divide-line/60" aria-busy="true">
        <div v-for="i in 6" :key="i" class="flex animate-pulse items-center gap-3 px-5 py-3.5">
          <span class="h-4 w-4 rounded bg-surface-2" />
          <span class="h-9 w-9 rounded-full bg-surface-2" />
          <span class="flex-1 space-y-1.5">
            <span class="block h-3 w-40 max-w-full rounded bg-surface-2" />
            <span class="block h-2.5 w-56 max-w-full rounded bg-surface-2" />
          </span>
          <span class="hidden h-3 w-16 rounded bg-surface-2 sm:block" />
          <span class="hidden h-3 w-20 rounded bg-surface-2 md:block" />
        </div>
      </div>

      <EmptyState
        v-else-if="loaded && items.length === 0 && hasFilters"
        icon="search"
        :title="t('adminUsers.list.noMatch')"
      >
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("adminUsers.filters.clear") }}
        </button>
      </EmptyState>
      <EmptyState v-else-if="loaded && items.length === 0" icon="users" :title="t('adminUsers.list.empty')">
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <UiIcon name="user-plus" :size="14" />
          {{ t("adminUsers.actions.create") }}
        </button>
      </EmptyState>

      <div v-else class="table-wrap transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
        <table class="data-table">
          <thead>
            <tr>
              <th v-if="isAdmin" class="w-10">
                <input
                  type="checkbox"
                  class="checkbox"
                  :checked="allSelected"
                  :indeterminate="someSelected"
                  :disabled="selectable.length === 0"
                  :aria-label="t('adminUsers.table.selectPage')"
                  @change="togglePage"
                />
              </th>
              <th>{{ t("adminUsers.table.user") }}</th>
              <th v-if="show('role')">{{ t("adminUsers.table.role") }}</th>
              <th v-if="show('status')">{{ t("adminUsers.table.status") }}</th>
              <th v-if="show('groups')">{{ t("userLimits.columns.keys.groups") }}</th>
              <th v-if="show('balance')" class="text-right">{{ t("adminUsers.table.balance") }}</th>
              <th v-if="show('usage')">{{ t("userLimits.columns.keys.usage") }}</th>
              <th v-if="show('spent')" class="text-right">{{ t("adminUsers.table.spent") }}</th>
              <th v-if="show('live')">{{ t("userLimits.columns.keys.live") }}</th>
              <th v-if="show('limits')">{{ t("userLimits.columns.keys.limits") }}</th>
              <th v-if="show('apiKeys')" class="text-right">{{ t("adminUsers.table.apiKeys") }}</th>
              <th v-if="show('subscriptions')" class="text-right">{{ t("adminUsers.table.subscriptions") }}</th>
              <th v-if="show('lastUsed')">{{ t("userLimits.columns.keys.lastUsed") }}</th>
              <th v-if="show('lastActive')">{{ t("userLimits.columns.keys.lastActive") }}</th>
              <th v-if="show('lastLogin')">{{ t("adminUsers.table.lastLogin") }}</th>
              <th v-if="show('created')">{{ t("adminUsers.table.created") }}</th>
              <th v-if="isAdmin" class="sticky-end text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(u, i) in items"
              :key="u.id"
              class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
              :class="[
                selected.has(u.id) ? 'is-selected !bg-accent/[0.06]' : '',
                u.status === 'suspended' ? 'text-fg-muted' : '',
              ]"
              :style="staggerStyle(i)"
            >
              <td v-if="isAdmin">
                <input
                  type="checkbox"
                  class="checkbox"
                  :checked="selected.has(u.id)"
                  :disabled="isSelf(u)"
                  :aria-label="t('adminUsers.table.select', { name: u.email })"
                  @change="toggleSelect(u.id)"
                />
              </td>

              <td class="min-w-[14rem] max-w-[20rem]">
                <div class="flex min-w-0 items-center gap-3">
                  <span
                    class="icon-chip h-9 w-9 rounded-full text-sm font-semibold"
                    :class="u.status === 'suspended' ? '' : avatarTone(u.id)"
                    aria-hidden="true"
                  >
                    {{ initial(u) }}
                  </span>
                  <div class="min-w-0">
                    <p class="flex min-w-0 items-center gap-1.5">
                      <button
                        type="button"
                        class="cursor-pointer truncate text-left font-medium text-fg transition-colors hover:text-accent"
                        :title="t('adminUsers.actions.edit')"
                        @click="isAdmin && openEdit(u)"
                      >
                        {{ displayName(u) }}
                      </button>
                      <UiBadge v-if="isSelf(u)" tone="accent">{{ t("adminUsers.you") }}</UiBadge>
                      <span v-if="u.totpEnabled" class="shrink-0 text-success" :title="t('adminUsers.table.totp')">
                        <UiIcon name="shield" :size="12" />
                        <span class="sr-only">{{ t("adminUsers.table.totp") }}</span>
                      </span>
                    </p>
                    <p class="truncate text-xs text-fg-subtle" :title="u.email">{{ u.email }}</p>
                    <p v-if="u.notes" class="mt-0.5 truncate text-2xs text-fg-muted" :title="u.notes">{{ u.notes }}</p>
                  </div>
                </div>
              </td>

              <td v-if="show('role')">
                <UiBadge :tone="u.role === 'admin' ? 'violet' : u.role === 'group_manager' ? 'info' : 'neutral'">
                  <UiIcon v-if="u.role === 'admin'" name="crown" :size="10" class="-ml-0.5 mr-0.5 inline" />
                  {{ t(`adminUsers.roles.${u.role}`) }}
                </UiBadge>
              </td>

              <td v-if="show('status')">
                <UiBadge :tone="STATUS_TONE[u.status]" dot>{{ t(`adminUsers.statuses.${u.status}`) }}</UiBadge>
              </td>

              <td v-if="show('groups')">
                <GroupChips :ids="u.allowedGroupIds" :names="groupNames" />
              </td>

              <td v-if="show('balance')" class="whitespace-nowrap text-right">
                <button
                  type="button"
                  class="cursor-pointer rounded-md px-1.5 py-0.5 font-mono text-xs font-medium tabular-nums transition-colors hover:bg-accent/10 hover:text-accent"
                  :class="u.balanceNanoUsd.startsWith('-') ? 'text-danger' : 'text-fg'"
                  :title="t('adminUsers.actions.balance')"
                  @click="openBalance(u)"
                >
                  {{ formatSignedUsd(u.balanceNanoUsd) }}
                </button>
              </td>
              <td v-if="show('usage')" class="whitespace-nowrap">
                <UserUsageCell :usage="usageById.get(u.id) ?? null" :window-days="usageWindow" :loading="usageLoading" />
              </td>
              <td v-if="show('spent')" class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">
                {{ formatSignedUsd(u.spentNanoUsd) }}
              </td>
              <td v-if="show('live')" class="whitespace-nowrap">
                <UserLiveCell :stat="liveById.get(u.id) ?? null" :live="liveOk" :loading="liveLoading" />
              </td>
              <td v-if="show('limits')" class="whitespace-nowrap">
                <button
                  type="button"
                  class="group/caps cursor-pointer rounded-md px-1.5 py-0.5 text-left text-xs transition-colors hover:bg-accent/10"
                  :title="t('userLimits.menu.limits')"
                  @click="openDetail(u, 'limits')"
                >
                  <span class="block font-mono tabular-nums text-fg group-hover/caps:text-accent">
                    {{ capText(u.effectiveRpmLimit ?? 0, "rpm") }}
                    <span v-if="u.rpmLimit === null || u.rpmLimit === undefined" class="font-sans text-2xs text-fg-subtle">· {{ t("userLimits.cap.default") }}</span>
                  </span>
                  <span class="block font-mono tabular-nums text-fg-muted group-hover/caps:text-accent">
                    {{ capText(u.effectiveConcurrencyLimit ?? 0, "concurrency") }}
                    <span v-if="u.concurrencyLimit === null || u.concurrencyLimit === undefined" class="font-sans text-2xs text-fg-subtle">· {{ t("userLimits.cap.default") }}</span>
                  </span>
                </button>
              </td>
              <td v-if="show('apiKeys')" class="text-right">
                <button
                  type="button"
                  class="cursor-pointer rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums transition-colors hover:bg-accent/10 hover:text-accent"
                  :class="u.apiKeyCount > 0 ? 'text-fg' : 'text-fg-subtle'"
                  :title="t('adminUsers.actions.apiKeys')"
                  @click="openKeys(u)"
                >
                  {{ u.apiKeyCount }}
                </button>
              </td>
              <td v-if="show('subscriptions')" class="text-right font-mono text-xs tabular-nums">
                <RouterLink
                  v-if="u.activeSubscriptionCount > 0"
                  :to="{ path: '/admin/subscriptions', query: { search: u.email } }"
                  class="rounded-md px-1.5 py-0.5 text-accent transition-colors hover:bg-accent/10"
                >
                  {{ u.activeSubscriptionCount }}
                </RouterLink>
                <span v-else class="px-1.5 text-fg-subtle">0</span>
              </td>
              <td v-if="show('lastUsed')" class="whitespace-nowrap text-xs">
                <span v-if="u.lastApiUsedAtIso" class="text-fg-muted" :title="formatDateTime(u.lastApiUsedAtIso)">
                  {{ formatRelative(u.lastApiUsedAtIso, now) }}
                </span>
                <span v-else class="text-fg-subtle">{{ t("userLimits.columns.neverUsed") }}</span>
              </td>
              <td v-if="show('lastActive')" class="whitespace-nowrap text-xs">
                <span v-if="u.lastActiveAtIso" class="text-fg-muted" :title="formatDateTime(u.lastActiveAtIso)">
                  {{ formatRelative(u.lastActiveAtIso, now) }}
                </span>
                <span v-else class="text-fg-subtle">{{ t("userLimits.columns.neverActive") }}</span>
              </td>
              <td v-if="show('lastLogin')" class="whitespace-nowrap text-xs">
                <span v-if="u.lastLoginAtIso" class="text-fg-muted" :title="formatDateTime(u.lastLoginAtIso)">
                  {{ formatRelative(u.lastLoginAtIso, now) }}
                </span>
                <span v-else class="text-fg-subtle">{{ t("adminUsers.table.never") }}</span>
              </td>
              <td v-if="show('created')" class="whitespace-nowrap font-mono text-xs text-fg-muted" :title="formatDateTime(u.createdAtIso)">
                {{ formatDateShort(u.createdAtIso) }}
              </td>

              <td v-if="isAdmin" class="sticky-end whitespace-nowrap text-right">
                <div class="inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-sm"
                    :title="t('adminUsers.actions.edit')"
                    :aria-label="t('adminUsers.actions.labelFor', { action: t('adminUsers.actions.edit'), name: u.email })"
                    @click="openEdit(u)"
                  >
                    <UiIcon name="pencil" :size="14" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-sm text-success hover:!bg-success/10"
                    :title="t('adminUsers.actions.balance')"
                    :aria-label="t('adminUsers.actions.labelFor', { action: t('adminUsers.actions.balance'), name: u.email })"
                    @click="openBalance(u)"
                  >
                    <UiIcon name="wallet" :size="14" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-sm"
                    aria-haspopup="menu"
                    :aria-expanded="menuOpen && menuUser?.id === u.id"
                    :disabled="busyIds.has(u.id)"
                    :title="t('adminUsers.actions.more')"
                    :aria-label="t('adminUsers.actions.labelFor', { action: t('adminUsers.actions.more'), name: u.email })"
                    @click="openMenu(u, $event)"
                  >
                    <UiIcon :name="busyIds.has(u.id) ? 'loader' : 'more'" :size="16" :spin="busyIds.has(u.id)" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <UiPagination
        v-if="loaded && total > 0"
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="total"
        :disabled="loading"
      />
    </UiCard>

    <UserRowMenu
      v-model:open="menuOpen"
      :user="menuUser"
      :anchor="menuAnchor"
      :is-self="menuUser !== null && isSelf(menuUser)"
      @ledger="openLedger"
      @api-keys="openKeys"
      @usage="viewUsage"
      @toggle-status="toggleStatus"
      @delete="deleteUser"
      @reset-totp="resetTotp"
      @limits="(u) => openDetail(u, 'limits')"
      @rates="(u) => openDetail(u, 'rates')"
      @replace-group="openReplace"
    />
    <UserFormModal v-model:open="formOpen" :user="editing" :groups="exclusiveGroups" :managed-groups="allGroups" :self-id="selfId" @saved="onSaved" />
    <UserAttributeDefinitionsModal v-model:open="attrDefsOpen" />
    <UserBalanceModal v-model:open="balanceOpen" :user="target" @adjusted="onAdjusted" />
    <UserLedgerDrawer v-model:open="ledgerOpen" :user="target" />
    <UserDetailDrawer v-model:open="detailOpen" v-model:tab="detailTab" :user="detailUser" :groups="allGroups" @changed="load" />
    <ReplaceGroupModal v-model:open="replaceOpen" :user="replaceUser" :groups="allGroups" @done="onReplaced" />
    <BulkUserLimitsModal v-model:open="bulkLimitsOpen" :user-ids="[...selected]" :total-users="stats?.total ?? total" @done="onBulkLimits" />
    <BulkDeleteUsersModal v-model:open="bulkDeleteOpen" :users="selectedUsers" :self-id="selfId" @done="onBulkDeleted" />
    <AdminStepUpModal v-model:open="stepUpOpen" :title="stepUpTitle" :action="runStepUp" />
  </div>
</template>

<style scoped>
/* Row actions stay reachable while the wide table scrolls horizontally. */
.sticky-end {
  position: sticky;
  right: 0;
  z-index: 1;
  background-color: rgb(var(--surface));
  box-shadow: inset 1px 0 0 rgb(var(--border));
}
thead .sticky-end {
  background-image: linear-gradient(rgb(var(--surface-2) / 0.6), rgb(var(--surface-2) / 0.6));
}
tbody tr:hover .sticky-end {
  background-image: linear-gradient(rgb(var(--surface-2) / 0.5), rgb(var(--surface-2) / 0.5));
}
tbody tr.is-selected .sticky-end {
  background-image: linear-gradient(rgb(var(--accent) / 0.06), rgb(var(--accent) / 0.06));
}
.dark .sticky-end {
  background-color: rgb(var(--bg));
  background-image: linear-gradient(rgb(var(--surface) / 0.7), rgb(var(--surface) / 0.7));
}
.dark thead .sticky-end {
  background-image:
    linear-gradient(rgb(var(--surface-2) / 0.4), rgb(var(--surface-2) / 0.4)),
    linear-gradient(rgb(var(--surface) / 0.7), rgb(var(--surface) / 0.7));
}
.dark tbody tr:hover .sticky-end {
  background-image:
    linear-gradient(rgb(var(--surface-2) / 0.3), rgb(var(--surface-2) / 0.3)),
    linear-gradient(rgb(var(--surface) / 0.7), rgb(var(--surface) / 0.7));
}
.dark tbody tr.is-selected .sticky-end {
  background-image:
    linear-gradient(rgb(var(--accent) / 0.06), rgb(var(--accent) / 0.06)),
    linear-gradient(rgb(var(--surface) / 0.7), rgb(var(--surface) / 0.7));
}
</style>
