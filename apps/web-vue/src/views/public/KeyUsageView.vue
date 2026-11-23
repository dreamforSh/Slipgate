<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { KeyUsageLookupResponse } from "@slipgate/contracts";
import PublicLayout from "../../components/PublicLayout.vue";
import TrendChart, { type TrendSeries } from "../../components/charts/TrendChart.vue";
import PeriodTotals from "../../components/public/PeriodTotals.vue";
import PublicDisabled from "../../components/public/PublicDisabled.vue";
import PublicHero from "../../components/public/PublicHero.vue";
import { vReveal } from "../../components/public/reveal";
import EmptyState from "../../components/ui/EmptyState.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { ApiError, publicJson } from "../../lib/api";
import {
  formatCompact,
  formatDateShort,
  formatDateTime,
  formatDurationMs,
  formatNumber,
  formatUsd,
  nanoToUsd,
} from "../../lib/format";
import { usePortalStore } from "../../stores/portal";

const KEY_PATTERN = /^sk-sg-[A-Za-z0-9_-]{16,128}$/;

const { t, locale } = useI18n();
const portal = usePortalStore();

// The key lives only in this component's memory: never in storage, the URL or the store.
const apiKey = ref("");
const showKey = ref(false);
const submitting = ref(false);
const formatError = ref(false);
const failure = ref<{ kind: "notFound" | "rateLimited" | "generic"; message?: string } | null>(null);
const result = ref<KeyUsageLookupResponse | null>(null);
const turnedOff = ref(false);
const input = ref<HTMLInputElement | null>(null);

const disabled = computed(() => turnedOff.value || portal.settings?.keyUsageLookupEnabled === false);

onMounted(() => {
  void portal.load();
  void nextTick(() => input.value?.focus());
});
onBeforeUnmount(() => {
  apiKey.value = "";
  result.value = null;
});

async function lookup() {
  const key = apiKey.value.trim();
  formatError.value = !KEY_PATTERN.test(key);
  failure.value = null;
  if (formatError.value) return;
  submitting.value = true;
  try {
    const tz = new Date().getTimezoneOffset();
    result.value = await publicJson<KeyUsageLookupResponse>(`/api/v1/public/key-usage?tz=${tz}`, {
      method: "POST",
      body: { apiKey: key },
    });
  } catch (err) {
    result.value = null;
    if (err instanceof ApiError && err.status === 404) {
      // 404 means either an unknown key or a switched-off page; the settings tell them apart.
      const settings = await portal.refresh();
      if (settings?.keyUsageLookupEnabled === false) turnedOff.value = true;
      else failure.value = { kind: "notFound" };
    } else if (err instanceof ApiError && (err.status === 403 || err.status === 429)) {
      failure.value = { kind: "rateLimited" };
    } else if (err instanceof ApiError && err.status === 400) {
      formatError.value = true;
    } else {
      failure.value = { kind: "generic", message: err instanceof Error ? err.message : undefined };
    }
  } finally {
    submitting.value = false;
  }
}

function clearAll() {
  apiKey.value = "";
  result.value = null;
  failure.value = null;
  formatError.value = false;
  showKey.value = false;
  void nextTick(() => input.value?.focus());
}

function onInput() {
  formatError.value = false;
  failure.value = null;
}

/* ---------------- Key summary ---------------- */
const keyState = computed(() => {
  const r = result.value;
  if (!r) return null;
  if (!r.enabled) return { label: t("public.keyUsage.state.disabled"), tone: "neutral" as const };
  if (r.expiresAtIso && Date.parse(r.expiresAtIso) <= Date.now()) return { label: t("public.keyUsage.state.expired"), tone: "danger" as const };
  return { label: t("public.keyUsage.state.enabled"), tone: "success" as const };
});

/** Balance may be negative (overdraft); keep the sign and pick precision by magnitude. */
function formatSignedUsd(nano: string): string {
  const usd = nanoToUsd(nano);
  const abs = Math.abs(usd);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 6 : abs < 1 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(usd);
}
const balanceNegative = computed(() => (result.value ? result.value.balanceNanoUsd.startsWith("-") : false));

/* ---------------- Trend ---------------- */
const trendMetric = ref<"requests" | "cost" | "tokens">("requests");
const metricOptions = computed(() => [
  { value: "requests" as const, label: t("public.keyUsage.trend.requests") },
  { value: "cost" as const, label: t("public.keyUsage.trend.cost") },
  { value: "tokens" as const, label: t("public.keyUsage.trend.tokens") },
]);

const trendLabels = computed(() => {
  const points = result.value?.series ?? [];
  return {
    short: points.map((p) => new Date(p.startIso).toLocaleDateString(locale.value, { month: "numeric", day: "numeric" })),
    full: points.map((p) =>
      new Date(p.startIso).toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric", weekday: "short" }),
    ),
  };
});

const trendSeries = computed<TrendSeries[]>(() => {
  const points = result.value?.series ?? [];
  if (trendMetric.value === "tokens") {
    return [
      { key: "in", label: t("public.keyUsage.trend.input"), color: "rgb(var(--viz-1))", values: points.map((p) => p.inputTokens) },
      { key: "out", label: t("public.keyUsage.trend.output"), color: "rgb(var(--viz-2))", values: points.map((p) => p.outputTokens) },
    ];
  }
  if (trendMetric.value === "cost") {
    return [{ key: "cost", label: t("public.keyUsage.trend.cost"), color: "rgb(var(--viz-1))", values: points.map((p) => nanoToUsd(p.costNanoUsd)) }];
  }
  return [{ key: "req", label: t("public.keyUsage.trend.requests"), color: "rgb(var(--viz-1))", values: points.map((p) => p.requests) }];
});

const hasTrend = computed(() => trendSeries.value.some((s) => s.values.some((v) => v > 0)));

const usdFormat = (usd: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: usd < 1 ? 4 : 2 }).format(usd);
const usdAxis = (usd: number) =>
  usd >= 1000
    ? `$${formatCompact(usd)}`
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: usd < 1 ? 2 : 0 }).format(usd);
const trendFormat = computed(() => (trendMetric.value === "cost" ? usdFormat : (v: number) => formatNumber(v)));
const trendAxisFormat = computed(() => (trendMetric.value === "cost" ? usdAxis : (v: number) => formatCompact(v)));
const trendChartLabel = computed(
  () => t("public.keyUsage.trend.chart", { metric: metricOptions.value.find((o) => o.value === trendMetric.value)?.label ?? "" }),
);

/* ---------------- Models ---------------- */
const modelRows = computed(() => {
  const rows = result.value?.models ?? [];
  const total = rows.reduce((s, r) => s + nanoToUsd(r.costNanoUsd), 0);
  const maxReq = Math.max(1, ...rows.map((r) => r.requests));
  return rows.map((r) => {
    const cost = nanoToUsd(r.costNanoUsd);
    return {
      ...r,
      share: total > 0 ? cost / total : r.requests / maxReq,
      shareText: total > 0 ? `${((cost / total) * 100).toFixed(1)}%` : "—",
    };
  });
});
</script>

<template>
  <PublicLayout>
    <PublicDisabled v-if="disabled" />
    <template v-else>
      <PublicHero
        icon="search"
        centered
        :eyebrow="t('public.keyUsage.eyebrow')"
        :title="t('public.keyUsage.title')"
        :subtitle="t('public.keyUsage.subtitle')"
      />

      <div class="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
        <!-- Lookup form -->
        <form class="lookup card mx-auto max-w-2xl p-4 sm:p-5" autocomplete="off" @submit.prevent="lookup">
          <label for="key-usage-input" class="label">{{ t("public.keyUsage.label") }}</label>
          <div class="flex flex-col gap-2.5 sm:flex-row">
            <div class="relative min-w-0 flex-1">
              <UiIcon name="key" :size="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle" />
              <input
                id="key-usage-input"
                ref="input"
                v-model="apiKey"
                :type="showKey ? 'text' : 'password'"
                name="sg-key-lookup"
                class="input h-11 pl-9 pr-11 font-mono text-[13px]"
                :class="formatError ? '!border-danger focus:!ring-danger/20' : ''"
                :placeholder="t('public.keyUsage.placeholder')"
                autocomplete="off"
                autocapitalize="off"
                autocorrect="off"
                spellcheck="false"
                data-1p-ignore
                data-lpignore="true"
                data-bwignore
                :aria-invalid="formatError"
                aria-describedby="key-usage-hint"
                @input="onInput"
              />
              <button
                type="button"
                class="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center text-fg-subtle transition-colors hover:text-fg"
                :aria-label="showKey ? t('public.keyUsage.hide') : t('public.keyUsage.show')"
                :title="showKey ? t('public.keyUsage.hide') : t('public.keyUsage.show')"
                @click="showKey = !showKey"
              >
                <UiIcon :name="showKey ? 'eye-off' : 'eye'" :size="16" />
              </button>
            </div>
            <button type="submit" class="btn btn-primary h-11 rounded-lg px-5" :disabled="submitting || !apiKey.trim()">
              <UiIcon :name="submitting ? 'loader' : 'search'" :size="16" :spin="submitting" />
              {{ submitting ? t("public.keyUsage.querying") : t("public.keyUsage.submit") }}
            </button>
          </div>
          <p v-if="formatError" id="key-usage-hint" class="mt-2 flex items-center gap-1.5 text-xs text-danger" role="alert">
            <UiIcon name="alert" :size="13" />
            {{ t("public.keyUsage.invalidFormat") }}
          </p>
          <p v-else id="key-usage-hint" class="mt-2.5 flex items-start gap-1.5 text-xs leading-relaxed text-fg-subtle">
            <UiIcon name="lock" :size="13" class="mt-px text-success" />
            {{ t("public.keyUsage.privacy") }}
          </p>
        </form>

        <!-- Errors -->
        <div v-if="failure" class="mx-auto mt-5 max-w-2xl animate-slide-up">
          <UiAlert v-if="failure.kind === 'notFound'" tone="danger" :title="t('public.keyUsage.errors.notFoundTitle')">
            {{ t("public.keyUsage.errors.notFoundDesc") }}
          </UiAlert>
          <UiAlert v-else-if="failure.kind === 'rateLimited'" tone="warning" :title="t('public.keyUsage.errors.rateLimitedTitle')">
            {{ t("public.keyUsage.errors.rateLimitedDesc") }}
          </UiAlert>
          <UiAlert v-else tone="danger" :title="t('public.keyUsage.errors.generic')">
            {{ failure.message || t("common.networkError") }}
          </UiAlert>
        </div>

        <!-- Results -->
        <div v-if="result" :key="result.keyPrefix" class="mt-10 space-y-6">
          <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <!-- Key + balance -->
            <div v-reveal class="card relative flex min-w-0 flex-col overflow-hidden p-5 md:col-span-2 lg:col-span-1">
              <div class="key-wash pointer-events-none absolute inset-x-0 top-0 h-20" aria-hidden="true" />
              <div class="relative flex items-start gap-3">
                <span class="icon-chip icon-chip-accent h-10 w-10 rounded-xl"><UiIcon name="key" :size="18" /></span>
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-semibold text-fg" :title="result.keyName">
                    {{ result.keyName || t("public.keyUsage.key.unnamed") }}
                  </p>
                  <p class="mt-1 truncate font-mono text-2xs text-fg-subtle" :title="t('public.keyUsage.key.prefix')">
                    {{ result.keyPrefix ? `${result.keyPrefix}…` : "—" }}
                  </p>
                </div>
                <UiBadge v-if="keyState" :tone="keyState.tone" dot>{{ keyState.label }}</UiBadge>
              </div>

              <div class="relative mt-5">
                <p class="text-xs text-fg-subtle">{{ t("public.keyUsage.balance") }}</p>
                <p class="mt-1 truncate text-[28px] font-semibold leading-9 tracking-tight tabular-nums" :class="balanceNegative ? 'text-danger' : 'text-fg'">
                  {{ formatSignedUsd(result.balanceNanoUsd) }}
                </p>
                <p class="mt-0.5 text-xs text-fg-subtle">
                  {{ result.billing === "subscription" ? t("public.keyUsage.subscriptionHint") : t("public.keyUsage.balanceHint") }}
                </p>
              </div>

              <div class="relative mt-auto pt-5">
              <dl class="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line/70 pt-4">
                <div class="min-w-0">
                  <dt class="text-2xs text-fg-subtle">{{ t("public.keyUsage.key.group") }}</dt>
                  <dd class="mt-0.5 truncate text-sm font-medium text-fg" :title="result.groupName">{{ result.groupName || "—" }}</dd>
                </div>
                <div class="min-w-0">
                  <dt class="text-2xs text-fg-subtle">{{ t("public.keyUsage.key.billing") }}</dt>
                  <dd class="mt-1">
                    <UiBadge :tone="result.billing === 'subscription' ? 'violet' : 'accent'">
                      {{ t(`public.plaza.billing.${result.billing}`) }}
                    </UiBadge>
                  </dd>
                </div>
                <div class="col-span-2 min-w-0">
                  <dt class="text-2xs text-fg-subtle">{{ t("public.keyUsage.key.expires") }}</dt>
                  <dd class="mt-0.5 text-sm font-medium tabular-nums text-fg">
                    {{ result.expiresAtIso ? formatDateShort(result.expiresAtIso) : t("public.keyUsage.key.never") }}
                  </dd>
                </div>
              </dl>
              </div>
            </div>

            <div v-reveal="80" class="min-w-0">
              <PeriodTotals class="h-full" :title="t('public.keyUsage.today')" icon="clock" chip="icon-chip-info" :totals="result.today" />
            </div>
            <div v-reveal="160" class="min-w-0">
              <PeriodTotals class="h-full" :title="t('public.keyUsage.last30d')" icon="calendar" chip="icon-chip-violet" :totals="result.last30d" />
            </div>
          </div>

          <!-- Trend -->
          <div v-reveal>
            <UiCard icon="trending-up" :title="t('public.keyUsage.trend.title')">
              <template #actions>
                <SegmentedControl v-model="trendMetric" :options="metricOptions" />
              </template>
              <EmptyState v-if="!hasTrend" compact icon="chart" :title="t('public.keyUsage.models.empty')" />
              <TrendChart
                v-else
                :labels="trendLabels.short"
                :titles="trendLabels.full"
                :series="trendSeries"
                :format="trendFormat"
                :axis-format="trendAxisFormat"
                :height="240"
                :chart-label="trendChartLabel"
              />
            </UiCard>
          </div>

          <!-- Models -->
          <div v-reveal>
            <UiCard icon="sparkles" :title="t('public.keyUsage.models.title')" flush>
              <EmptyState v-if="!modelRows.length" compact icon="sparkles" :title="t('public.keyUsage.models.empty')" />
              <div v-else class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>{{ t("public.keyUsage.models.model") }}</th>
                      <th class="text-right">{{ t("public.keyUsage.models.requests") }}</th>
                      <th class="text-right">{{ t("public.keyUsage.models.tokens") }}</th>
                      <th class="text-right">{{ t("public.keyUsage.models.cost") }}</th>
                      <th class="w-[28%] min-w-[9rem]">{{ t("public.keyUsage.models.share") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="m in modelRows" :key="m.model">
                      <td class="font-mono text-xs text-fg">{{ m.model }}</td>
                      <td class="text-right text-xs tabular-nums">{{ formatNumber(m.requests) }}</td>
                      <td class="text-right text-xs tabular-nums">{{ formatCompact(m.tokens) }}</td>
                      <td class="text-right font-mono text-xs tabular-nums text-fg">{{ formatUsd(m.costNanoUsd) }}</td>
                      <td>
                        <div class="flex items-center gap-2.5">
                          <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                            <div class="h-full rounded-full bg-accent/70" :style="{ width: `${Math.max(2, m.share * 100)}%` }" />
                          </div>
                          <span class="w-12 text-right text-2xs tabular-nums text-fg-subtle">{{ m.shareText }}</span>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </UiCard>
          </div>

          <!-- Recent -->
          <div v-reveal>
            <UiCard icon="list" :title="t('public.keyUsage.recent.title')" flush>
              <EmptyState v-if="!result.recent.length" compact icon="inbox" :title="t('public.keyUsage.recent.empty')" />
              <div v-else class="table-wrap">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>{{ t("public.keyUsage.recent.time") }}</th>
                      <th>{{ t("public.keyUsage.recent.model") }}</th>
                      <th class="text-right">{{ t("public.keyUsage.recent.input") }}</th>
                      <th class="text-right">{{ t("public.keyUsage.recent.output") }}</th>
                      <th class="text-right">{{ t("public.keyUsage.recent.cost") }}</th>
                      <th>{{ t("public.keyUsage.recent.status") }}</th>
                      <th class="text-right">{{ t("public.keyUsage.recent.duration") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(r, i) in result.recent" :key="`${r.createdAtIso}-${i}`">
                      <td class="whitespace-nowrap text-xs tabular-nums text-fg-muted">{{ formatDateTime(r.createdAtIso) }}</td>
                      <td class="max-w-[16rem] truncate font-mono text-xs text-fg" :title="r.model">{{ r.model }}</td>
                      <td class="text-right text-xs tabular-nums">{{ formatNumber(r.inputTokens) }}</td>
                      <td class="text-right text-xs tabular-nums">{{ formatNumber(r.outputTokens) }}</td>
                      <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg">{{ formatUsd(r.costNanoUsd) }}</td>
                      <td>
                        <UiBadge :tone="r.statusCode < 400 ? 'success' : 'danger'" mono>{{ r.statusCode }}</UiBadge>
                      </td>
                      <td class="whitespace-nowrap text-right text-xs tabular-nums text-fg-muted">{{ formatDurationMs(r.durationMs) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </UiCard>
          </div>

          <div class="flex justify-center">
            <button type="button" class="btn btn-ghost btn-sm" @click="clearAll">
              <UiIcon name="x" :size="14" />
              {{ t("public.keyUsage.clear") }}
            </button>
          </div>
        </div>
      </div>
    </template>
  </PublicLayout>
</template>

<style scoped>
.lookup {
  box-shadow:
    0 0 0 1px rgb(var(--accent) / 0.06),
    0 18px 48px -18px rgb(var(--accent-glow) / 0.35);
}
.key-wash {
  background: linear-gradient(180deg, rgb(var(--accent-glow) / 0.08), transparent);
}
</style>
