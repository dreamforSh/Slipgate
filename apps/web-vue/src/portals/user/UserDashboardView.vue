<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { DashboardRange, UsagePageResponse, UsageRow, UserDashboardStats } from "@slipgate/contracts";
import BarList, { type BarListItem } from "../../components/charts/BarList.vue";
import TrendChart, { type TrendSeries } from "../../components/charts/TrendChart.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { useNow } from "../../composables/useNow";
import { apiJson, errorText, toQuery } from "../../lib/api";
import { formatCompact, formatDurationMs, formatNumber, formatRelative, formatTokens, formatUsd, nanoToUsd } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const { t, locale } = useI18n();
const auth = useAuthStore();
const now = useNow(60_000);

const AUTO_REFRESH_MS = 60_000;

const stats = ref<UserDashboardStats | null>(null);
const recent = ref<UsageRow[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
const range = ref<DashboardRange>("7d");
const metric = ref<"requests" | "tokens" | "cost">("requests");

let requestSeq = 0;
let lastLoadedAt = 0;
let timer: number | undefined;

/* ---------------- Greeting ---------------- */

const displayName = computed(() => {
  const u = auth.user;
  if (!u) return "";
  return u.username?.trim() || u.email.split("@")[0] || u.email;
});

const greetingKey = computed(() => {
  const h = new Date(now.value).getHours();
  if (h < 5) return "night";
  if (h < 11) return "morning";
  if (h < 13) return "noon";
  if (h < 18) return "afternoon";
  return "evening";
});

const todayLabel = computed(() =>
  new Date(now.value).toLocaleDateString(locale.value, { month: "long", day: "numeric", weekday: "long" }),
);

/* ---------------- Data ---------------- */

async function load() {
  const seq = ++requestSeq;
  loading.value = true;
  try {
    const tz = new Date().getTimezoneOffset();
    const [s, usage] = await Promise.all([
      apiJson<UserDashboardStats>(`/api/v1/user/dashboard${toQuery({ range: range.value, tz })}`),
      // Rows only: the summary would aggregate the user's whole history on every refresh.
      apiJson<UsagePageResponse>(`/api/v1/user/usage/query${toQuery({ pageSize: 6, summary: false })}`).catch(() => null),
    ]);
    if (seq !== requestSeq) return;
    stats.value = s;
    if (usage) recent.value = usage.items;
    loadError.value = null;
    lastLoadedAt = Date.now();
  } catch (err) {
    if (seq === requestSeq) loadError.value = errorText(err, t("me.loadFailed"));
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function setRange(next: DashboardRange) {
  if (next === range.value) return;
  range.value = next;
  void load();
}

function onVisibility() {
  if (document.visibilityState === "visible" && Date.now() - lastLoadedAt >= AUTO_REFRESH_MS) void load();
}

onMounted(() => {
  void load();
  // Keep numbers fresh while the tab is visible; catch up as soon as it comes back.
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible") void load();
  }, AUTO_REFRESH_MS);
  document.addEventListener("visibilitychange", onVisibility);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});

/* ---------------- KPIs ---------------- */

const rangeOptions = computed(() => [
  { value: "24h" as const, label: t("me.range.h24") },
  { value: "7d" as const, label: t("me.range.d7") },
  { value: "30d" as const, label: t("me.range.d30") },
]);
const rangeLabel = computed(() => rangeOptions.value.find((o) => o.value === range.value)?.label ?? "");

const todayTokens = computed(() => (stats.value ? stats.value.today.inputTokens + stats.value.today.outputTokens : 0));
const successRate = computed(() => {
  const s = stats.value?.today;
  if (!s || s.requests === 0) return null;
  return (s.requests - s.errors) / s.requests;
});

const updatedAt = computed(() =>
  stats.value
    ? new Date(stats.value.generatedAtIso).toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit" })
    : "",
);

/* ---------------- Trend ---------------- */

const metricOptions = computed(() => [
  { value: "requests" as const, label: t("me.metric.requests") },
  { value: "tokens" as const, label: t("me.metric.tokens") },
  { value: "cost" as const, label: t("me.metric.cost") },
]);

const trendLabels = computed(() => {
  const s = stats.value;
  if (!s) return { short: [] as string[], full: [] as string[] };
  const hourly = s.granularity === "hour";
  const short = s.series.map((p) => {
    const d = new Date(p.startIso);
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
  const points = stats.value?.series ?? [];
  if (metric.value === "tokens") {
    return [
      { key: "in", label: t("me.metric.input"), color: "rgb(var(--viz-1))", values: points.map((p) => p.inputTokens) },
      { key: "out", label: t("me.metric.output"), color: "rgb(var(--viz-2))", values: points.map((p) => p.outputTokens) },
    ];
  }
  if (metric.value === "cost") {
    return [{ key: "cost", label: t("me.metric.cost"), color: "rgb(var(--viz-1))", values: points.map((p) => nanoToUsd(p.costNanoUsd)) }];
  }
  return [{ key: "req", label: t("me.metric.requests"), color: "rgb(var(--viz-1))", values: points.map((p) => p.requests) }];
});

const usdFormat = (usd: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd);
const usdAxis = (usd: number) =>
  usd >= 1000
    ? `$${formatCompact(usd)}`
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: usd < 1 ? 2 : 0 }).format(usd);
const trendFormat = computed(() => (metric.value === "cost" ? usdFormat : (v: number) => formatNumber(v)));
const trendAxisFormat = computed(() =>
  metric.value === "cost" ? usdAxis : metric.value === "tokens" ? (v: number) => formatTokens(v) : (v: number) => formatTokens(v),
);
const trendTitle = computed(() => t(`me.trend.${metric.value}`));

/* ---------------- Breakdowns ---------------- */

function breakdownMeta(row: { requests: number; tokens: number; costNanoUsd: string }) {
  return t("me.breakdown.meta", {
    requests: formatCompact(row.requests),
    tokens: formatTokens(row.tokens),
    cost: formatUsd(row.costNanoUsd),
  });
}

const modelItems = computed<BarListItem[]>(() =>
  (stats.value?.models ?? []).slice(0, 8).map((m) => ({
    key: m.model,
    label: m.model,
    value: m.tokens,
    valueText: formatTokens(m.tokens),
    meta: breakdownMeta(m),
  })),
);

const keyItems = computed<BarListItem[]>(() =>
  (stats.value?.keys ?? []).slice(0, 8).map((k) => ({
    key: k.apiKeyId,
    label: k.name,
    value: nanoToUsd(k.costNanoUsd),
    valueText: formatUsd(k.costNanoUsd),
    meta: breakdownMeta(k),
  })),
);

/** Staggered entrance (capped so later cards don't lag behind). */
const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 8) * 45}ms`, animationFillMode: "both" });
const enter = "animate-slide-up motion-reduce:animate-none";
</script>

<template>
  <div class="space-y-6">
    <!-- Greeting -->
    <section class="card relative overflow-hidden" :class="enter" :style="stagger(0)">
      <div class="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/[0.10] via-transparent to-info/[0.06]" />
      <div class="pointer-events-none absolute inset-0 bg-grid [mask-image:linear-gradient(to_bottom,black,transparent)]" />
      <div class="relative flex flex-wrap items-center justify-between gap-5 p-5 sm:p-6">
        <div class="min-w-0">
          <p class="flex items-center gap-1.5 text-xs font-medium text-accent">
            <UiIcon name="calendar" :size="13" />
            {{ todayLabel }}
          </p>
          <h1 class="mt-1.5 truncate text-2xl font-bold tracking-tight text-fg">
            {{ t(`me.greeting.${greetingKey}`, { name: displayName }) }}
          </h1>
          <p class="mt-1 text-sm text-fg-muted">{{ t("me.subtitle") }}</p>
        </div>
        <div class="flex w-full flex-wrap gap-2 sm:w-auto">
          <RouterLink to="/keys" class="btn btn-primary max-sm:flex-1">
            <UiIcon name="plus" :size="15" />
            {{ t("me.actions.createKey") }}
          </RouterLink>
          <RouterLink to="/redeem" class="btn btn-secondary max-sm:flex-1">
            <UiIcon name="gift" :size="15" />
            {{ t("me.actions.redeem") }}
          </RouterLink>
          <RouterLink to="/usage" class="btn btn-secondary max-sm:flex-1">
            <UiIcon name="chart" :size="15" />
            {{ t("me.actions.usage") }}
          </RouterLink>
        </div>
      </div>
    </section>

    <!-- Toolbar -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-3">
        <h2 class="text-sm font-semibold text-fg">{{ t("me.overview") }}</h2>
        <span v-if="updatedAt" class="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
          <span class="relative inline-flex h-1.5 w-1.5">
            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:animate-none" />
            <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          {{ t("me.updatedAt", { time: updatedAt }) }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <SegmentedControl :model-value="range" :options="rangeOptions" size="md" @update:model-value="setRange" />
        <button
          type="button"
          class="btn btn-secondary btn-icon"
          :disabled="loading"
          :title="t('common.refresh')"
          :aria-label="t('common.refresh')"
          @click="load"
        >
          <UiIcon name="refresh" :size="15" :spin="loading" />
        </button>
      </div>
    </div>

    <UiAlert v-if="loadError && !stats" tone="warning">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="load">
          {{ t("me.retry") }}
        </button>
      </template>
    </UiAlert>

    <!-- First-load skeleton -->
    <template v-if="!stats && loading">
      <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4" aria-busy="true">
        <div v-for="i in 8" :key="i" class="card p-4">
          <div class="flex items-center gap-2.5">
            <div class="h-7 w-7 animate-pulse rounded-lg bg-surface-2 motion-reduce:animate-none" />
            <div class="h-3 w-20 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
          </div>
          <div class="mt-4 h-7 w-24 animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" />
          <div class="mt-2 h-3 w-28 animate-pulse rounded bg-surface-2/70 motion-reduce:animate-none" />
        </div>
      </div>
      <div class="grid gap-6 xl:grid-cols-3">
        <div class="card h-80 animate-pulse bg-surface-2/40 motion-reduce:animate-none xl:col-span-2" />
        <div class="card h-80 animate-pulse bg-surface-2/40 motion-reduce:animate-none" />
      </div>
    </template>

    <template v-else-if="stats">
      <UiAlert v-if="stats.truncated" tone="info">{{ t("me.truncated") }}</UiAlert>

      <!-- KPIs -->
      <div class="grid grid-cols-2 gap-3 transition-opacity sm:gap-4 xl:grid-cols-4" :class="loading ? 'opacity-70' : ''">
        <StatCard
          :class="enter"
          :style="stagger(1)"
          :label="t('me.kpi.balance')"
          :value="formatUsd(stats.balanceNanoUsd)"
          icon="wallet"
          tone="accent"
        >
          <template #hint>
            <RouterLink to="/redeem" class="inline-flex items-center gap-0.5 hover:text-accent">
              {{ t("me.kpi.topUp") }}
              <UiIcon name="chevron-right" :size="12" />
            </RouterLink>
          </template>
        </StatCard>
        <StatCard
          :class="enter"
          :style="stagger(2)"
          :label="t('me.kpi.spent')"
          :value="formatUsd(stats.spentNanoUsd)"
          icon="credit-card"
          tone="violet"
          :hint="t('me.kpi.spentHint')"
        />
        <StatCard
          :class="enter"
          :style="stagger(3)"
          :label="t('me.kpi.keys')"
          :value="`${stats.apiKeys.enabled} / ${stats.apiKeys.total}`"
          icon="key"
          tone="info"
        >
          <template #hint>
            <RouterLink to="/keys" class="inline-flex items-center gap-0.5 hover:text-accent">
              {{ t("me.kpi.manageKeys") }}
              <UiIcon name="chevron-right" :size="12" />
            </RouterLink>
          </template>
        </StatCard>
        <StatCard
          :class="enter"
          :style="stagger(4)"
          :label="t('me.kpi.subs')"
          :value="stats.subscriptions.active"
          icon="crown"
          tone="warning"
        >
          <template #hint>
            <RouterLink to="/subscriptions" class="inline-flex items-center gap-0.5 hover:text-accent">
              {{ t("me.kpi.viewSubs") }}
              <UiIcon name="chevron-right" :size="12" />
            </RouterLink>
          </template>
        </StatCard>
        <StatCard
          :class="enter"
          :style="stagger(5)"
          :label="t('me.kpi.todayRequests')"
          :value="formatCompact(stats.today.requests)"
          icon="activity"
          tone="accent"
          :hint="
            successRate === null
              ? t('me.kpi.noRequestsToday')
              : t('me.kpi.successRate', { rate: (successRate * 100).toFixed(1) })
          "
        />
        <StatCard
          :class="enter"
          :style="stagger(6)"
          :label="t('me.kpi.todayTokens')"
          :value="formatTokens(todayTokens)"
          icon="braces"
          tone="info"
          :hint="
            t('me.kpi.tokenSplit', {
              input: formatTokens(stats.today.inputTokens),
              output: formatTokens(stats.today.outputTokens),
            })
          "
        />
        <StatCard
          :class="enter"
          :style="stagger(7)"
          :label="t('me.kpi.todayCost')"
          :value="formatUsd(stats.today.costNanoUsd)"
          icon="trending-up"
          tone="success"
          :hint="
            stats.today.avgDurationMs
              ? t('me.kpi.avgLatency', { latency: formatDurationMs(stats.today.avgDurationMs) })
              : t('me.kpi.noRequestsToday')
          "
        />
        <StatCard
          :class="enter"
          :style="stagger(8)"
          :label="t('me.kpi.periodRequests', { range: rangeLabel })"
          :value="formatCompact(stats.period.requests)"
          icon="calendar"
          :hint="t('me.kpi.periodCost', { cost: formatUsd(stats.period.costNanoUsd) })"
        />
      </div>

      <!-- Trend + models -->
      <div class="grid gap-6 transition-opacity xl:grid-cols-3" :class="loading ? 'opacity-70' : ''">
        <UiCard class="xl:col-span-2" :class="enter" :style="stagger(5)" icon="activity" :title="trendTitle">
          <template #actions>
            <SegmentedControl v-model="metric" :options="metricOptions" />
          </template>
          <EmptyState v-if="stats.period.requests === 0" compact icon="activity" :title="t('me.trend.empty')">
            <RouterLink to="/keys" class="btn btn-secondary btn-sm">
              <UiIcon name="key" :size="14" />
              {{ t("me.actions.createKey") }}
            </RouterLink>
          </EmptyState>
          <TrendChart
            v-else
            :labels="trendLabels.short"
            :titles="trendLabels.full"
            :series="trendSeries"
            :format="trendFormat"
            :axis-format="trendAxisFormat"
            :chart-label="trendTitle"
          />
        </UiCard>

        <UiCard :class="enter" :style="stagger(6)" icon="sparkles" :title="t('me.models.title')">
          <EmptyState v-if="!modelItems.length" compact icon="sparkles" :title="t('me.breakdown.empty')" />
          <BarList v-else :items="modelItems" />
        </UiCard>
      </div>

      <!-- Keys + recent requests -->
      <div class="grid gap-6 lg:grid-cols-2">
        <UiCard :class="enter" :style="stagger(7)" icon="key" :title="t('me.keys.title')">
          <template #actions>
            <RouterLink to="/keys" class="btn btn-ghost btn-sm">
              {{ t("me.kpi.manageKeys") }}
              <UiIcon name="chevron-right" :size="14" />
            </RouterLink>
          </template>
          <EmptyState v-if="!keyItems.length" compact icon="key" :title="t('me.breakdown.empty')" />
          <BarList v-else :items="keyItems" />
        </UiCard>

        <UiCard :class="enter" :style="stagger(8)" icon="clock" :title="t('me.recent.title')" flush>
          <template #actions>
            <RouterLink to="/usage" class="btn btn-ghost btn-sm">
              {{ t("me.recent.viewAll") }}
              <UiIcon name="chevron-right" :size="14" />
            </RouterLink>
          </template>
          <EmptyState v-if="!recent.length" compact icon="inbox" :title="t('me.recent.empty')" />
          <ul v-else class="divide-y divide-line/70">
            <li
              v-for="(row, i) in recent"
              :key="row.id"
              class="flex animate-fade-in items-center gap-3 px-5 py-3 transition-colors hover:bg-surface-2/40 motion-reduce:animate-none"
              :style="{ animationDelay: `${i * 40}ms`, animationFillMode: 'both' }"
            >
              <span
                class="icon-chip h-8 w-8"
                :class="row.statusCode < 400 ? 'icon-chip-success' : 'icon-chip-danger'"
              >
                <UiIcon :name="row.statusCode < 400 ? 'check' : 'x'" :size="14" />
              </span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-fg">{{ row.publicModel }}</p>
                <p class="mt-0.5 truncate text-2xs text-fg-subtle">
                  {{ row.apiKeyName || row.apiKeyId }} · {{ formatRelative(row.createdAtIso, now) }}
                </p>
              </div>
              <div class="shrink-0 text-right">
                <p class="font-mono text-xs font-medium tabular-nums text-fg">{{ formatUsd(row.costNanoUsd) }}</p>
                <p class="mt-0.5 font-mono text-2xs tabular-nums text-fg-subtle">
                  {{ t("me.recent.tokens", { input: formatTokens(row.inputTokens), output: formatTokens(row.outputTokens) }) }}
                </p>
              </div>
              <UiBadge class="hidden sm:inline-flex" :tone="row.statusCode < 400 ? 'success' : 'danger'" mono>
                {{ row.statusCode }}
              </UiBadge>
            </li>
          </ul>
        </UiCard>
      </div>
    </template>
  </div>
</template>
