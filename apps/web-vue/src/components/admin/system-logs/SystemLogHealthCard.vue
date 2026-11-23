<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { SystemLogSinkHealth } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon, { type IconName } from "../../ui/UiIcon.vue";
import { useNow } from "../../../composables/useNow";
import { apiJson } from "../../../lib/api";
import { formatCompact, formatDateTime, formatDurationMs, formatNumber, formatRelative, type Tone } from "../../../lib/format";
import SystemLogErrorMeta from "./SystemLogErrorMeta.vue";
import { describeError, type ErrorInfo } from "./systemLogUtil";

/**
 * Health of the log pipeline: this console process's queue and batch writer, plus the last
 * report of every slipgate-net forwarder. Polls while the page is visible.
 */
const props = defineProps<{ refreshToken: number }>();

const { t } = useI18n();
const now = useNow(5_000);

const POLL_MS = 15_000;
/** net reports at least every 30 s; a report older than this means it stopped. */
const FORWARDER_STALE_MS = 90_000;

const health = ref<SystemLogSinkHealth | null>(null);
const loading = ref(false);
const failure = ref<ErrorInfo | null>(null);

let seq = 0;
async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const res = await apiJson<SystemLogSinkHealth>("/api/v1/admin/ops/system-logs/health", {
      fallbackError: t("systemLogs.health.loadFailed"),
    });
    if (mine !== seq) return;
    health.value = res;
    failure.value = null;
  } catch (err) {
    if (mine === seq) failure.value = describeError(err, t, t("systemLogs.health.loadFailed"));
  } finally {
    if (mine === seq) loading.value = false;
  }
}

watch(() => props.refreshToken, () => void load());

let timer: number | undefined;
function onVisibility() {
  if (document.visibilityState === "visible") void load();
}
onMounted(() => {
  void load();
  timer = window.setInterval(() => {
    if (document.visibilityState === "visible" && !loading.value) void load();
  }, POLL_MS);
  document.addEventListener("visibilitychange", onVisibility);
});
onBeforeUnmount(() => {
  window.clearInterval(timer);
  document.removeEventListener("visibilitychange", onVisibility);
});

/* ---------------- Display ---------------- */

type StatusKey = "healthy" | "recovered" | "dropping" | "failing" | "forwarderStale";

/**
 * Overall state of the pipeline, the BFF sink and every reporting forwarder together, worst first:
 * a failing database write; entries dropped (here or by a forwarder); a forwarder that stopped
 * reporting; failures that have since recovered (failed batches, but the last attempt worked).
 */
const status = computed<{ tone: Tone; key: StatusKey }>(() => {
  const h = health.value;
  if (!h) return { tone: "neutral", key: "healthy" };
  const live = h.forwarders.filter((f) => !forwarderStale(f.reportedAtIso));
  if (h.lastError) return { tone: "danger", key: "failing" };
  if (h.droppedCount > 0 || live.some((f) => f.droppedCount > 0)) return { tone: "warning", key: "dropping" };
  if (live.length < h.forwarders.length) return { tone: "warning", key: "forwarderStale" };
  if (h.writeFailedCount > 0 || live.some((f) => f.failedCount > 0 || f.lastError)) return { tone: "info", key: "recovered" };
  return { tone: "success", key: "healthy" };
});

const queuePct = computed(() => {
  const h = health.value;
  if (!h || h.queueCapacity <= 0) return 0;
  return Math.min(100, Math.round((h.queueDepth / h.queueCapacity) * 100));
});
const queueTone = computed(() => (queuePct.value >= 90 ? "bg-danger" : queuePct.value >= 50 ? "bg-warning" : "bg-accent"));

interface Tile {
  key: string;
  label: string;
  value: string;
  hint: string;
  icon: IconName;
  tone: Tone;
}

const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-fg",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  violet: "text-violet",
};

const tiles = computed<Tile[]>(() => {
  const h = health.value;
  if (!h) return [];
  return [
    {
      key: "written",
      label: t("systemLogs.health.written"),
      value: formatCompact(h.writtenCount),
      hint: t("systemLogs.health.writtenHint"),
      icon: "database",
      tone: "neutral",
    },
    {
      key: "dropped",
      label: t("systemLogs.health.dropped"),
      value: formatCompact(h.droppedCount),
      hint: t("systemLogs.health.droppedHint"),
      icon: "alert",
      tone: h.droppedCount > 0 ? "warning" : "neutral",
    },
    {
      key: "failed",
      label: t("systemLogs.health.failed"),
      value: formatCompact(h.writeFailedCount),
      hint: t("systemLogs.health.failedHint"),
      icon: "x-circle",
      tone: h.writeFailedCount > 0 ? "danger" : "neutral",
    },
    {
      key: "delay",
      label: t("systemLogs.health.avgDelay"),
      value: formatDurationMs(h.avgWriteDelayMs),
      hint: t("systemLogs.health.avgDelayHint"),
      icon: "clock",
      tone: h.avgWriteDelayMs >= 1000 ? "warning" : "neutral",
    },
    {
      key: "sampled",
      label: t("systemLogs.health.sampledOut"),
      value: formatCompact(h.sampledOutCount),
      hint: t("systemLogs.health.sampledOutHint"),
      icon: "filter",
      tone: "neutral",
    },
  ];
});

function forwarderStale(reportedAtIso: string): boolean {
  const at = Date.parse(reportedAtIso);
  return Number.isFinite(at) && now.value - at > FORWARDER_STALE_MS;
}
</script>

<template>
  <section class="card min-w-0" :aria-busy="loading" :aria-label="t('systemLogs.health.title')">
    <header class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line/70 px-5 py-3">
      <div class="flex min-w-0 items-center gap-3">
        <span class="icon-chip icon-chip-accent h-8 w-8">
          <UiIcon name="activity" :size="16" />
        </span>
        <div class="min-w-0">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-fg">
            {{ t("systemLogs.health.title") }}
            <UiBadge
              v-if="health"
              :tone="status.tone"
              dot
              :pulse="status.key === 'failing'"
              :title="t(`systemLogs.health.statusHint.${status.key}`)"
            >
              {{ t(`systemLogs.health.status.${status.key}`) }}
            </UiBadge>
          </h2>
          <p v-if="health" class="mt-0.5 truncate text-2xs text-fg-subtle">
            <span class="font-mono" :title="t('systemLogs.health.host')">{{ health.host }}</span>
            <span class="mx-1.5">·</span>
            <span :title="formatDateTime(health.lastFlushAtIso)">
              {{
                health.lastFlushAtIso
                  ? t("systemLogs.health.lastFlush", { time: formatRelative(health.lastFlushAtIso, now) })
                  : t("systemLogs.health.neverFlushed")
              }}
            </span>
          </p>
        </div>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-icon btn-sm"
        :disabled="loading"
        :title="t('systemLogs.health.refresh')"
        :aria-label="t('systemLogs.health.refresh')"
        @click="load"
      >
        <UiIcon name="refresh" :size="14" :spin="loading" />
      </button>
    </header>

    <!-- First load -->
    <div v-if="!health && !failure" class="grid grid-cols-2 gap-3 p-5 sm:grid-cols-3 xl:grid-cols-6" role="status">
      <div v-for="i in 6" :key="i" class="h-[4.5rem] rounded-lg bg-surface-2/60 motion-safe:animate-pulse" />
      <span class="sr-only">{{ t("common.loading") }}</span>
    </div>

    <div v-else-if="!health && failure" class="flex flex-wrap items-center gap-3 px-5 py-4 text-sm">
      <span class="icon-chip icon-chip-warning h-8 w-8"><UiIcon name="alert" :size="15" /></span>
      <p class="min-w-0 flex-1 text-fg-muted">
        {{ failure.message }}
        <SystemLogErrorMeta :error="failure" />
      </p>
      <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="load">
        <UiIcon name="refresh" :size="13" :spin="loading" />
        {{ t("systemLogs.retry") }}
      </button>
    </div>

    <div v-else-if="health" class="space-y-4 p-5">
      <p v-if="failure" class="flex items-center gap-1.5 text-xs text-warning" role="status">
        <UiIcon name="alert" :size="12" />
        {{ t("systemLogs.health.stale") }}
      </p>

      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <!-- Queue -->
        <div class="rounded-lg border border-line/70 px-3.5 py-3" :title="t('systemLogs.health.queueHint')">
          <p class="flex items-center gap-1.5 text-2xs text-fg-subtle">
            <UiIcon name="layers" :size="12" />
            {{ t("systemLogs.health.queue") }}
          </p>
          <p class="mt-1 font-mono text-base font-semibold tabular-nums text-fg">
            {{ formatNumber(health.queueDepth) }}
            <span class="text-xs font-normal text-fg-subtle">/ {{ formatNumber(health.queueCapacity) }}</span>
          </p>
          <div
            class="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2"
            role="progressbar"
            :aria-valuenow="queuePct"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="t('systemLogs.health.queue')"
          >
            <div
              class="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
              :class="queueTone"
              :style="{ width: `${Math.max(queuePct, health.queueDepth > 0 ? 2 : 0)}%` }"
            />
          </div>
        </div>

        <div v-for="tile in tiles" :key="tile.key" class="rounded-lg border border-line/70 px-3.5 py-3" :title="tile.hint">
          <p class="flex items-center gap-1.5 text-2xs text-fg-subtle">
            <UiIcon :name="tile.icon" :size="12" />
            <span class="truncate">{{ tile.label }}</span>
          </p>
          <p class="mt-1 font-mono text-base font-semibold tabular-nums transition-colors" :class="TONE_TEXT[tile.tone]">
            {{ tile.value }}
          </p>
        </div>
      </div>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
      >
        <div v-if="health.lastError" class="flex gap-2.5 rounded-lg border border-danger/25 bg-danger/[0.06] px-3.5 py-2.5" role="alert">
          <UiIcon name="x-circle" :size="15" class="mt-0.5 shrink-0 text-danger" />
          <div class="min-w-0 text-xs">
            <p class="font-medium text-fg">{{ t("systemLogs.health.lastError") }}</p>
            <p class="mt-0.5 break-words font-mono text-2xs text-fg-muted">{{ health.lastError }}</p>
          </div>
        </div>
      </Transition>

      <!-- slipgate-net forwarders -->
      <div>
        <p class="eyebrow mb-2 flex items-center gap-1.5">
          {{ t("systemLogs.health.forwarders") }}
          <span class="rounded-full bg-surface-2 px-1.5 font-mono text-[10px] normal-case leading-4 tracking-normal">
            {{ health.forwarders.length }}
          </span>
        </p>
        <p v-if="health.forwarders.length === 0" class="rounded-lg border border-dashed border-line px-3.5 py-3 text-xs text-fg-subtle">
          {{ t("systemLogs.health.noForwarders") }}
        </p>
        <ul v-else class="divide-y divide-line/60 rounded-lg border border-line/70">
          <li v-for="f in health.forwarders" :key="f.host" class="px-3.5 py-2.5">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span class="inline-flex min-w-0 items-center gap-2">
                <span
                  class="h-1.5 w-1.5 shrink-0 rounded-full"
                  :class="forwarderStale(f.reportedAtIso) ? 'bg-fg-subtle' : f.lastError || f.failedCount > 0 ? 'bg-warning' : 'bg-success'"
                  aria-hidden="true"
                />
                <UiBadge tone="violet" mono>net</UiBadge>
                <span class="truncate font-mono text-xs text-fg" :title="f.host">{{ f.host || "-" }}</span>
              </span>
              <span
                class="text-2xs"
                :class="forwarderStale(f.reportedAtIso) ? 'text-warning' : 'text-fg-subtle'"
                :title="formatDateTime(f.reportedAtIso)"
              >
                {{
                  forwarderStale(f.reportedAtIso)
                    ? t("systemLogs.health.forwarderStale", { time: formatRelative(f.reportedAtIso, now) })
                    : t("systemLogs.health.reportedAt", { time: formatRelative(f.reportedAtIso, now) })
                }}
              </span>
              <dl class="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-subtle sm:ml-auto">
                <div class="flex items-center gap-1">
                  <dt>{{ t("systemLogs.health.queue") }}</dt>
                  <dd class="font-mono tabular-nums text-fg-muted">{{ formatNumber(f.queueDepth) }}/{{ formatNumber(f.queueCapacity) }}</dd>
                </div>
                <div class="flex items-center gap-1">
                  <dt>{{ t("systemLogs.health.sent") }}</dt>
                  <dd class="font-mono tabular-nums text-fg-muted">{{ formatCompact(f.sentCount) }}</dd>
                </div>
                <div class="flex items-center gap-1">
                  <dt>{{ t("systemLogs.health.dropped") }}</dt>
                  <dd class="font-mono tabular-nums" :class="f.droppedCount > 0 ? 'text-warning' : 'text-fg-muted'">
                    {{ formatCompact(f.droppedCount) }}
                  </dd>
                </div>
                <div class="flex items-center gap-1">
                  <dt>{{ t("systemLogs.health.sendFailed") }}</dt>
                  <dd class="font-mono tabular-nums" :class="f.failedCount > 0 ? 'text-danger' : 'text-fg-muted'">
                    {{ formatCompact(f.failedCount) }}
                  </dd>
                </div>
              </dl>
            </div>
            <p v-if="f.lastError" class="mt-1.5 break-words font-mono text-2xs text-danger">{{ f.lastError }}</p>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
