<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AuditLogItem, AuditRetentionStatus } from "@slipgate/contracts";
import AuditClearModal from "../../components/admin/ops/AuditClearModal.vue";
import AuditDetailDrawer from "../../components/admin/ops/AuditDetailDrawer.vue";
import AuditRetentionCard from "../../components/admin/ops/AuditRetentionCard.vue";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import { auditActionKey } from "../../components/admin/ops/auditActions";
import { httpStatusTone, methodTone, STAGGER_CLASS, stagger, useDebounced } from "../../components/admin/ops/opsUtil";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import { apiJson, errorText, toQuery } from "../../lib/api";
import { formatDateTime, formatDurationMs, formatNumber, formatRelative } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const toast = useToastStore();

const items = ref<AuditLogItem[]>([]);
const total = ref(0);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);

/* ---------------- Filters ---------------- */

type Method = "POST" | "PUT" | "PATCH" | "DELETE";
type Outcome = "success" | "failure";
type TimePreset = "1h" | "24h" | "7d" | "30d" | "all";

const METHODS: Method[] = ["POST", "PUT", "PATCH", "DELETE"];
const PRESET_MS: Record<Exclude<TimePreset, "all">, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

const search = ref("");
const debouncedSearch = useDebounced(search);
const method = ref<"all" | Method>("all");
const outcome = ref<"all" | Outcome>("all");
const preset = ref<TimePreset>("all");
const page = ref(1);
const pageSize = ref(20);

const presetOptions = computed(() => [
  { value: "1h" as const, label: t("audit.filters.time.h1") },
  { value: "24h" as const, label: t("audit.filters.time.h24") },
  { value: "7d" as const, label: t("audit.filters.time.d7") },
  { value: "30d" as const, label: t("audit.filters.time.d30") },
  { value: "all" as const, label: t("audit.filters.time.all") },
]);

const hasFilters = computed(
  () => debouncedSearch.value.trim() !== "" || method.value !== "all" || outcome.value !== "all" || preset.value !== "all",
);

function resetFilters() {
  search.value = "";
  debouncedSearch.value = "";
  method.value = "all";
  outcome.value = "all";
  preset.value = "all";
}

/* ---------------- Loading ---------------- */

let seq = 0;
let scheduled = false;

async function load() {
  const mine = ++seq;
  loading.value = true;
  const sinceIso = preset.value === "all" ? undefined : new Date(Date.now() - PRESET_MS[preset.value]).toISOString();
  try {
    const res = await apiJson<{ items: AuditLogItem[]; total: number }>(
      `/api/v1/admin/audit-logs${toQuery({
        page: page.value,
        pageSize: pageSize.value,
        search: debouncedSearch.value.trim() || undefined,
        method: method.value === "all" ? undefined : method.value,
        outcome: outcome.value === "all" ? undefined : outcome.value,
        sinceIso,
      })}`,
      { fallbackError: t("audit.errors.load") },
    );
    if (mine !== seq) return;
    items.value = res.items;
    total.value = res.total;
    loaded.value = true;
    loadError.value = null;
  } catch (err) {
    if (mine !== seq) return;
    loadError.value = errorText(err, t("audit.errors.load"));
    toast.error(loadError.value);
  } finally {
    if (mine === seq) loading.value = false;
  }
}

function scheduleLoad() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void load();
  });
}

watch([debouncedSearch, method, outcome, preset, pageSize], () => {
  page.value = 1;
  scheduleLoad();
});
watch(page, scheduleLoad);

/* ---------------- Display ---------------- */

function actionName(item: AuditLogItem): string | null {
  const key = auditActionKey(item.method, item.route);
  return key ? t(`audit.actions.${key}`) : null;
}

/** Route pattern plus the concrete path when it differs (the raw route already headlines unnamed rows). */
function subline(item: AuditLogItem): string {
  const differs = item.path !== item.route;
  if (actionName(item)) return differs ? `${item.route} · ${item.path}` : item.route;
  return differs ? item.path : "";
}

function roleLabel(role: string): string {
  return role === "admin" || role === "user" ? t(`shell.roles.${role}`) : role;
}

/* ---------------- Detail & clear ---------------- */

const detailOpen = ref(false);
const detailItem = ref<AuditLogItem | null>(null);
const clearOpen = ref(false);
const retention = ref<AuditRetentionStatus | null>(null);
const retentionCard = ref<InstanceType<typeof AuditRetentionCard> | null>(null);

/** Header refresh: the list and the retention card (a sweep may have run meanwhile). */
function refreshAll() {
  void load();
  void retentionCard.value?.reload();
}

/** The retention sweep removed rows: the current page may now be past the end. */
function onSwept() {
  page.value = 1;
  void load();
}

function openDetail(item: AuditLogItem) {
  detailItem.value = item;
  detailOpen.value = true;
}

function onCleared(deleted: number) {
  toast.success(t("audit.clear.done", { n: formatNumber(deleted) }, deleted));
  page.value = 1;
  void load();
}

onMounted(() => void load());
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.auditLogs')">
      <template #meta>
        <span v-if="loaded" class="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs tabular-nums text-fg-muted">
          {{ t("audit.list.total", { n: formatNumber(total) }, total) }}
        </span>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="refreshAll">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <button type="button" class="btn btn-danger" @click="clearOpen = true">
          <UiIcon name="trash" :size="15" />
          {{ t("audit.clear.button") }}
        </button>
      </template>
    </PageHeader>

    <AuditRetentionCard ref="retentionCard" @update:status="retention = $event" @swept="onSwept" />

    <UiCard icon="scroll" :title="t('audit.list.title')" flush>
      <template #actions>
        <div class="scrollbar-hide max-w-full overflow-x-auto">
          <SegmentedControl v-model="preset" :options="presetOptions" />
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
          <input v-model="search" type="search" class="input input-sm pl-8" :placeholder="t('audit.list.searchPlaceholder')" />
        </label>
        <select v-model="method" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('audit.detail.method')">
          <option value="all">{{ t("audit.filters.allMethods") }}</option>
          <option v-for="m in METHODS" :key="m" :value="m">{{ m }}</option>
        </select>
        <select v-model="outcome" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('audit.table.status')">
          <option value="all">{{ t("audit.filters.allOutcomes") }}</option>
          <option value="success">{{ t("audit.filters.success") }}</option>
          <option value="failure">{{ t("audit.filters.failure") }}</option>
        </select>
      </div>

      <ListSkeleton v-if="!loaded && loading" :rows="8" dense />
      <EmptyState v-else-if="!loaded && loadError" icon="alert" :title="t('audit.errors.load')">
        <p class="w-full max-w-sm text-xs text-fg-subtle">{{ loadError }}</p>
        <button type="button" class="btn btn-secondary btn-sm" @click="load">
          <UiIcon name="refresh" :size="14" />
          {{ t("common.refresh") }}
        </button>
      </EmptyState>
      <EmptyState v-else-if="items.length === 0 && !hasFilters && !loading" icon="scroll" :title="t('audit.list.empty')">
        <p class="w-full max-w-sm text-xs text-fg-subtle">{{ t("audit.list.emptyHint") }}</p>
      </EmptyState>
      <EmptyState v-else-if="items.length === 0 && !loading" icon="search" :title="t('audit.list.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("audit.list.clearFilters") }}
        </button>
      </EmptyState>
      <div v-else class="table-wrap transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("audit.table.time") }}</th>
              <th>{{ t("audit.table.actor") }}</th>
              <th>{{ t("audit.table.action") }}</th>
              <th>{{ t("audit.table.target") }}</th>
              <th>{{ t("audit.table.status") }}</th>
              <th class="text-right">{{ t("audit.table.duration") }}</th>
              <th>{{ t("audit.table.ip") }}</th>
              <th class="w-10"><span class="sr-only">{{ t("audit.table.details") }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(a, i) in items"
              :key="a.id"
              class="cursor-pointer"
              :class="STAGGER_CLASS"
              :style="stagger(i, 18)"
              @click="openDetail(a)"
            >
              <td class="whitespace-nowrap">
                <p class="text-xs text-fg">{{ formatDateTime(a.createdAtIso) }}</p>
                <p class="mt-0.5 text-2xs text-fg-subtle">{{ formatRelative(a.createdAtIso) }}</p>
              </td>
              <td class="max-w-[14rem]">
                <p class="truncate text-xs text-fg" :title="a.actorEmail">{{ a.actorEmail || a.actorId }}</p>
                <p class="mt-0.5 text-2xs text-fg-subtle">{{ roleLabel(a.actorRole) }}</p>
              </td>
              <td class="min-w-[14rem] max-w-[22rem]">
                <div class="flex items-center gap-1.5">
                  <UiBadge :tone="methodTone(a.method)" mono class="shrink-0">{{ a.method }}</UiBadge>
                  <span class="truncate text-xs font-medium text-fg" :title="actionName(a) ?? a.route">
                    {{ actionName(a) ?? a.route }}
                  </span>
                </div>
                <p v-if="subline(a)" class="mt-1 truncate font-mono text-2xs text-fg-subtle" :title="a.path">
                  {{ subline(a) }}
                </p>
              </td>
              <td class="max-w-[10rem]" @click.stop>
                <span v-if="a.targetId" class="inline-flex max-w-full items-center gap-0.5">
                  <span class="truncate font-mono text-2xs text-fg-muted" :title="a.targetId">{{ a.targetId }}</span>
                  <CopyButton :text="a.targetId" />
                </span>
                <span v-else class="text-xs text-fg-subtle">-</span>
              </td>
              <td>
                <UiBadge :tone="httpStatusTone(a.statusCode)" dot mono>{{ a.statusCode }}</UiBadge>
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">
                {{ formatDurationMs(a.durationMs) }}
              </td>
              <td class="whitespace-nowrap font-mono text-2xs text-fg-muted">{{ a.ip || "-" }}</td>
              <td class="w-10 text-right">
                <button
                  type="button"
                  class="btn btn-ghost btn-icon btn-xs"
                  :title="t('audit.table.details')"
                  :aria-label="t('audit.table.details')"
                  @click.stop="openDetail(a)"
                >
                  <UiIcon name="chevron-right" :size="14" />
                </button>
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

    <AuditDetailDrawer v-model:open="detailOpen" :item="detailItem" />
    <AuditClearModal v-model:open="clearOpen" :retention-days="retention?.retentionDays ?? null" @cleared="onCleared" />
  </div>
</template>
