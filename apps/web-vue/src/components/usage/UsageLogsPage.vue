<script setup lang="ts">
import { watch } from "vue";
import { useI18n } from "vue-i18n";
import { USAGE_EXPORT_MAX_ROWS } from "@slipgate/contracts";
import EmptyState from "../ui/EmptyState.vue";
import PageHeader from "../ui/PageHeader.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiPagination from "../ui/UiPagination.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { useNow } from "../../composables/useNow";
import { formatCompact } from "../../lib/format";
import UsageFilterBar from "./UsageFilterBar.vue";
import UsageSummaryCards from "./UsageSummaryCards.vue";
import UsageTable from "./UsageTable.vue";
import { useUsageLogs } from "./useUsageLogs";

/**
 * Whole usage-log page body shared by /admin/usage and /usage: header with CSV export,
 * filters, summary tiles and the paginated request table.
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

void usage.load();
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="title">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading || rangeInvalid" @click="usage.load">
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

    <UiCard icon="list" :title="t('usageLogs.list.title')" flush>
      <template #actions>
        <span v-if="loaded" class="font-mono text-xs tabular-nums text-fg-subtle">{{ formatCompact(total) }}</span>
      </template>

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
    </UiCard>
  </div>
</template>
