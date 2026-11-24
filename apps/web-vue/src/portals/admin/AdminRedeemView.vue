<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  RedeemCodeClaimItem,
  RedeemCodeItem,
  RedeemCodeKind,
  RedeemCodeListResponse,
  RedeemCodeStatus,
  UpdateRedeemCodesRequest,
} from "@slipgate/contracts";
import ExpiryPresetField from "../../components/admin/ops/ExpiryPresetField.vue";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import RedeemGenerateModal from "../../components/admin/ops/RedeemGenerateModal.vue";
import RedeemResultModal from "../../components/admin/ops/RedeemResultModal.vue";
import {
  isPast,
  resolveExpiry,
  STAGGER_CLASS,
  stagger,
  useDebounced,
  type ExpiryPreset,
} from "../../components/admin/ops/opsUtil";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiModal from "../../components/ui/UiModal.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import { apiJson, downloadFile, errorText, toQuery } from "../../lib/api";
import { formatDateTime, formatNumber, formatRelative, formatUsd, type Tone } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();

const items = ref<RedeemCodeItem[]>([]);
const total = ref(0);
const stats = ref<RedeemCodeListResponse["stats"] | null>(null);
const loading = ref(false);
const loaded = ref(false);
const exporting = ref(false);
const toast = useToastStore();

function fail(err: unknown, fallback: string) {
  toast.error(errorText(err, fallback));
}

function succeed(message: string) {
  toast.success(message);
}

/* ---------------- Filters & paging ---------------- */

type StatusFilter = "all" | RedeemCodeStatus;

const search = ref("");
const debouncedSearch = useDebounced(search);
const statusFilter = ref<StatusFilter>("all");
const kindFilter = ref<"all" | RedeemCodeKind>("all");
const batchFilter = ref("");
const page = ref(1);
const pageSize = ref(20);

const statusOptions = computed(() => {
  const s = stats.value;
  return [
    { value: "all" as const, label: t("common.all"), count: s?.total },
    { value: "unused" as const, label: t("redeem.statuses.unused"), count: s?.unused },
    { value: "used" as const, label: t("redeem.statuses.used"), count: s?.used },
    { value: "disabled" as const, label: t("redeem.statuses.disabled"), count: s?.disabled },
    { value: "expired" as const, label: t("redeem.statuses.expired"), count: s?.expired },
  ];
});

const hasFilters = computed(
  () =>
    debouncedSearch.value.trim() !== "" ||
    statusFilter.value !== "all" ||
    kindFilter.value !== "all" ||
    batchFilter.value !== "",
);

function resetFilters() {
  search.value = "";
  debouncedSearch.value = "";
  statusFilter.value = "all";
  kindFilter.value = "all";
  batchFilter.value = "";
}

const filterParams = computed(() => ({
  search: debouncedSearch.value.trim() || undefined,
  status: statusFilter.value === "all" ? undefined : statusFilter.value,
  kind: kindFilter.value === "all" ? undefined : kindFilter.value,
  batchId: batchFilter.value || undefined,
}));

/* ---------------- Loading ---------------- */

let seq = 0;
let scheduled = false;

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const res = await apiJson<RedeemCodeListResponse>(
      `/api/v1/admin/redeem-codes${toQuery({ ...filterParams.value, page: page.value, pageSize: pageSize.value })}`,
      { fallbackError: t("redeem.admin.errors.load") },
    );
    if (mine !== seq) return;
    items.value = res.items;
    total.value = res.total;
    stats.value = res.stats;
    loaded.value = true;
    // Drop selections that are no longer on screen.
    const visible = new Set(res.items.map((i) => i.code));
    selected.value = new Set([...selected.value].filter((c) => visible.has(c)));
    // Deleting the last rows of the last page: step back.
    if (res.items.length === 0 && res.total > 0 && page.value > 1) {
      page.value = Math.max(1, Math.ceil(res.total / pageSize.value));
    }
  } catch (err) {
    if (mine === seq) fail(err, t("redeem.admin.errors.load"));
  } finally {
    if (mine === seq) loading.value = false;
  }
}

/** Coalesces filter + page changes made in the same tick into one request. */
function scheduleLoad() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void load();
  });
}

watch([filterParams, pageSize], () => {
  page.value = 1;
  selected.value = new Set();
  scheduleLoad();
});
watch(page, scheduleLoad);

/* ---------------- Selection & bulk ---------------- */

const selected = ref(new Set<string>());
const bulkBusy = ref(false);

const allOnPageSelected = computed(
  () => items.value.length > 0 && items.value.every((i) => selected.value.has(i.code)),
);
const someOnPageSelected = computed(() => items.value.some((i) => selected.value.has(i.code)));

function toggleRow(code: string) {
  const next = new Set(selected.value);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  selected.value = next;
}

function toggleAll() {
  if (allOnPageSelected.value) selected.value = new Set();
  else selected.value = new Set(items.value.map((i) => i.code));
}

async function runBulk(action: UpdateRedeemCodesRequest["action"], extra: Partial<UpdateRedeemCodesRequest> = {}) {
  const codes = [...selected.value];
  if (codes.length === 0) return false;
  bulkBusy.value = true;
  try {
    const body: UpdateRedeemCodesRequest = { codes, action, ...extra };
    const { changed } = await apiJson<{ changed: number }>("/api/v1/admin/redeem-codes/batch", {
      method: "POST",
      body,
      fallbackError: t("redeem.admin.errors.batch"),
    });
    succeed(action === "delete" ? t("redeem.admin.bulk.deleted", { n: changed }) : t("redeem.admin.bulk.done", { n: changed }));
    selected.value = new Set();
    await load();
    return true;
  } catch (err) {
    fail(err, t("redeem.admin.errors.batch"));
    return false;
  } finally {
    bulkBusy.value = false;
  }
}

/* Expiry / notes dialogs */
const expiryOpen = ref(false);
const expiryPreset = ref<ExpiryPreset>("never");
const expiryCustom = ref("");
const expiryInvalid = ref(false);

function openExpiry() {
  expiryPreset.value = "never";
  expiryCustom.value = "";
  expiryInvalid.value = false;
  expiryOpen.value = true;
}

async function applyExpiry() {
  const iso = resolveExpiry(expiryPreset.value, expiryCustom.value);
  if (iso === undefined) {
    expiryInvalid.value = true;
    return;
  }
  if (await runBulk("set_expiry", { expiresAtIso: iso })) expiryOpen.value = false;
}

const notesOpen = ref(false);
const notesText = ref("");

function openNotes() {
  const first = items.value.find((i) => selected.value.has(i.code));
  notesText.value = first?.notes ?? "";
  notesOpen.value = true;
}

async function applyNotes() {
  if (await runBulk("set_notes", { notes: notesText.value.trim() })) notesOpen.value = false;
}

/* ---------------- Generate & export ---------------- */

const generateOpen = ref(false);
const resultOpen = ref(false);
const generated = ref<RedeemCodeItem[]>([]);

function onGenerated(list: RedeemCodeItem[]) {
  generated.value = list;
  resultOpen.value = true;
  succeed(t("redeem.admin.notice.generated", { n: list.length }));
  void load();
}

function filterBatch(batchId: string) {
  batchFilter.value = batchFilter.value === batchId ? "" : batchId;
}

async function exportCsv() {
  exporting.value = true;
  try {
    await downloadFile(`/api/v1/admin/redeem-codes/export${toQuery(filterParams.value)}`, "redeem-codes.csv");
  } catch (err) {
    fail(err, t("redeem.admin.errors.export"));
  } finally {
    exporting.value = false;
  }
}

/* ---------------- Display helpers ---------------- */

const statusTone: Record<RedeemCodeStatus, Tone> = {
  unused: "success",
  used: "info",
  disabled: "neutral",
  expired: "warning",
};

const kindTone: Record<RedeemCodeKind, Tone> = {
  balance: "accent",
  subscription: "violet",
  invitation: "info",
};

function valueText(item: RedeemCodeItem): string {
  if (item.kind === "balance") return formatUsd(item.amountNanoUsd);
  if (item.kind === "subscription") {
    return t("redeem.value.subscription", {
      days: item.validityDays ?? 0,
      group: item.groupName ?? t("redeem.value.unknownGroup"),
    });
  }
  return t("redeem.value.invitation");
}

/* ---------------- Claims drawer/modal ---------------- */

const claimsOpen = ref(false);
const claimsCode = ref("");
const claimsLoading = ref(false);
const claimsItems = ref<RedeemCodeClaimItem[]>([]);

async function openClaims(item: RedeemCodeItem) {
  claimsCode.value = item.code;
  claimsItems.value = [];
  claimsOpen.value = true;
  claimsLoading.value = true;
  try {
    claimsItems.value = (
      await apiJson<{ items: RedeemCodeClaimItem[] }>(
        `/api/v1/admin/redeem-codes/${encodeURIComponent(item.code)}/claims`,
        { fallbackError: t("redeem.admin.claims.loadFailed") },
      )
    ).items;
  } catch (err) {
    fail(err, t("redeem.admin.claims.loadFailed"));
  } finally {
    claimsLoading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.redeem')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <button type="button" class="btn btn-secondary" :disabled="exporting || total === 0" @click="exportCsv">
          <UiIcon :name="exporting ? 'loader' : 'download'" :size="15" :spin="exporting" />
          {{ exporting ? t("redeem.admin.actions.exporting") : t("redeem.admin.actions.export") }}
        </button>
        <button type="button" class="btn btn-primary" @click="generateOpen = true">
          <UiIcon name="plus" :size="15" />
          {{ t("redeem.admin.actions.generate") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-6">
      <StatCard :label="t('redeem.admin.stats.total')" :value="stats ? formatNumber(stats.total) : '—'" icon="ticket" tone="accent" />
      <StatCard
        :label="t('redeem.admin.stats.unused')"
        :value="stats ? formatNumber(stats.unused) : '—'"
        :hint="t('redeem.admin.stats.unusedHint')"
        icon="gift"
        tone="success"
      />
      <StatCard :label="t('redeem.admin.stats.used')" :value="stats ? formatNumber(stats.used) : '—'" icon="check-circle" tone="info" />
      <StatCard :label="t('redeem.admin.stats.disabled')" :value="stats ? formatNumber(stats.disabled) : '—'" icon="x-circle" />
      <StatCard :label="t('redeem.admin.stats.expired')" :value="stats ? formatNumber(stats.expired) : '—'" icon="clock" tone="warning" />
      <StatCard
        :label="t('redeem.admin.stats.redeemed')"
        :value="stats ? formatUsd(stats.redeemedNanoUsd) : '—'"
        icon="wallet"
        tone="violet"
      />
    </div>

    <UiCard icon="ticket" :title="t('redeem.admin.list.title')" flush>
      <template #actions>
        <div class="scrollbar-hide max-w-full overflow-x-auto">
          <SegmentedControl v-model="statusFilter" :options="statusOptions" />
        </div>
      </template>

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
            :placeholder="t('redeem.admin.list.searchPlaceholder')"
          />
        </label>
        <select v-model="kindFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('redeem.admin.table.kind')">
          <option value="all">{{ t("redeem.admin.list.allKinds") }}</option>
          <option value="balance">{{ t("redeem.kinds.balance") }}</option>
          <option value="subscription">{{ t("redeem.kinds.subscription") }}</option>
          <option value="invitation">{{ t("redeem.kinds.invitation") }}</option>
        </select>
        <Transition
          enter-active-class="transition duration-200 ease-out"
          enter-from-class="scale-95 opacity-0"
          leave-active-class="transition duration-150 ease-in"
          leave-to-class="scale-95 opacity-0"
        >
          <span
            v-if="batchFilter"
            class="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent/10 pl-3 pr-1 text-xs text-accent ring-1 ring-inset ring-accent/25"
          >
            <UiIcon name="layers" :size="12" />
            {{ t("redeem.admin.list.batch") }}
            <span class="font-mono font-semibold">{{ batchFilter }}</span>
            <button
              type="button"
              class="inline-flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-accent/15"
              :title="t('redeem.admin.list.clearBatch')"
              :aria-label="t('redeem.admin.list.clearBatch')"
              @click="batchFilter = ''"
            >
              <UiIcon name="x" :size="12" />
            </button>
          </span>
        </Transition>
      </div>

      <!-- Bulk action bar -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="-translate-y-1 opacity-0"
        leave-active-class="transition duration-150 ease-in"
        leave-to-class="-translate-y-1 opacity-0"
      >
        <div
          v-if="selected.size > 0"
          class="flex flex-wrap items-center gap-2 border-b border-accent/20 bg-accent/[0.06] px-5 py-2.5"
        >
          <span class="mr-1 inline-flex items-center gap-1.5 text-xs font-semibold text-accent">
            <UiIcon name="check-circle" :size="14" />
            {{ t("redeem.admin.bulk.selected", { n: selected.size }) }}
          </span>
          <button type="button" class="btn btn-secondary btn-xs" :disabled="bulkBusy" @click="runBulk('disable')">
            <UiIcon name="x-circle" :size="13" />
            {{ t("redeem.admin.bulk.disable") }}
          </button>
          <button type="button" class="btn btn-secondary btn-xs" :disabled="bulkBusy" @click="runBulk('enable')">
            <UiIcon name="rotate-ccw" :size="13" />
            {{ t("redeem.admin.bulk.enable") }}
          </button>
          <button type="button" class="btn btn-secondary btn-xs" :disabled="bulkBusy" @click="openExpiry">
            <UiIcon name="calendar" :size="13" />
            {{ t("redeem.admin.bulk.setExpiry") }}
          </button>
          <button type="button" class="btn btn-secondary btn-xs" :disabled="bulkBusy" @click="openNotes">
            <UiIcon name="pencil" :size="13" />
            {{ t("redeem.admin.bulk.setNotes") }}
          </button>
          <ConfirmButton
            :disabled="bulkBusy"
            :label="t('redeem.admin.bulk.delete')"
            :confirm-label="t('redeem.admin.bulk.confirmDelete', { n: selected.size })"
            @confirm="runBulk('delete')"
          />
          <button type="button" class="btn btn-ghost btn-xs ml-auto" :disabled="bulkBusy" @click="selected = new Set()">
            {{ t("redeem.admin.bulk.clear") }}
          </button>
        </div>
      </Transition>

      <ListSkeleton v-if="!loaded && loading" />
      <EmptyState v-else-if="items.length === 0 && !hasFilters && !loading" icon="ticket" :title="t('redeem.admin.list.empty')">
        <p class="w-full max-w-xs text-xs text-fg-subtle">{{ t("redeem.admin.list.emptyHint") }}</p>
        <button type="button" class="btn btn-primary btn-sm" @click="generateOpen = true">
          <UiIcon name="plus" :size="14" />
          {{ t("redeem.admin.actions.generate") }}
        </button>
      </EmptyState>
      <EmptyState v-else-if="items.length === 0 && !loading" icon="search" :title="t('redeem.admin.list.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("redeem.admin.list.clearFilters") }}
        </button>
      </EmptyState>
      <div v-else class="table-wrap transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
        <table class="data-table">
          <thead>
            <tr>
              <th class="w-10">
                <input
                  type="checkbox"
                  class="checkbox align-middle"
                  :checked="allOnPageSelected"
                  :indeterminate="someOnPageSelected && !allOnPageSelected"
                  :aria-label="t('redeem.admin.table.selectAll')"
                  @change="toggleAll"
                />
              </th>
              <th>{{ t("redeem.admin.table.code") }}</th>
              <th>{{ t("redeem.admin.table.kind") }}</th>
              <th>{{ t("redeem.admin.table.value") }}</th>
              <th>{{ t("redeem.admin.table.usage") }}</th>
              <th>{{ t("redeem.admin.table.status") }}</th>
              <th>{{ t("redeem.admin.table.batch") }}</th>
              <th>{{ t("redeem.admin.table.notes") }}</th>
              <th>{{ t("redeem.admin.table.redeemedBy") }}</th>
              <th>{{ t("redeem.admin.table.expires") }}</th>
              <th>{{ t("redeem.admin.table.created") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(c, i) in items"
              :key="c.code"
              :class="[STAGGER_CLASS, selected.has(c.code) ? '!bg-accent/[0.05]' : '']"
              :style="stagger(i)"
            >
              <td class="w-10">
                <input
                  type="checkbox"
                  class="checkbox align-middle"
                  :checked="selected.has(c.code)"
                  :aria-label="t('redeem.admin.table.selectRow', { code: c.code })"
                  @change="toggleRow(c.code)"
                />
              </td>
              <td class="whitespace-nowrap">
                <span class="inline-flex items-center gap-1">
                  <span
                    class="font-mono text-xs font-medium tracking-wide"
                    :class="c.status === 'unused' ? 'text-fg' : 'text-fg-muted'"
                  >
                    {{ c.code }}
                  </span>
                  <CopyButton :text="c.code" />
                </span>
              </td>
              <td><UiBadge :tone="kindTone[c.kind]">{{ t(`redeem.kinds.${c.kind}`) }}</UiBadge></td>
              <td class="whitespace-nowrap">
                <span
                  class="text-xs"
                  :class="c.kind === 'balance' ? 'font-mono font-semibold tabular-nums text-fg' : 'text-fg-muted'"
                >
                  {{ valueText(c) }}
                </span>
              </td>
              <td class="whitespace-nowrap">
                <div class="flex flex-col gap-0.5">
                  <button
                    v-if="c.usedCount > 0 || c.redeemedAtIso"
                    type="button"
                    class="inline-flex w-fit items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs text-accent transition-colors hover:bg-accent/10"
                    :title="t('redeem.admin.table.viewClaims')"
                    @click="openClaims(c)"
                  >
                    <UiIcon name="list" :size="12" />
                    {{ c.usedCount }} / {{ c.maxUses }}
                  </button>
                  <span v-else class="font-mono text-xs text-fg-subtle">{{ c.usedCount }} / {{ c.maxUses }}</span>
                  <span v-if="c.perUserLimit > 1 || c.batchPerUserLimit > 0" class="text-2xs text-fg-subtle">
                    {{ c.perUserLimit > 1 ? t("redeem.admin.table.perUserShort", { n: c.perUserLimit }) : "" }}
                    {{ c.perUserLimit > 1 && c.batchPerUserLimit > 0 ? " · " : "" }}
                    {{ c.batchPerUserLimit > 0 ? t("redeem.admin.table.batchLimitShort", { n: c.batchPerUserLimit }) : "" }}
                  </span>
                </div>
              </td>
              <td>
                <UiBadge :tone="statusTone[c.status]" dot>{{ t(`redeem.statuses.${c.status}`) }}</UiBadge>
              </td>
              <td>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-2xs transition-colors"
                  :class="
                    batchFilter === c.batchId
                      ? 'bg-accent/10 text-accent ring-1 ring-inset ring-accent/25'
                      : 'text-fg-subtle hover:bg-surface-2 hover:text-fg'
                  "
                  :title="batchFilter === c.batchId ? t('redeem.admin.list.clearBatch') : t('redeem.admin.list.filterByBatch')"
                  @click="filterBatch(c.batchId)"
                >
                  <UiIcon name="filter" :size="11" />
                  {{ c.batchId }}
                </button>
              </td>
              <td class="max-w-[12rem]">
                <p v-if="c.notes" class="truncate text-xs text-fg-muted" :title="c.notes">{{ c.notes }}</p>
                <span v-else class="text-xs text-fg-subtle">-</span>
              </td>
              <td class="max-w-[14rem]">
                <template v-if="c.redeemedByEmail || c.redeemedAtIso">
                  <p class="truncate text-xs text-fg" :title="c.redeemedByEmail ?? ''">{{ c.redeemedByEmail ?? c.redeemedBy }}</p>
                  <p class="mt-0.5 whitespace-nowrap text-2xs text-fg-subtle" :title="formatDateTime(c.redeemedAtIso)">
                    {{ formatRelative(c.redeemedAtIso) }}
                  </p>
                </template>
                <span v-else class="text-xs text-fg-subtle">-</span>
              </td>
              <td class="whitespace-nowrap text-xs">
                <span v-if="!c.expiresAtIso" class="text-fg-subtle">{{ t("redeem.expiry.never") }}</span>
                <span
                  v-else
                  :class="isPast(c.expiresAtIso) ? 'text-warning' : 'text-fg-muted'"
                  :title="formatRelative(c.expiresAtIso)"
                >
                  {{ formatDateTime(c.expiresAtIso) }}
                </span>
              </td>
              <td class="whitespace-nowrap text-xs text-fg-subtle" :title="formatDateTime(c.createdAtIso)">
                {{ formatRelative(c.createdAtIso) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <UiPagination
        v-if="total > 0"
        v-model:page="page"
        v-model:page-size="pageSize"
        :total="total"
        :disabled="loading"
      />
    </UiCard>

    <RedeemGenerateModal v-model:open="generateOpen" @generated="onGenerated" />
    <RedeemResultModal v-model:open="resultOpen" :items="generated" @view-batch="batchFilter = $event" />

    <UiModal v-model:open="expiryOpen" width="md" :title="t('redeem.admin.bulk.expiryTitle')" :persistent="bulkBusy">
      <template #icon>
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="calendar" :size="15" /></span>
      </template>
      <form id="redeem-expiry-form" class="space-y-3" @submit.prevent="applyExpiry">
        <ExpiryPresetField
          v-model:preset="expiryPreset"
          v-model:custom="expiryCustom"
          :label="t('redeem.admin.bulk.expiryLabel')"
          :invalid="expiryInvalid"
          @update:custom="expiryInvalid = false"
        />
        <p v-if="expiryInvalid" class="text-xs text-danger">{{ t("redeem.admin.generate.errors.expiry") }}</p>
        <p class="flex items-center gap-1.5 text-xs text-fg-subtle">
          <UiIcon name="info" :size="13" />
          {{ t("redeem.admin.bulk.affects", { n: selected.size }) }}
        </p>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="bulkBusy" @click="expiryOpen = false">
          {{ t("common.cancel") }}
        </button>
        <button type="submit" form="redeem-expiry-form" class="btn btn-primary" :disabled="bulkBusy">
          <UiIcon v-if="bulkBusy" name="loader" :size="15" spin />
          {{ t("redeem.admin.bulk.apply") }}
        </button>
      </template>
    </UiModal>

    <UiModal v-model:open="notesOpen" width="md" :title="t('redeem.admin.bulk.notesTitle')" :persistent="bulkBusy">
      <template #icon>
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="pencil" :size="15" /></span>
      </template>
      <form id="redeem-notes-form" class="space-y-3" @submit.prevent="applyNotes">
        <FormField :label="t('redeem.admin.bulk.notesLabel')">
          <input
            v-model="notesText"
            type="text"
            maxlength="200"
            class="input"
            :placeholder="t('redeem.admin.bulk.notesPlaceholder')"
          />
        </FormField>
        <p class="flex items-center gap-1.5 text-xs text-fg-subtle">
          <UiIcon name="info" :size="13" />
          {{ t("redeem.admin.bulk.affects", { n: selected.size }) }}
        </p>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="bulkBusy" @click="notesOpen = false">
          {{ t("common.cancel") }}
        </button>
        <button type="submit" form="redeem-notes-form" class="btn btn-primary" :disabled="bulkBusy">
          <UiIcon v-if="bulkBusy" name="loader" :size="15" spin />
          {{ t("redeem.admin.bulk.apply") }}
        </button>
      </template>
    </UiModal>

    <UiModal v-model:open="claimsOpen" width="lg" :title="t('redeem.admin.claims.title', { code: claimsCode })">
      <template #icon>
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="list" :size="15" /></span>
      </template>
      <ListSkeleton v-if="claimsLoading" />
      <EmptyState v-else-if="claimsItems.length === 0" compact icon="ticket" :title="t('redeem.admin.claims.empty')" />
      <div v-else class="table-wrap max-h-96 overflow-y-auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("redeem.admin.claims.user") }}</th>
              <th>{{ t("redeem.admin.claims.value") }}</th>
              <th class="text-right">{{ t("redeem.admin.claims.time") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="cl in claimsItems" :key="cl.id">
              <td class="font-mono text-xs text-fg">{{ cl.userEmail || cl.userId }}</td>
              <td class="text-xs text-fg-muted">
                {{ cl.kind === "balance" ? formatUsd(cl.amountNanoUsd) : cl.kind }}
              </td>
              <td class="whitespace-nowrap text-right text-xs text-fg-subtle">
                {{ formatDateTime(cl.redeemedAtIso) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="claimsOpen = false">{{ t("common.close") }}</button>
      </template>
    </UiModal>
  </div>
</template>
