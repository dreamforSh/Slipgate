<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type {
  ChannelHealth,
  ChannelStatusResponse,
  PublicChannelMonitorItem,
  PublicChannelMonitorsStatusResponse,
} from "@slipgate/contracts";
import PublicLayout from "../../components/PublicLayout.vue";
import ChannelStatusCard from "../../components/public/ChannelStatusCard.vue";
import PublicDisabled from "../../components/public/PublicDisabled.vue";
import PublicHero from "../../components/public/PublicHero.vue";
import { HEALTH_META, HEALTH_ORDER } from "../../components/public/health";
import { providerLabel, providerRank } from "../../components/public/publicUtils";
import { vReveal } from "../../components/public/reveal";
import EmptyState from "../../components/ui/EmptyState.vue";
import PlatformIcon from "../../components/ui/PlatformIcon.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { useNow } from "../../composables/useNow";
import { ApiError, errorText, publicJson } from "../../lib/api";
import { formatDurationMs, formatRelative, type Tone } from "../../lib/format";

const REFRESH_SECONDS = 60;

const { t, locale } = useI18n();
const now = useNow(30_000);

const data = ref<ChannelStatusResponse | null>(null);
const probeMonitors = ref<PublicChannelMonitorItem[]>([]);
const loading = ref(false);
const disabled = ref(false);
const error = ref<string | null>(null);
const countdown = ref(REFRESH_SECONDS);
const hidden = ref(typeof document !== "undefined" && document.visibilityState === "hidden");
let lastLoadedAt = 0;
let timer: number | undefined;

function monitorBadgeTone(s: PublicChannelMonitorItem["lastStatus"]): Tone {
  if (s === "up") return "success";
  if (s === "degraded") return "warning";
  if (s === "down") return "danger";
  return "neutral";
}

function runBarClass(s: "up" | "degraded" | "down"): string {
  if (s === "up") return "bg-success/80";
  if (s === "degraded") return "bg-warning/85";
  return "bg-danger/85";
}

async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const [statusRes, monitorsRes] = await Promise.allSettled([
      publicJson<ChannelStatusResponse>("/api/v1/public/status"),
      publicJson<PublicChannelMonitorsStatusResponse>("/api/v1/public/channel-monitors/status"),
    ]);
    if (statusRes.status === "rejected") throw statusRes.reason;
    data.value = statusRes.value;
    probeMonitors.value = monitorsRes.status === "fulfilled" ? monitorsRes.value.items : [];
    disabled.value = false;
    error.value = null;
    lastLoadedAt = Date.now();
    now.value = lastLoadedAt;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) disabled.value = true;
    else error.value = errorText(err, t("public.common.loadFailed"));
  } finally {
    loading.value = false;
    countdown.value = REFRESH_SECONDS;
  }
}

function onVisibility() {
  hidden.value = document.visibilityState === "hidden";
  // Coming back after a long absence: refresh right away instead of finishing the countdown.
  if (!hidden.value && !disabled.value && lastLoadedAt && Date.now() - lastLoadedAt > REFRESH_SECONDS * 1000) void load();
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => {
    if (hidden.value || loading.value || disabled.value) return;
    countdown.value = Math.max(0, countdown.value - 1);
    if (countdown.value === 0) void load();
  }, 1000);
  document.addEventListener("visibilitychange", onVisibility);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});

/* ---------------- Derived ---------------- */
const platform = ref("all");
const channels = computed(() => data.value?.channels ?? []);
const platforms = computed(() =>
  [...new Set(channels.value.map((c) => c.platform))].sort((a, b) => providerRank(a) - providerRank(b) || a.localeCompare(b)),
);
const visibleChannels = computed(() =>
  platform.value === "all" ? channels.value : channels.value.filter((c) => c.platform === platform.value),
);

const counts = computed(() => {
  const out: Partial<Record<ChannelHealth, number>> = {};
  for (const c of channels.value) out[c.health] = (out[c.health] ?? 0) + 1;
  return HEALTH_ORDER.filter((h) => out[h]).map((h) => ({ health: h, n: out[h]!, tone: HEALTH_META[h].tone }));
});

const overall = computed(() => {
  const h = data.value?.overall ?? "idle";
  return { health: h, ...HEALTH_META[h] };
});

const BANNER: Record<Tone, { border: string; wash: string; chip: string; halo: string }> = {
  success: { border: "border-success/25", wash: "from-success/[0.09]", chip: "icon-chip-success", halo: "bg-success/25" },
  warning: { border: "border-warning/30", wash: "from-warning/[0.1]", chip: "icon-chip-warning", halo: "bg-warning/25" },
  danger: { border: "border-danger/25", wash: "from-danger/[0.09]", chip: "icon-chip-danger", halo: "bg-danger/25" },
  info: { border: "border-info/25", wash: "from-info/[0.08]", chip: "icon-chip-info", halo: "bg-info/25" },
  accent: { border: "border-accent/25", wash: "from-accent/[0.08]", chip: "icon-chip-accent", halo: "bg-accent/25" },
  violet: { border: "border-violet/25", wash: "from-violet/[0.08]", chip: "icon-chip-violet", halo: "bg-violet/25" },
  neutral: { border: "border-line", wash: "from-surface-2/70", chip: "", halo: "bg-fg-subtle/20" },
};
const banner = computed(() => BANNER[overall.value.tone]);

const DOT: Record<Tone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  accent: "bg-accent",
  violet: "bg-violet",
  neutral: "bg-fg-subtle",
};

const updatedAt = computed(() =>
  data.value ? new Date(data.value.generatedAtIso).toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "",
);

/* Countdown ring around the refresh button. */
const RING_C = 2 * Math.PI * 17;
const ringOffset = computed(() => RING_C * (1 - countdown.value / REFRESH_SECONDS));
</script>

<template>
  <PublicLayout>
    <PublicDisabled v-if="disabled" />
    <template v-else>
      <PublicHero icon="activity" :eyebrow="t('public.status.eyebrow')" :title="t('public.status.title')" :subtitle="t('public.status.subtitle')">
        <template #actions>
          <div class="flex items-center gap-3 rounded-xl border border-line/80 bg-surface/80 py-1.5 pl-4 pr-1.5 shadow-card backdrop-blur">
            <div class="text-right">
              <p class="text-2xs text-fg-subtle">
                {{ updatedAt ? t("public.common.updatedAt", { time: updatedAt }) : t("common.loading") }}
              </p>
              <p class="text-xs font-medium tabular-nums text-fg-muted" :title="hidden ? t('public.status.pausedHint') : undefined">
                <template v-if="hidden">
                  <UiIcon name="pause" :size="11" class="mr-0.5 inline -translate-y-px" />{{ t("public.status.paused") }}
                </template>
                <template v-else>{{ t("public.status.nextRefresh", { n: countdown }) }}</template>
              </p>
            </div>
            <button
              type="button"
              class="relative inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-wait"
              :disabled="loading"
              :aria-label="t('public.common.refresh')"
              :title="t('public.common.refresh')"
              @click="load"
            >
              <svg class="absolute inset-0 -rotate-90" viewBox="0 0 40 40" aria-hidden="true">
                <circle cx="20" cy="20" r="17" fill="none" stroke="rgb(var(--border))" stroke-width="2" />
                <circle
                  cx="20"
                  cy="20"
                  r="17"
                  fill="none"
                  stroke="rgb(var(--accent))"
                  stroke-width="2"
                  stroke-linecap="round"
                  :stroke-dasharray="RING_C"
                  :stroke-dashoffset="ringOffset"
                  class="transition-[stroke-dashoffset] duration-1000 ease-linear"
                />
              </svg>
              <UiIcon name="refresh" :size="16" :spin="loading" />
            </button>
          </div>
        </template>
      </PublicHero>

      <div class="mx-auto w-full max-w-6xl space-y-6 px-4 pb-20 sm:px-6">
        <UiAlert v-if="error" tone="danger">
          {{ error }}
          <template #action>
            <button type="button" class="btn btn-secondary btn-sm" @click="load">
              <UiIcon name="refresh" :size="13" />
              {{ t("public.common.retry") }}
            </button>
          </template>
        </UiAlert>

        <!-- Loading skeleton -->
        <template v-if="!data && loading">
          <div class="card h-28 animate-pulse bg-surface-2/40" />
          <div class="grid gap-4 lg:grid-cols-2">
            <div v-for="i in 4" :key="i" class="card animate-pulse p-5">
              <div class="flex items-center gap-3">
                <div class="h-10 w-10 rounded-xl bg-surface-2" />
                <div class="flex-1 space-y-2">
                  <div class="h-3 w-1/3 rounded bg-surface-2" />
                  <div class="h-2.5 w-1/2 rounded bg-surface-2" />
                </div>
              </div>
              <div class="mt-5 grid grid-cols-4 gap-2.5">
                <div v-for="j in 4" :key="j" class="h-14 rounded-lg bg-surface-2" />
              </div>
              <div class="mt-5 h-9 rounded-md bg-surface-2" />
            </div>
          </div>
        </template>

        <template v-else-if="data">
          <!-- Overall banner -->
          <section class="card relative overflow-hidden p-5 animate-slide-up sm:p-6" :class="banner.border" role="status">
            <div class="pointer-events-none absolute inset-0 bg-gradient-to-r to-transparent" :class="banner.wash" aria-hidden="true" />
            <div class="relative flex flex-col gap-4 sm:flex-row sm:items-center">
              <span class="relative inline-flex shrink-0">
                <span class="halo absolute inset-0 rounded-2xl" :class="banner.halo" aria-hidden="true" />
                <span class="icon-chip relative h-12 w-12 rounded-2xl" :class="banner.chip">
                  <UiIcon :name="overall.icon" :size="24" />
                </span>
              </span>
              <div class="min-w-0 flex-1">
                <h2 class="text-lg font-semibold tracking-tight text-fg">{{ t(`public.status.overall.${overall.health}.title`) }}</h2>
                <p class="mt-1 text-sm text-fg-muted">{{ t(`public.status.overall.${overall.health}.desc`) }}</p>
              </div>
              <ul v-if="counts.length" class="flex flex-wrap gap-2">
                <li
                  v-for="c in counts"
                  :key="c.health"
                  class="inline-flex items-center gap-1.5 rounded-full bg-surface/80 px-2.5 py-1 text-xs text-fg-muted ring-1 ring-inset ring-line"
                >
                  <span class="h-1.5 w-1.5 rounded-full" :class="DOT[c.tone]" />
                  {{ t(`public.status.health.${c.health}`) }}
                  <span class="font-semibold tabular-nums text-fg">{{ c.n }}</span>
                </li>
              </ul>
            </div>
          </section>

          <div v-if="!channels.length" class="card">
            <EmptyState icon="activity" :title="t('public.status.empty')" />
          </div>

          <template v-else>
            <!-- Filter + legend -->
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div v-if="platforms.length > 1" class="scrollbar-hide -mx-1 flex gap-1.5 overflow-x-auto px-1" role="radiogroup">
                <button
                  type="button"
                  role="radio"
                  :aria-checked="platform === 'all'"
                  class="filter-chip"
                  :class="platform === 'all' ? 'filter-chip-on' : ''"
                  @click="platform = 'all'"
                >
                  {{ t("public.common.allPlatforms") }}
                  <span class="font-mono text-2xs opacity-70">{{ channels.length }}</span>
                </button>
                <button
                  v-for="p in platforms"
                  :key="p"
                  type="button"
                  role="radio"
                  :aria-checked="platform === p"
                  class="filter-chip"
                  :class="platform === p ? 'filter-chip-on' : ''"
                  @click="platform = p"
                >
                  <PlatformIcon :platform="p" :size="13" />
                  {{ providerLabel(p) }}
                </button>
              </div>
              <p v-else class="text-sm font-medium text-fg-muted">{{ t("public.status.channels", { n: channels.length }) }}</p>

              <ul class="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-subtle" aria-hidden="true">
                <li class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-success/75" />{{ t("public.status.legend.good") }}</li>
                <li class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-warning/80" />{{ t("public.status.legend.warn") }}</li>
                <li class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-danger/80" />{{ t("public.status.legend.bad") }}</li>
                <li class="inline-flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm bg-surface-3" />{{ t("public.status.legend.none") }}</li>
              </ul>
            </div>

            <div class="grid gap-4 lg:grid-cols-2">
              <div v-for="(c, i) in visibleChannels" :key="c.groupId" v-reveal="(i % 2) * 80" class="min-w-0">
                <ChannelStatusCard :item="c" :bucket-minutes="data.bucketMinutes" :now="now" :stagger="(i % 4) * 60" />
              </div>
            </div>
          </template>
        </template>

        <section v-if="probeMonitors.length > 0" class="space-y-4 pt-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 class="text-base font-semibold text-fg">{{ t("public.status.probes.title") }}</h2>
              <p class="text-xs text-fg-subtle">{{ t("public.status.probes.subtitle") }}</p>
            </div>
            <span class="text-xs font-medium text-fg-muted">
              {{ t("public.status.probes.count", { n: probeMonitors.length }) }}
            </span>
          </div>

          <div class="grid gap-4 lg:grid-cols-2">
            <article
              v-for="m in probeMonitors"
              :key="m.id"
              class="card flex min-w-0 flex-col gap-3.5 p-5"
            >
              <header class="flex items-start justify-between gap-3">
                <div class="flex min-w-0 items-center gap-3">
                  <span class="icon-chip h-9 w-9 rounded-xl bg-surface-2">
                    <PlatformIcon :platform="m.platform" :size="17" />
                  </span>
                  <div class="min-w-0">
                    <h3 class="truncate text-sm font-semibold text-fg" :title="m.name">{{ m.name }}</h3>
                    <p class="truncate font-mono text-2xs text-fg-subtle">
                      {{ m.model || providerLabel(m.platform) }}
                      <template v-if="m.lastCheckedAtIso"> · {{ formatRelative(m.lastCheckedAtIso, now) }}</template>
                    </p>
                  </div>
                </div>
                <UiBadge :tone="monitorBadgeTone(m.lastStatus)" dot :pulse="m.lastStatus === 'up'">
                  {{ t(`public.status.probes.statuses.${m.lastStatus}`) }}
                </UiBadge>
              </header>

              <div class="flex items-center gap-1">
                <span
                  v-for="(pt, idx) in m.recentRuns"
                  :key="idx"
                  class="h-5 flex-1 rounded-sm"
                  :class="runBarClass(pt.status)"
                  :title="`${pt.status} (${pt.latencyMs}ms)`"
                />
                <span v-if="m.recentRuns.length === 0" class="text-xs text-fg-subtle">
                  {{ t("public.status.probes.noRuns") }}
                </span>
              </div>

              <div class="flex items-center justify-between text-xs text-fg-subtle">
                <span>
                  {{ t("public.status.probes.uptime") }}:
                  <strong class="font-mono text-fg">{{ m.uptime24hPct !== null ? `${m.uptime24hPct}%` : "—" }}</strong>
                </span>
                <span class="font-mono tabular-nums text-fg-muted">
                  {{ m.lastCheckedAtIso ? formatDurationMs(m.lastLatencyMs) : "—" }}
                </span>
              </div>
            </article>
          </div>
        </section>
      </div>
    </template>
  </PublicLayout>
</template>

<style scoped>
.filter-chip {
  @apply inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-line/80 bg-surface px-3 text-xs font-medium text-fg-muted transition-colors duration-150 hover:border-line-strong hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40;
}
.filter-chip-on {
  @apply border-accent/30 bg-accent/10 text-accent hover:border-accent/40 hover:text-accent;
}
.halo {
  animation: halo 2.6s cubic-bezier(0.2, 0, 0, 1) infinite;
}
@keyframes halo {
  0% {
    opacity: 0.7;
    transform: scale(1);
  }
  80%,
  100% {
    opacity: 0;
    transform: scale(1.45);
  }
}
@media (prefers-reduced-motion: reduce) {
  .halo {
    animation: none;
    opacity: 0;
  }
}
</style>
