<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { USAGE_STATS_HOURLY_MAX_MS, type UsageStatsResponse } from "@slipgate/contracts";
import DistributionDonut, { type DistributionRow } from "../charts/DistributionDonut.vue";
import TrendChart, { type TrendSeries } from "../charts/TrendChart.vue";
import EmptyState from "../ui/EmptyState.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";
import { formatCompact, formatNumber, nanoToUsd } from "../../lib/format";

/**
 * sub2api usage-page charts over the list's filters: model and group distribution (donut + legend
 * table, by tokens or spend; picking a row narrows the filters to it) and the token usage trend
 * (input / output / cache read) by hour or day, with a table view.
 */
const props = defineProps<{
  stats: UsageStatsResponse | null;
  loading: boolean;
}>();
const granularity = defineModel<"hour" | "day" | undefined>("granularity");
const emit = defineEmits<{
  (e: "select-model", model: string): void;
  (e: "select-group", groupId: string): void;
}>();

const { t, locale } = useI18n();

type Metric = "tokens" | "cost";
const modelMetric = ref<Metric>("tokens");
const groupMetric = ref<Metric>("tokens");
const trendAsTable = ref(false);

const metricOptions = computed(() => [
  { value: "tokens" as const, label: t("dashboard.metric.tokens") },
  { value: "cost" as const, label: t("dashboard.metric.cost") },
]);
const metricLabel = (m: Metric) => (m === "tokens" ? t("dashboard.metric.tokens") : t("dashboard.metric.cost"));
const totalOf = (m: Metric) => {
  const s = props.stats?.totals;
  if (!s) return null;
  return m === "tokens" ? s.inputTokens + s.outputTokens : nanoToUsd(s.costNanoUsd);
};
const tokensOf = (r: { inputTokens: number; outputTokens: number }) => r.inputTokens + r.outputTokens;

const empty = computed(() => props.stats !== null && props.stats.totals.requests === 0);
const modelRows = computed<DistributionRow[]>(() =>
  (props.stats?.models ?? []).map((m) => ({ key: m.model, label: m.model, requests: m.requests, tokens: tokensOf(m), costNanoUsd: m.costNanoUsd })),
);
const groupRows = computed<DistributionRow[]>(() =>
  (props.stats?.groups ?? []).map((g) => ({
    key: g.groupId,
    label: g.name || g.groupId,
    requests: g.requests,
    tokens: tokensOf(g),
    costNanoUsd: g.costNanoUsd,
  })),
);

/* ---------------- Token trend ---------------- */

const spanMs = computed(() => (props.stats ? Date.parse(props.stats.untilIso) - Date.parse(props.stats.sinceIso) : 0));
const granularityOptions = computed(() => [
  {
    value: "hour" as const,
    label: t("usageLogs.charts.hourly"),
    disabled: spanMs.value > USAGE_STATS_HOURLY_MAX_MS,
  },
  { value: "day" as const, label: t("usageLogs.charts.daily") },
]);
/** What the server charted (a too-wide window turns an hourly ask into days). */
const shownGranularity = computed(() => props.stats?.granularity ?? granularity.value ?? "day");

const labels = computed(() => {
  const s = props.stats;
  if (!s) return { short: [] as string[], full: [] as string[] };
  const hourly = s.granularity === "hour";
  const multiDay = hourly && s.series.length > 24;
  const short = s.series.map((p) => {
    const d = new Date(p.startIso);
    if (multiDay) return d.toLocaleString(locale.value, { month: "numeric", day: "numeric", hour: "2-digit" });
    return hourly
      ? d.toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(locale.value, { month: "numeric", day: "numeric" });
  });
  const full = s.series.map((p) => {
    const d = new Date(p.startIso);
    return hourly
      ? d.toLocaleString(locale.value, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  });
  return { short, full };
});

const trendSeries = computed<TrendSeries[]>(() => {
  const points = props.stats?.series ?? [];
  return [
    { key: "in", label: t("dashboard.metric.input"), color: "rgb(var(--viz-1))", values: points.map((p) => p.inputTokens) },
    { key: "out", label: t("dashboard.metric.output"), color: "rgb(var(--viz-2))", values: points.map((p) => p.outputTokens) },
    { key: "cache", label: t("dashboard.metric.cacheRead"), color: "rgb(var(--viz-3))", values: points.map((p) => p.cacheReadTokens ?? 0) },
  ];
});
const tokenTotal = computed(() => (props.stats ? tokensOf(props.stats.totals) : 0));
</script>

<template>
  <div class="space-y-6 transition-opacity duration-200" :class="loading && stats ? 'opacity-70' : ''">
    <p v-if="stats?.clamped" class="flex items-center gap-2 text-xs text-warning">
      <UiIcon name="alert" :size="14" />
      {{ t("usageLogs.charts.clamped") }}
    </p>

    <div class="grid gap-6 xl:grid-cols-2">
      <UiCard icon="sparkles" :title="t('usageLogs.charts.modelTitle')">
        <template #actions>
          <SegmentedControl v-model="modelMetric" :options="metricOptions" />
        </template>
        <div v-if="!stats" class="h-[168px] animate-pulse rounded-lg bg-surface-2/60" aria-busy="true" />
        <EmptyState v-else-if="empty" compact icon="sparkles" :title="t('usageLogs.charts.empty')" />
        <DistributionDonut
          v-else
          :rows="modelRows"
          :metric="modelMetric"
          :total="totalOf(modelMetric)"
          :name-header="t('dashboard.distribution.model')"
          :donut-label="t('dashboard.distribution.donutLabel', { metric: metricLabel(modelMetric) })"
          :select-hint="t('usageLogs.charts.filterModel')"
          mono
          selectable
          @select="(m) => emit('select-model', m)"
        />
      </UiCard>

      <UiCard icon="layers" :title="t('usageLogs.charts.groupTitle')">
        <template #actions>
          <SegmentedControl v-model="groupMetric" :options="metricOptions" />
        </template>
        <div v-if="!stats" class="h-[168px] animate-pulse rounded-lg bg-surface-2/60" aria-busy="true" />
        <EmptyState v-else-if="empty" compact icon="layers" :title="t('usageLogs.charts.empty')" />
        <DistributionDonut
          v-else
          :rows="groupRows"
          :metric="groupMetric"
          :total="totalOf(groupMetric)"
          :name-header="t('usageLogs.charts.group')"
          :donut-label="t('usageLogs.charts.groupDonutLabel', { metric: metricLabel(groupMetric) })"
          :select-hint="t('usageLogs.charts.filterGroup')"
          selectable
          @select="(g) => emit('select-group', g)"
        />
      </UiCard>
    </div>

    <UiCard icon="braces" :title="t('usageLogs.charts.trendTitle')">
      <template #actions>
        <span v-if="stats" class="hidden text-2xs text-fg-subtle sm:inline">{{ t("usageLogs.charts.total", { n: formatCompact(tokenTotal) }) }}</span>
        <SegmentedControl
          :model-value="shownGranularity"
          :options="granularityOptions"
          :aria-label="t('usageLogs.charts.granularity')"
          @update:model-value="(v) => (granularity = v)"
        />
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm"
          :aria-pressed="trendAsTable"
          :title="trendAsTable ? t('dashboard.trend.showChart') : t('dashboard.trend.showTable')"
          :aria-label="trendAsTable ? t('dashboard.trend.showChart') : t('dashboard.trend.showTable')"
          @click="trendAsTable = !trendAsTable"
        >
          <UiIcon :name="trendAsTable ? 'activity' : 'list'" :size="15" />
        </button>
      </template>
      <div v-if="!stats" class="h-56 animate-pulse rounded-lg bg-surface-2/60" aria-busy="true" />
      <EmptyState v-else-if="empty" compact icon="braces" :title="t('usageLogs.charts.empty')" />
      <div v-else-if="trendAsTable" class="table-wrap max-h-72 overflow-y-auto">
        <table class="data-table">
          <thead class="sticky top-0 z-10">
            <tr>
              <th>{{ t("dashboard.trend.time") }}</th>
              <th v-for="sr in trendSeries" :key="sr.key" class="text-right">{{ sr.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(label, i) in labels.full" :key="label">
              <td class="whitespace-nowrap text-xs text-fg-muted">{{ label }}</td>
              <td v-for="sr in trendSeries" :key="sr.key" class="text-right font-mono text-xs tabular-nums">{{ formatNumber(sr.values[i] ?? 0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <TrendChart
        v-else
        :labels="labels.short"
        :titles="labels.full"
        :series="trendSeries"
        :format="formatNumber"
        :axis-format="formatCompact"
        :chart-label="t('usageLogs.charts.trendTitle')"
      />
    </UiCard>
  </div>
</template>
