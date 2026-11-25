<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import type { OpsOverview, OpsRange } from "@slipgate/contracts";
import OpsAccountsTable from "../../components/admin/ops-monitor/OpsAccountsTable.vue";
import OpsDeadLettersCard from "../../components/admin/ops-monitor/OpsDeadLettersCard.vue";
import OpsErrorCenterPanel from "../../components/admin/ops-monitor/OpsErrorCenterPanel.vue";
import OpsAlertsPanel from "../../components/admin/ops-monitor/OpsAlertsPanel.vue";
import OpsRollupsPanel from "../../components/admin/ops-monitor/OpsRollupsPanel.vue";
import OpsFleetCard from "../../components/admin/ops-monitor/OpsFleetCard.vue";
import OpsModelsTable from "../../components/admin/ops-monitor/OpsModelsTable.vue";
import OpsRecentErrors from "../../components/admin/ops-monitor/OpsRecentErrors.vue";
import OpsStatusCodes from "../../components/admin/ops-monitor/OpsStatusCodes.vue";
import OpsTrendCharts from "../../components/admin/ops-monitor/OpsTrendCharts.vue";
import { errorRateTone, formatRate, staggerStyle } from "../../components/admin/ops-monitor/opsFormat";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { useNow } from "../../composables/useNow";
import { usePersistentState } from "../../composables/usePersistentState";
import { apiJson, errorText } from "../../lib/api";
import { formatCompact, formatDurationMs, formatNumber, formatTokens, formatUsd, type Tone } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

const { t, locale } = useI18n();
const route = useRoute();
const router = useRouter();
const toast = useToastStore();
const now = useNow(15_000);

type OpsTab = "overview" | "errors" | "alerts" | "rollups";
const initialTab: OpsTab =
  route.query.tab === "errors"
    ? "errors"
    : route.query.tab === "alerts"
      ? "alerts"
      : route.query.tab === "rollups"
        ? "rollups"
        : "overview";
const tab = ref<OpsTab>(initialTab);
const errorsVisited = ref(tab.value === "errors");
const alertsVisited = ref(tab.value === "alerts");
const rollupsVisited = ref(tab.value === "rollups");
const openErrorCount = ref(0);
const firingAlertCount = ref(0);
const errorRefreshToken = ref(0);

const tabs = computed(() => [
  { key: "overview" as OpsTab, label: t("security.ops.tabs.overview"), icon: "activity" as const },
  {
    key: "errors" as OpsTab,
    label: t("security.ops.tabs.errors"),
    icon: "alert" as const,
    ...(openErrorCount.value > 0 ? { count: openErrorCount.value } : {}),
  },
  {
    key: "alerts" as OpsTab,
    label: t("security.ops.tabs.alerts"),
    icon: "bell" as const,
    ...(firingAlertCount.value > 0 ? { count: firingAlertCount.value } : {}),
  },
  {
    key: "rollups" as OpsTab,
    label: t("security.ops.tabs.rollups"),
    icon: "database" as const,
  },
]);

watch(tab, (value) => {
  if (value === "errors") errorsVisited.value = true;
  if (value === "alerts") alertsVisited.value = true;
  if (value === "rollups") rollupsVisited.value = true;
  const query = { ...route.query };
  if (value === "overview") delete query.tab;
  else query.tab = value;
  void router.replace({ query });
});

const REFRESH_MS = 30_000;
const RANGES: OpsRange[] = ["1h", "6h", "24h"];

const range = usePersistentState<OpsRange>("slipgate.ops.range", "1h", (v): v is OpsRange =>
  RANGES.includes(v as OpsRange),
);
const rangeOptions = computed(() => RANGES.map((value) => ({ value, label: t(`security.ops.ranges.${value}`) })));

const overview = ref<OpsOverview | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const deadLetters = ref<{ count: number; mode?: string }>({ count: 0 });
const deadLettersLoading = ref(false);
const deadLettersReplaying = ref(false);
const deadLettersError = ref<string | null>(null);
const lastLoadedAt = ref(0);
const autoRefresh = ref(true);
const pageVisible = ref(document.visibilityState !== "hidden");

let deadLetterSeq = 0;
async function loadDeadLetters() {
  const id = ++deadLetterSeq;
  deadLettersLoading.value = true;
  try {
    const res = await apiJson<{ count: number; mode?: string }>("/api/v1/admin/ops/settlement-dead-letters", {
      fallbackError: t("security.ops.deadLetters.loadFailed"),
    });
    if (id !== deadLetterSeq) return;
    deadLetters.value = { count: Math.max(0, res.count ?? 0), mode: res.mode };
    deadLettersError.value = null;
  } catch (err) {
    if (id === deadLetterSeq) deadLettersError.value = errorText(err, t("security.ops.deadLetters.loadFailed"));
  } finally {
    if (id === deadLetterSeq) deadLettersLoading.value = false;
  }
}

async function replayDeadLetters() {
  if (deadLettersReplaying.value) return;
  deadLettersReplaying.value = true;
  try {
    const res = await apiJson<{ replayed: number }>("/api/v1/admin/ops/settlement-dead-letters/replay", {
      method: "POST",
      fallbackError: t("security.ops.deadLetters.replayFailed"),
    });
    toast.success(t("security.ops.deadLetters.replayedToast", { n: formatNumber(res.replayed) }));
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.ops.deadLetters.replayFailed")));
  } finally {
    deadLettersReplaying.value = false;
  }
}

let seq = 0;
async function load() {
  const id = ++seq;
  loading.value = true;
  const [overviewRes] = await Promise.allSettled([
    apiJson<OpsOverview>(`/api/v1/admin/ops/overview?range=${range.value}`, {
      fallbackError: t("security.ops.errors.load"),
    }),
    loadDeadLetters(),
  ]);
  if (id !== seq) return;
  if (overviewRes.status === "fulfilled") {
    overview.value = overviewRes.value;
    error.value = null;
    lastLoadedAt.value = Date.now();
  } else {
    // Keep the last good snapshot on screen; the banner says it is stale.
    error.value = errorText(overviewRes.reason, t("security.ops.errors.load"));
  }
  loading.value = false;
}

watch(range, () => void load());

let timer: number | undefined;
function onVisibility() {
  pageVisible.value = document.visibilityState !== "hidden";
  // Coming back after a while: catch up right away instead of waiting for the next tick.
  if (pageVisible.value && autoRefresh.value && Date.now() - lastLoadedAt.value > REFRESH_MS) void load();
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => {
    if (autoRefresh.value && pageVisible.value && !loading.value) void load();
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", onVisibility);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});

/** live: polling and healthy · stale: polling but the last call failed · paused: polling off or tab hidden. */
const liveState = computed<"live" | "stale" | "paused">(() => {
  if (!autoRefresh.value || !pageVisible.value) return "paused";
  return error.value ? "stale" : "live";
});
const liveClass = computed(
  () =>
    ({
      live: "bg-success/10 text-success ring-success/20 hover:bg-success/15",
      stale: "bg-warning/10 text-warning ring-warning/25 hover:bg-warning/15",
      paused: "bg-surface-2 text-fg-subtle ring-line hover:text-fg",
    })[liveState.value],
);
const liveDot = computed(() => ({ live: "bg-success", stale: "bg-warning", paused: "bg-fg-subtle" })[liveState.value]);
/** Server detail under the banner title, unless it is just the same fallback text. */
const errorDetail = computed(() => (error.value && error.value !== t("security.ops.errors.load") ? error.value : null));
const updatedAt = computed(() =>
  overview.value
    ? new Date(overview.value.generatedAtIso).toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "",
);

/* ---------------- Stat cards ---------------- */

interface Stat {
  key: string;
  label: string;
  value: string;
  hint: string;
  icon: IconName;
  tone: Tone;
}

const stats = computed<Stat[]>(() => {
  const o = overview.value;
  if (!o) return [];
  const s = o.totals;
  const lb = o.truncated ? "≥ " : "";
  return [
    {
      key: "requests",
      label: t("security.ops.stats.requests"),
      value: `${lb}${formatCompact(s.requests)}`,
      hint: t("security.ops.stats.errorsHint", { n: formatNumber(s.errors) }),
      icon: "activity",
      tone: "accent",
    },
    {
      key: "errorRate",
      label: t("security.ops.stats.errorRate"),
      value: formatRate(s.errorRate),
      hint: t("security.ops.stats.errorRateHint"),
      icon: "alert",
      tone: errorRateTone(s.errorRate, s.requests),
    },
    {
      key: "rpm",
      label: t("security.ops.stats.throughput"),
      value: t("security.ops.stats.rpm", { n: formatCompact(s.rpm) }),
      hint: t("security.ops.stats.tpm", { n: formatTokens(s.tpm) }),
      icon: "zap",
      tone: "info",
    },
    {
      key: "ttft",
      label: t("security.ops.stats.ttft"),
      value: formatDurationMs(s.ttftP50),
      hint: t("security.ops.stats.p95", { value: formatDurationMs(s.ttftP95) }),
      icon: "gauge",
      tone: "neutral",
    },
    {
      key: "duration",
      label: t("security.ops.stats.duration"),
      value: formatDurationMs(s.durationP95),
      hint: t("security.ops.stats.durationHint", { p50: formatDurationMs(s.durationP50), p99: formatDurationMs(s.durationP99) }),
      icon: "clock",
      tone: s.durationP95 >= 60_000 ? "warning" : "neutral",
    },
    {
      key: "cost",
      label: t("security.ops.stats.cost"),
      value: `${lb}${formatUsd(s.costNanoUsd)}`,
      hint: t("security.ops.stats.tokensHint", { input: formatTokens(s.inputTokens), output: formatTokens(s.outputTokens) }),
      icon: "wallet",
      tone: "success",
    },
  ];
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.ops')">
      <template #meta>
        <button
          type="button"
          class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset transition-colors"
          :class="liveClass"
          :aria-pressed="autoRefresh"
          :title="autoRefresh ? t('security.ops.pauseLive') : t('security.ops.resumeLive')"
          @click="autoRefresh = !autoRefresh"
        >
          <span class="relative inline-flex h-1.5 w-1.5">
            <span
              v-if="liveState === 'live'"
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden"
            />
            <span class="relative inline-flex h-1.5 w-1.5 rounded-full" :class="liveDot" />
          </span>
          {{ t(`security.ops.liveStates.${liveState}`) }}
        </button>
        <span v-if="updatedAt" class="text-xs text-fg-subtle">{{ t("security.ops.updatedAt", { time: updatedAt }) }}</span>
      </template>
      <template #actions>
        <SegmentedControl v-model="range" :options="rangeOptions" size="md" />
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load(); errorRefreshToken++">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </PageHeader>

    <UiTabs v-model="tab" :tabs="tabs" />

    <div v-show="tab === 'overview'" class="space-y-6">
      <UiAlert v-if="error" tone="danger" :title="t('security.ops.errors.load')">
      {{ errorDetail ?? (overview ? t("security.ops.errors.stale") : t("security.ops.errors.hint")) }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-xs shrink-0" :disabled="loading" @click="load">
          {{ t("security.ops.retry") }}
        </button>
      </template>
    </UiAlert>

    <UiAlert v-if="overview?.truncated" tone="warning">{{ t("security.ops.truncated") }}</UiAlert>

    <!-- First load skeleton -->
    <div v-if="!overview && loading" class="space-y-6" aria-busy="true">
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-6">
        <div v-for="i in 6" :key="i" class="card h-[7.25rem] animate-pulse p-4">
          <div class="h-3 w-20 rounded bg-surface-2" />
          <div class="mt-4 h-6 w-24 rounded bg-surface-2" />
          <div class="mt-2 h-2.5 w-28 max-w-full rounded bg-surface-2" />
        </div>
      </div>
      <div class="grid gap-6 xl:grid-cols-2">
        <div v-for="i in 2" :key="i" class="card h-72 animate-pulse" />
      </div>
    </div>

    <div
      v-else-if="overview"
      class="space-y-6 transition-opacity duration-200"
      :class="loading && overview.range !== range ? 'opacity-60' : ''"
      :aria-busy="loading"
    >
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-6">
        <StatCard
          v-for="(s, i) in stats"
          :key="s.key"
          class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
          :style="staggerStyle(i, 40)"
          :label="s.label"
          :value="s.value"
          :hint="s.hint"
          :icon="s.icon"
          :tone="s.tone"
          mono
        />
      </div>

      <OpsTrendCharts
        class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
        :style="staggerStyle(6, 40)"
        :overview="overview"
      />

      <div class="grid gap-6 lg:grid-cols-2">
        <OpsStatusCodes
          class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
          :style="staggerStyle(7, 40)"
          :codes="overview.statusCodes"
        />
        <OpsFleetCard
          class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
          :style="staggerStyle(8, 40)"
          :fleet="overview.fleet"
        />
      </div>

      <div class="grid gap-6 xl:grid-cols-2">
        <OpsAccountsTable :accounts="overview.accounts" />
        <OpsModelsTable :models="overview.models" />
      </div>

      <OpsDeadLettersCard
        :count="deadLetters.count"
        :mode="deadLetters.mode"
        :loading="deadLettersLoading"
        :replaying="deadLettersReplaying"
        :error="deadLettersError"
        @refresh="loadDeadLetters"
        @replay="replayDeadLetters"
      />

      <OpsRecentErrors :errors="overview.recentErrors" :now="now" />
    </div>
    </div>

    <OpsErrorCenterPanel
      v-if="errorsVisited"
      v-show="tab === 'errors'"
      :range="range"
      :now="now"
      :refresh-token="errorRefreshToken"
      @open-count="openErrorCount = $event"
    />

    <OpsAlertsPanel
      v-if="alertsVisited"
      v-show="tab === 'alerts'"
      :now="now"
      :refresh-token="errorRefreshToken"
      @firing-count="firingAlertCount = $event"
    />

    <OpsRollupsPanel
      v-if="rollupsVisited"
      v-show="tab === 'rollups'"
      :now="now"
      :refresh-token="errorRefreshToken"
    />
  </div>
</template>
