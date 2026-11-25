<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AdminDashboardStats } from "@slipgate/contracts";
import DistributionDonut, { type DistributionRow } from "../../charts/DistributionDonut.vue";
import EmptyState from "../../ui/EmptyState.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiCard from "../../ui/UiCard.vue";
import { nanoToUsd } from "../../../lib/format";

/**
 * sub2api-style dashboard card toggling "model distribution" and "spending ranking" (top users,
 * each linking to their usage), by tokens or spend, as a donut beside its legend table.
 */
const props = defineProps<{
  stats: AdminDashboardStats | null;
}>();

const { t } = useI18n();

type View = "models" | "ranking";
type Metric = "tokens" | "cost";
const view = ref<View>("models");
const metric = ref<Metric>("tokens");

const viewOptions = computed(() => [
  { value: "models" as const, label: t("dashboard.distribution.models") },
  { value: "ranking" as const, label: t("dashboard.distribution.ranking") },
]);
const metricOptions = computed(() => [
  { value: "tokens" as const, label: t("dashboard.metric.tokens") },
  { value: "cost" as const, label: t("dashboard.metric.cost") },
]);
const metricLabel = computed(() => (metric.value === "tokens" ? t("dashboard.metric.tokens") : t("dashboard.metric.cost")));

const periodTotal = computed(() => {
  const p = props.stats?.period;
  if (!p) return null;
  return metric.value === "tokens" ? p.inputTokens + p.outputTokens : nanoToUsd(p.costNanoUsd);
});

const modelRows = computed<DistributionRow[]>(() => (props.stats?.models ?? []).map((m) => ({ ...m, key: m.model, label: m.model })));
const userRows = computed<DistributionRow[]>(() =>
  (props.stats?.topUsers ?? []).map((u) => ({
    ...u,
    key: u.userId,
    label: u.email,
    to: { path: "/admin/usage", query: { userId: u.userId } },
  })),
);
</script>

<template>
  <UiCard icon="sparkles" :title="view === 'models' ? t('dashboard.distribution.modelsTitle') : t('dashboard.distribution.rankingTitle')">
    <template #actions>
      <SegmentedControl v-model="metric" :options="metricOptions" />
      <SegmentedControl v-model="view" :options="viewOptions" />
    </template>

    <EmptyState v-if="!stats || !stats.models.length" compact icon="sparkles" :title="t('dashboard.breakdown.empty')" />
    <DistributionDonut
      v-else-if="view === 'models'"
      key="models"
      :rows="modelRows"
      :metric="metric"
      :total="periodTotal"
      :name-header="t('dashboard.distribution.model')"
      :donut-label="t('dashboard.distribution.donutLabel', { metric: metricLabel })"
      mono
    />
    <EmptyState v-else-if="!userRows.length" compact icon="users" :title="t('dashboard.breakdown.empty')" />
    <DistributionDonut
      v-else
      key="ranking"
      :rows="userRows"
      :metric="metric"
      :total="periodTotal"
      :name-header="t('dashboard.distribution.user')"
      :donut-label="t('dashboard.distribution.rankingDonutLabel', { metric: metricLabel })"
      ranked
    />
  </UiCard>
</template>
