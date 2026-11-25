<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import DonutChart, { type DonutItem } from "./DonutChart.vue";
import { formatCompact, formatNumber, formatTokens, formatUsd, nanoToUsd } from "../../lib/format";

/**
 * sub2api-style distribution: a donut of the top 5 + "Other" beside a compact table that is its
 * legend (color dot, name, requests, the charted metric, the other metric, share). Hovering a row
 * highlights its slice and vice versa. The requests and other-metric columns only show where the
 * block is wide (sm..xl when its card spans the row, 2xl when it is half width); the row tooltip
 * always carries every number. A row may link somewhere (`to`) or be picked (`selectable`).
 */
export interface DistributionRow {
  key: string;
  label: string;
  requests: number;
  tokens: number;
  costNanoUsd: string;
  to?: RouteLocationRaw;
  /** Extra tooltip line (e.g. the codecs an endpoint was recognised from). */
  detail?: string;
}

const props = withDefaults(
  defineProps<{
    rows: DistributionRow[];
    metric: "tokens" | "cost";
    /** Whole-period value of the metric; "Other" is this minus the top 5. Defaults to the rows' sum. */
    total?: number | null;
    /** Header of the name column. */
    nameHeader: string;
    /** Accessible name of the donut. */
    donutLabel: string;
    /** Leading rank column. */
    ranked?: boolean;
    /** Monospace names (model ids). */
    mono?: boolean;
    /** Names are buttons emitting `select`. */
    selectable?: boolean;
    /** Tooltip of a selectable name. */
    selectHint?: string;
    size?: number;
  }>(),
  { total: null, ranked: false, mono: false, selectable: false, selectHint: "", size: 168 },
);
const emit = defineEmits<{ (e: "select", key: string): void }>();

const { t } = useI18n();
/** Slice / row highlighted together. */
const active = ref<string | null>(null);

/** The categorical slots in fixed order; "Other" is neutral gray. */
const SLOT_COLORS = ["rgb(var(--viz-1))", "rgb(var(--viz-2))", "rgb(var(--viz-3))", "rgb(var(--viz-4))", "rgb(var(--viz-5))"];
const OTHER_COLOR = "rgb(var(--fg-subtle) / 0.45)";
const OTHER_KEY = "__other";
const TOP = 5;

type Sums = { requests: number; tokens: number; costNanoUsd: string };
const valueOf = (row: Sums) => (props.metric === "tokens" ? row.tokens : nanoToUsd(row.costNanoUsd));
const fmt = (v: number) => (props.metric === "tokens" ? formatTokens(v) : formatUsd(String(Math.round(v * 1e9))));
const pct = (share: number) => `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;
/** The metric not being charted, as text. */
const otherOf = (row: Sums) => (props.metric === "tokens" ? formatUsd(row.costNanoUsd) : formatTokens(row.tokens));
const tipOf = (row: DistributionRow) =>
  `${row.label}\n${t("dashboard.distribution.userMeta", {
    requests: formatNumber(row.requests),
    other: `${formatTokens(row.tokens)} Token · ${formatUsd(row.costNanoUsd)}`,
  })}${row.detail ? `\n${row.detail}` : ""}`;

const metricLabel = computed(() => (props.metric === "tokens" ? t("dashboard.metric.tokens") : t("dashboard.metric.cost")));
const otherLabel = computed(() => (props.metric === "tokens" ? t("dashboard.metric.cost") : t("dashboard.metric.tokens")));

const totalValue = computed(() => props.total ?? props.rows.reduce((s, r) => s + valueOf(r), 0));

/** Sorted by the metric; rows past the top N wear the "Other" color and share its slice. */
const sorted = computed(() => {
  const total = totalValue.value;
  return [...props.rows]
    .sort((a, b) => valueOf(b) - valueOf(a) || b.requests - a.requests || a.label.localeCompare(b.label))
    .map((r, i) => ({
      ...r,
      rank: i + 1,
      slice: i < TOP ? r.key : OTHER_KEY,
      color: i < TOP ? SLOT_COLORS[i]! : OTHER_COLOR,
      share: total > 0 ? valueOf(r) / total : 0,
    }));
});

const slices = computed<DonutItem[]>(() => {
  const top = sorted.value.slice(0, TOP).map((r) => ({ key: r.key, label: r.label, value: valueOf(r), color: r.color }));
  const shown = top.reduce((s, x) => s + x.value, 0);
  const other = Math.max(0, totalValue.value - shown);
  return other > totalValue.value * 0.001
    ? [...top, { key: OTHER_KEY, label: t("dashboard.distribution.other"), value: other, color: OTHER_COLOR }]
    : top;
});

// Compact legend-table cells (the shared .data-table is too roomy beside a donut).
const th = "sticky top-0 z-10 whitespace-nowrap border-b border-line bg-surface px-2 py-1.5 text-2xs font-medium text-fg-muted";
const td = "whitespace-nowrap px-2 py-1.5";
const num = `${td} text-right font-mono text-xs tabular-nums`;
/** Secondary columns: shown when the block spans the row (sm..xl) or is wide enough (2xl). */
const wide = "hidden sm:table-cell xl:hidden 2xl:table-cell";
const nameClass = computed(() => ["truncate text-xs text-fg", props.mono ? "font-mono" : ""]);
</script>

<template>
  <div class="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
    <DonutChart
      v-model:active="active"
      :items="slices"
      :format="fmt"
      :size="size"
      :thickness="Math.round(size / 7)"
      :total-label="t('dashboard.distribution.total', { metric: metricLabel })"
      :label="donutLabel"
    />
    <div class="w-full min-w-0 flex-1 overflow-y-auto" :style="{ maxHeight: `${size}px` }">
      <table class="w-full border-collapse text-left">
        <thead>
          <tr>
            <th v-if="ranked" :class="[th, 'w-6']">#</th>
            <th :class="th">{{ nameHeader }}</th>
            <th :class="[th, wide, 'text-right']">{{ t("dashboard.metric.requests") }}</th>
            <th :class="[th, 'text-right']">{{ metricLabel }}</th>
            <th :class="[th, wide, 'text-right']">{{ otherLabel }}</th>
            <th :class="[th, 'text-right']">{{ t("dashboard.distribution.share") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in sorted"
            :key="r.key"
            class="border-b border-line/50 transition-colors last:border-0"
            :class="active === r.slice ? 'bg-surface-2/70' : ''"
            :title="tipOf(r)"
            @mouseenter="active = r.slice"
            @mouseleave="active = null"
          >
            <td v-if="ranked" :class="[td, 'font-mono text-xs tabular-nums text-fg-subtle']">{{ r.rank }}</td>
            <td :class="[td, 'w-full max-w-0']">
              <span class="flex min-w-0 items-center gap-2">
                <span class="inline-block h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: r.color }" />
                <RouterLink v-if="r.to" :to="r.to" :class="[nameClass, 'hover:text-accent']">{{ r.label }}</RouterLink>
                <button
                  v-else-if="selectable"
                  type="button"
                  :class="[nameClass, 'min-w-0 text-left hover:text-accent focus-visible:text-accent focus-visible:outline-none']"
                  :title="selectHint || undefined"
                  @click="emit('select', r.key)"
                >
                  {{ r.label }}
                </button>
                <span v-else :class="nameClass">{{ r.label }}</span>
              </span>
            </td>
            <td :class="[num, wide, 'text-fg-muted']">{{ formatCompact(r.requests) }}</td>
            <td :class="[num, 'font-medium text-fg']">{{ fmt(valueOf(r)) }}</td>
            <td :class="[num, wide, 'text-fg-muted']">{{ otherOf(r) }}</td>
            <td :class="[num, 'text-fg-muted']">{{ pct(r.share) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
