<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import type {
  BulkSubscriptionActionRequest,
  GroupItem,
  SubscriptionAction,
  UpdateSubscriptionRequest,
  UserSubscriptionItem,
  UserSubscriptionStatus,
} from "@slipgate/contracts";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import SubscriptionAssignModal from "../../components/admin/subscriptions/SubscriptionAssignModal.vue";
import SubscriptionExtendModal from "../../components/admin/subscriptions/SubscriptionExtendModal.vue";
import SubscriptionUsageCell from "../../components/admin/subscriptions/SubscriptionUsageCell.vue";
import { STATUS_TONE, expiryInfo } from "../../components/admin/subscriptions/subscriptionDisplay";
import { staggerStyle } from "../../components/admin/users/userDisplay";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { useNow } from "../../composables/useNow";
import { apiJson, errorText, toQuery } from "../../lib/api";
import { formatCompact, formatDateShort, formatDateTime, formatRelative } from "../../lib/format";

const { t, te } = useI18n();
const route = useRoute();
const now = useNow(60_000);

const errorMessage = ref<string | null>(null);
const notice = ref<string | null>(null);
useFeedbackToasts(errorMessage, notice);

/* ---------------- List state ---------------- */

const items = ref<UserSubscriptionItem[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);

const initialSearch = typeof route.query.search === "string" ? route.query.search : "";
const page = ref(1);
const pageSize = ref(20);
const search = ref(initialSearch);
const debouncedSearch = ref(initialSearch.trim());
const statusFilter = ref<"" | UserSubscriptionStatus>("");
const groupFilter = ref("");

let searchTimer: number | undefined;
watch(search, (value) => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => (debouncedSearch.value = value.trim()), 300);
});
onBeforeUnmount(() => window.clearTimeout(searchTimer));

const hasFilters = computed(() => debouncedSearch.value !== "" || statusFilter.value !== "" || groupFilter.value !== "");

function resetFilters() {
  search.value = "";
  debouncedSearch.value = "";
  statusFilter.value = "";
  groupFilter.value = "";
}

watch([debouncedSearch, statusFilter, groupFilter, pageSize], () => {
  page.value = 1;
});

const query = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  search: debouncedSearch.value,
  status: statusFilter.value,
  groupId: groupFilter.value,
}));

let seq = 0;
async function load() {
  const id = ++seq;
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await apiJson<{ items: UserSubscriptionItem[]; total: number }>(
      `/api/v1/admin/subscriptions${toQuery(query.value)}`,
      { fallbackError: t("subscriptions.errors.load") },
    );
    if (id !== seq) return;
    items.value = res.items;
    total.value = res.total;
    loaded.value = true;
    const visible = new Set(res.items.map((s) => s.id));
    selected.value = new Set([...selected.value].filter((sid) => visible.has(sid)));
    const lastPage = Math.max(1, Math.ceil(res.total / pageSize.value));
    if (page.value > lastPage) page.value = lastPage;
  } catch (err) {
    if (id === seq) errorMessage.value = errorText(err, t("subscriptions.errors.load"));
  } finally {
    if (id === seq) loading.value = false;
  }
}

watch(query, () => void load());

/* ---------------- Subscription groups ---------------- */

const groups = ref<GroupItem[]>([]);
const groupsLoaded = ref(false);

async function loadGroups() {
  try {
    const res = await apiJson<{ groups: GroupItem[] }>("/api/v1/admin/groups");
    groups.value = res.groups
      .filter((g) => g.subscriptionType === "subscription")
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  } catch (err) {
    errorMessage.value = errorText(err, t("subscriptions.errors.groups"));
  } finally {
    groupsLoaded.value = true;
  }
}

/* ---------------- Selection ---------------- */

const selected = ref(new Set<string>());
const allSelected = computed(() => items.value.length > 0 && items.value.every((s) => selected.value.has(s.id)));
const someSelected = computed(() => !allSelected.value && items.value.some((s) => selected.value.has(s.id)));
const selectedItems = computed(() => items.value.filter((s) => selected.value.has(s.id)));

function toggleSelect(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}
function togglePage() {
  selected.value = allSelected.value ? new Set() : new Set(items.value.map((s) => s.id));
}

/* ---------------- Row actions ---------------- */

const busyIds = ref(new Set<string>());
function setBusy(id: string, busy: boolean) {
  const next = new Set(busyIds.value);
  if (busy) next.add(id);
  else next.delete(id);
  busyIds.value = next;
}

const ACTION_NOTICE: Record<SubscriptionAction, string> = {
  extend: "subscriptions.notice.extended",
  reset_usage: "subscriptions.notice.reset",
  revoke: "subscriptions.notice.revoked",
  reactivate: "subscriptions.notice.reactivated",
};

async function runAction(sub: UserSubscriptionItem, action: SubscriptionAction, days?: number): Promise<boolean> {
  errorMessage.value = null;
  notice.value = null;
  setBusy(sub.id, true);
  try {
    const body: UpdateSubscriptionRequest = { action, ...(days !== undefined ? { days } : {}) };
    await apiJson(`/api/v1/admin/subscriptions/${encodeURIComponent(sub.id)}`, {
      method: "PATCH",
      body,
      fallbackError: t("subscriptions.errors.update"),
    });
    notice.value = t(ACTION_NOTICE[action], { email: sub.userEmail });
    await load();
    return true;
  } catch (err) {
    errorMessage.value = errorText(err, t("subscriptions.errors.update"));
    return false;
  } finally {
    setBusy(sub.id, false);
  }
}

async function deleteSub(sub: UserSubscriptionItem) {
  errorMessage.value = null;
  notice.value = null;
  setBusy(sub.id, true);
  try {
    await apiJson(`/api/v1/admin/subscriptions/${encodeURIComponent(sub.id)}`, {
      method: "DELETE",
      fallbackError: t("subscriptions.errors.delete"),
    });
    notice.value = t("subscriptions.notice.deleted");
    await load();
  } catch (err) {
    errorMessage.value = errorText(err, t("subscriptions.errors.delete"));
  } finally {
    setBusy(sub.id, false);
  }
}

/* ---------------- Bulk actions ---------------- */

const bulkBusy = ref(false);
const bulkFailures = ref<{ id: string; label: string; message: string }[]>([]);

async function runBulk(action: SubscriptionAction, days?: number): Promise<boolean> {
  const targets = selectedItems.value;
  if (targets.length === 0 || bulkBusy.value) return false;
  const labels = new Map(targets.map((s) => [s.id, `${s.userEmail} · ${s.groupName}`]));
  errorMessage.value = null;
  notice.value = null;
  bulkFailures.value = [];
  bulkBusy.value = true;
  try {
    const body: BulkSubscriptionActionRequest = { action, ids: targets.map((s) => s.id), ...(days !== undefined ? { days } : {}) };
    const res = await apiJson<{ items: UserSubscriptionItem[]; failed: { id: string; message: string }[] }>(
      "/api/v1/admin/subscriptions/bulk",
      { method: "POST", body, fallbackError: t("subscriptions.errors.bulk") },
    );
    bulkFailures.value = res.failed.map((f) => ({ id: f.id, label: labels.get(f.id) ?? f.id, message: f.message }));
    if (res.items.length > 0) notice.value = t("subscriptions.notice.bulkDone", { n: res.items.length });
    // Keep failed rows selected so they can be retried.
    selected.value = new Set(res.failed.map((f) => f.id));
    await load();
    return true;
  } catch (err) {
    errorMessage.value = errorText(err, t("subscriptions.errors.bulk"));
    return false;
  } finally {
    bulkBusy.value = false;
  }
}

/* ---------------- Modals ---------------- */

const assignOpen = ref(false);
const extendOpen = ref(false);
const extendTargets = ref<UserSubscriptionItem[]>([]);
const extendBulk = ref(false);

const extendBusy = computed(() =>
  extendBulk.value ? bulkBusy.value : extendTargets.value.some((s) => busyIds.value.has(s.id)),
);

function openExtend(sub: UserSubscriptionItem) {
  extendTargets.value = [sub];
  extendBulk.value = false;
  extendOpen.value = true;
}
function openBulkExtend() {
  extendTargets.value = [...selectedItems.value];
  extendBulk.value = true;
  extendOpen.value = true;
}
async function confirmExtend(days: number) {
  const ok = extendBulk.value
    ? await runBulk("extend", days)
    : extendTargets.value[0]
      ? await runAction(extendTargets.value[0], "extend", days)
      : false;
  if (ok) extendOpen.value = false;
}

function onAssigned(created: UserSubscriptionItem[]) {
  notice.value = t("subscriptions.notice.assigned", { n: new Set(created.map((s) => s.userId)).size });
  void load();
}

/* ---------------- Display helpers ---------------- */

/** Sources look like "admin", "redeem:<code>" or "order:<id>": label the kind, keep the reference for the tooltip. */
function sourceLabel(source: string): string {
  if (!source) return "—";
  const kind = source.split(":", 1)[0];
  const key = `subscriptions.sources.${kind}`;
  return te(key) ? t(key) : source;
}
function sourceRef(source: string): string | undefined {
  const i = source.indexOf(":");
  return i > 0 ? source.slice(i + 1) : undefined;
}

function expiryText(sub: UserSubscriptionItem): string {
  const info = expiryInfo(sub, now.value);
  if (info.state === "expired") return t("subscriptions.table.expired");
  if (info.state === "today") return t("subscriptions.table.expiresToday");
  return t("subscriptions.table.daysLeft", { n: info.days });
}

onMounted(() => {
  void load();
  void loadGroups();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.subscriptions')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="!groupsLoaded" @click="assignOpen = true">
          <UiIcon name="plus" :size="15" />
          {{ t("subscriptions.actions.assign") }}
        </button>
      </template>
    </PageHeader>

    <UiCard icon="badge-check" :title="t('subscriptions.list.title')" flush>
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
            :placeholder="t('subscriptions.filters.searchPlaceholder')"
          />
        </label>
        <select
          v-model="statusFilter"
          class="select input-sm w-auto min-w-[8rem]"
          :aria-label="t('subscriptions.table.status')"
        >
          <option value="">{{ t("subscriptions.filters.allStatuses") }}</option>
          <option value="active">{{ t("subscriptions.statuses.active") }}</option>
          <option value="expired">{{ t("subscriptions.statuses.expired") }}</option>
          <option value="revoked">{{ t("subscriptions.statuses.revoked") }}</option>
        </select>
        <select v-model="groupFilter" class="select input-sm w-auto min-w-[10rem]" :aria-label="t('subscriptions.table.group')">
          <option value="">{{ t("subscriptions.filters.allGroups") }}</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
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
          <span class="text-xs font-medium text-accent">
            {{ t("subscriptions.bulk.selected", { n: selected.size }) }}
          </span>
          <div class="ml-auto flex flex-wrap items-center gap-1.5">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy" @click="openBulkExtend">
              <UiIcon name="calendar" :size="13" />
              {{ t("subscriptions.bulk.extend") }}
            </button>
            <button type="button" class="btn btn-secondary btn-sm" :disabled="bulkBusy" @click="runBulk('reset_usage')">
              <UiIcon name="rotate-ccw" :size="13" />
              {{ t("subscriptions.bulk.resetUsage") }}
            </button>
            <button type="button" class="btn btn-success btn-sm" :disabled="bulkBusy" @click="runBulk('reactivate')">
              <UiIcon name="play" :size="13" />
              {{ t("subscriptions.bulk.reactivate") }}
            </button>
            <ConfirmButton
              size="sm"
              icon="x-circle"
              :label="t('subscriptions.bulk.revoke')"
              :confirm-label="t('subscriptions.actions.confirmRevoke')"
              :disabled="bulkBusy"
              @confirm="runBulk('revoke')"
            />
            <button type="button" class="btn btn-ghost btn-sm" :disabled="bulkBusy" @click="selected = new Set()">
              <UiIcon :name="bulkBusy ? 'loader' : 'x'" :size="13" :spin="bulkBusy" />
              {{ t("subscriptions.bulk.clear") }}
            </button>
          </div>
        </div>
      </Transition>

      <!-- Bulk failures -->
      <div v-if="bulkFailures.length" class="animate-slide-up border-b border-line/70 px-5 py-3">
        <UiAlert tone="warning" :title="t('subscriptions.bulk.failedTitle', { n: bulkFailures.length })">
          <ul class="max-h-36 space-y-0.5 overflow-y-auto text-xs">
            <li v-for="f in bulkFailures" :key="f.id" class="flex flex-wrap gap-x-2">
              <span class="text-fg">{{ f.label }}</span>
              <span class="text-fg-muted">{{ f.message }}</span>
            </li>
          </ul>
          <template #action>
            <button type="button" class="btn btn-ghost btn-xs shrink-0" @click="bulkFailures = []">
              {{ t("subscriptions.bulk.dismiss") }}
            </button>
          </template>
        </UiAlert>
      </div>

      <!-- First load skeleton -->
      <div v-if="!loaded && loading" class="divide-y divide-line/60" aria-busy="true">
        <div v-for="i in 5" :key="i" class="flex animate-pulse items-center gap-4 px-5 py-4">
          <span class="h-4 w-4 rounded bg-surface-2" />
          <span class="flex-1 space-y-1.5">
            <span class="block h-3 w-48 max-w-full rounded bg-surface-2" />
            <span class="block h-2.5 w-24 rounded bg-surface-2" />
          </span>
          <span class="hidden w-40 space-y-1.5 sm:block">
            <span class="block h-1.5 rounded-full bg-surface-2" />
            <span class="block h-1.5 w-3/4 rounded-full bg-surface-2" />
          </span>
          <span class="hidden h-3 w-20 rounded bg-surface-2 md:block" />
        </div>
      </div>

      <EmptyState
        v-else-if="loaded && items.length === 0 && hasFilters"
        icon="search"
        :title="t('subscriptions.list.noMatch')"
      >
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("subscriptions.filters.clear") }}
        </button>
      </EmptyState>
      <EmptyState v-else-if="loaded && items.length === 0" icon="badge-check" :title="t('subscriptions.list.empty')">
        <p class="w-full max-w-md text-xs leading-relaxed text-fg-subtle">{{ t("subscriptions.list.emptyHint") }}</p>
        <RouterLink to="/admin/groups" class="btn btn-secondary btn-sm">
          <UiIcon name="layers" :size="14" />
          {{ t("subscriptions.list.goGroups") }}
        </RouterLink>
        <button
          v-if="groups.length > 0"
          type="button"
          class="btn btn-primary btn-sm"
          @click="assignOpen = true"
        >
          <UiIcon name="plus" :size="14" />
          {{ t("subscriptions.actions.assign") }}
        </button>
      </EmptyState>

      <div v-else class="table-wrap transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
        <table class="data-table">
          <thead>
            <tr>
              <th class="w-10">
                <input
                  type="checkbox"
                  class="checkbox"
                  :checked="allSelected"
                  :indeterminate="someSelected"
                  :aria-label="t('subscriptions.table.selectPage')"
                  @change="togglePage"
                />
              </th>
              <th>{{ t("subscriptions.table.user") }}</th>
              <th>{{ t("subscriptions.table.group") }}</th>
              <th>{{ t("subscriptions.table.usage") }}</th>
              <th>{{ t("subscriptions.table.expires") }}</th>
              <th>{{ t("subscriptions.table.status") }}</th>
              <th>{{ t("subscriptions.table.source") }}</th>
              <th class="sticky-end text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(s, i) in items"
              :key="s.id"
              class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
              :class="[
                selected.has(s.id) ? 'is-selected !bg-accent/[0.06]' : '',
                s.status === 'active' ? '' : 'text-fg-muted',
              ]"
              :style="staggerStyle(i)"
            >
              <td>
                <input
                  type="checkbox"
                  class="checkbox"
                  :checked="selected.has(s.id)"
                  :aria-label="t('subscriptions.table.select', { name: s.userEmail })"
                  @change="toggleSelect(s.id)"
                />
              </td>

              <td class="min-w-[12rem] max-w-[18rem]">
                <p class="truncate font-medium text-fg" :title="s.userEmail">{{ s.userEmail }}</p>
                <p v-if="s.notes" class="mt-0.5 truncate text-2xs text-fg-muted" :title="s.notes">{{ s.notes }}</p>
                <p
                  v-if="s.usageResetAtIso"
                  class="mt-0.5 flex items-center gap-1 truncate text-2xs text-fg-subtle"
                  :title="formatDateTime(s.usageResetAtIso)"
                >
                  <UiIcon name="rotate-ccw" :size="10" />
                  {{ t("subscriptions.table.resetAt", { time: formatRelative(s.usageResetAtIso, now) }) }}
                </p>
              </td>

              <td>
                <span class="inline-flex max-w-[11rem] items-center gap-1 text-xs text-fg-muted">
                  <UiIcon name="layers" :size="12" class="shrink-0" />
                  <span class="truncate" :title="s.groupName">{{ s.groupName }}</span>
                </span>
              </td>

              <td>
                <SubscriptionUsageCell :limits="s.limits" :usage="s.usage" />
              </td>

              <td class="whitespace-nowrap">
                <p class="font-mono text-xs text-fg-muted" :title="formatDateTime(s.expiresAtIso)">
                  {{ formatDateShort(s.expiresAtIso) }}
                </p>
                <UiBadge v-if="s.status !== 'revoked'" class="mt-1" :tone="expiryInfo(s, now).tone">
                  {{ expiryText(s) }}
                </UiBadge>
              </td>

              <td>
                <div class="flex flex-col items-start gap-1">
                  <UiBadge :tone="STATUS_TONE[s.status]" dot>{{ t(`subscriptions.statuses.${s.status}`) }}</UiBadge>
                  <span
                    v-if="s.overLimit && s.status === 'active'"
                    class="inline-flex items-center gap-1 text-2xs font-medium text-danger"
                    :title="t('subscriptions.table.overLimitHint')"
                  >
                    <UiIcon name="alert" :size="11" />
                    {{ t("subscriptions.table.overLimit") }}
                  </span>
                </div>
              </td>

              <td class="whitespace-nowrap text-xs text-fg-muted">
                <p>{{ sourceLabel(s.source) }}</p>
                <p v-if="sourceRef(s.source)" class="mt-0.5 max-w-[9rem] truncate font-mono text-2xs text-fg-subtle" :title="s.source">
                  {{ sourceRef(s.source) }}
                </p>
              </td>

              <td class="sticky-end whitespace-nowrap text-right">
                <div class="inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :disabled="busyIds.has(s.id)"
                    :title="t('subscriptions.actions.extend')"
                    :aria-label="t('subscriptions.actions.labelFor', { action: t('subscriptions.actions.extend'), name: s.userEmail })"
                    @click="openExtend(s)"
                  >
                    <UiIcon name="calendar" :size="13" />
                  </button>
                  <ConfirmButton
                    icon-only
                    icon="rotate-ccw"
                    :label="t('subscriptions.actions.resetUsage')"
                    :confirm-label="t('subscriptions.actions.confirmReset')"
                    :disabled="busyIds.has(s.id)"
                    @confirm="runAction(s, 'reset_usage')"
                  />
                  <button
                    v-if="s.status === 'revoked'"
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs text-success hover:!bg-success/10"
                    :disabled="busyIds.has(s.id)"
                    :title="t('subscriptions.actions.reactivate')"
                    :aria-label="t('subscriptions.actions.labelFor', { action: t('subscriptions.actions.reactivate'), name: s.userEmail })"
                    @click="runAction(s, 'reactivate')"
                  >
                    <UiIcon name="play" :size="13" />
                  </button>
                  <ConfirmButton
                    v-else
                    icon-only
                    icon="x-circle"
                    :label="t('subscriptions.actions.revoke')"
                    :confirm-label="t('subscriptions.actions.confirmRevoke')"
                    :disabled="busyIds.has(s.id)"
                    @confirm="runAction(s, 'revoke')"
                  />
                  <ConfirmButton
                    icon-only
                    :label="t('subscriptions.actions.delete')"
                    :disabled="busyIds.has(s.id)"
                    @confirm="deleteSub(s)"
                  />
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

    <SubscriptionAssignModal v-model:open="assignOpen" :groups="groups" @assigned="onAssigned" />
    <SubscriptionExtendModal
      v-model:open="extendOpen"
      :targets="extendTargets"
      :busy="extendBusy"
      @confirm="confirmExtend"
    />
  </div>
</template>

<style scoped>
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
