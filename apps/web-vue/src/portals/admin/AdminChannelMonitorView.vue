<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { UpstreamAccount } from "@slipgate/contracts";
import AccountTestModal from "../../components/admin/AccountTestModal.vue";
import PlatformTypeBadge from "../../components/admin/accounts/PlatformTypeBadge.vue";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import { STAGGER_CLASS, stagger } from "../../components/admin/ops/opsUtil";
import AutoTestScheduleCard from "../../components/admin/tools/AutoTestScheduleCard.vue";
import { formatInterval, type AutoTestConfig } from "../../components/admin/tools/toolsTypes";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { apiJson, errorText } from "../../lib/api";
import {
  accountStatusLabel,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatRelative,
  healthTone,
  type Tone,
} from "../../lib/format";

const { t } = useI18n();

/* ---------------- Clock ---------------- */

const now = ref(Date.now());
let clock: number | undefined;

/* ---------------- Accounts ---------------- */

const accounts = ref<UpstreamAccount[]>([]);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);
let inflight: Promise<void> | null = null;

async function fetchAccounts(silent: boolean) {
  if (!silent) loading.value = true;
  try {
    const res = await apiJson<{ accounts: UpstreamAccount[] }>("/api/v1/admin/accounts", {
      fallbackError: t("adminTools.monitor.errors.loadAccounts"),
    });
    accounts.value = res.accounts;
    loaded.value = true;
    loadError.value = null;
    now.value = Date.now();
  } catch (err) {
    if (!silent || !loaded.value) loadError.value = errorText(err, t("adminTools.monitor.errors.loadAccounts"));
  } finally {
    loading.value = false;
  }
}

/** Coalesces overlapping reloads (polling + manual refresh + row tests). */
function load(silent = false): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchAccounts(silent).finally(() => (inflight = null));
  return inflight;
}

/* ---------------- Classification ---------------- */

type Health = "ok" | "failed" | "never" | "vm";
type Filter = "all" | "failing" | "never" | "healthy";

const intervalMinutes = ref(60);
const staleAfterMs = computed(() => intervalMinutes.value * 60_000 * 2);

function onConfig(cfg: AutoTestConfig) {
  intervalMinutes.value = cfg.intervalMinutes;
}

function healthOf(a: UpstreamAccount): Health {
  if (a.lastTest) return a.lastTest.ok ? "ok" : "failed";
  return a.executionMode === "vm_slot" ? "vm" : "never";
}

function isStale(a: UpstreamAccount): boolean {
  if (!a.lastTest) return false;
  const at = Date.parse(a.lastTest.atIso);
  return Number.isFinite(at) && now.value - at > staleAfterMs.value;
}

const stats = computed(() => {
  let tested = 0;
  let healthy = 0;
  let failing = 0;
  let never = 0;
  let stale = 0;
  for (const a of accounts.value) {
    const h = healthOf(a);
    if (h === "ok" || h === "failed") tested++;
    if (h === "ok") healthy++;
    if (h === "failed") failing++;
    if (h === "never") never++;
    if (isStale(a)) stale++;
  }
  return { total: accounts.value.length, tested, healthy, failing, never, stale };
});

const passRate = computed(() =>
  stats.value.tested ? `${((stats.value.healthy / stats.value.tested) * 100).toFixed(stats.value.healthy === stats.value.tested ? 0 : 1)}%` : "-",
);

const filter = ref<Filter>("all");
const search = ref("");

const filterOptions = computed(() => [
  { value: "all" as const, label: t("adminTools.monitor.health.filters.all"), count: stats.value.total },
  { value: "failing" as const, label: t("adminTools.monitor.health.filters.failing"), count: stats.value.failing },
  { value: "never" as const, label: t("adminTools.monitor.health.filters.never"), count: stats.value.never },
  { value: "healthy" as const, label: t("adminTools.monitor.health.filters.healthy"), count: stats.value.healthy },
]);

const HEALTH_RANK: Record<Health, number> = { failed: 0, never: 1, ok: 2, vm: 3 };

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return accounts.value
    .filter((a) => {
      const h = healthOf(a);
      if (filter.value === "failing" && h !== "failed") return false;
      if (filter.value === "never" && h !== "never") return false;
      if (filter.value === "healthy" && h !== "ok") return false;
      if (!q) return true;
      return [a.name, a.groupName, a.platform, a.lastTest?.model ?? "", a.lastTest?.message ?? ""].some((v) =>
        v.toLowerCase().includes(q),
      );
    })
    .sort((a, b) => {
      // Problems first: failures, never tested, stale passes, then fresh passes.
      const ra = HEALTH_RANK[healthOf(a)] * 2 + (isStale(a) ? 0 : 1);
      const rb = HEALTH_RANK[healthOf(b)] * 2 + (isStale(b) ? 0 : 1);
      return ra - rb || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
});

const hasFilters = computed(() => filter.value !== "all" || search.value.trim() !== "");

function resetFilters() {
  filter.value = "all";
  search.value = "";
}

const RESULT_TONE: Record<Health, Tone> = { ok: "success", failed: "danger", never: "neutral", vm: "neutral" };
const RESULT_KEY: Record<Health, string> = {
  ok: "adminTools.monitor.health.result.ok",
  failed: "adminTools.monitor.health.result.failed",
  never: "adminTools.monitor.health.result.never",
  vm: "adminTools.monitor.health.result.vm",
};

function latencyClass(ms: number): string {
  if (ms >= 20_000) return "text-danger";
  if (ms >= 8_000) return "text-warning";
  return "text-fg-muted";
}

const staleHint = computed(() => t("adminTools.monitor.health.staleHint", { interval: formatInterval(intervalMinutes.value) }));

/* ---------------- Test now ---------------- */

const testOpen = ref(false);
const testAccount = ref<UpstreamAccount | null>(null);
const flashId = ref<string | null>(null);
let flashTimer: number | undefined;

function openTest(a: UpstreamAccount) {
  testAccount.value = a;
  testOpen.value = true;
}

async function onTested() {
  const id = testAccount.value?.id ?? null;
  await load(true);
  if (!id) return;
  flashId.value = id;
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => (flashId.value = null), 1800);
}

onMounted(() => {
  void load();
  clock = window.setInterval(() => (now.value = Date.now()), 30_000);
});

onBeforeUnmount(() => {
  window.clearInterval(clock);
  window.clearTimeout(flashTimer);
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.channelMonitor')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load()">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
      </template>
    </PageHeader>

    <AutoTestScheduleCard :now="now" @config="onConfig" @progress="load(true)" @finished="load(true)" />

    <div class="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <StatCard
        :label="t('adminTools.monitor.health.stats.tested')"
        :value="loaded ? formatNumber(stats.tested) : '—'"
        icon="activity"
        tone="accent"
      >
        <template #hint>
          <span v-if="loaded && stats.stale" class="text-warning">{{ t("adminTools.monitor.health.stats.stale", { n: stats.stale }) }}</span>
          <span v-else>{{ t("adminTools.monitor.health.stats.testedHint", { total: formatNumber(stats.total) }) }}</span>
        </template>
      </StatCard>
      <StatCard
        :label="t('adminTools.monitor.health.stats.healthy')"
        :value="loaded ? formatNumber(stats.healthy) : '—'"
        :hint="t('adminTools.monitor.health.stats.healthyHint', { pct: passRate })"
        icon="check-circle"
        tone="success"
      />
      <StatCard
        :label="t('adminTools.monitor.health.stats.failing')"
        :value="loaded ? formatNumber(stats.failing) : '—'"
        :hint="t('adminTools.monitor.health.stats.failingHint')"
        icon="x-circle"
        :tone="stats.failing ? 'danger' : 'neutral'"
      />
      <StatCard
        :label="t('adminTools.monitor.health.stats.never')"
        :value="loaded ? formatNumber(stats.never) : '—'"
        :hint="t('adminTools.monitor.health.stats.neverHint')"
        icon="clock"
        :tone="stats.never ? 'warning' : 'neutral'"
      />
    </div>

    <UiCard icon="radar" :title="t('adminTools.monitor.health.title')" flush>
      <template #actions>
        <div class="scrollbar-hide max-w-full overflow-x-auto">
          <SegmentedControl v-model="filter" :options="filterOptions" />
        </div>
      </template>

      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span class="sr-only">{{ t("common.search") }}</span>
          <UiIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
          <input
            v-model="search"
            type="search"
            class="input input-sm pl-8"
            :placeholder="t('adminTools.monitor.health.searchPlaceholder')"
          />
        </label>
      </div>

      <div v-if="loadError" class="p-5">
        <UiAlert tone="danger">
          {{ loadError }}
          <template #action>
            <button type="button" class="btn btn-secondary btn-xs shrink-0" :disabled="loading" @click="load()">
              <UiIcon name="refresh" :size="13" :spin="loading" />
              {{ t("common.refresh") }}
            </button>
          </template>
        </UiAlert>
      </div>
      <ListSkeleton v-else-if="!loaded" />
      <EmptyState v-else-if="accounts.length === 0" icon="server" :title="t('adminTools.monitor.health.empty')">
        <p class="w-full max-w-xs text-xs text-fg-subtle">{{ t("adminTools.monitor.health.emptyHint") }}</p>
        <RouterLink to="/admin/accounts" class="btn btn-primary btn-sm">
          <UiIcon name="arrow-right" :size="14" />
          {{ t("adminTools.monitor.health.addAccount") }}
        </RouterLink>
      </EmptyState>
      <EmptyState v-else-if="visible.length === 0" icon="search" :title="t('adminTools.monitor.health.noMatch')">
        <button v-if="hasFilters" type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("adminTools.monitor.health.clearFilters") }}
        </button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("adminTools.monitor.health.table.account") }}</th>
              <th>{{ t("adminTools.monitor.health.table.group") }}</th>
              <th>{{ t("adminTools.monitor.health.table.status") }}</th>
              <th>{{ t("adminTools.monitor.health.table.result") }}</th>
              <th>{{ t("adminTools.monitor.health.table.model") }}</th>
              <th class="text-right">{{ t("adminTools.monitor.health.table.latency") }}</th>
              <th>{{ t("adminTools.monitor.health.table.testedAt") }}</th>
              <th>{{ t("adminTools.monitor.health.table.message") }}</th>
              <th class="text-right"><span class="sr-only">{{ t("adminTools.monitor.health.table.actions") }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(a, i) in visible"
              :key="a.id"
              :class="[STAGGER_CLASS, flashId === a.id ? '!bg-accent/[0.08]' : '']"
              :style="stagger(i)"
            >
              <td class="min-w-[13rem] max-w-[18rem]">
                <p class="truncate text-sm font-medium text-fg" :title="a.name">{{ a.name }}</p>
                <PlatformTypeBadge
                  class="mt-1.5"
                  :platform="a.platform"
                  :auth-kind="a.authKind"
                  :subscription-tier="a.subscriptionTier"
                  :tier-multiplier="a.tierMultiplier"
                  inline
                />
              </td>
              <td class="max-w-[10rem]">
                <p class="truncate text-xs text-fg-muted" :title="a.groupName">{{ a.groupName || "-" }}</p>
              </td>
              <td>
                <UiBadge :tone="healthTone(a.effectiveStatus)" dot>{{ accountStatusLabel(a.effectiveStatus) }}</UiBadge>
              </td>
              <td class="whitespace-nowrap">
                <span class="inline-flex items-center gap-1.5">
                  <UiBadge
                    :tone="RESULT_TONE[healthOf(a)]"
                    :dot="healthOf(a) !== 'vm'"
                    :title="healthOf(a) === 'vm' ? t('adminTools.monitor.health.vmHint') : undefined"
                  >
                    {{ t(RESULT_KEY[healthOf(a)]) }}
                  </UiBadge>
                  <UiBadge v-if="isStale(a)" tone="warning" :title="staleHint">
                    <UiIcon name="clock" :size="10" class="-ml-0.5 mr-0.5 inline" />{{ t("adminTools.monitor.health.stale") }}
                  </UiBadge>
                </span>
              </td>
              <td class="max-w-[12rem]">
                <p v-if="a.lastTest?.model" class="truncate font-mono text-2xs text-fg-muted" :title="a.lastTest.model">
                  {{ a.lastTest.model }}
                </p>
                <span v-else class="text-xs text-fg-subtle">-</span>
              </td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                <span v-if="a.lastTest" :class="latencyClass(a.lastTest.durationMs)">{{ formatDurationMs(a.lastTest.durationMs) }}</span>
                <span v-else class="text-fg-subtle">-</span>
              </td>
              <td class="whitespace-nowrap text-xs">
                <span
                  v-if="a.lastTest"
                  :class="isStale(a) ? 'text-warning' : 'text-fg-subtle'"
                  :title="isStale(a) ? `${formatDateTime(a.lastTest.atIso)} · ${staleHint}` : formatDateTime(a.lastTest.atIso)"
                >
                  {{ formatRelative(a.lastTest.atIso, now) }}
                </span>
                <span v-else class="text-fg-subtle">-</span>
              </td>
              <td class="min-w-[10rem] max-w-[18rem]">
                <p
                  v-if="a.lastTest && !a.lastTest.ok && a.lastTest.message"
                  class="truncate font-mono text-2xs text-danger"
                  :title="a.lastTest.message"
                >
                  {{ a.lastTest.message }}
                </p>
                <span v-else class="text-xs text-fg-subtle">-</span>
              </td>
              <td class="text-right">
                <button
                  type="button"
                  class="btn btn-secondary btn-xs"
                  :disabled="a.executionMode === 'vm_slot'"
                  :title="a.executionMode === 'vm_slot' ? t('adminTools.monitor.health.vmHint') : undefined"
                  @click="openTest(a)"
                >
                  <UiIcon name="play" :size="12" />
                  {{ t("adminTools.monitor.health.testNow") }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <AccountTestModal v-model:open="testOpen" :account="testAccount" @tested="onTested" />
  </div>
</template>
