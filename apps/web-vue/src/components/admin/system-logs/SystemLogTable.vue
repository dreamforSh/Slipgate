<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import {
  SYSTEM_LOG_DEFAULT_PAGE_SIZE,
  SYSTEM_LOG_DEFAULT_TIME_RANGE,
  SYSTEM_LOG_LEVELS,
  SYSTEM_LOG_MAX_PAGE_SIZE,
  SYSTEM_LOG_SOURCES,
  SYSTEM_LOG_TIME_RANGES,
  type SystemLogCleanupRequest,
  type SystemLogItem,
  type SystemLogListResponse,
  type SystemLogSource,
  type SystemLogTimeRange,
} from "@slipgate/contracts";
import ListSkeleton from "../ops/ListSkeleton.vue";
import { httpStatusTone, isoToLocalInput, localInputToIso } from "../ops/opsUtil";
import EmptyState from "../../ui/EmptyState.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiPagination from "../../ui/UiPagination.vue";
import { usePersistentState } from "../../../composables/usePersistentState";
import { apiJson, toQuery } from "../../../lib/api";
import { formatNumber, formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import SystemLogCleanupModal from "./SystemLogCleanupModal.vue";
import SystemLogDetailDrawer from "./SystemLogDetailDrawer.vue";
import SystemLogErrorMeta from "./SystemLogErrorMeta.vue";
import {
  LEVEL_EDGE,
  LEVEL_TONE,
  SOURCE_TONE,
  TEXT_FILTER_KEYS,
  TEXT_FILTER_MAX,
  TONE_TEXT,
  contextError,
  describeError,
  emptyTextFilters,
  formatLogClock,
  formatLogDate,
  formatLogInstant,
  httpSummary,
  levelParams,
  newestId,
  type ErrorInfo,
  type LevelChoice,
  type TextFilterKey,
  type TextFilters,
} from "./systemLogUtil";

/**
 * Stored system log entries: filters, time window, pagination, auto-refresh / live tail, the
 * detail drawer and the cleanup of everything the current filters match.
 */
const props = withDefaults(
  defineProps<{
    /** False while the page shows another tab: live polling pauses (and catches up on return). */
    active?: boolean;
  }>(),
  { active: true },
);
const emit = defineEmits<{ (e: "cleaned"): void }>();

const { t } = useI18n();
const toast = useToastStore();
const route = useRoute();
const router = useRouter();

const TAIL_MS = 3_000;
const REFRESH_MS = 15_000;
const FRESH_MS = 2_400;
const PAGE_SIZES = [20, SYSTEM_LOG_DEFAULT_PAGE_SIZE, 100, SYSTEM_LOG_MAX_PAGE_SIZE];

/* ---------------- Filters ---------------- */

type TimeChoice = SystemLogTimeRange | "custom";
const RANGE_KEY: Record<SystemLogTimeRange, string> = {
  "5m": "m5",
  "30m": "m30",
  "1h": "h1",
  "6h": "h6",
  "24h": "h24",
  "7d": "d7",
  "30d": "d30",
};

const timeChoice = ref<TimeChoice>(SYSTEM_LOG_DEFAULT_TIME_RANGE);
const sinceLocal = ref("");
const untilLocal = ref("");
const timeOptions = computed(() => [
  ...SYSTEM_LOG_TIME_RANGES.map((value) => ({ value: value as TimeChoice, label: t(`systemLogs.time.ranges.${RANGE_KEY[value]}`) })),
  { value: "custom" as TimeChoice, label: t("systemLogs.time.custom") },
]);

const levelChoice = ref<LevelChoice>("");
const source = ref<"" | SystemLogSource>("");
const q = ref("");
const text = reactive<TextFilters>(emptyTextFilters());
const advancedOpen = ref(false);

/** Text filters take effect after typing pauses (or on Enter); selects apply at once. */
const applied = ref<{ q: string; text: TextFilters }>({ q: "", text: emptyTextFilters() });
let textTimer: number | undefined;

function applyTextNow() {
  window.clearTimeout(textTimer);
  const next = emptyTextFilters();
  for (const k of TEXT_FILTER_KEYS) next[k] = text[k].trim();
  applied.value = { q: q.value.trim(), text: next };
}

watch([q, () => TEXT_FILTER_KEYS.map((k) => text[k])], () => {
  window.clearTimeout(textTimer);
  textTimer = window.setTimeout(applyTextNow, 350);
});

const sinceIso = computed(() => (timeChoice.value === "custom" ? localInputToIso(sinceLocal.value) : null));
const untilIso = computed(() => (timeChoice.value === "custom" ? localInputToIso(untilLocal.value) : null));
const rangeInvalid = computed(
  () => !!sinceIso.value && !!untilIso.value && Date.parse(sinceIso.value) > Date.parse(untilIso.value),
);

type FilterParams = Partial<Record<keyof SystemLogCleanupRequest, string>>;

/** Filters shared by the list and the cleanup (the window is added separately). */
const filterParams = computed<FilterParams>(() => {
  const out: FilterParams = { ...levelParams(levelChoice.value) };
  if (source.value) out.source = source.value;
  for (const k of TEXT_FILTER_KEYS) if (applied.value.text[k]) out[k] = applied.value.text[k];
  if (applied.value.q) out.q = applied.value.q;
  return out;
});

const advancedCount = computed(() => TEXT_FILTER_KEYS.filter((k) => applied.value.text[k]).length);
const hasFilters = computed(() => Object.keys(filterParams.value).length > 0 || timeChoice.value === "custom");

const levelOptions = computed(() => ({
  min: (["info", "warn"] as const).map((l) => ({ value: `min:${l}` as LevelChoice, label: t("systemLogs.filters.levelAtLeast", { level: l }) })),
  eq: SYSTEM_LOG_LEVELS.map((l) => ({ value: `eq:${l}` as LevelChoice, label: t("systemLogs.filters.levelOnly", { level: l }) })),
}));

function levelLabel(choice: LevelChoice): string {
  if (!choice) return t("systemLogs.filters.allLevels");
  const [mode, level] = choice.split(":");
  return mode === "min" ? t("systemLogs.filters.levelAtLeast", { level }) : t("systemLogs.filters.levelOnly", { level });
}

function fieldLabel(key: TextFilterKey | "q"): string {
  return t(`systemLogs.fields.${key}`);
}

function setTextFilter(key: TextFilterKey, value: string) {
  text[key] = value;
  applyTextNow();
}

function resetFilters() {
  levelChoice.value = "";
  source.value = "";
  q.value = "";
  for (const k of TEXT_FILTER_KEYS) text[k] = "";
  applyTextNow();
  timeChoice.value = SYSTEM_LOG_DEFAULT_TIME_RANGE;
  sinceLocal.value = "";
  untilLocal.value = "";
}

/* ---------------- List ---------------- */

const items = ref<SystemLogItem[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(SYSTEM_LOG_DEFAULT_PAGE_SIZE);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<ErrorInfo | null>(null);
/** Filters and window of the rows on screen: what a cleanup deletes and what the header shows. */
const shown = ref<{ params: FilterParams; levelChoice: LevelChoice; sinceIso: string; untilIso: string } | null>(null);
const freshIds = ref<Set<string>>(new Set());

function listQuery(extra: Record<string, string | number | undefined> = {}): string {
  return toQuery({
    ...filterParams.value,
    timeRange: timeChoice.value === "custom" ? undefined : timeChoice.value,
    sinceIso: sinceIso.value ?? undefined,
    untilIso: untilIso.value ?? undefined,
    page: page.value,
    pageSize: pageSize.value,
    ...extra,
  });
}

let seq = 0;
async function load() {
  if (rangeInvalid.value) return;
  const mine = ++seq;
  loading.value = true;
  const params = { ...filterParams.value };
  const choice = levelChoice.value;
  try {
    const res = await apiJson<SystemLogListResponse>(`/api/v1/admin/ops/system-logs${listQuery()}`, {
      fallbackError: t("systemLogs.errors.load"),
    });
    if (mine !== seq) return;
    // A later page emptied meanwhile (entries aged out of the window, a cleanup, the retention
    // prune): go to the last page that still has rows instead of showing "no logs".
    if (res.items.length === 0 && res.total > 0 && page.value > 1) {
      const last = Math.max(1, Math.ceil(res.total / pageSize.value));
      if (last < page.value) {
        page.value = last;
        return;
      }
    }
    items.value = res.items;
    total.value = res.total;
    shown.value = { params, levelChoice: choice, sinceIso: res.sinceIso, untilIso: res.untilIso };
    loaded.value = true;
    loadError.value = null;
    freshIds.value = new Set();
  } catch (err) {
    if (mine === seq) loadError.value = describeError(err, t, t("systemLogs.errors.load"));
  } finally {
    if (mine === seq) loading.value = false;
  }
}

let scheduled = false;
function scheduleLoad() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void load();
  });
}

const queryKey = computed(() => JSON.stringify([filterParams.value, timeChoice.value, sinceIso.value, untilIso.value]));
watch(queryKey, () => {
  if (rangeInvalid.value) return;
  page.value = 1;
  scheduleLoad();
});
watch(pageSize, () => {
  page.value = 1;
  scheduleLoad();
});
watch(page, scheduleLoad);

/* ---------------- Live: auto refresh / tail ---------------- */

type LiveMode = "off" | "refresh" | "tail";
const LIVE_MODES: LiveMode[] = ["off", "refresh", "tail"];
const liveMode = usePersistentState<LiveMode>("slipgate.systemLogs.live", "off", (v): v is LiveMode =>
  LIVE_MODES.includes(v as LiveMode),
);
const liveOptions = computed(() => LIVE_MODES.map((value) => ({ value, label: t(`systemLogs.live.modes.${value}`) })));
const pageVisible = ref(document.visibilityState !== "hidden");

/** Why the chosen live mode is not polling right now ("" = it is). */
const pauseReason = computed(() => {
  if (liveMode.value === "off") return "";
  if (!props.active) return t("systemLogs.live.pausedTab");
  if (!pageVisible.value) return t("systemLogs.live.pausedHidden");
  if (liveMode.value === "tail" && untilIso.value) return t("systemLogs.live.pausedUntil");
  if (liveMode.value === "tail" && page.value !== 1) return t("systemLogs.live.pausedPage");
  return "";
});
const liveState = computed<"off" | "live" | "stale" | "paused">(() => {
  if (liveMode.value === "off") return "off";
  if (pauseReason.value) return "paused";
  return loadError.value ? "stale" : "live";
});
const liveText = computed(() => {
  switch (liveState.value) {
    case "live":
      return liveMode.value === "tail" ? t("systemLogs.live.tailing") : t("systemLogs.live.refreshing", { s: REFRESH_MS / 1000 });
    case "stale":
      return t("systemLogs.live.stale");
    case "paused":
      return pauseReason.value;
    default:
      return t("systemLogs.live.off");
  }
});
const liveDot = computed(
  () => ({ live: "bg-success", stale: "bg-warning", paused: "bg-fg-subtle", off: "bg-fg-subtle" })[liveState.value],
);

function markFresh(ids: string[]) {
  if (!ids.length) return;
  const next = new Set(freshIds.value);
  for (const id of ids) next.add(id);
  freshIds.value = next;
  window.setTimeout(() => {
    const rest = new Set(freshIds.value);
    for (const id of ids) rest.delete(id);
    freshIds.value = rest;
  }, FRESH_MS);
}

let tailing = false;
/** Fetches only rows newer than the newest one shown and prepends them (page 1 stays page 1). */
async function tail() {
  if (tailing) return;
  const after = newestId(items.value);
  if (!after) return load();
  tailing = true;
  const mine = seq;
  try {
    const res = await apiJson<SystemLogListResponse>(
      `/api/v1/admin/ops/system-logs${listQuery({ page: 1, pageSize: SYSTEM_LOG_MAX_PAGE_SIZE, afterId: after })}`,
      { fallbackError: t("systemLogs.errors.load") },
    );
    // A full load started meanwhile owns the list now.
    if (mine !== seq) return;
    if (res.total > res.items.length) {
      // More arrived than one batch holds: resync instead of leaving a gap.
      void load();
      return;
    }
    if (res.items.length) {
      const known = new Set(items.value.map((i) => i.id));
      const fresh = res.items.filter((i) => !known.has(i.id));
      items.value = [...fresh, ...items.value].slice(0, pageSize.value);
      total.value += fresh.length;
      markFresh(fresh.map((i) => i.id));
    }
    // The rows on screen now span the original start up to this poll.
    if (shown.value) shown.value = { ...shown.value, untilIso: res.untilIso };
    loadError.value = null;
  } catch (err) {
    if (mine === seq) loadError.value = describeError(err, t, t("systemLogs.errors.load"));
  } finally {
    tailing = false;
  }
}

function tick() {
  if (liveState.value === "off" || pauseReason.value || loading.value || rangeInvalid.value) return;
  if (liveMode.value === "tail") void tail();
  else void load();
}

let timer: number | undefined;
function restartTimer() {
  window.clearInterval(timer);
  timer = undefined;
  if (liveMode.value === "off") return;
  timer = window.setInterval(tick, liveMode.value === "tail" ? TAIL_MS : REFRESH_MS);
}

watch(liveMode, (mode) => {
  if (mode === "tail" && page.value !== 1) page.value = 1;
  restartTimer();
  tick();
});

function onVisibility() {
  pageVisible.value = document.visibilityState !== "hidden";
  // Coming back: catch up at once instead of waiting for the next tick.
  if (pageVisible.value) tick();
}

// Back from the settings tab: the same catch-up.
watch(
  () => props.active,
  (active) => {
    if (active) tick();
  },
);

/* ---------------- Detail ---------------- */

const detailOpen = ref(false);
const detailItem = ref<SystemLogItem | null>(null);
const detailIndex = computed(() => (detailItem.value ? items.value.findIndex((i) => i.id === detailItem.value?.id) : -1));

function openDetail(item: SystemLogItem) {
  detailItem.value = item;
  detailOpen.value = true;
}

function navigateDetail(delta: -1 | 1) {
  const next = items.value[detailIndex.value + delta];
  if (detailIndex.value >= 0 && next) detailItem.value = next;
}

function filterFromDetail(key: TextFilterKey, value: string) {
  setTextFilter(key, value);
  if (key !== "component") advancedOpen.value = true;
  toast.info(t("systemLogs.filters.applied", { field: fieldLabel(key) }));
}

/* ---------------- Cleanup ---------------- */

const cleanupOpen = ref(false);

const cleanupBody = computed<SystemLogCleanupRequest>(() => {
  const s = shown.value;
  if (!s) return {} as SystemLogCleanupRequest;
  return { ...s.params, sinceIso: s.sinceIso, untilIso: s.untilIso } as SystemLogCleanupRequest;
});

const cleanupConditions = computed(() => {
  const s = shown.value;
  if (!s) return [];
  const rows = [
    { label: t("systemLogs.cleanup.window"), value: `${formatLogInstant(s.sinceIso)} → ${formatLogInstant(s.untilIso)}` },
  ];
  if (s.levelChoice) rows.push({ label: t("systemLogs.filters.level"), value: levelLabel(s.levelChoice) });
  if (s.params.source) rows.push({ label: t("systemLogs.filters.source"), value: s.params.source });
  for (const k of TEXT_FILTER_KEYS) {
    const v = s.params[k];
    if (v) rows.push({ label: fieldLabel(k), value: v });
  }
  if (s.params.q) rows.push({ label: fieldLabel("q"), value: s.params.q });
  return rows;
});

function onCleaned(deleted: number) {
  toast.success(t("systemLogs.cleanup.done", { n: formatNumber(deleted) }, deleted));
  page.value = 1;
  scheduleLoad();
  emit("cleaned");
}

/* ---------------- Display ---------------- */

/** Per-row summaries, computed once per list change rather than on every render. */
const rows = computed(() =>
  items.value.map((item) => {
    const http = httpSummary(item);
    const err = contextError(item);
    return {
      item,
      http,
      statusClass: http?.status != null ? TONE_TEXT[httpStatusTone(http.status)] : "",
      error: err && err !== item.message ? err : "",
    };
  }),
);

const shownWindow = computed(() => {
  const s = shown.value;
  if (!s) return "";
  return `${formatLogInstant(s.sinceIso)} → ${formatLogInstant(s.untilIso)}`;
});

/** Widen the window from the empty state (the next longer preset). */
const widerRange = computed<SystemLogTimeRange | null>(() => {
  if (timeChoice.value === "custom") return null;
  const i = SYSTEM_LOG_TIME_RANGES.indexOf(timeChoice.value);
  return SYSTEM_LOG_TIME_RANGES[i + 1] ?? null;
});

function onCustomToggle(choice: TimeChoice) {
  // Start a custom window from the one on screen (open-ended, so live tail keeps working).
  if (choice === "custom" && !sinceLocal.value && shown.value) sinceLocal.value = isoToLocalInput(shown.value.sinceIso);
}
watch(timeChoice, onCustomToggle);

const DEEP_LINK_KEYS = [...TEXT_FILTER_KEYS, "q", "level"] as const;

/** A deep-link ?level= as a choice the level select offers. */
function deepLinkLevel(raw: string): LevelChoice | null {
  if (!(SYSTEM_LOG_LEVELS as readonly string[]).includes(raw)) return null;
  // "debug and above" is every level; "error and above" is exactly error.
  if (raw === "debug") return "";
  if (raw === "error") return "eq:error";
  return `min:${raw}` as LevelChoice;
}

onMounted(() => {
  // Deep links (?requestId=…, ?component=…, ?level=…) prefill the filters once; they are then
  // removed from the URL so a reload or a copied link does not bring back a filter cleared since.
  for (const k of [...TEXT_FILTER_KEYS, "q"] as const) {
    const v = route.query[k];
    if (typeof v !== "string" || !v.trim()) continue;
    if (k === "q") q.value = v.trim().slice(0, TEXT_FILTER_MAX.q);
    else {
      text[k] = v.trim().slice(0, TEXT_FILTER_MAX[k]);
      advancedOpen.value = true;
    }
  }
  applyTextNow();
  const lvl = route.query.level;
  if (typeof lvl === "string") {
    const choice = deepLinkLevel(lvl.trim().toLowerCase());
    if (choice !== null) levelChoice.value = choice;
  }
  if (DEEP_LINK_KEYS.some((k) => k in route.query)) {
    const query = { ...route.query };
    for (const k of DEEP_LINK_KEYS) delete query[k];
    void router.replace({ query });
  }
  scheduleLoad();
  restartTimer();
  document.addEventListener("visibilitychange", onVisibility);
});

onBeforeUnmount(() => {
  window.clearInterval(timer);
  window.clearTimeout(textTimer);
  document.removeEventListener("visibilitychange", onVisibility);
});

const fieldInputId = (k: TextFilterKey) => `syslog-filter-${k}`;
/** A short cascade for the first rows of a fresh list, capped so long pages do not lag. */
const rowDelay = (i: number) => ({ animationDelay: `${Math.min(i, 10) * 16}ms` });
const errorRing = "!border-danger focus:!ring-danger/20";
</script>

<template>
  <div class="min-w-0">
    <UiCard flush>
      <template #header>
        <div class="flex min-w-0 items-center gap-3">
          <span class="icon-chip icon-chip-accent h-8 w-8">
            <UiIcon name="terminal" :size="16" />
          </span>
          <h2 class="truncate text-sm font-semibold text-fg">{{ t("systemLogs.list.title") }}</h2>
          <span v-if="loaded" class="whitespace-nowrap rounded-full bg-surface-2 px-2 py-0.5 text-2xs tabular-nums text-fg-muted">
            {{ t("systemLogs.list.total", { n: formatNumber(total) }, total) }}
          </span>
        </div>
      </template>
      <template #actions>
        <span class="inline-flex items-center gap-1.5 text-2xs text-fg-subtle" role="status" aria-live="polite" :title="liveText">
          <span class="relative inline-flex h-1.5 w-1.5 shrink-0">
            <span
              v-if="liveState === 'live'"
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60 motion-reduce:hidden"
            />
            <span class="relative inline-flex h-1.5 w-1.5 rounded-full" :class="liveDot" />
          </span>
          <span class="hidden max-w-[14rem] truncate sm:inline">{{ liveText }}</span>
        </span>
        <div class="scrollbar-hide max-w-full overflow-x-auto" :aria-label="t('systemLogs.live.label')" role="group">
          <SegmentedControl v-model="liveMode" :options="liveOptions" />
        </div>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="loading || rangeInvalid"
          :title="t('common.refresh')"
          @click="load"
        >
          <UiIcon name="refresh" :size="13" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <button
          type="button"
          class="btn btn-danger btn-sm"
          :disabled="!shown || total === 0 || loading"
          :title="t('systemLogs.cleanup.buttonHint')"
          @click="cleanupOpen = true"
        >
          <UiIcon name="trash" :size="13" />
          {{ t("systemLogs.cleanup.button") }}
        </button>
      </template>

      <!-- Filters -->
      <div class="space-y-3 border-b border-line/70 px-5 py-3">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div class="scrollbar-hide max-w-full overflow-x-auto" role="group" :aria-label="t('systemLogs.time.label')">
            <SegmentedControl v-model="timeChoice" :options="timeOptions" />
          </div>
          <span v-if="shownWindow" class="hidden text-2xs tabular-nums text-fg-subtle md:inline" :title="t('systemLogs.time.searched')">
            {{ shownWindow }}
          </span>
        </div>

        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="-translate-y-1 opacity-0"
          leave-to-class="-translate-y-1 opacity-0"
        >
          <div v-if="timeChoice === 'custom'" class="grid max-w-2xl gap-3 sm:grid-cols-2">
            <label class="block min-w-0">
              <span class="label">{{ t("systemLogs.time.since") }}</span>
              <input v-model="sinceLocal" type="datetime-local" class="input input-sm" :class="rangeInvalid ? errorRing : ''" />
            </label>
            <label class="block min-w-0">
              <span class="label">{{ t("systemLogs.time.until") }}</span>
              <input v-model="untilLocal" type="datetime-local" class="input input-sm" :class="rangeInvalid ? errorRing : ''" />
            </label>
            <p v-if="rangeInvalid" class="flex items-center gap-1 text-xs text-danger sm:col-span-2" role="alert">
              <UiIcon name="alert" :size="12" />
              {{ t("systemLogs.errors.invalidRange") }}
            </p>
            <p v-else class="hint !mt-0 sm:col-span-2">{{ t("systemLogs.time.customHint") }}</p>
          </div>
        </Transition>

        <div class="flex flex-wrap items-center gap-2">
          <label class="relative min-w-[12rem] flex-1 basis-full sm:basis-auto">
            <span class="sr-only">{{ t("systemLogs.fields.q") }}</span>
            <UiIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
            <input
              v-model="q"
              type="search"
              class="input input-sm pl-8"
              :maxlength="TEXT_FILTER_MAX.q"
              :placeholder="t('systemLogs.filters.searchPlaceholder')"
              @keydown.enter.prevent="applyTextNow"
            />
          </label>
          <select v-model="levelChoice" class="select input-sm w-auto min-w-[8.5rem]" :aria-label="t('systemLogs.filters.level')">
            <option value="">{{ t("systemLogs.filters.allLevels") }}</option>
            <optgroup :label="t('systemLogs.filters.levelMinGroup')">
              <option v-for="o in levelOptions.min" :key="o.value" :value="o.value">{{ o.label }}</option>
            </optgroup>
            <optgroup :label="t('systemLogs.filters.levelOnlyGroup')">
              <option v-for="o in levelOptions.eq" :key="o.value" :value="o.value">{{ o.label }}</option>
            </optgroup>
          </select>
          <select v-model="source" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('systemLogs.filters.source')">
            <option value="">{{ t("systemLogs.filters.allSources") }}</option>
            <option v-for="s in SYSTEM_LOG_SOURCES" :key="s" :value="s">{{ t(`systemLogs.sources.${s}`) }}</option>
          </select>
          <button
            type="button"
            class="btn btn-secondary btn-sm"
            :aria-expanded="advancedOpen"
            aria-controls="syslog-advanced-filters"
            @click="advancedOpen = !advancedOpen"
          >
            <UiIcon name="filter" :size="13" />
            {{ t("systemLogs.filters.more") }}
            <span v-if="advancedCount" class="rounded-full bg-accent/10 px-1.5 font-mono text-[10px] leading-4 text-accent">
              {{ advancedCount }}
            </span>
            <UiIcon
              name="chevron-down"
              :size="12"
              class="transition-transform duration-200 motion-reduce:transition-none"
              :class="advancedOpen ? 'rotate-180' : ''"
            />
          </button>
          <button v-if="hasFilters" type="button" class="btn btn-ghost btn-sm" @click="resetFilters">
            <UiIcon name="x" :size="13" />
            {{ t("systemLogs.filters.reset") }}
          </button>
        </div>

        <Transition
          enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
          leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
          enter-from-class="-translate-y-1 opacity-0"
          leave-to-class="-translate-y-1 opacity-0"
        >
          <div v-if="advancedOpen" id="syslog-advanced-filters" class="rounded-lg border border-line/70 bg-surface-2/30 p-3">
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <label v-for="k in TEXT_FILTER_KEYS" :key="k" class="block min-w-0">
                <span class="label">{{ fieldLabel(k) }}</span>
                <input
                  :id="fieldInputId(k)"
                  v-model="text[k]"
                  type="text"
                  autocomplete="off"
                  spellcheck="false"
                  class="input input-sm font-mono"
                  :maxlength="TEXT_FILTER_MAX[k]"
                  :placeholder="t(`systemLogs.filters.placeholders.${k}`)"
                  @keydown.enter.prevent="applyTextNow"
                />
              </label>
            </div>
            <p class="hint">{{ t("systemLogs.filters.exactHint") }}</p>
          </div>
        </Transition>

        <!-- Active exact-match filters while the panel is folded -->
        <div v-if="!advancedOpen && advancedCount" class="flex flex-wrap items-center gap-1.5">
          <template v-for="k in TEXT_FILTER_KEYS" :key="k">
            <span
              v-if="applied.text[k]"
              class="inline-flex max-w-full items-center gap-1 rounded-full bg-accent/10 py-0.5 pl-2.5 pr-1 text-2xs text-accent ring-1 ring-inset ring-accent/20"
            >
              <span class="shrink-0">{{ fieldLabel(k) }}</span>
              <span class="truncate font-mono text-fg" :title="applied.text[k]">{{ applied.text[k] }}</span>
              <button
                type="button"
                class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-accent/20"
                :aria-label="t('systemLogs.filters.remove', { field: fieldLabel(k) })"
                @click="setTextFilter(k, '')"
              >
                <UiIcon name="x" :size="10" />
              </button>
            </span>
          </template>
        </div>
      </div>

      <!-- Refresh failure while older rows stay on screen -->
      <div v-if="loaded && loadError" class="border-b border-line/70 px-5 py-3">
        <UiAlert tone="warning" :title="t('systemLogs.errors.staleTitle')">
          {{ loadError.message }}
          <SystemLogErrorMeta :error="loadError" />
          <template #action>
            <button type="button" class="btn btn-secondary btn-xs shrink-0" :disabled="loading" @click="load">
              {{ t("systemLogs.retry") }}
            </button>
          </template>
        </UiAlert>
      </div>

      <ListSkeleton v-if="!loaded && (loading || !loadError)" :rows="8" dense />

      <EmptyState v-else-if="!loaded && loadError" icon="alert" :title="t('systemLogs.errors.load')">
        <div class="flex w-full max-w-md flex-col items-center gap-3">
          <p class="text-xs text-fg-subtle">
            {{ loadError.message }}
            <SystemLogErrorMeta :error="loadError" class="items-center" />
          </p>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="load">
            <UiIcon name="refresh" :size="13" :spin="loading" />
            {{ t("systemLogs.retry") }}
          </button>
        </div>
      </EmptyState>

      <EmptyState v-else-if="items.length === 0 && !hasFilters" icon="terminal" :title="t('systemLogs.list.empty')">
        <div class="flex w-full max-w-md flex-col items-center gap-3">
          <p class="text-xs text-fg-subtle">{{ t("systemLogs.list.emptyHint") }}</p>
          <button v-if="widerRange" type="button" class="btn btn-secondary btn-sm" @click="timeChoice = widerRange">
            <UiIcon name="clock" :size="13" />
            {{ t("systemLogs.list.widen", { range: t(`systemLogs.time.ranges.${RANGE_KEY[widerRange]}`) }) }}
          </button>
        </div>
      </EmptyState>

      <EmptyState v-else-if="items.length === 0" icon="search" :title="t('systemLogs.list.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="13" />
          {{ t("systemLogs.filters.reset") }}
        </button>
      </EmptyState>

      <template v-else>
        <!-- Desktop table -->
        <div class="table-wrap hidden transition-opacity duration-200 md:block" :class="loading ? 'opacity-60' : ''" :aria-busy="loading">
          <!-- Fixed layout: the message column takes whatever width is left and clamps. -->
          <table class="data-table min-w-[42rem] table-fixed">
            <thead>
              <tr>
                <th class="w-[7.5rem]">{{ t("systemLogs.table.time") }}</th>
                <th class="w-[6rem]">{{ t("systemLogs.table.level") }}</th>
                <th class="w-[9rem] xl:w-[12rem]">{{ t("systemLogs.table.component") }}</th>
                <th>{{ t("systemLogs.table.message") }}</th>
                <th class="hidden w-[9rem] xl:table-cell">{{ t("systemLogs.table.host") }}</th>
                <th class="w-16"><span class="sr-only">{{ t("systemLogs.table.details") }}</span></th>
              </tr>
            </thead>
            <!-- Rows animate when they mount (new page, new filter, or arrived by tail); kept rows stay still. -->
            <tbody>
              <tr
                v-for="(r, i) in rows"
                :key="r.item.id"
                class="row-in cursor-pointer"
                :class="freshIds.has(r.item.id) ? 'row-fresh' : ''"
                :style="rowDelay(i)"
                @click="openDetail(r.item)"
              >
                <td
                  class="relative whitespace-nowrap before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-r-full"
                  :class="LEVEL_EDGE[r.item.level]"
                >
                  <p class="font-mono text-xs tabular-nums text-fg" :title="formatRelative(r.item.createdAtIso)">
                    {{ formatLogClock(r.item.createdAtIso) }}
                  </p>
                  <p class="mt-0.5 text-2xs tabular-nums text-fg-subtle">{{ formatLogDate(r.item.createdAtIso) }}</p>
                </td>
                <td>
                  <UiBadge :tone="LEVEL_TONE[r.item.level]" dot mono>{{ r.item.level }}</UiBadge>
                </td>
                <td>
                  <div class="flex min-w-0 items-center gap-1.5">
                    <UiBadge :tone="SOURCE_TONE[r.item.source]" mono class="shrink-0">{{ r.item.source }}</UiBadge>
                    <button
                      v-if="r.item.component"
                      type="button"
                      class="min-w-0 truncate rounded font-mono text-2xs text-fg-muted transition-colors hover:text-accent focus-visible:text-accent"
                      :title="`${t('systemLogs.detail.filterBy', { field: fieldLabel('component') })}: ${r.item.component}`"
                      @click.stop="setTextFilter('component', r.item.component)"
                    >
                      {{ r.item.component }}
                    </button>
                  </div>
                </td>
                <td>
                  <p class="line-clamp-2 break-words text-xs text-fg" :title="r.item.message">{{ r.item.message || "-" }}</p>
                  <div
                    v-if="r.http || r.error || r.item.requestId"
                    class="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-subtle"
                  >
                    <template v-if="r.http">
                      <span v-if="r.http.method" class="font-mono">{{ r.http.method }}</span>
                      <span v-if="r.http.status !== null" class="font-mono" :class="r.statusClass">{{ r.http.status }}</span>
                    </template>
                    <span v-else-if="r.error" class="max-w-full truncate text-danger" :title="r.error">{{ r.error }}</span>
                    <button
                      v-if="r.item.requestId"
                      type="button"
                      class="inline-flex min-w-0 max-w-[12rem] items-center gap-1 rounded font-mono transition-colors hover:text-accent focus-visible:text-accent"
                      :title="`${t('systemLogs.detail.filterBy', { field: fieldLabel('requestId') })}: ${r.item.requestId}`"
                      @click.stop="setTextFilter('requestId', r.item.requestId)"
                    >
                      <UiIcon name="link" :size="10" class="shrink-0" />
                      <span class="truncate">{{ r.item.requestId }}</span>
                    </button>
                  </div>
                </td>
                <td class="hidden xl:table-cell">
                  <span class="block truncate font-mono text-2xs text-fg-muted" :title="r.item.host">{{ r.item.host || "-" }}</span>
                </td>
                <td class="w-10 text-right">
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :title="t('systemLogs.table.details')"
                    :aria-label="t('systemLogs.table.details')"
                    @click.stop="openDetail(r.item)"
                  >
                    <UiIcon name="chevron-right" :size="14" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Phone cards -->
        <ul class="divide-y divide-line/60 transition-opacity duration-200 md:hidden" :class="loading ? 'opacity-60' : ''" :aria-busy="loading">
          <li v-for="(r, i) in rows" :key="r.item.id" class="row-in relative" :style="rowDelay(i)">
            <span
              class="absolute inset-y-3 left-0 w-[3px] rounded-r-full before:absolute before:inset-0 before:rounded-r-full"
              :class="LEVEL_EDGE[r.item.level]"
              aria-hidden="true"
            />
            <button
              type="button"
              class="block w-full px-4 py-3 text-left transition-colors hover:bg-surface-2/50 focus:outline-none focus-visible:bg-surface-2/60"
              :class="freshIds.has(r.item.id) ? 'row-fresh' : ''"
              @click="openDetail(r.item)"
            >
              <span class="flex items-center gap-2">
                <UiBadge :tone="LEVEL_TONE[r.item.level]" dot mono>{{ r.item.level }}</UiBadge>
                <UiBadge :tone="SOURCE_TONE[r.item.source]" mono>{{ r.item.source }}</UiBadge>
                <span class="min-w-0 flex-1 truncate font-mono text-2xs text-fg-muted">{{ r.item.component }}</span>
                <span class="shrink-0 font-mono text-2xs tabular-nums text-fg-subtle">{{ formatLogClock(r.item.createdAtIso) }}</span>
              </span>
              <span class="mt-1.5 line-clamp-3 block break-words text-xs text-fg">{{ r.item.message || "-" }}</span>
              <span v-if="r.item.requestId || r.http" class="mt-1 flex min-w-0 items-center gap-2 text-2xs text-fg-subtle">
                <span v-if="r.http && r.http.status !== null" class="shrink-0 font-mono" :class="r.statusClass">
                  {{ r.http.method }} {{ r.http.status }}
                </span>
                <span v-if="r.item.requestId" class="truncate font-mono">{{ r.item.requestId }}</span>
              </span>
            </button>
          </li>
        </ul>

        <UiPagination
          v-if="total > 0"
          v-model:page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="PAGE_SIZES"
          :disabled="loading"
        />
      </template>
    </UiCard>

    <SystemLogDetailDrawer
      v-model:open="detailOpen"
      :item="detailItem"
      :has-newer="detailIndex > 0"
      :has-older="detailIndex >= 0 && detailIndex < items.length - 1"
      @navigate="navigateDetail"
      @filter="filterFromDetail"
    />
    <SystemLogCleanupModal
      v-model:open="cleanupOpen"
      :body="cleanupBody"
      :conditions="cleanupConditions"
      :match-count="total"
      @cleaned="onCleaned"
    />
  </div>
</template>

<style scoped>
/*
 * A row rises in once, when it mounts (a new page or filter, or an entry the tail brought in);
 * rows that stay across a refresh keep their element and do not move. Rows that just arrived by
 * live tail also glow briefly (no fill mode on the glow, so hover still works afterwards).
 */
.row-in {
  animation: syslog-row-in 200ms cubic-bezier(0.2, 0, 0, 1) both;
}
.row-fresh {
  animation: syslog-fresh 2400ms cubic-bezier(0.2, 0, 0, 1);
}
.row-in.row-fresh {
  animation:
    syslog-row-in 200ms cubic-bezier(0.2, 0, 0, 1) both,
    syslog-fresh 2400ms cubic-bezier(0.2, 0, 0, 1);
}
@keyframes syslog-row-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@keyframes syslog-fresh {
  from {
    background-color: rgb(var(--accent) / 0.12);
  }
  to {
    background-color: transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .row-in,
  .row-in.row-fresh {
    animation: none;
  }
  .row-fresh {
    animation: none;
    background-color: rgb(var(--accent) / 0.06);
  }
}
</style>
