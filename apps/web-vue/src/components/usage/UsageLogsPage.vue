<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { USAGE_EXPORT_MAX_ROWS } from "@slipgate/contracts";
import EmptyState from "../ui/EmptyState.vue";
import PageHeader from "../ui/PageHeader.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiPagination from "../ui/UiPagination.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { useNow } from "../../composables/useNow";
import { formatCompact } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import UsageErrorsTab from "./UsageErrorsTab.vue";
import UsageFilterBar from "./UsageFilterBar.vue";
import UsageStatsCharts from "./UsageStatsCharts.vue";
import UsageSummaryCards from "./UsageSummaryCards.vue";
import UsageTable from "./UsageTable.vue";
import UsageUserRanking from "./UsageUserRanking.vue";
import { useUsageLogs } from "./useUsageLogs";
import { useUsageStats } from "./useUsageStats";

/**
 * Whole usage-log page body shared by /admin/usage and /usage: header with CSV export,
 * filters, summary tiles and the paginated request table. The admin page adds the sub2api charts
 * (model / group distribution, token trend) plus user-ranking and (admins only) request-error tabs
 * beside the request list, all over the same filters.
 */
const props = defineProps<{
  mode: "admin" | "user";
  title: string;
  groups: { id: string; name: string }[];
  apiKeys?: { id: string; name: string; groupName: string }[];
  /** Admin: user to pre-filter by (from `?userId=`); follows route changes. */
  userId?: string;
}>();

const { t } = useI18n();
const now = useNow(30_000);

const base = props.mode === "admin" ? "/api/v1/admin/usage" : "/api/v1/user/usage";
const usage = useUsageLogs({
  base,
  initial: props.userId ? { userId: props.userId } : {},
  errorLoad: t("usageLogs.errors.load"),
  errorExport: t("usageLogs.errors.export"),
});
const { filters, page, pageSize, items, total, summary, loading, loaded, exporting, rangeInvalid, hasFilters } = usage;

const toast = useFeedbackToasts(usage.error);

const adminMode = props.mode === "admin";
const auth = useAuthStore();
const statsPanel = adminMode
  ? useUsageStats({
      base,
      criteriaKey: usage.criteriaKey,
      params: usage.params,
      rangeInvalid,
      errorLoad: t("usageLogs.errors.stats"),
    })
  : null;
if (statsPanel) useFeedbackToasts(statsPanel.error);

type Tab = "records" | "ranking" | "errors";
const tab = ref<Tab>("records");
/** The request-error center is admin-only; group managers get records and ranking. */
const showErrors = computed(() => adminMode && auth.isAdmin);
const tabOptions = computed(() => [
  { value: "records" as const, label: t("usageLogs.tabs.records") },
  { value: "ranking" as const, label: t("usageLogs.tabs.ranking") },
  ...(showErrors.value ? [{ value: "errors" as const, label: t("usageLogs.tabs.errors") }] : []),
]);
const tabMeta = computed(() => {
  if (tab.value === "ranking") return { icon: "crown" as const, title: t("usageLogs.tabs.ranking") };
  if (tab.value === "errors") return { icon: "alert" as const, title: t("usageLogs.tabs.errors") };
  return { icon: "list" as const, title: t("usageLogs.list.title") };
});
const errorsTab = ref<InstanceType<typeof UsageErrorsTab> | null>(null);

function selectUser(userId: string) {
  patch({ userId });
  tab.value = "records";
}

function refresh() {
  void usage.load();
  void statsPanel?.load();
  void errorsTab.value?.load();
}

watch(
  () => props.userId,
  (id) => {
    if (id !== undefined && id !== filters.value.userId) filters.value = { ...filters.value, userId: id };
  },
);

async function exportCsv() {
  if (await usage.exportCsv()) toast.success(t("usageLogs.export.done"));
}

function patch(p: Partial<typeof filters.value>) {
  filters.value = { ...filters.value, ...p };
}

refresh();
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="title">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading || rangeInvalid" @click="refresh">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="exporting || rangeInvalid || (loaded && total === 0)"
          :title="t('usageLogs.export.hint', { n: formatCompact(USAGE_EXPORT_MAX_ROWS) })"
          @click="exportCsv"
        >
          <UiIcon :name="exporting ? 'loader' : 'download'" :size="15" :spin="exporting" />
          {{ exporting ? t("usageLogs.export.busy") : t("usageLogs.export.button") }}
        </button>
      </template>
    </PageHeader>

    <UsageFilterBar
      v-model="filters"
      :mode="mode"
      :groups="groups"
      :api-keys="apiKeys"
      :range-invalid="rangeInvalid"
      :has-filters="hasFilters"
      @reset="usage.reset()"
    />

    <div class="transition-opacity duration-200" :class="loading && loaded ? 'opacity-70' : ''">
      <UsageSummaryCards :summary="summary" />
    </div>

    <UsageStatsCharts
      v-if="statsPanel"
      v-model:granularity="statsPanel.granularity.value"
      :stats="statsPanel.stats.value"
      :loading="statsPanel.loading.value"
      @select-model="(m) => patch({ model: m })"
      @select-group="(g) => patch({ groupId: g })"
    />

    <UiCard :icon="tabMeta.icon" :title="tabMeta.title" flush>
      <template #actions>
        <span v-if="loaded && tab === 'records'" class="font-mono text-xs tabular-nums text-fg-subtle">{{ formatCompact(total) }}</span>
        <SegmentedControl v-if="statsPanel" v-model="tab" :options="tabOptions" :aria-label="t('usageLogs.tabs.label')" />
      </template>

      <UsageUserRanking
        v-if="statsPanel && tab === 'ranking'"
        v-model:rank-by="statsPanel.rankBy.value"
        v-model:rank-limit="statsPanel.rankLimit.value"
        :stats="statsPanel.stats.value"
        :loading="statsPanel.loading.value"
        @select-user="selectUser"
      />
      <UsageErrorsTab
        v-else-if="showErrors && tab === 'errors'"
        ref="errorsTab"
        :criteria-key="usage.criteriaKey.value"
        :params="usage.params"
        :now="now"
        @error="(m) => toast.error(m)"
      />
      <template v-else>
        <div v-if="!loaded && loading" class="divide-y divide-line/60" aria-busy="true">
          <div v-for="i in 8" :key="i" class="flex animate-pulse items-center gap-4 px-5 py-3.5">
            <span class="w-24 space-y-1.5">
              <span class="block h-3 rounded bg-surface-2" />
              <span class="block h-2.5 w-2/3 rounded bg-surface-2" />
            </span>
            <span class="h-3 w-28 rounded bg-surface-2" />
            <span class="hidden h-3 w-20 rounded bg-surface-2 sm:block" />
            <span class="h-3 flex-1 rounded bg-surface-2" />
            <span class="hidden h-3 w-16 rounded bg-surface-2 md:block" />
            <span class="h-4 w-10 rounded-full bg-surface-2" />
          </div>
        </div>

        <EmptyState
          v-else-if="loaded && items.length === 0"
          :icon="hasFilters ? 'search' : 'activity'"
          :title="hasFilters ? t('usageLogs.list.emptyFiltered') : t('usageLogs.list.empty')"
        >
          <button v-if="hasFilters" type="button" class="btn btn-secondary btn-sm" @click="usage.reset()">
            <UiIcon name="x" :size="14" />
            {{ t("usageLogs.filters.reset") }}
          </button>
        </EmptyState>

        <div v-else class="transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
          <UsageTable
            :rows="items"
            :mode="mode"
            :now="now"
            @filter-user="(id) => patch({ userId: id })"
            @filter-group="(id) => patch({ groupId: id })"
            @filter-model="(m) => patch({ model: m })"
          />
        </div>

        <UiPagination
          v-if="loaded && total > 0"
          v-model:page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[20, 50, 100, 200]"
          :disabled="loading"
        />
      </template>
    </UiCard>
  </div>
</template>
