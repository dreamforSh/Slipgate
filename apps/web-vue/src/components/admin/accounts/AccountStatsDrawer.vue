<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountStatsRange, AccountUsageStats, UpstreamAccount } from "@slipgate/contracts";
import BarList, { type BarListItem } from "../../charts/BarList.vue";
import TrendChart, { type TrendSeries } from "../../charts/TrendChart.vue";
import CopyButton from "../../ui/CopyButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import PlatformTypeBadge from "./PlatformTypeBadge.vue";
import {
  accountStatusLabel,
  formatCompact,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatRelative,
  formatUsd,
  healthTone,
  nanoToUsd,
} from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";

/** One account's traffic: totals, trend, model mix, error codes and lifecycle details. */
const props = defineProps<{
  open: boolean;
  account: UpstreamAccount | null;
  now: number;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const { t, locale } = useI18n();
const auth = useAuthStore();

const range = ref<AccountStatsRange>("7d");
type Metric = "requests" | "tokens" | "cost";
const metric = ref<Metric>("requests");
const stats = ref<AccountUsageStats | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
let requestSeq = 0;

const rangeOptions = computed(() => [
  { value: "24h" as const, label: t("accounts.statsDrawer.ranges.h24") },
  { value: "7d" as const, label: t("accounts.statsDrawer.ranges.d7") },
  { value: "30d" as const, label: t("accounts.statsDrawer.ranges.d30") },
]);
const metricOptions = computed(() => [
  { value: "requests" as const, label: t("accounts.statsDrawer.metric.requests") },
  { value: "tokens" as const, label: t("accounts.statsDrawer.metric.tokens") },
  { value: "cost" as const, label: t("accounts.statsDrawer.metric.cost") },
]);

async function load() {
  const acc = props.account;
  if (!acc) return;
  const seq = ++requestSeq;
  loading.value = true;
  error.value = null;
  try {
    const tz = new Date().getTimezoneOffset();
    const res = await auth.apiFetch(
      `/api/v1/admin/accounts/${encodeURIComponent(acc.id)}/stats?range=${range.value}&tz=${tz}`,
    );
    if (seq !== requestSeq) return;
    if (!res.ok) {
      stats.value = null;
      error.value = t("accounts.statsDrawer.loadFailed");
      return;
    }
    stats.value = (await res.json()) as AccountUsageStats;
  } catch (err) {
    if (seq === requestSeq) error.value = err instanceof Error ? err.message : t("accounts.statsDrawer.loadFailed");
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

watch(
  () => [props.open, props.account?.id] as const,
  ([open]) => {
    if (open) {
      stats.value = null;
      void load();
    }
  },
);
watch(range, () => {
  if (props.open) void load();
});

const labels = computed(() => {
  const s = stats.value;
  if (!s) return { short: [] as string[], full: [] as string[] };
  const hourly = s.granularity === "hour";
  return {
    short: s.series.map((p) => {
      const d = new Date(p.startIso);
      return hourly
        ? d.toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString(locale.value, { month: "numeric", day: "numeric" });
    }),
    full: s.series.map((p) => {
      const d = new Date(p.startIso);
      return hourly
        ? d.toLocaleString(locale.value, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : d.toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric", weekday: "short" });
    }),
  };
});

const series = computed<TrendSeries[]>(() => {
  const points = stats.value?.series ?? [];
  if (metric.value === "tokens") {
    return [
      { key: "in", label: t("accounts.statsDrawer.input"), color: "rgb(var(--viz-1))", values: points.map((p) => p.inputTokens) },
      { key: "out", label: t("accounts.statsDrawer.output"), color: "rgb(var(--viz-2))", values: points.map((p) => p.outputTokens) },
    ];
  }
  if (metric.value === "cost") {
    return [
      { key: "cost", label: t("accounts.statsDrawer.metric.cost"), color: "rgb(var(--viz-1))", values: points.map((p) => nanoToUsd(p.costNanoUsd)) },
    ];
  }
  return [
    { key: "req", label: t("accounts.statsDrawer.metric.requests"), color: "rgb(var(--viz-1))", values: points.map((p) => p.requests) },
  ];
});

const usd = (v: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v < 1 ? 4 : 2 }).format(v);
const valueFormat = computed(() => (metric.value === "cost" ? usd : (v: number) => formatNumber(v)));
const axisFormat = computed(() => (metric.value === "cost" ? usd : (v: number) => formatCompact(v)));

const modelItems = computed<BarListItem[]>(() =>
  (stats.value?.models ?? []).map((m) => ({
    key: m.model,
    label: m.model,
    value: m.requests,
    valueText: formatCompact(m.requests),
    meta: `${formatCompact(m.tokens)} tok · ${formatUsd(m.costNanoUsd)}`,
  })),
);

const peakText = computed(() => {
  const peak = stats.value?.peak;
  if (!peak || !stats.value) return "";
  const d = new Date(peak.startIso);
  const time =
    stats.value.granularity === "hour"
      ? d.toLocaleString(locale.value, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(locale.value, { month: "numeric", day: "numeric" });
  return t("accounts.statsDrawer.peak", { time, requests: formatNumber(peak.requests) });
});

const hasTraffic = computed(() => (stats.value?.period.requests ?? 0) > 0);
</script>

<template>
  <UiDrawer :open="open" :title="t('accounts.statsDrawer.title')" width="xl" @update:open="emit('update:open', $event)">
    <div v-if="account" class="space-y-5">
      <!-- Identity -->
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="truncate text-base font-semibold text-fg">{{ account.name }}</p>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <PlatformTypeBadge
              inline
              :platform="account.platform"
              :auth-kind="account.authKind"
              :subscription-tier="account.subscriptionTier"
              :tier-multiplier="account.tierMultiplier"
            />
            <UiBadge :tone="healthTone(account.effectiveStatus)" dot>{{ accountStatusLabel(account.effectiveStatus) }}</UiBadge>
            <span class="text-xs text-fg-muted">{{ account.groupName || t("accounts.ungrouped") }}</span>
          </div>
        </div>
        <SegmentedControl v-model="range" :options="rangeOptions" />
      </div>

      <UiAlert v-if="error" tone="danger">{{ error }}</UiAlert>
      <UiAlert v-else-if="stats?.truncated" tone="warning">{{ t("accounts.statsDrawer.truncated") }}</UiAlert>

      <!-- Totals -->
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4" :class="loading && !stats ? 'animate-pulse' : ''">
        <div class="rounded-xl bg-surface-2/60 p-3">
          <p class="text-2xs text-fg-subtle">{{ t("accounts.statsDrawer.requests") }}</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-fg">{{ formatNumber(stats?.period.requests ?? 0) }}</p>
          <p class="mt-0.5 text-2xs" :class="stats?.period.errors ? 'text-danger' : 'text-fg-subtle'">
            {{ t("accounts.statsDrawer.errors", { n: formatNumber(stats?.period.errors ?? 0) }) }}
          </p>
        </div>
        <div class="rounded-xl bg-surface-2/60 p-3">
          <p class="text-2xs text-fg-subtle">{{ t("accounts.statsDrawer.tokens") }}</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-fg">
            {{ formatCompact((stats?.period.inputTokens ?? 0) + (stats?.period.outputTokens ?? 0)) }}
          </p>
          <p class="mt-0.5 truncate text-2xs text-fg-subtle">
            {{
              t("accounts.statsDrawer.tokensHint", {
                input: formatCompact(stats?.period.inputTokens ?? 0),
                output: formatCompact(stats?.period.outputTokens ?? 0),
              })
            }}
          </p>
        </div>
        <div class="rounded-xl bg-surface-2/60 p-3">
          <p class="text-2xs text-fg-subtle">{{ t("accounts.statsDrawer.cost") }}</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-fg">{{ formatUsd(stats?.period.costNanoUsd ?? "0") }}</p>
          <p class="mt-0.5 truncate text-2xs text-fg-subtle">{{ peakText || "—" }}</p>
        </div>
        <div class="rounded-xl bg-surface-2/60 p-3">
          <p class="text-2xs text-fg-subtle">{{ t("accounts.statsDrawer.latency") }}</p>
          <p class="mt-1 text-xl font-semibold tabular-nums text-fg">{{ formatDurationMs(stats?.period.avgDurationMs ?? 0) }}</p>
          <p class="mt-0.5 text-2xs text-fg-subtle">
            {{ t("accounts.statsDrawer.latencyHint", { ttft: formatDurationMs(stats?.period.avgTtftMs ?? 0) }) }}
          </p>
        </div>
      </div>
      <p v-if="stats" class="text-xs text-fg-muted">
        {{
          t("accounts.statsDrawer.today", {
            requests: formatNumber(stats.today.requests),
            tokens: formatCompact(stats.today.inputTokens + stats.today.outputTokens),
            cost: formatUsd(stats.today.costNanoUsd),
          })
        }}
      </p>

      <!-- Trend -->
      <section class="rounded-xl border border-line/70 p-4">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-fg">{{ t("accounts.statsDrawer.trend") }}</h3>
          <SegmentedControl v-model="metric" :options="metricOptions" />
        </div>
        <div v-if="loading && !stats" class="flex h-[200px] items-center justify-center text-fg-subtle">
          <UiIcon name="loader" :size="20" spin />
        </div>
        <EmptyState v-else-if="!hasTraffic" compact icon="chart" :title="t('accounts.statsDrawer.empty')" />
        <TrendChart
          v-else
          :labels="labels.short"
          :titles="labels.full"
          :series="series"
          :format="valueFormat"
          :axis-format="axisFormat"
          :height="200"
          :chart-label="t('accounts.statsDrawer.trend')"
        />
      </section>

      <div v-if="hasTraffic" class="grid gap-4 lg:grid-cols-2">
        <section class="rounded-xl border border-line/70 p-4">
          <h3 class="mb-2 text-sm font-semibold text-fg">{{ t("accounts.statsDrawer.models") }}</h3>
          <BarList :items="modelItems" />
        </section>
        <section class="rounded-xl border border-line/70 p-4">
          <h3 class="mb-2 text-sm font-semibold text-fg">{{ t("accounts.statsDrawer.errorCodes") }}</h3>
          <p v-if="!stats?.errorCodes.length" class="text-xs text-fg-subtle">{{ t("accounts.statsDrawer.noErrors") }}</p>
          <ul v-else class="space-y-1.5">
            <li v-for="code in stats.errorCodes" :key="code.statusCode" class="flex items-center justify-between text-xs">
              <UiBadge :tone="code.statusCode === 429 ? 'warning' : 'danger'" mono>HTTP {{ code.statusCode }}</UiBadge>
              <span class="font-mono tabular-nums text-fg-muted">{{ formatNumber(code.count) }}</span>
            </li>
          </ul>
        </section>
      </div>

      <!-- Details -->
      <section class="rounded-xl border border-line/70 p-4">
        <h3 class="mb-3 text-sm font-semibold text-fg">{{ t("accounts.statsDrawer.details") }}</h3>
        <dl class="kv grid-cols-1 sm:grid-cols-2">
          <div>
            <dt>{{ t("accounts.statsDrawer.id") }}</dt>
            <dd class="flex items-center gap-1">
              <span class="truncate">{{ account.id }}</span>
              <CopyButton :text="account.id" />
            </dd>
          </div>
          <div>
            <dt>{{ t("accounts.statsDrawer.credential") }}</dt>
            <dd>{{ account.credentialPreview }}</dd>
          </div>
          <div>
            <dt>{{ t("accounts.statsDrawer.created") }}</dt>
            <dd>{{ formatDateTime(account.createdAtIso) }}</dd>
          </div>
          <div>
            <dt>{{ t("accounts.statsDrawer.lastUsed") }}</dt>
            <dd>{{ account.lastUsedAtIso ? formatRelative(account.lastUsedAtIso, now) : t("accounts.lastUsed.never") }}</dd>
          </div>
          <div>
            <dt>{{ t("accounts.statsDrawer.lastTest") }}</dt>
            <dd :class="account.lastTest && !account.lastTest.ok ? '!text-danger' : ''" :title="account.lastTest?.message || undefined">
              {{
                account.lastTest
                  ? `${account.lastTest.ok ? t("accounts.lastTest.ok") : t("accounts.lastTest.failed")} · ${formatRelative(account.lastTest.atIso, now)}`
                  : t("accounts.lastTest.never")
              }}
            </dd>
          </div>
          <div>
            <dt>{{ t("accounts.statsDrawer.expires") }}</dt>
            <dd>{{ account.expiresAtIso ? formatDateTime(account.expiresAtIso) : t("accounts.expiry.none") }}</dd>
          </div>
          <div v-if="account.cooldownUntilIso">
            <dt>{{ t("accounts.statsDrawer.cooldown") }}</dt>
            <dd :title="account.cooldownReason || undefined">{{ formatDateTime(account.cooldownUntilIso) }}</dd>
          </div>
        </dl>
      </section>
    </div>
  </UiDrawer>
</template>
