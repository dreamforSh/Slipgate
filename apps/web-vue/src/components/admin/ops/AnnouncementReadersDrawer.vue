<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  AnnouncementEligibleFilter,
  AnnouncementItem,
  AnnouncementReadFilter,
  AnnouncementReadStatusItem,
  AnnouncementReadStatusResponse,
  AnnouncementReadStatusSort,
} from "@slipgate/contracts";
import EmptyState from "../../ui/EmptyState.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiPagination from "../../ui/UiPagination.vue";
import { ApiError, apiJson, toQuery } from "../../../lib/api";
import { formatDateTime, formatNumber, formatRelative } from "../../../lib/format";
import ListSkeleton from "./ListSkeleton.vue";
import { describeTargeting, isBrokenTargeting, targetingSentence, useSubscriptionGroups } from "./announcementTargeting";
import { formatUsdAny, STAGGER_CLASS, stagger, useDebounced } from "./opsUtil";

/**
 * Read status of one announcement across every account: read / unread, whether the account can
 * see it right now (audience role + targeting), searchable, filterable and paginated server-side.
 */
const props = defineProps<{ open: boolean; item: AnnouncementItem | null }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const { t } = useI18n();
const subGroups = useSubscriptionGroups();

type Stats = AnnouncementReadStatusResponse["stats"];

const items = ref<AnnouncementReadStatusItem[]>([]);
const total = ref(0);
const stats = ref<Stats | null>(null);
const loading = ref(false);
const loaded = ref(false);
const failure = ref<{ title: string; detail: string | null } | null>(null);

const search = ref("");
const debouncedSearch = useDebounced(search);
const readFilter = ref<AnnouncementReadFilter>("all");
const eligibleFilter = ref<AnnouncementEligibleFilter>("all");
const sort = ref<AnnouncementReadStatusSort>("email_asc");
const page = ref(1);
const pageSize = ref(20);

const readOptions = computed(() =>
  (["all", "read", "unread"] as const).map((value) => ({ value, label: t(`annAdmin.readStatus.readFilter.${value}`) })),
);
const eligibleOptions = computed(() =>
  (["all", "eligible", "ineligible"] as const).map((value) => ({ value, label: t(`annAdmin.readStatus.eligibleFilter.${value}`) })),
);
const sortOptions = computed(() =>
  (
    ["email_asc", "email_desc", "username_asc", "username_desc", "balance_desc", "balance_asc", "read_at_desc", "read_at_asc"] as const
  ).map((value) => ({
    value,
    label: t(`annAdmin.readStatus.sort.${value}`),
  })),
);

const hasFilters = computed(
  () => debouncedSearch.value.trim() !== "" || readFilter.value !== "all" || eligibleFilter.value !== "all",
);

/* ---------------- Loading ---------------- */

let controller: AbortController | null = null;
let scheduled = false;

function failureOf(err: unknown): { title: string; detail: string | null } {
  if (err instanceof ApiError) {
    if (err.status === 404) return { title: t("annAdmin.readStatus.errors.notFound"), detail: null };
    if (err.status === 403) return { title: t("annAdmin.readStatus.errors.forbidden"), detail: null };
    return { title: t("annAdmin.readStatus.errors.load"), detail: err.message || null };
  }
  return { title: t("annAdmin.readStatus.errors.load"), detail: t("common.networkError") };
}

async function load() {
  const id = props.item?.id;
  if (!props.open || !id) return;
  controller?.abort();
  const mine = new AbortController();
  controller = mine;
  loading.value = true;
  try {
    const res = await apiJson<AnnouncementReadStatusResponse>(
      `/api/v1/admin/announcements/${encodeURIComponent(id)}/read-status${toQuery({
        q: debouncedSearch.value.trim() || undefined,
        read: readFilter.value,
        eligible: eligibleFilter.value,
        sort: sort.value,
        page: page.value,
        pageSize: pageSize.value,
      })}`,
      { signal: mine.signal, fallbackError: t("annAdmin.readStatus.errors.load") },
    );
    if (controller !== mine) return;
    // The page fell off the end (accounts removed meanwhile): step back to the last one.
    const lastPage = Math.max(1, Math.ceil(res.total / pageSize.value));
    if (res.items.length === 0 && page.value > lastPage) {
      page.value = lastPage;
      return;
    }
    items.value = res.items;
    total.value = res.total;
    stats.value = res.stats;
    loaded.value = true;
    failure.value = null;
  } catch (err) {
    if (controller !== mine || mine.signal.aborted) return;
    failure.value = failureOf(err);
  } finally {
    if (controller === mine) {
      loading.value = false;
      controller = null;
    }
  }
}

function scheduleLoad() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    void load();
  });
}

function resetFilters() {
  search.value = "";
  debouncedSearch.value = "";
  readFilter.value = "all";
  eligibleFilter.value = "all";
}

watch(
  () => [props.open, props.item?.id] as const,
  ([open, id]) => {
    if (!open || !id) {
      controller?.abort();
      controller = null;
      loading.value = false;
      return;
    }
    resetFilters();
    sort.value = "email_asc";
    page.value = 1;
    items.value = [];
    total.value = 0;
    stats.value = null;
    loaded.value = false;
    failure.value = null;
    void subGroups.load();
    scheduleLoad();
  },
  { immediate: true },
);

watch([debouncedSearch, readFilter, eligibleFilter, sort, pageSize], () => {
  page.value = 1;
  scheduleLoad();
});
watch(page, scheduleLoad);

onBeforeUnmount(() => controller?.abort());

/* ---------------- Display ---------------- */

const readRate = computed(() => {
  const s = stats.value;
  if (!s || s.eligible === 0) return 0;
  return Math.min(1, s.eligibleRead / s.eligible);
});
const otherRead = computed(() => (stats.value ? Math.max(0, stats.value.read - stats.value.eligibleRead) : 0));

const targetingText = computed(() => {
  const rule = props.item?.targeting;
  if (!rule || rule.anyOf.length === 0) return null;
  if (isBrokenTargeting(rule)) return t("annAdmin.targeting.broken");
  const name = (id: string) => subGroups.byId.value.get(id)?.name ?? t("annAdmin.targeting.unknownGroup");
  return targetingSentence(describeTargeting(rule, name, t), t, true);
});

function initial(r: AnnouncementReadStatusItem): string {
  return (r.username || r.email).slice(0, 1) || "?";
}
</script>

<template>
  <UiDrawer :open="open" width="xl" :title="t('annAdmin.readStatus.title')" @update:open="emit('update:open', $event)">
    <div v-if="item" class="space-y-4">
      <!-- Announcement -->
      <div class="rounded-xl border border-line bg-surface-2/40 px-4 py-3">
        <p class="truncate text-sm font-semibold text-fg" :title="item.title">{{ item.title }}</p>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
          <span class="inline-flex items-center gap-1">
            <UiIcon name="users" :size="12" />
            {{ t(`annAdmin.audiences.${item.audience}`) }}
          </span>
          <span v-if="targetingText" class="inline-flex min-w-0 items-center gap-1">
            <UiIcon name="filter" :size="12" class="shrink-0 text-violet" />
            <span class="min-w-0 break-words">{{ targetingText }}</span>
          </span>
        </div>
        <p class="mt-2 text-2xs leading-relaxed text-fg-subtle">{{ t("annAdmin.readStatus.liveNote") }}</p>
      </div>

      <!-- Stats (over every account, ignoring filters) -->
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-live="polite">
        <template v-if="stats">
          <div class="rounded-lg border border-line px-3 py-2.5">
            <p class="truncate text-2xs text-fg-subtle">{{ t("annAdmin.readStatus.stats.users") }}</p>
            <p class="mt-1 text-lg font-semibold tabular-nums text-fg">{{ formatNumber(stats.users) }}</p>
          </div>
          <div class="rounded-lg border border-line px-3 py-2.5">
            <p class="truncate text-2xs text-fg-subtle">{{ t("annAdmin.readStatus.stats.eligible") }}</p>
            <p class="mt-1 text-lg font-semibold tabular-nums text-info">{{ formatNumber(stats.eligible) }}</p>
          </div>
          <div class="rounded-lg border border-line px-3 py-2.5">
            <p class="truncate text-2xs text-fg-subtle">{{ t("annAdmin.readStatus.stats.read") }}</p>
            <p class="mt-1 text-lg font-semibold tabular-nums text-success">{{ formatNumber(stats.eligibleRead) }}</p>
          </div>
          <div class="rounded-lg border border-line px-3 py-2.5">
            <p class="truncate text-2xs text-fg-subtle">{{ t("annAdmin.readStatus.stats.rate") }}</p>
            <p class="mt-1 text-lg font-semibold tabular-nums text-fg">{{ Math.round(readRate * 100) }}%</p>
          </div>
        </template>
        <template v-else>
          <div v-for="i in 4" :key="i" class="rounded-lg border border-line px-3 py-2.5" aria-hidden="true">
            <span class="block h-2 w-16 rounded-full bg-surface-2 motion-safe:animate-pulse" />
            <span class="mt-2.5 block h-4 w-10 rounded bg-surface-2 motion-safe:animate-pulse" />
          </div>
        </template>
      </div>
      <div v-if="stats" class="space-y-1.5">
        <div
          class="h-1.5 overflow-hidden rounded-full bg-surface-2"
          role="progressbar"
          :aria-valuenow="Math.round(readRate * 100)"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-label="t('annAdmin.readStatus.stats.rate')"
        >
          <div
            class="h-full w-full origin-left rounded-full bg-success transition-transform duration-500 ease-out motion-reduce:transition-none"
            :style="{ transform: `scaleX(${readRate})` }"
          />
        </div>
        <p class="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-2xs text-fg-subtle">
          <span>{{ t("annAdmin.readStatus.stats.rateDetail", { read: formatNumber(stats.eligibleRead), eligible: formatNumber(stats.eligible) }) }}</span>
          <span v-if="otherRead > 0">{{ t("annAdmin.readStatus.stats.otherRead", { n: formatNumber(otherRead) }) }}</span>
        </p>
      </div>

      <!-- Filters -->
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <label class="relative min-w-0 flex-1 basis-48">
            <span class="sr-only">{{ t("common.search") }}</span>
            <UiIcon
              name="search"
              :size="14"
              class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
            />
            <input
              v-model="search"
              type="search"
              maxlength="200"
              class="input input-sm pl-8"
              :placeholder="t('annAdmin.readStatus.searchPlaceholder')"
            />
          </label>
          <button
            type="button"
            class="btn btn-secondary btn-sm btn-icon"
            :disabled="loading"
            :title="t('common.refresh')"
            :aria-label="t('common.refresh')"
            @click="load"
          >
            <UiIcon name="refresh" :size="14" :spin="loading" />
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="scrollbar-hide max-w-full overflow-x-auto">
            <SegmentedControl v-model="readFilter" :options="readOptions" :aria-label="t('annAdmin.readStatus.readFilter.label')" />
          </div>
          <select v-model="eligibleFilter" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('annAdmin.readStatus.eligibleFilter.label')">
            <option v-for="o in eligibleOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <select v-model="sort" class="select input-sm w-auto min-w-[8rem]" :aria-label="t('annAdmin.readStatus.sort.label')">
            <option v-for="o in sortOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
      </div>

      <UiAlert v-if="failure && loaded" tone="danger" :title="failure.title">
        <span v-if="failure.detail">{{ failure.detail }}</span>
        <template #action>
          <button type="button" class="btn btn-secondary btn-xs self-center" :disabled="loading" @click="load">
            {{ t("annAdmin.readStatus.retry") }}
          </button>
        </template>
      </UiAlert>

      <!-- Accounts -->
      <div class="overflow-hidden rounded-xl border border-line">
        <ListSkeleton v-if="!loaded && !failure" :rows="6" dense />
        <EmptyState v-else-if="!loaded && failure" icon="alert" :title="failure.title" compact>
          <p v-if="failure.detail" class="w-full max-w-xs text-xs text-fg-subtle">{{ failure.detail }}</p>
          <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="load">
            <UiIcon name="refresh" :size="13" :spin="loading" />
            {{ t("annAdmin.readStatus.retry") }}
          </button>
        </EmptyState>
        <EmptyState v-else-if="items.length === 0 && !hasFilters" icon="users" :title="t('annAdmin.readStatus.empty')" compact />
        <EmptyState v-else-if="items.length === 0" icon="search" :title="t('annAdmin.readStatus.noMatch')" compact>
          <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
            <UiIcon name="x" :size="13" />
            {{ t("annAdmin.readStatus.clearFilters") }}
          </button>
        </EmptyState>
        <ul
          v-else
          class="divide-y divide-line/60 transition-opacity duration-200 motion-reduce:transition-none"
          :class="loading ? 'opacity-60' : ''"
          :aria-busy="loading"
        >
          <li
            v-for="(r, i) in items"
            :key="r.userId"
            class="flex items-start gap-3 px-4 py-3 sm:items-center"
            :class="STAGGER_CLASS"
            :style="stagger(i, 18)"
          >
            <span
              class="icon-chip h-8 w-8 text-xs font-semibold uppercase"
              :class="r.eligible ? 'icon-chip-accent' : ''"
              aria-hidden="true"
            >
              {{ initial(r) }}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                <p class="min-w-0 max-w-full truncate text-sm text-fg" :title="r.email">{{ r.email }}</p>
                <UiBadge v-if="r.role === 'admin'" tone="accent">{{ t("shell.roles.admin") }}</UiBadge>
                <UiBadge v-if="r.status === 'suspended'" tone="warning">{{ t("annAdmin.readStatus.suspended") }}</UiBadge>
              </div>
              <p class="mt-0.5 truncate text-2xs text-fg-subtle">
                <span v-if="r.username">{{ r.username }} · </span>
                <span class="tabular-nums">{{ t("annAdmin.readStatus.balance", { amount: formatUsdAny(r.balanceNanoUsd) }) }}</span>
              </p>
            </div>
            <div class="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
              <UiBadge
                :tone="r.eligible ? 'info' : 'neutral'"
                :title="r.eligible ? t('annAdmin.readStatus.eligibleHint') : t('annAdmin.readStatus.ineligibleHint')"
              >
                {{ r.eligible ? t("annAdmin.readStatus.eligible") : t("annAdmin.readStatus.ineligible") }}
              </UiBadge>
              <span class="flex flex-col items-end sm:w-24">
                <UiBadge :tone="r.read ? 'success' : 'neutral'" dot>
                  {{ r.read ? t("annAdmin.readStatus.read") : t("annAdmin.readStatus.unread") }}
                </UiBadge>
                <span
                  v-if="r.readAtIso"
                  class="mt-0.5 whitespace-nowrap text-2xs text-fg-subtle"
                  :title="formatDateTime(r.readAtIso)"
                >
                  {{ formatRelative(r.readAtIso) }}
                </span>
              </span>
            </div>
          </li>
        </ul>
        <UiPagination
          v-if="loaded && total > 0"
          v-model:page="page"
          v-model:page-size="pageSize"
          :total="total"
          :disabled="loading"
        />
      </div>
    </div>
  </UiDrawer>
</template>
