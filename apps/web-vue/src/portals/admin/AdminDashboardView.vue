<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  AdminDashboardStats,
  ClashExitNode,
  DashboardRange,
  ClashRuntimeStatus,
  GroupItem,
  Provider,
  RiskBanEvent,
  RoutePreviewResponse,
  StoredCompositeRoute,
  UsageLogItem,
  VmSlotSummary,
} from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import BarList, { type BarListItem } from "../../components/charts/BarList.vue";
import TrendChart, { type TrendSeries } from "../../components/charts/TrendChart.vue";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import UsageMeter from "../../components/ui/UsageMeter.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import {
  PROVIDER_OPTIONS,
  RUNTIME_PROFILE_TONE,
  formatCompact,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatUsd,
  nanoToUsd,
  healthLabel,
  healthTone,
  planeLabel,
  shortHash,
  slotStateLabel,
} from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import { useSystemUpdateStore } from "../../stores/systemUpdate";

const auth = useAuthStore();
const systemUpdate = useSystemUpdateStore();
const { t, locale } = useI18n();

interface ReadinessState {
  ready: boolean;
  degraded: boolean;
  planes: Record<string, string>;
}

const groups = ref<GroupItem[]>([]);
const routes = ref<StoredCompositeRoute[]>([]);
const adminUsage = ref<UsageLogItem[]>([]);
const clashNodes = ref<ClashExitNode[]>([]);
const clashRuntime = ref<ClashRuntimeStatus | null>(null);
const vmSlots = ref<VmSlotSummary[]>([]);
const riskEvents = ref<RiskBanEvent[]>([]);
const readiness = ref<ReadinessState | null>(null);
const routeGroupId = ref("grp_default");
const routePublicModel = ref("");
const routeMatchType = ref<"exact" | "prefix">("exact");
const routeTargetPlatform = ref<Provider>("anthropic");
const routeUpstreamModel = ref("");
const routePriority = ref(50);
const previewModel = ref("claude-sonnet-4-5");
const previewResult = ref<RoutePreviewResponse | null>(null);
const previewError = ref<string | null>(null);
const loading = ref(false);
const routeFormOpen = ref(false);

useFeedbackToasts(computed(() => systemUpdate.error));

/* ---------------- Usage statistics ---------------- */

const stats = ref<AdminDashboardStats | null>(null);
const statsLoading = ref(false);
const statsError = ref(false);
const range = ref<DashboardRange>("7d");
const trendMetric = ref<"requests" | "tokens" | "cost">("requests");
const trendAsTable = ref(false);
const AUTO_REFRESH_MS = 60_000;
let refreshTimer: number | undefined;

const rangeOptions = computed(() => [
  { value: "24h" as const, label: t("dashboard.range.h24") },
  { value: "7d" as const, label: t("dashboard.range.d7") },
  { value: "30d" as const, label: t("dashboard.range.d30") },
]);
const metricOptions = computed(() => [
  { value: "requests" as const, label: t("dashboard.metric.requests") },
  { value: "tokens" as const, label: t("dashboard.metric.tokens") },
  { value: "cost" as const, label: t("dashboard.metric.cost") },
]);

async function loadStats() {
  statsLoading.value = true;
  try {
    const tz = new Date().getTimezoneOffset();
    const res = await auth.apiFetch(`/api/v1/admin/dashboard/stats?range=${range.value}&tz=${tz}`);
    if (!res.ok) {
      statsError.value = true;
      return;
    }
    stats.value = (await res.json()) as AdminDashboardStats;
    statsError.value = false;
  } catch {
    statsError.value = true;
  } finally {
    statsLoading.value = false;
  }
}

function setRange(next: DashboardRange) {
  range.value = next;
  void loadStats();
}

function refreshAll() {
  void loadStats();
  void loadOverview();
}

/** Relative change; null when the reference period is empty. */
function change(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

const updatedAt = computed(() =>
  stats.value
    ? new Date(stats.value.generatedAtIso).toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit" })
    : "",
);

const todayTokens = computed(() => (stats.value ? stats.value.today.inputTokens + stats.value.today.outputTokens : 0));
const successRate = computed(() => {
  const s = stats.value?.today;
  if (!s || s.requests === 0) return null;
  return (s.requests - s.errors) / s.requests;
});

const healthSegments = computed(() => {
  const a = stats.value?.accounts;
  if (!a) return [];
  return [
    { key: "active", label: t("dashboard.health.active"), value: a.active, color: "rgb(var(--success))" },
    { key: "paused", label: t("dashboard.health.paused"), value: a.paused, color: "rgb(var(--fg-subtle))" },
    { key: "cooldown", label: t("dashboard.health.cooldown"), value: a.cooldown, color: "rgb(var(--warning))" },
    { key: "expired", label: t("dashboard.health.expired"), value: a.expired, color: "rgb(var(--danger))" },
  ].filter((s) => s.value > 0);
});

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
  if (trendMetric.value === "tokens") {
    return [
      { key: "in", label: t("dashboard.metric.input"), color: "rgb(var(--viz-1))", values: points.map((p) => p.inputTokens) },
      { key: "out", label: t("dashboard.metric.output"), color: "rgb(var(--viz-2))", values: points.map((p) => p.outputTokens) },
    ];
  }
  if (trendMetric.value === "cost") {
    return [{ key: "cost", label: t("dashboard.metric.cost"), color: "rgb(var(--viz-1))", values: points.map((p) => nanoToUsd(p.costNanoUsd)) }];
  }
  return [{ key: "req", label: t("dashboard.metric.requests"), color: "rgb(var(--viz-1))", values: points.map((p) => p.requests) }];
});

const usdFormat = (usd: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd);
const usdAxis = (usd: number) =>
  usd >= 1000
    ? `$${formatCompact(usd)}`
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: usd < 1 ? 2 : 0 }).format(usd);
const trendFormat = computed(() => (trendMetric.value === "cost" ? usdFormat : (v: number) => formatNumber(v)));
const trendAxisFormat = computed(() => (trendMetric.value === "cost" ? usdAxis : (v: number) => formatCompact(v)));

const trendTitle = computed(() =>
  trendMetric.value === "tokens"
    ? t("dashboard.trend.tokens")
    : trendMetric.value === "cost"
      ? t("dashboard.trend.cost")
      : t("dashboard.trend.requests"),
);

function breakdownMeta(row: { requests: number; tokens: number; costNanoUsd: string }) {
  return t("dashboard.breakdown.meta", {
    requests: formatCompact(row.requests),
    tokens: formatCompact(row.tokens),
    cost: formatUsd(row.costNanoUsd),
  });
}

const modelItems = computed<BarListItem[]>(() =>
  (stats.value?.models ?? []).map((m) => ({
    key: m.model,
    label: m.model,
    value: m.tokens,
    valueText: formatCompact(m.tokens),
    meta: breakdownMeta(m),
  })),
);
const userItems = computed<BarListItem[]>(() =>
  (stats.value?.topUsers ?? []).map((u) => ({
    key: u.userId,
    label: u.email,
    value: nanoToUsd(u.costNanoUsd),
    valueText: formatUsd(u.costNanoUsd),
    meta: breakdownMeta(u),
  })),
);
const groupItems = computed<BarListItem[]>(() =>
  (stats.value?.groups ?? []).map((g) => ({
    key: g.groupId,
    label: g.name,
    value: g.tokens,
    valueText: formatCompact(g.tokens),
    meta: breakdownMeta(g),
  })),
);

const planes = computed<{ key: string; label: string; icon: IconName }[]>(() => [
  { key: "net", label: t("dashboard.planes.net"), icon: "globe" },
  { key: "core", label: t("dashboard.planes.core"), icon: "cpu" },
  { key: "bff", label: t("dashboard.planes.bff"), icon: "layers" },
]);

const healthyNodes = computed(() => clashNodes.value.filter((n) => n.healthStatus === "healthy").length);
const readySlots = computed(() => vmSlots.value.filter((s) => s.state === "ready").length);
const activeSubagents = computed(() => vmSlots.value.reduce((sum, s) => sum + s.activeSubagents, 0));
const maxSubagents = computed(() => vmSlots.value.reduce((sum, s) => sum + s.maxSubagents, 0));

const groupNameById = computed(() => new Map(groups.value.map((g) => [g.id, g.name])));

async function loadOverview() {
  loading.value = true;
  try {
    const [grpRes, routeRes, usageRes, clashRes, vmRes, riskRes, readyRes] = await Promise.all([
      auth.apiFetch("/api/v1/admin/groups"),
      auth.apiFetch("/api/v1/admin/routes"),
      auth.apiFetch("/api/v1/admin/usage?limit=15"),
      auth.apiFetch("/api/v1/admin/clash/nodes"),
      auth.apiFetch("/api/v1/admin/vms/slots"),
      auth.apiFetch("/api/v1/admin/risk/events"),
      fetch("/readyz"),
      systemUpdate.loadStatus(true),
    ]);
    if (grpRes.ok) {
      const grpData = (await grpRes.json()) as { groups: GroupItem[] };
      groups.value = grpData.groups;
      if (groups.value.length > 0 && !groups.value.some((g) => g.id === routeGroupId.value)) {
        routeGroupId.value = groups.value[0]!.id;
      }
    }
    if (routeRes.ok) {
      const routeData = (await routeRes.json()) as { routes: StoredCompositeRoute[] };
      routes.value = routeData.routes;
    }
    if (usageRes.ok) {
      const usageData = (await usageRes.json()) as { items: UsageLogItem[] };
      adminUsage.value = usageData.items;
    }
    if (clashRes.ok) {
      const clashData = (await clashRes.json()) as {
        nodes: ClashExitNode[];
        runtime?: ClashRuntimeStatus;
      };
      clashNodes.value = clashData.nodes;
      clashRuntime.value = clashData.runtime ?? null;
    }
    if (vmRes.ok) {
      const vmData = (await vmRes.json()) as { slots: VmSlotSummary[] };
      vmSlots.value = vmData.slots;
    }
    if (riskRes.ok) {
      const riskData = (await riskRes.json()) as { events: RiskBanEvent[] };
      riskEvents.value = riskData.events;
    }
    if (readyRes.ok || readyRes.status === 503) {
      readiness.value = (await readyRes.json()) as ReadinessState;
    }
  } catch {
    // Allow standalone preview when backend is offline.
  } finally {
    loading.value = false;
  }
}

async function checkSystemUpdates() {
  await systemUpdate.checkForUpdates();
}

async function handleCreateRoute() {
  previewError.value = null;
  const res = await auth.apiFetch("/api/v1/admin/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      groupId: routeGroupId.value,
      publicModel: routePublicModel.value,
      matchType: routeMatchType.value,
      targetPlatform: routeTargetPlatform.value,
      upstreamModel: routeUpstreamModel.value,
      priority: routePriority.value,
    }),
  });
  if (!res.ok) {
    const err = (await res.json()) as { message?: string; error?: string };
    previewError.value = err.message ?? err.error ?? t("dashboard.routes.createFailed");
    return;
  }
  routePublicModel.value = "";
  routeUpstreamModel.value = "";
  routeFormOpen.value = false;
  await loadOverview();
}

async function deleteRoute(routeId: string) {
  previewError.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/routes/${routeId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json()) as { message?: string };
    previewError.value = err.message ?? t("dashboard.routes.deleteFailed");
    return;
  }
  await loadOverview();
}

async function runRoutePreview() {
  previewError.value = null;
  previewResult.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/routes/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: routeGroupId.value,
        publicModel: previewModel.value,
        endpoint: "any",
      }),
    });
    const data = (await res.json()) as RoutePreviewResponse & { error?: string };
    if (!res.ok) {
      previewError.value = data.error ?? t("dashboard.preview.notMatched");
      return;
    }
    previewResult.value = data;
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : t("common.requestFailed");
  }
}

onMounted(() => {
  void loadOverview();
  void loadStats();
  // Keep the numbers fresh while the page is open; skip ticks while the tab is hidden.
  refreshTimer = window.setInterval(() => {
    if (document.visibilityState === "visible") void loadStats();
  }, AUTO_REFRESH_MS);
});

onBeforeUnmount(() => window.clearInterval(refreshTimer));
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('dashboard.title')">
      <template #meta>
        <span v-if="updatedAt" class="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
          <span class="relative inline-flex h-1.5 w-1.5">
            <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
          </span>
          {{ t("dashboard.updatedAt", { time: updatedAt }) }}
        </span>
      </template>
      <template #actions>
        <SegmentedControl :model-value="range" :options="rangeOptions" size="md" @update:model-value="setRange" />
        <button type="button" class="btn btn-secondary" :disabled="loading || statsLoading" @click="refreshAll">
          <UiIcon name="refresh" :size="15" :spin="loading || statsLoading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </PageHeader>

    <UiAlert v-if="statsError && !stats" tone="warning">{{ t("dashboard.loadFailed") }}</UiAlert>

    <!-- Usage KPIs -->
    <div
      class="grid grid-cols-2 gap-3 transition-opacity sm:gap-4 xl:grid-cols-4"
      :class="statsLoading && stats ? 'opacity-70' : ''"
    >
      <StatCard
        :label="t('dashboard.kpi.todayRequests')"
        :value="formatCompact(stats?.today.requests ?? 0)"
        icon="activity"
        tone="accent"
        :delta="stats ? change(stats.today.requests, stats.yesterday.requests) : null"
        :delta-label="t('dashboard.kpi.vsYesterday')"
      >
        <template #hint>
          {{
            successRate === null
              ? t("dashboard.kpi.noRequestsToday")
              : t("dashboard.kpi.successRate", { rate: (successRate * 100).toFixed(1) })
          }}
        </template>
      </StatCard>
      <StatCard
        :label="t('dashboard.kpi.todayTokens')"
        :value="formatCompact(todayTokens)"
        icon="braces"
        tone="info"
        :delta="stats ? change(todayTokens, stats.yesterday.inputTokens + stats.yesterday.outputTokens) : null"
        :delta-label="t('dashboard.kpi.vsYesterday')"
        :hint="
          t('dashboard.kpi.tokenSplit', {
            input: formatCompact(stats?.today.inputTokens ?? 0),
            output: formatCompact(stats?.today.outputTokens ?? 0),
          })
        "
      />
      <StatCard
        :label="t('dashboard.kpi.todayCost')"
        :value="formatUsd(stats?.today.costNanoUsd ?? '0')"
        icon="wallet"
        tone="success"
        :delta="stats ? change(nanoToUsd(stats.today.costNanoUsd), nanoToUsd(stats.yesterday.costNanoUsd)) : null"
        :delta-label="t('dashboard.kpi.vsYesterday')"
        :hint="t('dashboard.kpi.periodCost', { range: rangeOptions.find((o) => o.value === range)?.label, cost: formatUsd(stats?.period.costNanoUsd ?? '0') })"
      />
      <StatCard
        :label="t('dashboard.kpi.activeUsers')"
        :value="formatCompact(stats?.users.activeToday ?? 0)"
        icon="users"
        tone="violet"
        :hint="t('dashboard.kpi.userSplit', { new: stats?.users.newToday ?? 0, total: stats?.users.total ?? 0 })"
      />
      <StatCard
        :label="t('dashboard.kpi.throughput')"
        :value="`${formatCompact(stats?.throughput.rpm ?? 0)} RPM`"
        icon="zap"
        tone="warning"
        :hint="t('dashboard.kpi.tpm', { tpm: formatCompact(stats?.throughput.tpm ?? 0) })"
      />
      <StatCard
        :label="t('dashboard.kpi.avgLatency')"
        :value="stats?.today.avgDurationMs ? formatDurationMs(stats.today.avgDurationMs) : '-'"
        icon="clock"
        tone="info"
        :hint="
          stats?.today.avgTtftMs
            ? t('dashboard.kpi.ttft', { ttft: formatDurationMs(stats.today.avgTtftMs) })
            : t('dashboard.kpi.noRequestsToday')
        "
      />
      <StatCard
        :label="t('dashboard.kpi.apiKeys')"
        :value="`${stats?.apiKeys.enabled ?? 0} / ${stats?.apiKeys.total ?? 0}`"
        icon="key"
        tone="accent"
        :hint="t('dashboard.kpi.keysHint')"
      />
      <StatCard
        :label="t('dashboard.kpi.accounts')"
        :value="`${stats?.accounts.active ?? 0} / ${stats?.accounts.total ?? 0}`"
        icon="layers"
        :tone="(stats?.accounts.failedTests ?? 0) > 0 ? 'danger' : 'success'"
      >
        <template #hint>
          <RouterLink to="/admin/accounts" class="hover:text-fg">
            {{
              (stats?.accounts.failedTests ?? 0) > 0
                ? t("dashboard.kpi.failedTests", { count: stats?.accounts.failedTests })
                : t("dashboard.kpi.allHealthy")
            }}
          </RouterLink>
        </template>
        <template #footer>
          <div
            v-if="healthSegments.length"
            class="mt-3 flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
            role="img"
            :aria-label="healthSegments.map((s) => `${s.label} ${s.value}`).join(', ')"
          >
            <span
              v-for="seg in healthSegments"
              :key="seg.key"
              class="h-full first:rounded-l-full last:rounded-r-full"
              :style="{ flexGrow: seg.value, background: seg.color }"
              :title="`${seg.label} ${seg.value}`"
            />
          </div>
          <div v-if="healthSegments.length" class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs text-fg-muted">
            <span v-for="seg in healthSegments" :key="seg.key" class="inline-flex items-center gap-1">
              <span class="inline-block h-2 w-2 rounded-full" :style="{ background: seg.color }" />
              {{ seg.label }} {{ seg.value }}
            </span>
          </div>
        </template>
      </StatCard>
    </div>

    <!-- Trend + model distribution -->
    <div class="grid gap-6 xl:grid-cols-3" :class="statsLoading && stats ? 'opacity-70 transition-opacity' : 'transition-opacity'">
      <UiCard class="xl:col-span-2" icon="activity" :title="trendTitle">
        <template #actions>
          <SegmentedControl v-model="trendMetric" :options="metricOptions" />
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
        <EmptyState
          v-if="stats && stats.period.requests === 0"
          compact
          icon="activity"
          :title="t('dashboard.trend.empty')"
        />
        <div v-else-if="trendAsTable" class="table-wrap max-h-72 overflow-y-auto">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("dashboard.trend.time") }}</th>
                <th v-for="s in trendSeries" :key="s.key" class="text-right">{{ s.label }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(label, i) in trendLabels.full" :key="label">
                <td class="whitespace-nowrap text-xs text-fg-muted">{{ label }}</td>
                <td v-for="s in trendSeries" :key="s.key" class="text-right font-mono text-xs tabular-nums">
                  {{ trendFormat(s.values[i] ?? 0) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
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

      <UiCard icon="sparkles" :title="t('dashboard.models.title')">
        <EmptyState v-if="!modelItems.length" compact icon="sparkles" :title="t('dashboard.breakdown.empty')" />
        <BarList v-else :items="modelItems" />
      </UiCard>
    </div>

    <!-- Top users + groups -->
    <div class="grid gap-6 lg:grid-cols-2">
      <UiCard icon="users" :title="t('dashboard.topUsers.title')">
        <EmptyState v-if="!userItems.length" compact icon="users" :title="t('dashboard.breakdown.empty')" />
        <BarList v-else :items="userItems" />
      </UiCard>
      <UiCard icon="layers" :title="t('dashboard.groups.title')">
        <template #actions>
          <RouterLink to="/admin/groups" class="btn btn-ghost btn-sm">
            {{ t("dashboard.groups.manage") }}
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="!groupItems.length" compact icon="layers" :title="t('dashboard.breakdown.empty')" />
        <BarList v-else :items="groupItems" />
      </UiCard>
    </div>

    <!-- System status -->
    <h2 class="pt-2 text-sm font-semibold text-fg">{{ t("dashboard.sections.system") }}</h2>

    <!-- Plane health -->
    <div class="grid gap-4 md:grid-cols-3">
      <div v-for="p in planes" :key="p.key" class="card min-w-0 p-4">
        <div class="flex items-center justify-between gap-3">
          <span
            class="icon-chip h-9 w-9 rounded-xl"
            :class="readiness?.planes[p.key] === 'up' ? 'icon-chip-accent' : ''"
          >
            <UiIcon :name="p.icon" :size="18" />
          </span>
          <UiBadge
            :tone="healthTone(readiness?.planes[p.key] ?? 'unknown')"
            dot
            :pulse="readiness?.planes[p.key] === 'up'"
          >
            {{ planeLabel(readiness?.planes[p.key] ?? "unknown") }}
          </UiBadge>
        </div>
        <p class="mt-3 truncate text-sm font-medium text-fg">{{ p.label }}</p>
      </div>
    </div>

    <!-- KPIs -->
    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        :label="t('dashboard.stats.groupsRoutes')"
        :value="`${groups.length} / ${routes.length}`"
        icon="route"
        tone="accent"
      />
      <StatCard
        :label="t('dashboard.stats.healthyNodes')"
        :value="`${healthyNodes} / ${clashNodes.length}`"
        icon="globe"
        tone="success"
        :hint="t('dashboard.stats.listeners', { count: clashRuntime?.activeListeners ?? clashNodes.length })"
      />
      <StatCard
        :label="t('dashboard.stats.readySlots')"
        :value="`${readySlots} / ${vmSlots.length}`"
        icon="server"
        tone="info"
        :hint="t('dashboard.stats.concurrency', { active: activeSubagents, max: maxSubagents })"
      />
      <StatCard
        :label="t('dashboard.stats.riskBlocks')"
        :value="riskEvents.length"
        icon="shield-alert"
        :tone="riskEvents.length > 0 ? 'warning' : 'neutral'"
      />
    </div>

    <!-- Egress & VM -->
    <div class="grid gap-6 xl:grid-cols-2">
      <UiCard icon="globe" :title="t('nav.proxyClash')" flush>
        <template #actions>
          <RouterLink to="/admin/proxy/clash" class="btn btn-ghost btn-sm">
            {{ t("dashboard.clash.manage") }}
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="clashNodes.length === 0" compact icon="globe" :title="t('dashboard.clash.empty')" />
        <ul v-else class="divide-y divide-line/70">
          <li v-for="node in clashNodes.slice(0, 6)" :key="node.nodeId" class="flex items-center gap-3 px-5 py-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-fg">{{ node.name }}</p>
              <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">
                :{{ node.listenerPort }} → {{ node.exitIp || t("dashboard.clash.notProbed") }} · {{ node.latencyMs }}ms
              </p>
            </div>
            <span class="font-mono text-2xs text-fg-subtle">{{ node.boundAccounts }}/{{ node.maxAccounts }}</span>
            <UiBadge :tone="healthTone(node.healthStatus)" dot>{{ healthLabel(node.healthStatus) }}</UiBadge>
          </li>
        </ul>
      </UiCard>

      <UiCard icon="server" :title="t('nav.vms')" flush>
        <template #actions>
          <RouterLink to="/admin/vms" class="btn btn-ghost btn-sm">
            {{ t("dashboard.clash.manage") }}
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="vmSlots.length === 0" compact icon="server" :title="t('dashboard.vms.empty')" />
        <ul v-else class="divide-y divide-line/70">
          <li v-for="slot in vmSlots.slice(0, 6)" :key="slot.slotId" class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto]">
            <div class="min-w-0">
              <p class="flex items-center gap-1.5 truncate font-mono text-xs font-medium text-fg">
                {{ slot.slotId }}
                <UiBadge :tone="RUNTIME_PROFILE_TONE[slot.runtimeProfile] ?? 'neutral'">{{ slot.runtimeProfile }}</UiBadge>
              </p>
              <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{{ slot.hypervisorKind }} · {{ slot.exitIp }}</p>
            </div>
            <UsageMeter class="hidden sm:block" label="5h" :bps="slot.window5hUsedBps" />
            <UsageMeter
              class="hidden sm:block"
              :label="t('dashboard.vms.concurrency')"
              :value="slot.activeSubagents"
              :max="slot.maxSubagents"
            />
            <UiBadge :tone="healthTone(slot.state)" dot>{{ slotStateLabel(slot.state) }}</UiBadge>
          </li>
        </ul>
      </UiCard>
    </div>

    <!-- Routing -->
    <div class="grid gap-6 xl:grid-cols-3">
      <UiCard class="xl:col-span-2" icon="route" :title="t('dashboard.routes.title')" flush>
        <template #actions>
          <button type="button" class="btn btn-sm" :class="routeFormOpen ? 'btn-secondary' : 'btn-primary'" @click="routeFormOpen = !routeFormOpen">
            <UiIcon :name="routeFormOpen ? 'x' : 'plus'" :size="14" />
            {{ routeFormOpen ? t("dashboard.routes.hideForm") : t("dashboard.routes.add") }}
          </button>
        </template>

        <form
          v-if="routeFormOpen"
          class="grid animate-fade-in gap-3 border-b border-line bg-surface-2/40 p-5 sm:grid-cols-2 lg:grid-cols-3"
          @submit.prevent="handleCreateRoute"
        >
          <label class="block">
            <span class="label">{{ t("dashboard.routes.group") }}</span>
            <select v-model="routeGroupId" class="select">
              <option v-if="groups.length === 0" value="grp_default">grp_default</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }} ({{ g.id }})</option>
            </select>
          </label>
          <label class="block">
            <span class="label">{{ t("dashboard.routes.publicModel") }} <span class="text-danger">*</span></span>
            <input
              v-model="routePublicModel"
              type="text"
              required
              :placeholder="t('dashboard.routes.publicModelPlaceholder')"
              class="input font-mono"
            />
          </label>
          <label class="block">
            <span class="label">{{ t("dashboard.routes.matchType") }}</span>
            <select v-model="routeMatchType" class="select">
              <option value="exact">{{ t("dashboard.routes.matchExact") }}</option>
              <option value="prefix">{{ t("dashboard.routes.matchPrefix") }}</option>
            </select>
          </label>
          <label class="block">
            <span class="label">{{ t("dashboard.routes.targetPlatform") }}</span>
            <select v-model="routeTargetPlatform" class="select">
              <option v-for="p in PROVIDER_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </label>
          <label class="block">
            <span class="label">{{ t("dashboard.routes.upstreamModel") }}</span>
            <input
              v-model="routeUpstreamModel"
              type="text"
              :placeholder="t('dashboard.routes.upstreamModelPlaceholder')"
              class="input font-mono"
            />
          </label>
          <div class="flex items-end gap-2">
            <label class="block w-24 shrink-0">
              <span class="label">{{ t("dashboard.routes.priority") }}</span>
              <input v-model.number="routePriority" type="number" min="0" class="input font-mono" />
            </label>
            <button type="submit" class="btn btn-primary flex-1">{{ t("common.save") }}</button>
          </div>
        </form>

        <EmptyState v-if="routes.length === 0" compact icon="route" :title="t('dashboard.routes.empty')" />
        <div v-else class="table-wrap max-h-80 overflow-y-auto">
          <table class="data-table">
            <thead class="sticky top-0 z-10">
              <tr>
                <th>{{ t("dashboard.routes.colPublicModel") }}</th>
                <th>{{ t("dashboard.routes.colTarget") }}</th>
                <th>{{ t("dashboard.routes.colMatch") }}</th>
                <th>{{ t("dashboard.routes.group") }}</th>
                <th class="text-right">{{ t("common.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in routes" :key="r.id">
                <td class="font-mono text-xs font-medium text-fg">{{ r.publicModel }}</td>
                <td class="font-mono text-xs text-fg-muted">
                  <span class="text-fg">{{ r.targetPlatform }}</span> / {{ r.upstreamModel || r.publicModel }}
                </td>
                <td>
                  <div class="flex items-center gap-1.5">
                    <UiBadge :tone="r.matchType === 'exact' ? 'accent' : 'info'">
                      {{ t(`dashboard.routes.match.${r.matchType}`) }}
                    </UiBadge>
                    <span class="font-mono text-2xs text-fg-subtle">#{{ r.priority }}</span>
                  </div>
                </td>
                <td class="text-xs text-fg-muted">{{ groupNameById.get(r.groupId) ?? r.groupId }}</td>
                <td class="text-right">
                  <ConfirmButton icon-only @confirm="deleteRoute(r.id)" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <UiCard icon="search" :title="t('dashboard.preview.title')">
        <form class="flex gap-2" @submit.prevent="runRoutePreview">
          <input
            v-model="previewModel"
            type="text"
            class="input font-mono"
            :placeholder="t('dashboard.preview.modelPlaceholder')"
            :aria-label="t('dashboard.preview.modelLabel')"
          />
          <button type="submit" class="btn btn-primary">{{ t("dashboard.preview.run") }}</button>
        </form>

        <div v-if="previewResult" class="mt-4 animate-fade-in overflow-hidden rounded-lg border border-success/30">
          <div class="flex items-center gap-2 bg-success/[0.08] px-3.5 py-2 text-xs font-medium text-success">
            <UiIcon name="check-circle" :size="14" />
            {{ t("dashboard.preview.matched") }}
          </div>
          <dl class="kv grid-cols-1 p-3.5">
            <div>
              <dt>{{ t("dashboard.routes.targetPlatform") }}</dt>
              <dd class="!text-sm">{{ previewResult.targetPlatform }}</dd>
            </div>
            <div>
              <dt>{{ t("dashboard.routes.upstreamModel") }}</dt>
              <dd class="!text-sm">{{ previewResult.upstreamModel }}</dd>
            </div>
            <div>
              <dt>{{ t("dashboard.preview.source") }}</dt>
              <dd>{{ previewResult.resolutionSource }}</dd>
            </div>
          </dl>
        </div>
        <UiAlert v-if="previewError" tone="danger" class="mt-4">{{ previewError }}</UiAlert>
      </UiCard>
    </div>

    <!-- Risk -->
    <UiCard icon="shield-alert" :title="t('dashboard.risk.title')" flush>
      <EmptyState v-if="riskEvents.length === 0" compact icon="shield" :title="t('dashboard.risk.empty')" />
      <ul v-else class="divide-y divide-line/70">
        <li v-for="ev in riskEvents" :key="ev.eventId" class="px-5 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <UiBadge :tone="ev.strikeLevel >= 3 ? 'danger' : 'warning'">
              {{ t("dashboard.risk.strike", { level: ev.strikeLevel, duration: ev.banDuration }) }}
            </UiBadge>
            <span class="text-xs text-fg-muted">{{ ev.subjectKind }}</span>
            <span class="ml-auto font-mono text-2xs text-fg-subtle">{{ formatDateTime(ev.createdAtIso) }}</span>
          </div>
          <p class="mt-1.5 font-mono text-xs text-fg">{{ ev.reason }}</p>
          <p class="mt-1 text-2xs text-fg-subtle">
            {{ t("dashboard.risk.counts", { downgraded: ev.downgradedCount, upstream400: ev.ordinaryUpstream400Count }) }}
          </p>
        </li>
      </ul>
    </UiCard>

    <!-- Global usage -->
    <UiCard icon="activity" :title="t('dashboard.usage.title')" flush>
      <EmptyState v-if="adminUsage.length === 0" compact icon="activity" :title="t('dashboard.usage.empty')" />
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("dashboard.usage.colRequest") }}</th>
              <th>{{ t("dashboard.usage.colModel") }}</th>
              <th>{{ t("dashboard.usage.colAccount") }}</th>
              <th>{{ t("dashboard.usage.colProtocol") }}</th>
              <th class="text-right">{{ t("dashboard.usage.colTokens") }}</th>
              <th class="text-right">{{ t("dashboard.usage.colCost") }}</th>
              <th>{{ t("common.status") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in adminUsage" :key="u.id">
              <td>
                <p class="font-mono text-xs text-fg">{{ shortHash(u.requestId, 18) }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ u.userId }}</p>
              </td>
              <td>
                <p class="text-sm text-fg">{{ u.publicModel }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">→ {{ u.upstreamModel }}</p>
              </td>
              <td>
                <p class="text-xs text-fg-muted">{{ u.platform }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ u.accountId }}</p>
              </td>
              <td class="whitespace-nowrap font-mono text-xs text-fg-muted">{{ u.ingressCodec }} → {{ u.egressCodec }}</td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                {{ formatNumber(u.inputTokens) }} / {{ formatNumber(u.outputTokens) }}
              </td>
              <td class="text-right font-mono text-xs font-medium tabular-nums text-fg">{{ u.formattedCostUsd }}</td>
              <td class="whitespace-nowrap">
                <UiBadge :tone="u.statusCode < 400 ? 'success' : 'danger'" mono>{{ u.statusCode }}</UiBadge>
                <span class="ml-1.5 font-mono text-2xs text-fg-subtle">{{ u.durationMs }}ms</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <!-- System update summary -->
    <UiCard icon="branch" :title="t('dashboard.update.title')">
      <template #actions>
        <UiBadge :tone="systemUpdate.status?.channel === 'dev' ? 'warning' : 'neutral'" dot>
          {{
            systemUpdate.status?.channel === "dev"
              ? t("updates.channels.shortDev")
              : t("dashboard.update.stable")
          }}
        </UiBadge>
        <UiBadge v-if="systemUpdate.needsEdgeRestart" tone="warning" dot>
          {{ t("dashboard.update.edgeRestartNeeded") }}
        </UiBadge>
        <UiBadge v-else-if="systemUpdate.updateAvailable" tone="accent" dot>
          {{ t("dashboard.update.available") }}
        </UiBadge>
        <UiBadge v-else tone="success" dot>
          {{ t("dashboard.update.upToDate") }}
        </UiBadge>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="systemUpdate.isBusy" @click="checkSystemUpdates">
          <UiIcon :name="systemUpdate.checking ? 'loader' : 'refresh'" :size="14" :spin="systemUpdate.checking" />
          {{ t("dashboard.update.check") }}
        </button>
        <RouterLink to="/admin/updates" class="btn btn-primary btn-sm">
          <UiIcon name="download" :size="14" />
          {{ t("dashboard.update.manage") }}
        </RouterLink>
      </template>

      <div class="flex flex-wrap items-center justify-between gap-4 text-xs text-fg-muted">
        <div class="flex flex-wrap items-center gap-x-5 gap-y-2">
          <span class="inline-flex items-center gap-1.5">
            <span class="text-fg-subtle">{{ t("dashboard.update.branchVersion") }}:</span>
            <code class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-fg">
              {{ systemUpdate.status?.version ?? "0.1.0" }}
            </code>
            <span class="font-mono text-2xs text-fg-subtle">
              ({{ shortHash(systemUpdate.status?.activeCommit ?? "dev", 8) }})
            </span>
          </span>

          <span v-if="systemUpdate.updateAvailable && (systemUpdate.status?.remoteVersion || systemUpdate.status?.remoteCommit)" class="font-medium text-accent">
            {{
              t("dashboard.update.remoteHint", {
                version: systemUpdate.status?.remoteVersion ?? shortHash(systemUpdate.status?.remoteCommit, 8),
              })
            }}
          </span>

          <span class="inline-flex items-center gap-1.5">
            <span class="text-fg-subtle">{{ t("dashboard.update.console") }}:</span>
            <span>
              {{ systemUpdate.status?.webUiOverridden ? t("dashboard.update.consoleLive") : t("dashboard.update.consoleBuiltin") }}
            </span>
          </span>
        </div>

        <span class="font-mono text-2xs text-fg-subtle">
          {{ systemUpdate.status?.repo ?? "dreamforSh/Slipgate" }} · {{ systemUpdate.status?.branch ?? "main" }}
        </span>
      </div>

      <UiAlert v-if="systemUpdate.error || systemUpdate.status?.lastError" tone="danger" class="mt-4">
        <span class="font-mono text-xs">{{ systemUpdate.error ?? systemUpdate.status?.lastError }}</span>
      </UiAlert>
    </UiCard>
  </div>
</template>
