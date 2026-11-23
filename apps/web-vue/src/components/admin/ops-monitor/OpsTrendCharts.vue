<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { OpsOverview } from "@slipgate/contracts";
import { formatCompact, formatDurationMs, formatNumber } from "../../../lib/format";
import TrendChart, { type TrendSeries } from "../../charts/TrendChart.vue";
import EmptyState from "../../ui/EmptyState.vue";
import UiCard from "../../ui/UiCard.vue";

/** Requests vs errors and latency (TTFT p50, duration p95) per bucket. */
const props = defineProps<{ overview: OpsOverview }>();

const { t, locale } = useI18n();

const points = computed(() => props.overview.series);
const empty = computed(() => points.value.every((p) => p.requests === 0));

const labels = computed(() => {
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  const short = points.value.map((p) => new Date(p.startIso).toLocaleTimeString(locale.value, opts));
  const bucketMs = props.overview.bucketMinutes * 60_000;
  const full = points.value.map((p) => {
    const start = new Date(p.startIso);
    const end = new Date(start.getTime() + bucketMs);
    const day = start.toLocaleDateString(locale.value, { month: "numeric", day: "numeric" });
    return `${day} ${start.toLocaleTimeString(locale.value, opts)} – ${end.toLocaleTimeString(locale.value, opts)}`;
  });
  return { short, full };
});

const traffic = computed<TrendSeries[]>(() => [
  { key: "req", label: t("security.ops.charts.requests"), color: "rgb(var(--viz-1))", values: points.value.map((p) => p.requests) },
  { key: "err", label: t("security.ops.charts.errors"), color: "rgb(var(--danger))", values: points.value.map((p) => p.errors) },
]);

const latency = computed<TrendSeries[]>(() => [
  { key: "ttft", label: t("security.ops.charts.ttftP50"), color: "rgb(var(--viz-1))", values: points.value.map((p) => p.ttftP50) },
  { key: "dur", label: t("security.ops.charts.durationP95"), color: "rgb(var(--viz-2))", values: points.value.map((p) => p.durationP95) },
]);

const countFmt = (v: number) => formatNumber(Math.round(v));
const countAxis = (v: number) => formatCompact(v);
const msFmt = (v: number) => formatDurationMs(v);
</script>

<template>
  <div class="grid gap-6 xl:grid-cols-2">
    <UiCard icon="activity" :title="t('security.ops.charts.traffic')">
      <template #actions>
        <span class="text-2xs text-fg-subtle">{{ t("security.ops.charts.bucket", { n: overview.bucketMinutes }) }}</span>
      </template>
      <EmptyState v-if="empty" compact icon="activity" :title="t('security.ops.charts.empty')" />
      <TrendChart
        v-else
        :labels="labels.short"
        :titles="labels.full"
        :series="traffic"
        :format="countFmt"
        :axis-format="countAxis"
        :height="220"
        :chart-label="t('security.ops.charts.traffic')"
      />
    </UiCard>
    <UiCard icon="clock" :title="t('security.ops.charts.latency')">
      <EmptyState v-if="empty" compact icon="clock" :title="t('security.ops.charts.empty')" />
      <TrendChart
        v-else
        :labels="labels.short"
        :titles="labels.full"
        :series="latency"
        :format="msFmt"
        :height="220"
        :chart-label="t('security.ops.charts.latency')"
      />
    </UiCard>
  </div>
</template>
