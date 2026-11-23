<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { PaymentConfig, PaymentDashboard } from "@slipgate/contracts";
import BarList, { type BarListItem } from "../../components/charts/BarList.vue";
import TrendChart, { type TrendSeries } from "../../components/charts/TrendChart.vue";
import { currencySymbol, formatFiat, STAGGER_CLASS, stagger } from "../../components/payments/paymentUtil";
import { usePaymentLabels } from "../../components/payments/usePaymentLabels";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { usePersistentState } from "../../composables/usePersistentState";
import { apiJson, errorText } from "../../lib/api";
import { formatCompact, formatNumber, formatRelative, formatUsd } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

const { t, locale } = useI18n();
const { channelLabel, providerLabel } = usePaymentLabels();
const toast = useToastStore();

type Range = "7" | "30" | "90";
type Metric = "revenue" | "orders";

const range = ref<Range>("30");
const metric = ref<Metric>("revenue");
const asTable = usePersistentState("slipgate_payment_trend_table", false, (v): v is boolean => typeof v === "boolean");

const data = ref<PaymentDashboard | null>(null);
const loading = ref(false);
const paymentsOn = ref<boolean | null>(null);

const rangeOptions = computed<{ value: Range; label: string }[]>(() => [
  { value: "7", label: t("payments.admin.dashboard.range.d7") },
  { value: "30", label: t("payments.admin.dashboard.range.d30") },
  { value: "90", label: t("payments.admin.dashboard.range.d90") },
]);
const metricOptions = computed<{ value: Metric; label: string }[]>(() => [
  { value: "revenue", label: t("payments.admin.dashboard.trend.revenue") },
  { value: "orders", label: t("payments.admin.dashboard.trend.orders") },
]);

let seq = 0;

async function load() {
  const mine = ++seq;
  loading.value = true;
  try {
    const res = await apiJson<PaymentDashboard>(`/api/v1/admin/payments/dashboard?days=${range.value}`, {
      fallbackError: t("payments.admin.dashboard.loadFailed"),
    });
    if (mine === seq) data.value = res;
  } catch (err) {
    if (mine === seq) toast.error(errorText(err, t("payments.admin.dashboard.loadFailed")));
  } finally {
    if (mine === seq) loading.value = false;
  }
}

async function loadConfig() {
  try {
    paymentsOn.value = (await apiJson<PaymentConfig>("/api/v1/admin/payments/config")).enabled;
  } catch {
    paymentsOn.value = null;
  }
}

watch(range, () => void load());
onMounted(() => {
  void load();
  void loadConfig();
});

/* ---------------- Derived ---------------- */

const currency = computed(() => data.value?.currency ?? "CNY");
const totals = computed(() => data.value?.totals ?? null);
const money = (minor: number) => formatFiat(minor, currency.value);
const percent = (v: number) => `${(v * 100).toFixed(v >= 0.1 || v === 0 ? 1 : 2)}%`;

const labels = computed(() => {
  const series = data.value?.series ?? [];
  return {
    short: series.map((p) => new Date(p.dateIso).toLocaleDateString(locale.value, { month: "numeric", day: "numeric" })),
    full: series.map((p) =>
      new Date(p.dateIso).toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric", weekday: "short" }),
    ),
  };
});

const series = computed<TrendSeries[]>(() => {
  const points = data.value?.series ?? [];
  if (metric.value === "orders") {
    return [
      { key: "orders", label: t("payments.admin.dashboard.trend.orders"), color: "rgb(var(--viz-1))", values: points.map((p) => p.orders) },
    ];
  }
  // Chart values are whole currency units for axis readability; tooltips format the exact minor amount.
  return [
    {
      key: "revenue",
      label: t("payments.admin.dashboard.trend.revenue"),
      color: "rgb(var(--viz-1))",
      values: points.map((p) => p.revenueMinor / 100),
    },
  ];
});

const trendFormat = computed(() =>
  metric.value === "orders" ? (v: number) => formatNumber(v) : (v: number) => money(Math.round(v * 100)),
);
const trendAxis = computed(() =>
  metric.value === "orders" ? (v: number) => formatCompact(v) : (v: number) => `${currencySymbol(currency.value)}${formatCompact(v)}`,
);
const trendTitle = computed(() =>
  metric.value === "orders" ? t("payments.admin.dashboard.trend.titleOrders") : t("payments.admin.dashboard.trend.titleRevenue"),
);
const hasPaid = computed(() => (totals.value?.paidOrders ?? 0) > 0);

const providerItems = computed<BarListItem[]>(() =>
  (data.value?.byProvider ?? [])
    .filter((p) => p.orders > 0)
    .map((p) => ({
      key: p.provider,
      label: providerLabelFor(p.provider),
      value: p.revenueMinor,
      valueText: money(p.revenueMinor),
      meta: t("payments.admin.dashboard.meta", { orders: formatNumber(p.orders) }),
    })),
);

/** byProvider keys are a provider, or "easypay:alipay"-style when the BFF splits by method. */
function providerLabelFor(key: string) {
  const [provider, method] = key.split(":");
  if (provider === "easypay" && method) return `${providerLabel(provider)} · ${channelLabel(provider, method)}`;
  return providerLabel(provider ?? key);
}

const planItems = computed<BarListItem[]>(() =>
  (data.value?.topPlans ?? [])
    .filter((p) => p.orders > 0)
    .map((p, i) => ({
      key: `${p.planName}-${i}`,
      label: p.planName || t("payments.admin.customTopUp"),
      value: p.revenueMinor,
      valueText: money(p.revenueMinor),
      meta: t("payments.admin.dashboard.meta", { orders: formatNumber(p.orders) }),
    })),
);

const stats = computed(() => {
  const s = totals.value;
  const v = <T,>(fn: (x: NonNullable<typeof s>) => T) => (s ? fn(s) : "—");
  return [
    { key: "revenue", label: t("payments.admin.dashboard.stats.revenue"), value: v((x) => money(x.revenueMinor)), hint: t("payments.admin.dashboard.stats.revenueHint"), icon: "trending-up", tone: "accent" },
    { key: "paid", label: t("payments.admin.dashboard.stats.paidOrders"), value: v((x) => formatNumber(x.paidOrders)), hint: t("payments.admin.dashboard.stats.paidOrdersHint"), icon: "check-circle", tone: "success" },
    { key: "users", label: t("payments.admin.dashboard.stats.payingUsers"), value: v((x) => formatNumber(x.payingUsers)), hint: t("payments.admin.dashboard.stats.payingUsersHint"), icon: "users", tone: "info" },
    { key: "conversion", label: t("payments.admin.dashboard.stats.conversion"), value: v((x) => percent(x.conversionRate)), hint: t("payments.admin.dashboard.stats.conversionHint"), icon: "percent", tone: "violet" },
    { key: "pending", label: t("payments.admin.dashboard.stats.pending"), value: v((x) => formatNumber(x.pendingOrders)), hint: t("payments.admin.dashboard.stats.pendingHint"), icon: "clock", tone: "warning" },
    { key: "refunded", label: t("payments.admin.dashboard.stats.refunded"), value: v((x) => formatNumber(x.refundedOrders)), hint: t("payments.admin.dashboard.stats.refundedHint"), icon: "rotate-ccw", tone: "danger" },
    { key: "credited", label: t("payments.admin.dashboard.stats.credited"), value: v((x) => formatUsd(x.creditedNanoUsd)), hint: t("payments.admin.dashboard.stats.creditedHint"), icon: "wallet", tone: "accent" },
    { key: "rebates", label: t("payments.admin.dashboard.stats.rebates"), value: v((x) => formatUsd(x.rebatesNanoUsd)), hint: t("payments.admin.dashboard.stats.rebatesHint"), icon: "gift", tone: "violet" },
  ] as const;
});

</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.paymentDashboard')">
      <template #meta>
        <span v-if="data" class="text-xs text-fg-subtle">{{ formatRelative(data.generatedAtIso) }}</span>
      </template>
      <template #actions>
        <SegmentedControl v-model="range" :options="rangeOptions" size="md" />
        <button
          type="button"
          class="btn btn-secondary btn-icon"
          :disabled="loading"
          :title="t('common.refresh')"
          :aria-label="t('common.refresh')"
          @click="load"
        >
          <UiIcon name="refresh" :size="15" :spin="loading" />
        </button>
        <RouterLink to="/admin/orders" class="btn btn-secondary">
          <UiIcon name="list" :size="15" />
          <span class="hidden sm:inline">{{ t("payments.admin.dashboard.viewOrders") }}</span>
        </RouterLink>
      </template>
    </PageHeader>

    <UiAlert v-if="paymentsOn === false" tone="warning">
      {{ t("payments.admin.paymentOff") }}
      <template #action>
        <RouterLink to="/admin/payment-settings" class="btn btn-secondary btn-sm shrink-0">
          <UiIcon name="sliders" :size="14" />
          {{ t("payments.admin.openSettings") }}
        </RouterLink>
      </template>
    </UiAlert>

    <div
      class="grid grid-cols-2 gap-3 transition-opacity duration-200 sm:gap-4 xl:grid-cols-4"
      :class="loading && data ? 'opacity-70' : ''"
    >
      <StatCard
        v-for="(s, i) in stats"
        :key="s.key"
        :class="STAGGER_CLASS"
        :style="stagger(i, 30, 8)"
        :label="s.label"
        :value="s.value"
        :hint="s.hint"
        :icon="s.icon"
        :tone="s.tone"
        mono
      />
    </div>

    <div class="grid gap-6 xl:grid-cols-3" :class="loading && data ? 'opacity-70 transition-opacity' : 'transition-opacity'">
      <UiCard class="xl:col-span-2" icon="trending-up" :title="trendTitle">
        <template #actions>
          <SegmentedControl v-model="metric" :options="metricOptions" />
          <button
            type="button"
            class="btn btn-ghost btn-icon btn-sm"
            :aria-pressed="asTable"
            :title="asTable ? t('payments.admin.dashboard.trend.showChart') : t('payments.admin.dashboard.trend.showTable')"
            :aria-label="asTable ? t('payments.admin.dashboard.trend.showChart') : t('payments.admin.dashboard.trend.showTable')"
            @click="asTable = !asTable"
          >
            <UiIcon :name="asTable ? 'activity' : 'list'" :size="15" />
          </button>
        </template>
        <div v-if="!data" class="h-60 animate-pulse rounded-lg bg-surface-2/50 motion-reduce:animate-none" />
        <EmptyState v-else-if="!hasPaid" compact icon="trending-up" :title="t('payments.admin.dashboard.trend.empty')" />
        <div v-else-if="asTable" class="table-wrap max-h-72 overflow-y-auto">
          <table class="data-table">
            <thead class="sticky top-0 z-10">
              <tr>
                <th>{{ t("payments.admin.dashboard.trend.date") }}</th>
                <th class="text-right">{{ t("payments.admin.dashboard.trend.orders") }}</th>
                <th class="text-right">{{ t("payments.admin.dashboard.trend.revenue") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in data.series" :key="p.dateIso">
                <td class="whitespace-nowrap text-xs text-fg-muted">{{ labels.full[i] }}</td>
                <td class="text-right font-mono text-xs tabular-nums">{{ formatNumber(p.orders) }}</td>
                <td class="text-right font-mono text-xs tabular-nums">{{ money(p.revenueMinor) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <TrendChart
          v-else
          :labels="labels.short"
          :titles="labels.full"
          :series="series"
          :format="trendFormat"
          :axis-format="trendAxis"
          :chart-label="trendTitle"
        />
      </UiCard>

      <UiCard icon="credit-card" :title="t('payments.admin.dashboard.providers.title')">
        <div v-if="!data" class="space-y-3">
          <div v-for="i in 3" :key="i" class="h-8 animate-pulse rounded-lg bg-surface-2/50 motion-reduce:animate-none" />
        </div>
        <EmptyState v-else-if="!providerItems.length" compact icon="credit-card" :title="t('payments.admin.dashboard.providers.empty')" />
        <BarList v-else :items="providerItems" />
      </UiCard>
    </div>

    <UiCard icon="box" :title="t('payments.admin.dashboard.plans.title')">
      <template #actions>
        <RouterLink to="/admin/payment-plans" class="btn btn-ghost btn-sm">
          {{ t("nav.paymentPlans") }}
          <UiIcon name="chevron-right" :size="14" />
        </RouterLink>
      </template>
      <div v-if="!data" class="space-y-3">
        <div v-for="i in 3" :key="i" class="h-8 animate-pulse rounded-lg bg-surface-2/50 motion-reduce:animate-none" />
      </div>
      <EmptyState v-else-if="!planItems.length" compact icon="box" :title="t('payments.admin.dashboard.plans.empty')" />
      <BarList v-else :items="planItems" />
    </UiCard>
  </div>
</template>
