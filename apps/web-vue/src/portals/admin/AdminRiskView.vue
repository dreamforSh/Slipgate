<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { RiskBanEvent } from "@slipgate/contracts";
import RiskLadderCard from "../../components/admin/ops-monitor/RiskLadderCard.vue";
import RiskModerationPanel from "../../components/admin/ops-monitor/RiskModerationPanel.vue";
import { staggerStyle } from "../../components/admin/ops-monitor/opsFormat";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import UiPagination from "../../components/ui/UiPagination.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { useNow } from "../../composables/useNow";
import { apiJson, errorText } from "../../lib/api";
import { formatDateTime, formatNumber, formatRelative, shortHash, type Tone } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

type Kind = RiskBanEvent["subjectKind"];
type Duration = RiskBanEvent["banDuration"];

interface RiskEventsResponse {
  events: RiskBanEvent[];
  banLadder?: string[];
  exemptOrdinaryUpstream400?: boolean;
}

const { t } = useI18n();
const toast = useToastStore();
const now = useNow(60_000);

type RiskTab = "bans" | "moderation" | "events";
const tab = ref<RiskTab>("bans");
const moderationVisited = ref(false);
const eventsVisited = ref(false);
const refreshToken = ref(0);

const tabs = computed(() => [
  { key: "bans" as RiskTab, label: t("security.risk.tabs.bans"), icon: "shield-alert" as const },
  { key: "moderation" as RiskTab, label: t("security.risk.tabs.moderation"), icon: "sliders" as const },
  { key: "events" as RiskTab, label: t("security.risk.tabs.events"), icon: "list" as const },
]);

watch(tab, (val) => {
  if (val === "moderation") moderationVisited.value = true;
  if (val === "events") eventsVisited.value = true;
});

const KINDS: Kind[] = ["device", "session", "api_key", "ip"];
const DURATIONS: Duration[] = ["10m", "24h", "permanent"];

const KIND_ICON: Record<Kind, IconName> = { device: "monitor", session: "fingerprint", api_key: "key", ip: "globe" };
const DURATION_TONE: Record<Duration, Tone> = { "10m": "info", "24h": "warning", permanent: "danger" };
const STRIKE_TONE: Record<number, Tone> = { 1: "info", 2: "warning", 3: "danger" };

const events = ref<RiskBanEvent[]>([]);
const exempt = ref(true);
const loading = ref(false);
const loaded = ref(false);
const errorMessage = ref<string | null>(null);
useFeedbackToasts(errorMessage);

async function load() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await apiJson<RiskEventsResponse>("/api/v1/admin/risk/events?limit=200", {
      fallbackError: t("security.risk.errors.load"),
    });
    events.value = [...res.events].sort((a, b) => (a.createdAtIso < b.createdAtIso ? 1 : -1));
    exempt.value = res.exemptOrdinaryUpstream400 !== false;
    loaded.value = true;
  } catch (err) {
    errorMessage.value = errorText(err, t("security.risk.errors.load"));
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());

/* ---------------- Stats ---------------- */

const DAY_MS = 86_400_000;
const durationCounts = computed(() => {
  const out: Record<Duration, number> = { "10m": 0, "24h": 0, permanent: 0 };
  for (const e of events.value) out[e.banDuration] += 1;
  return out;
});
const last24h = computed(() => events.value.filter((e) => now.value - Date.parse(e.createdAtIso) < DAY_MS).length);

const stats = computed<{ key: string; label: string; value: string; hint?: string; icon: IconName; tone: Tone }[]>(() => [
  {
    key: "total",
    label: t("security.risk.stats.total"),
    value: loaded.value ? formatNumber(events.value.length) : "—",
    hint: t("security.risk.stats.totalHint"),
    icon: "shield-alert",
    tone: "accent",
  },
  {
    key: "permanent",
    label: t("security.risk.stats.permanent"),
    value: loaded.value ? formatNumber(durationCounts.value.permanent) : "—",
    icon: "lock",
    tone: durationCounts.value.permanent > 0 ? "danger" : "neutral",
  },
  {
    key: "day",
    label: t("security.risk.stats.day"),
    value: loaded.value ? formatNumber(durationCounts.value["24h"]) : "—",
    icon: "calendar",
    tone: "warning",
  },
  {
    key: "recent",
    label: t("security.risk.stats.last24h"),
    value: loaded.value ? formatNumber(last24h.value) : "—",
    hint: t("security.risk.stats.last24hHint"),
    icon: "clock",
    tone: last24h.value > 0 ? "info" : "neutral",
  },
]);

/* ---------------- Filters + paging ---------------- */

const kindFilter = ref<"all" | Kind>("all");
const durationFilter = ref<"all" | Duration>("all");
const page = ref(1);
const pageSize = ref(20);

const kindOptions = computed(() => [
  { value: "all" as const, label: t("security.risk.filters.all"), count: events.value.length },
  ...KINDS.map((k) => ({
    value: k,
    label: t(`security.risk.kinds.${k}`),
    count: events.value.filter((e) => e.subjectKind === k).length,
  })),
]);
const durationOptions = computed(() => [
  { value: "all" as const, label: t("security.risk.filters.all") },
  ...DURATIONS.map((d) => ({ value: d, label: t(`security.risk.durations.${d}`) })),
]);

const filtered = computed(() =>
  events.value.filter(
    (e) =>
      (kindFilter.value === "all" || e.subjectKind === kindFilter.value) &&
      (durationFilter.value === "all" || e.banDuration === durationFilter.value),
  ),
);
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));
const hasFilters = computed(() => kindFilter.value !== "all" || durationFilter.value !== "all");

watch([kindFilter, durationFilter, pageSize], () => (page.value = 1));

function resetFilters() {
  kindFilter.value = "all";
  durationFilter.value = "all";
}

const clearingAll = ref(false);
const unbanningId = ref<string | null>(null);

function banStateOf(e: RiskBanEvent): "active" | "unbanned" | "expired" {
  if (e.unbannedAtIso) return "unbanned";
  if (e.active === false) return "expired";
  return "active";
}

async function unbanEvent(e: RiskBanEvent) {
  if (!e.subjectHash) return;
  unbanningId.value = e.eventId;
  try {
    const res = await apiJson<{ ok: boolean; unbanned: number }>("/api/v1/admin/risk/unban", {
      method: "POST",
      body: { subjectKind: e.subjectKind, subjectHash: e.subjectHash },
      fallbackError: t("security.risk.errors.unban"),
    });
    toast.success(t("security.risk.unbanDone", { n: formatNumber(res.unbanned) }));
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.risk.errors.unban")));
  } finally {
    unbanningId.value = null;
  }
}

async function clearAllBans() {
  clearingAll.value = true;
  try {
    const res = await apiJson<{ ok: boolean; unbanned: number; refusalCacheCleared: number }>("/api/v1/admin/risk/clear-cache", {
      method: "POST",
      fallbackError: t("security.risk.errors.clearAll"),
    });
    toast.success(
      t("security.risk.clearAllDone", {
        unbanned: formatNumber(res.unbanned),
        cache: formatNumber(res.refusalCacheCleared),
      }),
    );
    await load();
  } catch (err) {
    toast.error(errorText(err, t("security.risk.errors.clearAll")));
  } finally {
    clearingAll.value = false;
  }
}

function refreshActiveTab() {
  refreshToken.value += 1;
  void load();
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.risk')">
      <template #actions>
        <div class="flex flex-wrap items-center gap-2">
          <ConfirmButton
            size="sm"
            icon="rotate-ccw"
            :label="t('security.risk.clearAll')"
            :confirm-label="t('security.risk.confirmClearAll')"
            :disabled="clearingAll"
            @confirm="clearAllBans"
          />
          <button type="button" class="btn btn-secondary" :disabled="loading" @click="refreshActiveTab">
            <UiIcon name="refresh" :size="15" :spin="loading" />
            {{ t("common.refresh") }}
          </button>
        </div>
      </template>
    </PageHeader>

    <UiTabs v-model="tab" :items="tabs" />

    <div v-show="tab === 'bans'" class="space-y-6">

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
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

    <RiskLadderCard
      class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
      :style="staggerStyle(4, 40)"
      :counts="durationCounts"
      :exempt-upstream400="exempt"
    />

    <UiCard icon="list" :title="t('security.risk.list.title')" flush>
      <template #actions>
        <span v-if="loaded" class="font-mono text-xs tabular-nums text-fg-subtle">
          {{ hasFilters ? `${filtered.length} / ${events.length}` : events.length }}
        </span>
      </template>

      <div class="flex flex-col gap-2 border-b border-line/70 px-4 py-3 sm:px-5 lg:flex-row lg:items-center">
        <div class="scrollbar-hide -mx-1 overflow-x-auto px-1">
          <SegmentedControl v-model="kindFilter" :options="kindOptions" />
        </div>
        <div class="scrollbar-hide -mx-1 overflow-x-auto px-1 lg:ml-auto">
          <SegmentedControl v-model="durationFilter" :options="durationOptions" />
        </div>
      </div>

      <div v-if="!loaded && loading" class="divide-y divide-line/60" aria-busy="true">
        <div v-for="i in 5" :key="i" class="flex animate-pulse items-center gap-4 px-5 py-3.5">
          <span class="h-3 w-24 rounded bg-surface-2" />
          <span class="h-5 w-16 rounded-full bg-surface-2" />
          <span class="h-3 flex-1 rounded bg-surface-2" />
          <span class="hidden h-3 w-12 rounded bg-surface-2 sm:block" />
        </div>
      </div>

      <EmptyState v-else-if="loaded && events.length === 0" icon="shield" :title="t('security.risk.list.empty')" />
      <EmptyState v-else-if="loaded && filtered.length === 0" icon="filter" :title="t('security.risk.list.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("security.risk.filters.clear") }}
        </button>
      </EmptyState>

      <template v-else-if="loaded">
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("security.risk.table.time") }}</th>
                <th>{{ t("security.risk.table.subject") }}</th>
                <th>{{ t("security.risk.table.status") }}</th>
                <th>{{ t("security.risk.table.strike") }}</th>
                <th>{{ t("security.risk.table.duration") }}</th>
                <th>{{ t("security.risk.table.reason") }}</th>
                <th class="text-right">{{ t("security.risk.table.upstream400") }}</th>
                <th class="text-right">{{ t("security.risk.table.downgraded") }}</th>
                <th class="text-right">{{ t("common.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(e, i) in paged"
                :key="e.eventId"
                class="animate-slide-up [animation-fill-mode:backwards] motion-reduce:animate-none"
                :style="staggerStyle(i, 20, 12)"
              >
                <td class="whitespace-nowrap">
                  <p class="text-xs text-fg">{{ formatRelative(e.createdAtIso, now) }}</p>
                  <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ formatDateTime(e.createdAtIso) }}</p>
                </td>
                <td class="whitespace-nowrap">
                  <div class="flex items-center gap-2 text-xs text-fg">
                    <span class="icon-chip h-6 w-6"><UiIcon :name="KIND_ICON[e.subjectKind]" :size="13" /></span>
                    <div>
                      <p>{{ t(`security.risk.kinds.${e.subjectKind}`) }}</p>
                      <p v-if="e.subjectHash" class="font-mono text-2xs text-fg-subtle" :title="e.subjectHash">
                        {{ shortHash(e.subjectHash, 14) }}
                      </p>
                    </div>
                  </div>
                </td>
                <td>
                  <UiBadge :tone="banStateOf(e) === 'active' ? 'danger' : 'neutral'" dot>
                    {{ t(`security.risk.states.${banStateOf(e)}`) }}
                  </UiBadge>
                </td>
                <td>
                  <UiBadge :tone="STRIKE_TONE[e.strikeLevel] ?? 'neutral'" dot>{{ t("security.risk.strike", { n: e.strikeLevel }) }}</UiBadge>
                </td>
                <td>
                  <UiBadge :tone="DURATION_TONE[e.banDuration]">
                    <UiIcon v-if="e.banDuration === 'permanent'" name="lock" :size="10" class="-ml-0.5 mr-0.5 inline" />
                    {{ t(`security.risk.durations.${e.banDuration}`) }}
                  </UiBadge>
                </td>
                <td class="max-w-[16rem]">
                  <span class="code-chip max-w-full truncate" :title="e.reason">{{ e.reason }}</span>
                </td>
                <td class="text-right font-mono text-xs tabular-nums" :class="e.ordinaryUpstream400Count > 0 ? 'text-fg' : 'text-fg-subtle'">
                  {{ formatNumber(e.ordinaryUpstream400Count) }}
                </td>
                <td class="text-right font-mono text-xs tabular-nums" :class="e.downgradedCount > 0 ? 'text-warning' : 'text-fg-subtle'">
                  {{ formatNumber(e.downgradedCount) }}
                </td>
                <td class="text-right whitespace-nowrap">
                  <button
                    v-if="banStateOf(e) === 'active' && e.subjectHash"
                    type="button"
                    class="btn btn-secondary btn-xs"
                    :disabled="unbanningId === e.eventId"
                    @click="unbanEvent(e)"
                  >
                    <UiIcon :name="unbanningId === e.eventId ? 'loader' : 'rotate-ccw'" :size="12" :spin="unbanningId === e.eventId" />
                    {{ t("security.risk.unban") }}
                  </button>
                  <span v-else class="text-2xs text-fg-subtle">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <UiPagination
          v-if="filtered.length > 0"
          v-model:page="page"
          v-model:page-size="pageSize"
          :total="filtered.length"
          :page-sizes="[20, 50, 100]"
        />
      </template>
    </UiCard>
    </div>

    <RiskModerationPanel
      v-if="moderationVisited"
      v-show="tab === 'moderation'"
      mode="moderation"
      :now="now"
      :refresh-token="refreshToken"
    />

    <RiskModerationPanel
      v-if="eventsVisited"
      v-show="tab === 'events'"
      mode="events"
      :now="now"
      :refresh-token="refreshToken"
    />
  </div>
</template>
