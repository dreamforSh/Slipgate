<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { GroupItem, PaymentConfig, PaymentPlan, PaymentPlanKind } from "@slipgate/contracts";
import PlanEditorModal from "../../components/payments/PlanEditorModal.vue";
import {
  formatFiat,
  formatFiatCompact,
  planBonusPct,
  planToRequest,
  STAGGER_CLASS,
  stagger,
} from "../../components/payments/paymentUtil";
import { usePaymentLabels } from "../../components/payments/usePaymentLabels";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import { apiJson, errorText } from "../../lib/api";
import { formatUsd } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const { kindLabel } = usePaymentLabels();
const toast = useToastStore();

const plans = ref<PaymentPlan[]>([]);
const groups = ref<GroupItem[]>([]);
const config = ref<PaymentConfig | null>(null);
const loading = ref(false);
const loaded = ref(false);

async function loadPlans() {
  loading.value = true;
  try {
    plans.value = (await apiJson<{ items: PaymentPlan[] }>("/api/v1/admin/payments/plans", {
      fallbackError: t("payments.admin.plans.errors.load"),
    })).items;
    loaded.value = true;
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.plans.errors.load")));
  } finally {
    loading.value = false;
  }
}

async function loadGroups() {
  try {
    const all = (await apiJson<{ groups: GroupItem[] }>("/api/v1/admin/groups")).groups;
    groups.value = all.filter((g) => g.subscriptionType === "subscription");
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.plans.errors.groups")));
  }
}

async function loadConfig() {
  try {
    config.value = await apiJson<PaymentConfig>("/api/v1/admin/payments/config");
  } catch {
    config.value = null;
  }
}

function refresh() {
  void loadPlans();
  void loadGroups();
  void loadConfig();
}

onMounted(refresh);

/* ---------------- Filters & stats ---------------- */

type KindFilter = "all" | PaymentPlanKind;
const kindFilter = ref<KindFilter>("all");

const sorted = computed(() =>
  [...plans.value].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAtIso.localeCompare(b.createdAtIso)),
);
const visible = computed(() => (kindFilter.value === "all" ? sorted.value : sorted.value.filter((p) => p.kind === kindFilter.value)));

const counts = computed(() => ({
  all: plans.value.length,
  enabled: plans.value.filter((p) => p.enabled).length,
  recharge: plans.value.filter((p) => p.kind === "recharge").length,
  subscription: plans.value.filter((p) => p.kind === "subscription").length,
}));

const kindOptions = computed<{ value: KindFilter; label: string; count: number }[]>(() => [
  { value: "all", label: t("common.all"), count: counts.value.all },
  { value: "recharge", label: t("payments.kinds.recharge"), count: counts.value.recharge },
  { value: "subscription", label: t("payments.kinds.subscription"), count: counts.value.subscription },
]);

const lowest = computed(() => {
  const currency = config.value?.currency ?? plans.value[0]?.currency;
  const pool = plans.value.filter((p) => p.enabled && p.currency === currency);
  if (!pool.length || !currency) return "—";
  return formatFiat(Math.min(...pool.map((p) => p.priceMinor)), currency);
});

function bonusFor(plan: PaymentPlan) {
  const c = config.value;
  return c ? planBonusPct(plan, c.minorPerUsd, c.currency) : null;
}

/* ---------------- Row actions ---------------- */

const busy = ref(new Set<string>());

function setBusy(id: string, on: boolean) {
  const next = new Set(busy.value);
  if (on) next.add(id);
  else next.delete(id);
  busy.value = next;
}

async function toggle(plan: PaymentPlan) {
  setBusy(plan.id, true);
  try {
    const res = await apiJson<{ item: PaymentPlan }>(`/api/v1/admin/payments/plans/${encodeURIComponent(plan.id)}`, {
      method: "PUT",
      body: planToRequest(plan, { enabled: !plan.enabled }),
      fallbackError: t("payments.admin.plans.errors.toggle"),
    });
    plans.value = plans.value.map((p) => (p.id === plan.id ? res.item : p));
    toast.success(
      res.item.enabled
        ? t("payments.admin.plans.toggledOn", { name: plan.name })
        : t("payments.admin.plans.toggledOff", { name: plan.name }),
    );
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.plans.errors.toggle")));
  } finally {
    setBusy(plan.id, false);
  }
}

async function remove(plan: PaymentPlan) {
  setBusy(plan.id, true);
  try {
    await apiJson(`/api/v1/admin/payments/plans/${encodeURIComponent(plan.id)}`, {
      method: "DELETE",
      fallbackError: t("payments.admin.plans.errors.delete"),
    });
    plans.value = plans.value.filter((p) => p.id !== plan.id);
    toast.success(t("payments.admin.plans.deleted"));
  } catch (err) {
    toast.error(errorText(err, t("payments.admin.plans.errors.delete")));
  } finally {
    setBusy(plan.id, false);
  }
}

/* ---------------- Editor ---------------- */

const editorOpen = ref(false);
const editing = ref<PaymentPlan | null>(null);

function openCreate() {
  editing.value = null;
  editorOpen.value = true;
}

function openEdit(plan: PaymentPlan) {
  editing.value = plan;
  editorOpen.value = true;
}

function onSaved(plan: PaymentPlan, created: boolean) {
  plans.value = created ? [...plans.value, plan] : plans.value.map((p) => (p.id === plan.id ? plan : p));
  if (created && kindFilter.value !== "all" && kindFilter.value !== plan.kind) kindFilter.value = "all";
}
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.paymentPlans')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="refresh">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <button type="button" class="btn btn-primary" @click="openCreate">
          <UiIcon name="plus" :size="15" />
          {{ t("payments.admin.plans.create") }}
        </button>
      </template>
    </PageHeader>

    <UiAlert v-if="config && !config.enabled" tone="warning">
      {{ t("payments.admin.paymentOff") }}
      <template #action>
        <RouterLink to="/admin/payment-settings" class="btn btn-secondary btn-sm shrink-0">
          <UiIcon name="sliders" :size="14" />
          {{ t("payments.admin.openSettings") }}
        </RouterLink>
      </template>
    </UiAlert>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        :label="t('payments.admin.plans.stats.total')"
        :value="loaded ? `${counts.enabled} / ${counts.all}` : '—'"
        icon="box"
        tone="accent"
      />
      <StatCard :label="t('payments.admin.plans.stats.recharge')" :value="loaded ? counts.recharge : '—'" icon="wallet" tone="info" />
      <StatCard
        :label="t('payments.admin.plans.stats.subscription')"
        :value="loaded ? counts.subscription : '—'"
        icon="crown"
        tone="violet"
      />
      <StatCard :label="t('payments.admin.plans.stats.lowest')" :value="loaded ? lowest : '—'" icon="trending-up" tone="success" />
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="scrollbar-hide max-w-full overflow-x-auto">
        <SegmentedControl v-model="kindFilter" :options="kindOptions" size="md" />
      </div>
    </div>

    <!-- Skeleton -->
    <div v-if="!loaded && loading" class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
      <div v-for="i in 3" :key="i" class="card h-56 animate-pulse bg-surface-2/40 motion-reduce:animate-none" />
    </div>

    <section v-else-if="plans.length === 0" class="card">
      <EmptyState icon="box" :title="t('payments.admin.plans.empty')">
        <p class="w-full max-w-sm text-xs text-fg-subtle">{{ t("payments.admin.plans.emptyHint") }}</p>
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <UiIcon name="plus" :size="14" />
          {{ t("payments.admin.plans.create") }}
        </button>
      </EmptyState>
    </section>

    <section v-else-if="visible.length === 0" class="card">
      <EmptyState icon="search" :title="t('payments.admin.plans.noMatch')">
        <button type="button" class="btn btn-primary btn-sm" @click="openCreate">
          <UiIcon name="plus" :size="14" />
          {{ t("payments.admin.plans.create") }}
        </button>
      </EmptyState>
    </section>

    <TransitionGroup
      v-else
      tag="div"
      class="grid gap-4 pt-2 sm:grid-cols-2 xl:grid-cols-3"
      move-class="transition-transform duration-300 ease-out motion-reduce:transition-none"
      leave-active-class="transition duration-200 ease-in motion-reduce:transition-none"
      leave-to-class="scale-95 opacity-0"
    >
      <div v-for="(p, i) in visible" :key="p.id" :class="STAGGER_CLASS" :style="stagger(i, 30, 9)">
        <article
          class="card card-hover relative flex h-full flex-col"
          :class="p.enabled ? '' : 'bg-surface-2/40 dark:bg-surface/40'"
        >
          <span
            v-if="p.badge"
            class="absolute -top-2.5 right-4 inline-flex max-w-[60%] items-center gap-1 rounded-full bg-accent-solid px-2.5 py-0.5 text-2xs font-semibold text-accent-fg shadow-glow"
          >
            <UiIcon name="sparkles" :size="11" class="shrink-0" />
            <span class="truncate">{{ p.badge }}</span>
          </span>

          <div class="flex items-start gap-3 p-4 pb-0">
            <span class="icon-chip h-9 w-9" :class="p.kind === 'subscription' ? 'icon-chip-violet' : 'icon-chip-accent'">
              <UiIcon :name="p.kind === 'subscription' ? 'crown' : 'wallet'" :size="17" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold" :class="p.enabled ? 'text-fg' : 'text-fg-muted'" :title="p.name">{{ p.name }}</p>
              <div class="mt-1 flex flex-wrap items-center gap-1">
                <UiBadge :tone="p.kind === 'subscription' ? 'violet' : 'accent'">{{ kindLabel(p.kind) }}</UiBadge>
                <UiBadge v-if="!p.enabled">{{ t("payments.admin.plans.card.offSale") }}</UiBadge>
              </div>
            </div>
            <UiSwitch
              :model-value="p.enabled"
              :disabled="busy.has(p.id)"
              :label="t('payments.admin.plans.card.onSale')"
              hide-label
              @update:model-value="toggle(p)"
            />
          </div>

          <div class="mt-4 flex items-baseline gap-1 px-4" :class="p.enabled ? '' : 'opacity-70'">
            <span class="text-2xl font-bold tracking-tight tabular-nums text-fg">{{ formatFiatCompact(p.priceMinor, p.currency) }}</span>
            <span class="text-2xs font-medium text-fg-subtle">{{ p.currency }}</span>
          </div>

          <dl class="mx-4 mt-3 grid grid-cols-2 gap-3 rounded-lg bg-surface-2/60 px-3 py-2.5 text-xs dark:bg-surface-2/40">
            <div v-if="p.kind === 'recharge'" class="col-span-2 min-w-0">
              <dt class="text-fg-subtle">{{ t("payments.admin.plans.card.credit") }}</dt>
              <dd class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span class="truncate font-semibold tabular-nums text-fg">{{ formatUsd(p.creditNanoUsd) }}</span>
                <span v-if="bonusFor(p)" class="rounded-full bg-success/10 px-1.5 py-px text-2xs font-semibold text-success">
                  {{ t("payments.admin.plans.card.bonus", { pct: bonusFor(p) }) }}
                </span>
              </dd>
            </div>
            <template v-else>
              <div class="min-w-0">
                <dt class="text-fg-subtle">{{ t("payments.admin.plans.card.group") }}</dt>
                <dd class="mt-0.5 truncate font-medium text-fg" :title="p.groupName ?? ''">{{ p.groupName || t("payments.unknownGroup") }}</dd>
              </div>
              <div class="min-w-0">
                <dt class="text-fg-subtle">{{ t("payments.admin.plans.card.validity") }}</dt>
                <dd class="mt-0.5 truncate tabular-nums text-fg">{{ t("payments.days", { n: p.validityDays ?? 0 }) }}</dd>
              </div>
            </template>
          </dl>

          <p v-if="p.description" class="mx-4 mt-3 line-clamp-2 text-xs leading-relaxed text-fg-muted" :title="p.description">
            {{ p.description }}
          </p>

          <div class="min-h-[1rem] flex-1" />
          <footer class="flex items-center justify-between gap-2 border-t border-line/70 px-4 py-2.5">
            <span class="min-w-0 truncate text-2xs text-fg-subtle">
              {{ t("payments.admin.plans.card.sort", { n: p.sortOrder }) }}
              <span class="ml-1 font-mono">{{ p.id }}</span>
            </span>
            <div class="flex shrink-0 items-center gap-1">
              <button type="button" class="btn btn-ghost btn-xs" :disabled="busy.has(p.id)" @click="openEdit(p)">
                <UiIcon name="pencil" :size="12" />
                {{ t("common.edit") }}
              </button>
              <ConfirmButton icon-only :disabled="busy.has(p.id)" @confirm="remove(p)" />
            </div>
          </footer>
        </article>
      </div>
    </TransitionGroup>

    <PlanEditorModal
      v-model:open="editorOpen"
      :plan="editing"
      :groups="groups"
      :default-currency="config?.currency ?? 'CNY'"
      :minor-per-usd="config?.minorPerUsd ?? null"
      @saved="onSaved"
    />
  </div>
</template>
