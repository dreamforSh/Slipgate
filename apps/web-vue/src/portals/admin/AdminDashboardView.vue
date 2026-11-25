<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type {
  AdminDashboardStats,
  ClashExitNode,
  DashboardGranularity,
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
import ModelDistributionCard from "../../components/admin/dashboard/ModelDistributionCard.vue";
import { nodeStatus, type NodeStatus } from "../../components/admin/clash/nodeFilters";
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
  formatRelative,
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
import UiSelect from "../../components/ui/UiSelect.vue";

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
const trendMetric = ref<"requests" | "tokens" | "cost" | "errors">("requests");
/** Bucket size; hourly is offered for 24h (always) and 7d. */
const granularity = ref<DashboardGranularity>("day");
const tokenTrendAsTable = ref(false);
const userTrendMetric = ref<"tokens" | "cost">("tokens");
const userTrendAsTable = ref(false);
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
  { value: "cost" as const, label: t("dashboard.metric.cost") },
  { value: "errors" as const, label: t("dashboard.metric.errors") },
]);
const granularityOptions = computed(() => [
  { value: "day" as const, label: t("dashboard.granularity.day"), disabled: range.value === "24h" },
  { value: "hour" as const, label: t("dashboard.granularity.hour"), disabled: range.value === "30d" },
]);
const userMetricOptions = computed(() => [
  { value: "tokens" as const, label: t("dashboard.metric.tokens") },
  { value: "cost" as const, label: t("dashboard.metric.cost") },
]);

async function loadStats() {
  statsLoading.value = true;
  try {
    const tz = new Date().getTimezoneOffset();
    const res = await auth.apiFetch(`/api/v1/admin/dashboard/stats?range=${range.value}&granularity=${granularity.value}&tz=${tz}`);
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
  // 24h is hourly only, 30d daily only; 7d keeps the current choice.
  if (next === "24h") granularity.value = "hour";
  else if (next === "30d") granularity.value = "day";
  void loadStats();
}

function setGranularity(next: DashboardGranularity) {
  if ((next === "day" && range.value === "24h") || (next === "hour" && range.value === "30d")) return;
  granularity.value = next;
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
  // Hourly buckets over several days (7d by hour) need the day in the axis label too.
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
  if (trendMetric.value === "errors") {
    return [{ key: "err", label: t("dashboard.metric.errors"), color: "rgb(var(--viz-1))", values: points.map((p) => p.errors) }];
  }
  return [{ key: "req", label: t("dashboard.metric.requests"), color: "rgb(var(--viz-1))", values: points.map((p) => p.requests) }];
});

/** sub2api "Token usage trend": input, output and cache-read tokens (one axis, no hit-rate overlay). */
const tokenTrendSeries = computed<TrendSeries[]>(() => {
  const points = stats.value?.series ?? [];
  return [
    { key: "in", label: t("dashboard.metric.input"), color: "rgb(var(--viz-1))", values: points.map((p) => p.inputTokens) },
    { key: "out", label: t("dashboard.metric.output"), color: "rgb(var(--viz-2))", values: points.map((p) => p.outputTokens) },
    { key: "cache", label: t("dashboard.metric.cacheRead"), color: "rgb(var(--viz-3))", values: points.map((p) => p.cacheReadTokens ?? 0) },
  ];
});
const tokenTrendTotal = computed(() => {
  const p = stats.value?.period;
  return p ? p.inputTokens + p.outputTokens : 0;
});

/** Top users over time (at most 5 lines; slots 1-5 in fixed order). */
const USER_COLORS = ["rgb(var(--viz-1))", "rgb(var(--viz-2))", "rgb(var(--viz-3))", "rgb(var(--viz-4))", "rgb(var(--viz-5))"];
const userTrendSeries = computed<TrendSeries[]>(() =>
  (stats.value?.userSeries ?? []).map((u, i) => ({
    key: u.userId,
    label: u.email,
    color: USER_COLORS[i] ?? "rgb(var(--fg-subtle))",
    values: userTrendMetric.value === "tokens" ? u.tokens : u.costNanoUsd.map((c) => nanoToUsd(c)),
  })),
);

const usdFormat = (usd: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd);
const usdAxis = (usd: number) =>
  usd >= 1000
    ? `$${formatCompact(usd)}`
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: usd < 1 ? 2 : 0 }).format(usd);
const trendFormat = computed(() => (trendMetric.value === "cost" ? usdFormat : (v: number) => formatNumber(v)));
const trendAxisFormat = computed(() => (trendMetric.value === "cost" ? usdAxis : (v: number) => formatCompact(v)));
const userTrendFormat = computed(() => (userTrendMetric.value === "cost" ? usdFormat : (v: number) => formatNumber(v)));
const userTrendAxisFormat = computed(() => (userTrendMetric.value === "cost" ? usdAxis : (v: number) => formatCompact(v)));
const tokenFormat = (v: number) => formatNumber(v);
const tokenAxisFormat = (v: number) => formatCompact(v);

const trendTitle = computed(() =>
  trendMetric.value === "tokens"
    ? t("dashboard.trend.tokens")
    : trendMetric.value === "cost"
      ? t("dashboard.trend.cost")
      : trendMetric.value === "errors"
        ? t("dashboard.trend.errors")
        : t("dashboard.trend.requests"),
);

/* ---------------- Stat cards ---------------- */

const rangeLabel = computed(() => rangeOptions.value.find((o) => o.value === range.value)?.label ?? "");
/** Accounts the scheduler cannot use right now (cooling down or expired). */
const accountsInTrouble = computed(() => (stats.value ? stats.value.accounts.cooldown + stats.value.accounts.expired : 0));
const periodTokens = computed(() => (stats.value ? stats.value.period.inputTokens + stats.value.period.outputTokens : 0));

/** sub2api-style quick actions. */
const quickActions = computed<{ to: string; icon: IconName; title: string; desc: string; tone: string }[]>(() => [
  { to: "/admin/accounts", icon: "layers", title: t("dashboard.quick.accounts"), desc: t("dashboard.quick.accountsDesc"), tone: "icon-chip-accent" },
  { to: "/admin/groups", icon: "route", title: t("dashboard.quick.groups"), desc: t("dashboard.quick.groupsDesc"), tone: "icon-chip-info" },
  { to: "/admin/users", icon: "users", title: t("dashboard.quick.users"), desc: t("dashboard.quick.usersDesc"), tone: "icon-chip-violet" },
  { to: "/admin/redeem", icon: "ticket", title: t("dashboard.quick.redeem"), desc: t("dashboard.quick.redeemDesc"), tone: "icon-chip-success" },
  { to: "/admin/proxy/clash", icon: "globe", title: t("dashboard.quick.proxy"), desc: t("dashboard.quick.proxyDesc"), tone: "icon-chip-warning" },
  { to: "/admin/usage", icon: "activity", title: t("dashboard.quick.usage"), desc: t("dashboard.quick.usageDesc"), tone: "icon-chip-info" },
]);
/** Share of failed requests over the selected range; null without traffic. */
const errorRate = computed(() => {
  const p = stats.value?.period;
  if (!p || p.requests === 0) return null;
  return p.errors / p.requests;
});

/* ---------------- Needs attention ---------------- */

interface AttentionItem {
  key: string;
  label: string;
  count: number;
  tone: "danger" | "warning" | "info";
  icon: IconName;
  to?: string;
  action?: () => void;
}

const ATTENTION_TONE: Record<AttentionItem["tone"], string> = {
  danger: "bg-danger/10 text-danger ring-danger/20 hover:bg-danger/15",
  warning: "bg-warning/10 text-warning ring-warning/20 hover:bg-warning/15",
  info: "bg-info/10 text-info ring-info/20 hover:bg-info/15",
};

function scrollToRisk() {
  document.getElementById("dashboard-risk")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

const attention = computed<AttentionItem[]>(() => {
  const a = stats.value?.accounts;
  const planesDown = planes.value.filter((p) => readiness.value && readiness.value.planes[p.key] !== "up").length;
  const nodeCount = (st: NodeStatus) => clashNodes.value.filter((n) => nodeStatus(n) === st).length;
  const items: AttentionItem[] = [
    { key: "planes", label: t("dashboard.attention.planesDown"), count: planesDown, tone: "danger", icon: "cpu", to: "/admin/ops" },
    { key: "failed", label: t("dashboard.attention.failedTests"), count: a?.failedTests ?? 0, tone: "danger", icon: "x-circle", to: "/admin/accounts?status=failed_test" },
    { key: "drift", label: t("dashboard.attention.drift"), count: nodeCount("drift"), tone: "danger", icon: "alert", to: "/admin/proxy/clash" },
    { key: "unhealthy", label: t("dashboard.attention.unhealthyNodes"), count: nodeCount("unhealthy"), tone: "warning", icon: "globe", to: "/admin/proxy/clash" },
    { key: "cooldown", label: t("dashboard.attention.cooldown"), count: a?.cooldown ?? 0, tone: "warning", icon: "clock", to: "/admin/accounts?status=cooldown" },
    { key: "quota", label: t("dashboard.attention.quota"), count: a?.quotaExceeded ?? 0, tone: "warning", icon: "wallet", to: "/admin/accounts?status=quota_exceeded" },
    { key: "expiring", label: t("dashboard.attention.expiring"), count: (a?.expiringSoon ?? 0) + (a?.expired ?? 0), tone: "warning", icon: "calendar", to: "/admin/accounts?status=expiring" },
    { key: "risk", label: t("dashboard.attention.risk"), count: riskEvents.value.length, tone: "warning", icon: "shield-alert", action: scrollToRisk },
    { key: "update", label: t("dashboard.attention.update"), count: systemUpdate.updateAvailable ? 1 : 0, tone: "info", icon: "download", to: "/admin/updates" },
  ];
  return items.filter((i) => i.count > 0);
});

/* ---------------- Exit node summary ---------------- */

const nodeSegments = computed(() => {
  const counts = { healthy: 0, degraded: 0, problem: 0, unprobed: 0, disabled: 0 };
  for (const n of clashNodes.value) {
    const st = nodeStatus(n);
    if (st === "healthy") counts.healthy++;
    else if (st === "degraded") counts.degraded++;
    else if (st === "unhealthy" || st === "drift") counts.problem++;
    else if (st === "unprobed") counts.unprobed++;
    else counts.disabled++;
  }
  return [
    { key: "healthy", label: t("dashboard.nodes.healthy"), value: counts.healthy, color: "rgb(var(--success))" },
    { key: "degraded", label: t("dashboard.nodes.degraded"), value: counts.degraded, color: "rgb(var(--warning))" },
    { key: "problem", label: t("dashboard.nodes.problem"), value: counts.problem, color: "rgb(var(--danger))" },
    { key: "unprobed", label: t("dashboard.nodes.unprobed"), value: counts.unprobed, color: "rgb(var(--fg-subtle))" },
    { key: "disabled", label: t("dashboard.nodes.disabled"), value: counts.disabled, color: "rgb(var(--border-strong))" },
  ].filter((s) => s.value > 0);
});
const NODE_RANK: Record<NodeStatus, number> = { drift: 0, unhealthy: 1, degraded: 2, unprobed: 3, healthy: 4, disabled: 5 };
/** Nodes that need a look first, then the rest by latency. */
const nodesToWatch = computed(() =>
  [...clashNodes.value]
    .sort((a, b) => NODE_RANK[nodeStatus(a)] - NODE_RANK[nodeStatus(b)] || (a.latencyMs || 1e9) - (b.latencyMs || 1e9))
    .slice(0, 5),
);

function breakdownMeta(row: { requests: number; tokens: number; costNanoUsd: string }) {
  return t("dashboard.breakdown.meta", {
    requests: formatCompact(row.requests),
    tokens: formatCompact(row.tokens),
    cost: formatUsd(row.costNanoUsd),
  });
}

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
        <button type="button" class="btn btn-secondary" :disabled="loading || statsLoading" @click="refreshAll">
          <UiIcon name="refresh" :size="15" :spin="loading || statsLoading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </PageHeader>

    <UiAlert v-if="statsError && !stats" tone="warning">{{ t("dashboard.loadFailed") }}</UiAlert>

    <!-- Needs attention -->
    <section class="card flex flex-wrap items-center gap-2 px-4 py-3" :aria-label="t('dashboard.attention.title')">
      <span class="mr-1 inline-flex items-center gap-1.5 text-xs font-semibold text-fg">
        <UiIcon
          :name="attention.length ? 'alert' : 'check-circle'"
          :size="14"
          :class="attention.length ? 'text-warning' : 'text-success'"
        />
        {{ attention.length ? t("dashboard.attention.title") : t("dashboard.attention.allClear") }}
      </span>
      <template v-for="item in attention" :key="item.key">
        <RouterLink
          v-if="item.to"
          :to="item.to"
          class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors"
          :class="ATTENTION_TONE[item.tone]"
        >
          <UiIcon :name="item.icon" :size="12" />
          {{ item.label }}
          <span class="font-semibold tabular-nums">{{ item.count }}</span>
        </RouterLink>
        <button
          v-else
          type="button"
          class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors"
          :class="ATTENTION_TONE[item.tone]"
          @click="item.action?.()"
        >
          <UiIcon :name="item.icon" :size="12" />
          {{ item.label }}
          <span class="font-semibold tabular-nums">{{ item.count }}</span>
        </button>
      </template>
      <span v-if="!attention.length" class="text-xs text-fg-subtle">{{ t("dashboard.attention.allClearHint") }}</span>
    </section>

    <!-- Stat cards, two rows of four (sub2api layout) -->
    <div class="space-y-3 sm:space-y-4">
      <div class="grid grid-cols-2 gap-3 transition-opacity sm:gap-4 xl:grid-cols-4" :class="statsLoading && stats ? 'opacity-70' : ''">
        <StatCard :label="t('dashboard.kpi.apiKeys')" :value="formatCompact(stats?.apiKeys.total ?? 0)" icon="key" tone="info">
          <template #hint>
            <span class="text-success">{{ t("dashboard.cards.enabled", { n: stats?.apiKeys.enabled ?? 0 }) }}</span>
          </template>
        </StatCard>
        <StatCard :label="t('dashboard.cards.accounts')" :value="formatCompact(stats?.accounts.total ?? 0)" icon="server" tone="violet">
          <template #hint>
            <RouterLink to="/admin/accounts" class="hover:text-fg">
              <span class="text-success">{{ t("dashboard.cards.normal", { n: stats?.accounts.active ?? 0 }) }}</span>
              <span v-if="accountsInTrouble > 0" class="ml-1.5 text-danger">{{ t("dashboard.cards.abnormal", { n: accountsInTrouble }) }}</span>
            </RouterLink>
          </template>
          <template #footer>
            <div
              v-if="healthSegments.length"
              class="mt-auto flex h-1.5 w-full gap-0.5 overflow-hidden rounded-full pt-0"
              role="img"
              :aria-label="healthSegments.map((seg) => `${seg.label} ${seg.value}`).join(', ')"
            >
              <span
                v-for="seg in healthSegments"
                :key="seg.key"
                class="h-full first:rounded-l-full last:rounded-r-full"
                :style="{ flexGrow: seg.value, background: seg.color }"
                :title="`${seg.label} ${seg.value}`"
              />
            </div>
          </template>
        </StatCard>
        <StatCard
          :label="t('dashboard.kpi.todayRequests')"
          :value="formatCompact(stats?.today.requests ?? 0)"
          icon="chart"
          tone="success"
          :delta="stats ? change(stats.today.requests, stats.yesterday.requests) : null"
          :delta-label="t('dashboard.kpi.vsYesterday')"
          :hint="t('dashboard.cards.periodTotal', { range: rangeLabel, n: formatCompact(stats?.period.requests ?? 0) })"
        />
        <StatCard :label="t('dashboard.cards.users')" :value="`+${stats?.users.newToday ?? 0}`" icon="user-plus" tone="success">
          <template #hint>
            {{ t("dashboard.cards.usersHint", { total: formatCompact(stats?.users.total ?? 0), active: stats?.users.activeToday ?? 0 }) }}
          </template>
        </StatCard>
      </div>
      <div class="grid grid-cols-2 gap-3 transition-opacity sm:gap-4 xl:grid-cols-4" :class="statsLoading && stats ? 'opacity-70' : ''">
        <StatCard
          :label="t('dashboard.kpi.todayTokens')"
          :value="formatCompact(todayTokens)"
          icon="box"
          tone="warning"
          :delta="stats ? change(todayTokens, stats.yesterday.inputTokens + stats.yesterday.outputTokens) : null"
          :delta-label="t('dashboard.kpi.vsYesterday')"
          :hint="t('dashboard.cards.costAndCache', { cost: formatUsd(stats?.today.costNanoUsd ?? '0'), cache: formatCompact(stats?.today.cacheReadTokens ?? 0) })"
        />
        <StatCard
          :label="t('dashboard.cards.periodTokens', { range: rangeLabel })"
          :value="formatCompact(periodTokens)"
          icon="database"
          tone="accent"
          :hint="t('dashboard.cards.periodCost', { cost: formatUsd(stats?.period.costNanoUsd ?? '0') })"
        />
        <StatCard :label="t('dashboard.cards.performance')" :value="`${formatCompact(stats?.throughput.rpm ?? 0)} RPM`" icon="zap" tone="violet">
          <template #hint>
            <span class="font-medium text-violet">{{ formatCompact(stats?.throughput.tpm ?? 0) }}</span> TPM
          </template>
        </StatCard>
        <StatCard
          :label="t('dashboard.cards.avgResponse')"
          :value="stats?.today.avgDurationMs ? formatDurationMs(stats.today.avgDurationMs) : '—'"
          icon="clock"
          tone="danger"
        >
          <template #hint>
            {{
              stats?.today.avgTtftMs
                ? t("dashboard.cards.responseHint", {
                    ttft: formatDurationMs(stats.today.avgTtftMs),
                    rate: errorRate === null ? "—" : `${(errorRate * 100).toFixed(1)}%`,
                  })
                : t("dashboard.kpi.noRequestsToday")
            }}
          </template>
        </StatCard>
      </div>
    </div>

    <!-- Quick actions -->
    <UiCard icon="zap" :title="t('dashboard.quick.title')">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <RouterLink
          v-for="a in quickActions"
          :key="a.to"
          :to="a.to"
          class="group flex min-w-0 items-center gap-3 rounded-xl border border-line/70 px-3 py-2.5 transition-colors hover:border-accent/40 hover:bg-accent/[0.04]"
        >
          <span class="icon-chip h-9 w-9 shrink-0 rounded-lg" :class="a.tone"><UiIcon :name="a.icon" :size="16" /></span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium text-fg">{{ a.title }}</span>
            <span class="block truncate text-2xs text-fg-subtle">{{ a.desc }}</span>
          </span>
          <UiIcon name="chevron-right" :size="14" class="shrink-0 text-fg-subtle transition-transform group-hover:translate-x-0.5" />
        </RouterLink>
      </div>
    </UiCard>

    <!-- Range + granularity for every chart below -->
    <section class="card flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3" :aria-label="t('dashboard.filters.title')">
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-fg-muted">{{ t("dashboard.filters.range") }}</span>
        <SegmentedControl :model-value="range" :options="rangeOptions" @update:model-value="setRange" />
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-fg-muted">{{ t("dashboard.filters.granularity") }}</span>
        <SegmentedControl :model-value="granularity" :options="granularityOptions" @update:model-value="setGranularity" />
      </div>
      <span v-if="stats?.truncated" class="text-2xs text-warning">{{ t("dashboard.filters.truncated") }}</span>
      <span class="ml-auto text-2xs text-fg-subtle">{{ t("dashboard.filters.hint") }}</span>
    </section>

    <!-- Model distribution / spending ranking + token usage trend -->
    <div class="grid gap-6 xl:grid-cols-2" :class="statsLoading && stats ? 'opacity-70 transition-opacity' : 'transition-opacity'">
      <ModelDistributionCard :stats="stats" />

      <UiCard icon="braces" :title="t('dashboard.tokenTrend.title')">
        <template #actions>
          <span class="hidden text-2xs text-fg-subtle sm:inline">{{ t("dashboard.tokenTrend.total", { n: formatCompact(tokenTrendTotal) }) }}</span>
          <button
            type="button"
            class="btn btn-ghost btn-icon btn-sm"
            :aria-pressed="tokenTrendAsTable"
            :title="tokenTrendAsTable ? t('dashboard.trend.showChart') : t('dashboard.trend.showTable')"
            :aria-label="tokenTrendAsTable ? t('dashboard.trend.showChart') : t('dashboard.trend.showTable')"
            @click="tokenTrendAsTable = !tokenTrendAsTable"
          >
            <UiIcon :name="tokenTrendAsTable ? 'activity' : 'list'" :size="15" />
          </button>
        </template>
        <EmptyState v-if="stats && stats.period.requests === 0" compact icon="braces" :title="t('dashboard.trend.empty')" />
        <div v-else-if="tokenTrendAsTable" class="table-wrap max-h-72 overflow-y-auto">
          <table class="data-table">
            <thead class="sticky top-0 z-10">
              <tr>
                <th>{{ t("dashboard.trend.time") }}</th>
                <th v-for="sr in tokenTrendSeries" :key="sr.key" class="text-right">{{ sr.label }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(label, i) in trendLabels.full" :key="label">
                <td class="whitespace-nowrap text-xs text-fg-muted">{{ label }}</td>
                <td v-for="sr in tokenTrendSeries" :key="sr.key" class="text-right font-mono text-xs tabular-nums">{{ tokenFormat(sr.values[i] ?? 0) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <TrendChart
          v-else
          :labels="trendLabels.short"
          :titles="trendLabels.full"
          :series="tokenTrendSeries"
          :format="tokenFormat"
          :axis-format="tokenAxisFormat"
          :chart-label="t('dashboard.tokenTrend.title')"
        />
      </UiCard>
    </div>

    <!-- Top users over time (full width) -->
    <UiCard icon="users" :title="t('dashboard.userTrend.title', { n: userTrendSeries.length || 5 })">
      <template #actions>
        <SegmentedControl v-model="userTrendMetric" :options="userMetricOptions" />
        <button
          type="button"
          class="btn btn-ghost btn-icon btn-sm"
          :aria-pressed="userTrendAsTable"
          :title="userTrendAsTable ? t('dashboard.trend.showChart') : t('dashboard.trend.showTable')"
          :aria-label="userTrendAsTable ? t('dashboard.trend.showChart') : t('dashboard.trend.showTable')"
          @click="userTrendAsTable = !userTrendAsTable"
        >
          <UiIcon :name="userTrendAsTable ? 'activity' : 'list'" :size="15" />
        </button>
      </template>
      <EmptyState v-if="!userTrendSeries.length" compact icon="users" :title="t('dashboard.breakdown.empty')" />
      <div v-else-if="userTrendAsTable" class="table-wrap max-h-72 overflow-y-auto">
        <table class="data-table">
          <thead class="sticky top-0 z-10">
            <tr>
              <th>{{ t("dashboard.trend.time") }}</th>
              <th v-for="sr in userTrendSeries" :key="sr.key" class="max-w-[10rem] truncate text-right" :title="sr.label">{{ sr.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(label, i) in trendLabels.full" :key="label">
              <td class="whitespace-nowrap text-xs text-fg-muted">{{ label }}</td>
              <td v-for="sr in userTrendSeries" :key="sr.key" class="text-right font-mono text-xs tabular-nums">{{ userTrendFormat(sr.values[i] ?? 0) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <TrendChart
        v-else
        :labels="trendLabels.short"
        :titles="trendLabels.full"
        :series="userTrendSeries"
        :format="userTrendFormat"
        :axis-format="userTrendAxisFormat"
        :chart-label="t('dashboard.userTrend.title', { n: userTrendSeries.length })"
      />
    </UiCard>

    <!-- Requests / spend / errors over time + group usage -->
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
        <EmptyState v-if="stats && stats.period.requests === 0" compact icon="activity" :title="t('dashboard.trend.empty')" />
        <div v-else-if="trendAsTable" class="table-wrap max-h-72 overflow-y-auto">
          <table class="data-table">
            <thead class="sticky top-0 z-10">
              <tr>
                <th>{{ t("dashboard.trend.time") }}</th>
                <th v-for="sr in trendSeries" :key="sr.key" class="text-right">{{ sr.label }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(label, i) in trendLabels.full" :key="label">
                <td class="whitespace-nowrap text-xs text-fg-muted">{{ label }}</td>
                <td v-for="sr in trendSeries" :key="sr.key" class="text-right font-mono text-xs tabular-nums">{{ trendFormat(sr.values[i] ?? 0) }}</td>
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

    <!-- System & resources -->
    <h2 class="pt-2 text-sm font-semibold text-fg">{{ t("dashboard.sections.system") }}</h2>
    <div class="grid gap-6 lg:grid-cols-2 xl:grid-cols-3">
      <!-- Runtime: service planes + version / updates -->
      <UiCard icon="cpu" :title="t('dashboard.runtime.title')" flush>
        <template #actions>
          <RouterLink to="/admin/ops" class="btn btn-ghost btn-sm">
            {{ t("dashboard.runtime.ops") }}
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <ul class="divide-y divide-line/70">
          <li v-for="p in planes" :key="p.key" class="flex items-center gap-3 px-5 py-2.5">
            <span class="icon-chip h-8 w-8 rounded-lg" :class="readiness?.planes[p.key] === 'up' ? 'icon-chip-accent' : ''">
              <UiIcon :name="p.icon" :size="15" />
            </span>
            <span class="min-w-0 flex-1 truncate text-sm font-medium text-fg">{{ p.label }}</span>
            <UiBadge :tone="healthTone(readiness?.planes[p.key] ?? 'unknown')" dot :pulse="readiness?.planes[p.key] === 'up'">
              {{ planeLabel(readiness?.planes[p.key] ?? "unknown") }}
            </UiBadge>
          </li>
        </ul>
        <div class="mt-auto space-y-3 border-t border-line/70 px-5 py-4">
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span class="text-fg-subtle">{{ t("dashboard.update.branchVersion") }}</span>
            <code class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-fg">{{ systemUpdate.status?.version ?? "0.1.0" }}</code>
            <span class="font-mono text-2xs text-fg-subtle">{{ shortHash(systemUpdate.status?.activeCommit ?? "dev", 8) }}</span>
            <span class="ml-auto">
              <UiBadge v-if="systemUpdate.restartActive" tone="info" dot pulse>{{ t("dashboard.update.restarting") }}</UiBadge>
              <UiBadge v-else-if="systemUpdate.needsEdgeRestart" tone="warning" dot>{{ t("dashboard.update.edgeRestartNeeded") }}</UiBadge>
              <UiBadge v-else-if="systemUpdate.updateAvailable" tone="accent" dot>{{ t("dashboard.update.available") }}</UiBadge>
              <UiBadge v-else tone="success" dot>{{ t("dashboard.update.upToDate") }}</UiBadge>
            </span>
          </div>
          <p
            v-if="systemUpdate.updateAvailable && (systemUpdate.status?.remoteVersion || systemUpdate.status?.remoteCommit)"
            class="text-2xs font-medium text-accent"
          >
            {{ t("dashboard.update.remoteHint", { version: systemUpdate.status?.remoteVersion ?? shortHash(systemUpdate.status?.remoteCommit, 8) }) }}
          </p>
          <p class="truncate text-2xs text-fg-subtle">
            <UiBadge :tone="systemUpdate.status?.channel === 'dev' ? 'warning' : 'neutral'" class="mr-1.5">
              {{ systemUpdate.status?.channel === "dev" ? t("updates.channels.shortDev") : t("dashboard.update.stable") }}
            </UiBadge>
            {{ t("dashboard.update.console") }}:
            {{ systemUpdate.status?.webUiOverridden ? t("dashboard.update.consoleLive") : t("dashboard.update.consoleBuiltin") }}
          </p>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="systemUpdate.isBusy" @click="checkSystemUpdates">
              <UiIcon :name="systemUpdate.checking ? 'loader' : 'refresh'" :size="14" :spin="systemUpdate.checking" />
              {{ t("dashboard.update.check") }}
            </button>
            <RouterLink to="/admin/updates" class="btn btn-ghost btn-sm">
              <UiIcon name="download" :size="14" />
              {{ t("dashboard.update.manage") }}
            </RouterLink>
          </div>
          <UiAlert v-if="systemUpdate.error || systemUpdate.status?.lastError" tone="danger">
            <span class="font-mono text-xs">{{ systemUpdate.error ?? systemUpdate.status?.lastError }}</span>
          </UiAlert>
        </div>
      </UiCard>

      <!-- Exit nodes: health split + the ones to look at first -->
      <UiCard icon="globe" :title="t('dashboard.nodes.title')" flush>
        <template #actions>
          <RouterLink to="/admin/proxy/clash" class="btn btn-ghost btn-sm">
            {{ t("dashboard.clash.manage") }}
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="clashNodes.length === 0" compact icon="globe" :title="t('dashboard.clash.empty')" />
        <template v-else>
          <div class="space-y-2 px-5 pb-3 pt-4">
            <div class="flex items-baseline justify-between gap-2">
              <p class="text-2xl font-semibold tabular-nums text-fg">
                {{ healthyNodes }}<span class="text-sm font-medium text-fg-subtle"> / {{ clashNodes.length }}</span>
              </p>
              <span class="text-2xs text-fg-subtle">{{ t("dashboard.stats.listeners", { count: clashRuntime?.activeListeners ?? clashNodes.length }) }}</span>
            </div>
            <div
              class="flex h-2 w-full gap-0.5 overflow-hidden rounded-full"
              role="img"
              :aria-label="nodeSegments.map((seg) => `${seg.label} ${seg.value}`).join(', ')"
            >
              <span
                v-for="seg in nodeSegments"
                :key="seg.key"
                class="h-full first:rounded-l-full last:rounded-r-full"
                :style="{ flexGrow: seg.value, background: seg.color }"
                :title="`${seg.label} ${seg.value}`"
              />
            </div>
            <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-fg-muted">
              <span v-for="seg in nodeSegments" :key="seg.key" class="inline-flex items-center gap-1">
                <span class="inline-block h-2 w-2 rounded-full" :style="{ background: seg.color }" />
                {{ seg.label }} {{ seg.value }}
              </span>
            </div>
          </div>
          <ul class="divide-y divide-line/70 border-t border-line/70">
            <li v-for="node in nodesToWatch" :key="node.nodeId" class="flex items-center gap-3 px-5 py-2.5">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-fg">{{ node.name }}</p>
                <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">
                  {{ node.exitIp || t("dashboard.clash.notProbed") }}<template v-if="node.latencyMs > 0"> · {{ node.latencyMs }}ms</template>
                </p>
              </div>
              <span class="font-mono text-2xs tabular-nums text-fg-subtle" :title="t('dashboard.nodes.occupancy')">{{ node.boundAccounts }}/{{ node.maxAccounts }}</span>
              <UiBadge :tone="healthTone(node.healthStatus)" dot>
                {{ node.driftUnconfirmed ? t("dashboard.nodes.driftShort") : node.enabled === false ? t("dashboard.nodes.disabled") : healthLabel(node.healthStatus) }}
              </UiBadge>
            </li>
          </ul>
        </template>
      </UiCard>

      <!-- VM slots -->
      <UiCard icon="server" :title="t('nav.vms')" flush class="lg:col-span-2 xl:col-span-1">
        <template #actions>
          <RouterLink to="/admin/vms" class="btn btn-ghost btn-sm">
            {{ t("dashboard.clash.manage") }}
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="vmSlots.length === 0" compact icon="server" :title="t('dashboard.vms.empty')" />
        <template v-else>
          <div class="flex items-baseline justify-between gap-2 px-5 pb-3 pt-4">
            <p class="text-2xl font-semibold tabular-nums text-fg">
              {{ readySlots }}<span class="text-sm font-medium text-fg-subtle"> / {{ vmSlots.length }}</span>
            </p>
            <span class="text-2xs text-fg-subtle">{{ t("dashboard.stats.concurrency", { active: activeSubagents, max: maxSubagents }) }}</span>
          </div>
          <ul class="divide-y divide-line/70 border-t border-line/70">
            <li
              v-for="slot in vmSlots.slice(0, 5)"
              :key="slot.slotId"
              class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-2.5 sm:grid-cols-[minmax(0,1fr)_6rem_auto]"
            >
              <div class="min-w-0">
                <p class="flex items-center gap-1.5 truncate font-mono text-xs font-medium text-fg">
                  {{ slot.slotId }}
                  <UiBadge :tone="RUNTIME_PROFILE_TONE[slot.runtimeProfile] ?? 'neutral'">{{ slot.runtimeProfile }}</UiBadge>
                </p>
                <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{{ slot.hypervisorKind }} · {{ slot.exitIp }}</p>
              </div>
              <UsageMeter class="hidden sm:block" label="5h" :bps="slot.window5hUsedBps" />
              <UiBadge :tone="healthTone(slot.state)" dot>{{ slotStateLabel(slot.state) }}</UiBadge>
            </li>
          </ul>
        </template>
      </UiCard>
    </div>

    <!-- Recent requests + risk -->
    <div class="grid gap-6 xl:grid-cols-3">
      <UiCard class="xl:col-span-2" icon="activity" :title="t('dashboard.usage.title')" flush>
        <template #actions>
          <RouterLink to="/admin/usage" class="btn btn-ghost btn-sm">
            {{ t("dashboard.usage.viewAll") }}
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="adminUsage.length === 0" compact icon="activity" :title="t('dashboard.usage.empty')" />
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("dashboard.usage.colModel") }}</th>
                <th>{{ t("dashboard.usage.colAccount") }}</th>
                <th class="text-right">{{ t("dashboard.usage.colTokens") }}</th>
                <th class="text-right">{{ t("dashboard.usage.colCost") }}</th>
                <th>{{ t("common.status") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="u in adminUsage.slice(0, 8)" :key="u.id">
                <td class="max-w-[16rem]">
                  <p class="truncate text-sm text-fg" :title="`${u.publicModel} → ${u.upstreamModel}`">{{ u.publicModel }}</p>
                  <p class="mt-0.5 truncate text-2xs text-fg-subtle" :title="`${u.requestId}
${u.ingressCodec} → ${u.egressCodec}`">
                    {{ formatRelative(u.createdAtIso) }}
                  </p>
                </td>
                <td class="max-w-[10rem]">
                  <p class="truncate text-xs text-fg-muted">{{ u.platform }}</p>
                  <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle" :title="u.accountId">{{ shortHash(u.accountId, 14) }}</p>
                </td>
                <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                  {{ formatCompact(u.inputTokens) }} / {{ formatCompact(u.outputTokens) }}
                </td>
                <td class="text-right font-mono text-xs font-medium tabular-nums text-fg">{{ u.formattedCostUsd }}</td>
                <td class="whitespace-nowrap">
                  <UiBadge :tone="u.statusCode < 400 ? 'success' : 'danger'" mono>{{ u.statusCode }}</UiBadge>
                  <span class="ml-1.5 font-mono text-2xs text-fg-subtle">{{ formatDurationMs(u.durationMs) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <UiCard id="dashboard-risk" class="scroll-mt-4" icon="shield-alert" :title="t('dashboard.risk.title')" flush>
        <template #actions>
          <UiBadge v-if="riskEvents.length" tone="warning">{{ riskEvents.length }}</UiBadge>
        </template>
        <EmptyState v-if="riskEvents.length === 0" compact icon="shield" :title="t('dashboard.risk.empty')" />
        <ul v-else class="max-h-96 divide-y divide-line/70 overflow-y-auto">
          <li v-for="ev in riskEvents" :key="ev.eventId" class="px-5 py-3">
            <div class="flex flex-wrap items-center gap-2">
              <UiBadge :tone="ev.strikeLevel >= 3 ? 'danger' : 'warning'">
                {{ t("dashboard.risk.strike", { level: ev.strikeLevel, duration: ev.banDuration }) }}
              </UiBadge>
              <span class="text-xs text-fg-muted">{{ ev.subjectKind }}</span>
              <span class="ml-auto font-mono text-2xs text-fg-subtle" :title="formatDateTime(ev.createdAtIso)">{{ formatRelative(ev.createdAtIso) }}</span>
            </div>
            <p class="mt-1.5 break-words font-mono text-xs text-fg">{{ ev.reason }}</p>
            <p class="mt-1 text-2xs text-fg-subtle">
              {{ t("dashboard.risk.counts", { downgraded: ev.downgradedCount, upstream400: ev.ordinaryUpstream400Count }) }}
            </p>
          </li>
        </ul>
      </UiCard>
    </div>

    <!-- Routing rules -->
    <h2 class="pt-2 text-sm font-semibold text-fg">{{ t("dashboard.sections.routing") }}</h2>
    <!-- Routing -->
    <div class="grid gap-6 xl:grid-cols-3">
      <UiCard class="xl:col-span-2" icon="route" :title="t('dashboard.routes.title')" flush>
        <template #actions>
          <span class="hidden text-2xs text-fg-subtle sm:inline">{{ t("dashboard.routes.count", { routes: routes.length, groups: groups.length }) }}</span>
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
            <UiSelect v-model="routeGroupId" class="select">
              <option v-if="groups.length === 0" value="grp_default">grp_default</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }} ({{ g.id }})</option>
            </UiSelect>
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
            <UiSelect v-model="routeMatchType" class="select">
              <option value="exact">{{ t("dashboard.routes.matchExact") }}</option>
              <option value="prefix">{{ t("dashboard.routes.matchPrefix") }}</option>
            </UiSelect>
          </label>
          <label class="block">
            <span class="label">{{ t("dashboard.routes.targetPlatform") }}</span>
            <UiSelect v-model="routeTargetPlatform" class="select">
              <option v-for="p in PROVIDER_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </UiSelect>
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
  </div>
</template>
