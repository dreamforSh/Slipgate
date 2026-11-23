<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import {
  minorToFiat,
  type CreateOrderRequest,
  type EasypayMethod,
  type PaymentChannel,
  type PaymentOptions,
  type PaymentPlan,
  type PaymentPlanKind,
} from "@slipgate/contracts";
import { formatUsdAny } from "../../components/admin/ops/opsUtil";
import ChannelGlyph from "../../components/payments/ChannelGlyph.vue";
import PaymentMethodPicker from "../../components/payments/PaymentMethodPicker.vue";
import PaymentQrModal from "../../components/payments/PaymentQrModal.vue";
import PlanCard from "../../components/payments/PlanCard.vue";
import { detectDevice, usePayErrors } from "../../components/payments/paymentFlow";
import { useCheckoutFlow } from "../../components/payments/useCheckoutFlow";
import {
  channelBlock,
  channelId,
  creditNanoForMinor,
  currencySymbol,
  formatFiat,
  formatFiatCompact,
  parseFiatInput,
  planBonusPct,
  refreshWallet,
  sortChannels,
  STAGGER_CLASS,
  stagger,
} from "../../components/payments/paymentUtil";
import { usePaymentLabels } from "../../components/payments/usePaymentLabels";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { ApiError, apiJson, errorText } from "../../lib/api";
import { formatUsd } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toast = useToastStore();
const { channelLabel } = usePaymentLabels();
const payError = usePayErrors();
const checkout = useCheckoutFlow();
const { qrOrder, qrOpen } = checkout;
const device = detectDevice();

/* ---------------- Options ---------------- */

const options = ref<PaymentOptions | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    options.value = await apiJson<PaymentOptions>("/api/v1/user/payments/options", {
      fallbackError: t("payments.purchase.loadFailed"),
    });
    loadError.value = null;
    applyDefaults();
  } catch (err) {
    loadError.value = errorText(err, t("payments.purchase.loadFailed"));
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
  void refreshWallet();
});

const byOrder = (a: PaymentPlan, b: PaymentPlan) => a.sortOrder - b.sortOrder || a.priceMinor - b.priceMinor;
const rechargePlans = computed(() => (options.value?.plans ?? []).filter((p) => p.kind === "recharge").sort(byOrder));
const subscriptionPlans = computed(() => (options.value?.plans ?? []).filter((p) => p.kind === "subscription").sort(byOrder));
const customEnabled = computed(() => Boolean(options.value?.customAmountEnabled));
const channels = computed(() => sortChannels(options.value?.channels ?? []));
const ready = computed(() => Boolean(options.value?.enabled && channels.value.length > 0));

/* ---------------- Tabs & selection ---------------- */

const tab = ref<PaymentPlanKind>(route.query.tab === "subscription" ? "subscription" : "recharge");

const tabs = computed(() => {
  const list: { key: PaymentPlanKind; label: string; icon: "wallet" | "crown"; count?: number }[] = [];
  if (rechargePlans.value.length || customEnabled.value) {
    list.push({ key: "recharge", label: t("payments.purchase.tabs.recharge"), icon: "wallet", count: rechargePlans.value.length || undefined });
  }
  if (subscriptionPlans.value.length) {
    list.push({ key: "subscription", label: t("payments.purchase.tabs.subscription"), icon: "crown", count: subscriptionPlans.value.length });
  }
  return list;
});

/** One remembered choice per tab; "custom" is the free-amount card on the recharge tab. */
const selection = reactive<{ recharge: string | null; subscription: string | null }>({ recharge: null, subscription: null });
const customAmount = ref("");
const channel = ref<string | null>(null);

function preferred(list: PaymentPlan[]): string | null {
  return (list.find((p) => p.badge) ?? list[0])?.id ?? null;
}

function applyDefaults() {
  if (!tabs.value.some((x) => x.key === tab.value)) tab.value = tabs.value[0]?.key ?? "recharge";
  const ids = new Set((options.value?.plans ?? []).map((p) => p.id));
  if (!selection.recharge || (selection.recharge !== "custom" && !ids.has(selection.recharge))) {
    selection.recharge = preferred(rechargePlans.value) ?? (customEnabled.value ? "custom" : null);
  }
  if (selection.recharge === "custom" && !customEnabled.value) selection.recharge = preferred(rechargePlans.value);
  if (!selection.subscription || !ids.has(selection.subscription)) selection.subscription = preferred(subscriptionPlans.value);
  ensureChannel();
}

watch(tab, (next) => {
  const query = { ...route.query };
  if (next === "subscription") query.tab = "subscription";
  else delete query.tab;
  void router.replace({ query });
});

const isCustom = computed(() => tab.value === "recharge" && selection.recharge === "custom");
const selectedPlan = computed<PaymentPlan | null>(() => {
  const id = selection[tab.value];
  if (!id || id === "custom") return null;
  return options.value?.plans.find((p) => p.id === id) ?? null;
});

function choose(id: string) {
  selection[tab.value] = id;
}

/* ---------------- Custom amount ---------------- */

const customInput = ref<HTMLInputElement | null>(null);
const customMinor = computed(() => parseFiatInput(customAmount.value));

// Picking the free-amount card puts the caret straight into the amount box.
watch(isCustom, async (on) => {
  if (!on || customAmount.value) return;
  await nextTick();
  customInput.value?.focus({ preventScroll: true });
});
const customError = computed<string | null>(() => {
  const o = options.value;
  if (!o || !isCustom.value || customAmount.value.trim() === "") return null;
  const minor = customMinor.value;
  if (minor === null || minor <= 0) return t("payments.purchase.custom.invalid");
  if (minor < o.minAmountMinor) return t("payments.purchase.custom.tooLow", { min: formatFiat(o.minAmountMinor, o.currency) });
  if (minor > o.maxAmountMinor) return t("payments.purchase.custom.tooHigh", { max: formatFiat(o.maxAmountMinor, o.currency) });
  return null;
});
const customValid = computed(() => isCustom.value && customMinor.value !== null && customMinor.value > 0 && customError.value === null);

/** A few round amounts inside the allowed range. */
const quickAmounts = computed(() => {
  const o = options.value;
  if (!o) return [];
  return [10, 30, 50, 100, 200, 500, 1000]
    .map((n) => n * 100)
    .filter((m) => m >= o.minAmountMinor && m <= o.maxAmountMinor)
    .slice(0, 5);
});

function pickQuick(minor: number) {
  customAmount.value = minorToFiat(minor).replace(/\.00$/, "");
}

const rateText = computed(() => {
  const o = options.value;
  if (!o) return "";
  return t("payments.purchase.custom.rate", { fiat: formatFiat(o.minorPerUsd, o.currency), usd: formatUsd("1000000000") });
});

/* ---------------- What is being bought ---------------- */

const itemCurrency = computed(() => {
  if (isCustom.value) return options.value?.currency ?? null;
  return selectedPlan.value?.currency ?? null;
});
const itemMinor = computed<number | null>(() => {
  if (isCustom.value) return customValid.value ? customMinor.value : null;
  return selectedPlan.value?.priceMinor ?? null;
});
const itemName = computed(() => {
  if (isCustom.value) return t("payments.customTopUp");
  return selectedPlan.value?.name ?? "";
});
const creditNano = computed<string | null>(() => {
  const o = options.value;
  if (!o) return null;
  if (isCustom.value) return customValid.value && customMinor.value ? creditNanoForMinor(customMinor.value, o.minorPerUsd) : null;
  if (selectedPlan.value?.kind === "recharge") return selectedPlan.value.creditNanoUsd;
  return null;
});
const balanceAfter = computed(() => {
  if (!creditNano.value || !auth.wallet) return null;
  try {
    return formatUsdAny((BigInt(auth.wallet.availableNanoUsd) + BigInt(creditNano.value)).toString());
  } catch {
    return null;
  }
});

function bonusFor(plan: PaymentPlan) {
  const o = options.value;
  return o ? planBonusPct(plan, o.minorPerUsd, o.currency) : null;
}

/* ---------------- Channel ---------------- */

const selectedChannel = computed(() => channels.value.find((c) => channelId(c) === channel.value) ?? null);

/** Currency / availability problems move the selection; an amount problem only explains itself. */
function blockedForItem(ch: PaymentChannel) {
  return channelBlock(ch, itemCurrency.value, null) !== null;
}

function ensureChannel() {
  if (selectedChannel.value && !blockedForItem(selectedChannel.value)) return;
  const first = channels.value.find((c) => !blockedForItem(c));
  channel.value = first ? channelId(first) : null;
}

watch(itemCurrency, ensureChannel);

/* ---------------- Pay ---------------- */

const submitting = ref(false);
/** The browser is on its way to the provider (or WeChat): keep the button busy. */
const redirecting = computed(() => checkout.leaving.value);

const channelProblem = computed(() =>
  selectedChannel.value ? channelBlock(selectedChannel.value, itemCurrency.value, itemMinor.value) : null,
);

const blocker = computed<string | null>(() => {
  if (itemMinor.value === null) return t("payments.purchase.summary.selectItem");
  if (!selectedChannel.value || channelProblem.value) return t("payments.purchase.summary.selectMethod");
  return null;
});

async function pay() {
  const ch = selectedChannel.value;
  if (!ch || blocker.value || submitting.value || redirecting.value) return;
  const body: CreateOrderRequest = { provider: ch.provider, device };
  if (ch.provider === "easypay" && ch.method) body.method = ch.method as EasypayMethod;
  if (isCustom.value && customMinor.value !== null) body.amount = minorToFiat(customMinor.value);
  else if (selectedPlan.value) body.planId = selectedPlan.value.id;
  else return;

  submitting.value = true;
  try {
    const res = await checkout.createOrder(body);
    if (!res) return; // On the way to WeChat's authorization page.
    await checkout.proceed(res.order, res.checkout);
  } catch (err) {
    toast.error(payError(err, t("payments.purchase.errors.create"), { conflict: t("payFlow.errors.tooManyPending") }));
    // Limits may have moved since the page loaded: refresh what each channel can take.
    if (err instanceof ApiError && err.code === "payment_limit_exceeded") void load();
  } finally {
    submitting.value = false;
  }
}

function onQrDismissed() {
  toast.info(t("payFlow.qr.keptNote"));
}

const enter = "animate-slide-up [animation-fill-mode:both] motion-reduce:animate-none";
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.purchase')">
      <template #actions>
        <RouterLink to="/orders" class="btn btn-secondary">
          <UiIcon name="list" :size="15" />
          {{ t("payments.purchase.viewOrders") }}
        </RouterLink>
      </template>
    </PageHeader>

    <UiAlert v-if="loadError && !options" tone="warning">
      {{ loadError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="load">
          {{ t("payments.purchase.retry") }}
        </button>
      </template>
    </UiAlert>

    <!-- Skeleton -->
    <div v-if="!options && loading" class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]" aria-busy="true">
      <div class="space-y-6">
        <div class="card h-28 animate-pulse bg-surface-2/40 motion-reduce:animate-none" />
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="i in 3" :key="i" class="card h-40 animate-pulse bg-surface-2/40 motion-reduce:animate-none" />
        </div>
      </div>
      <div class="card h-72 animate-pulse bg-surface-2/40 motion-reduce:animate-none" />
    </div>

    <!-- Payments off / no channel -->
    <section v-else-if="options && !ready" class="card relative overflow-hidden" :class="enter">
      <div class="pointer-events-none absolute inset-0 bg-gradient-to-b from-accent/[0.06] to-transparent" />
      <div class="relative flex flex-col items-center px-6 py-16 text-center">
        <span
          class="relative inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-surface-2 text-fg-subtle ring-1 ring-inset ring-line"
        >
          <UiIcon name="credit-card" :size="28" :stroke-width="1.6" />
          <span class="absolute -right-1.5 -top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full bg-surface ring-1 ring-line">
            <UiIcon name="clock" :size="13" class="text-warning" />
          </span>
        </span>
        <h2 class="mt-5 text-lg font-semibold text-fg">
          {{ options.enabled ? t("payments.purchase.noChannels.title") : t("payments.purchase.disabled.title") }}
        </h2>
        <p class="mt-1.5 max-w-md text-sm leading-relaxed text-fg-subtle">
          {{ options.enabled ? t("payments.purchase.noChannels.body") : t("payments.purchase.disabled.body") }}
        </p>
        <div class="mt-6 flex flex-wrap justify-center gap-2">
          <RouterLink to="/redeem" class="btn btn-primary">
            <UiIcon name="ticket" :size="15" />
            {{ t("payments.purchase.disabled.redeem") }}
          </RouterLink>
          <RouterLink to="/dashboard" class="btn btn-secondary">
            <UiIcon name="home" :size="15" />
            {{ t("payments.purchase.disabled.back") }}
          </RouterLink>
        </div>
      </div>
    </section>

    <div v-else-if="options" class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <div class="min-w-0 space-y-6">
        <!-- Balance -->
        <section class="card relative overflow-hidden" :class="enter">
          <div class="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/[0.10] via-transparent to-violet/[0.06]" />
          <div class="pointer-events-none absolute inset-0 bg-grid [mask-image:linear-gradient(to_bottom,black,transparent)]" />
          <div class="relative flex flex-wrap items-center gap-4 p-5">
            <span class="icon-chip icon-chip-accent h-11 w-11 rounded-xl">
              <UiIcon name="wallet" :size="20" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-medium text-fg-subtle">{{ t("payments.purchase.balance") }}</p>
              <p class="mt-0.5 truncate text-2xl font-bold tracking-tight tabular-nums text-fg">
                {{ auth.wallet ? formatUsdAny(auth.wallet.availableNanoUsd) : "—" }}
              </p>
            </div>
            <p class="w-full text-xs text-fg-subtle sm:w-auto sm:max-w-[16rem] sm:text-right">{{ t("payments.purchase.balanceHint") }}</p>
          </div>
        </section>

        <!-- Step 1: what to buy -->
        <section class="card" :class="enter" :style="{ animationDelay: '40ms' }">
          <div class="px-3">
            <UiTabs v-model="tab" :tabs="tabs" />
          </div>
          <div class="p-4 sm:p-5">
            <Transition
              mode="out-in"
              enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
              enter-from-class="translate-y-1 opacity-0"
              leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
              leave-to-class="opacity-0"
            >
              <!-- Recharge -->
              <div v-if="tab === 'recharge'" key="recharge" class="space-y-4">
                <EmptyState
                  v-if="!rechargePlans.length && !customEnabled"
                  compact
                  icon="wallet"
                  :title="t('payments.purchase.empty.recharge')"
                />
                <div
                  v-else
                  role="radiogroup"
                  :aria-label="t('payments.purchase.tabs.recharge')"
                  class="grid gap-4 pt-2.5 sm:grid-cols-2 xl:grid-cols-3"
                >
                  <div v-for="(p, i) in rechargePlans" :key="p.id" :class="STAGGER_CLASS" :style="stagger(i, 40, 8)">
                    <PlanCard
                      :plan="p"
                      :selected="selection.recharge === p.id"
                      :bonus-pct="bonusFor(p)"
                      @select="choose(p.id)"
                    />
                  </div>
                  <div v-if="customEnabled" :class="STAGGER_CLASS" :style="stagger(rechargePlans.length, 40, 8)">
                    <button
                      type="button"
                      role="radio"
                      :aria-checked="isCustom"
                      class="group relative flex h-full min-h-[9rem] w-full min-w-0 flex-col justify-between rounded-xl border border-dashed p-4 text-left transition-[border-color,box-shadow,transform,background-color] duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      :class="
                        isCustom
                          ? 'border-solid border-accent bg-accent/[0.04] shadow-glow ring-1 ring-accent dark:bg-accent/[0.07]'
                          : 'border-line-strong bg-surface-2/30 hover:-translate-y-0.5 hover:border-accent/50 hover:bg-surface motion-reduce:hover:translate-y-0'
                      "
                      @click="choose('custom')"
                    >
                      <div class="flex items-start gap-3">
                        <span class="icon-chip icon-chip-info h-9 w-9">
                          <UiIcon name="sliders" :size="17" />
                        </span>
                        <div class="min-w-0 flex-1 pt-0.5">
                          <p class="truncate text-sm font-semibold text-fg">{{ t("payments.purchase.custom.title") }}</p>
                          <p class="mt-0.5 line-clamp-2 text-xs text-fg-subtle">{{ t("payments.purchase.custom.hint") }}</p>
                        </div>
                        <span
                          class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
                          :class="isCustom ? 'border-accent-solid bg-accent-solid text-accent-fg' : 'border-line-strong bg-surface'"
                          aria-hidden="true"
                        >
                          <UiIcon
                            name="check"
                            :size="12"
                            :stroke-width="3"
                            class="transition-[opacity,transform] duration-200"
                            :class="isCustom ? 'scale-100 opacity-100' : 'scale-50 opacity-0'"
                          />
                        </span>
                      </div>
                      <p class="mt-4 text-xs tabular-nums text-fg-muted">
                        {{
                          t("payments.purchase.custom.range", {
                            min: formatFiat(options.minAmountMinor, options.currency),
                            max: formatFiat(options.maxAmountMinor, options.currency),
                          })
                        }}
                      </p>
                    </button>
                  </div>
                </div>

                <!-- Custom amount entry -->
                <Transition
                  enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
                  enter-from-class="-translate-y-1 opacity-0"
                  leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
                  leave-to-class="-translate-y-1 opacity-0"
                >
                  <div v-if="isCustom" class="rounded-xl border border-line bg-surface-2/40 p-4">
                    <label class="label" for="purchase-custom-amount">{{ t("payments.purchase.custom.title") }}</label>
                    <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                      <div class="min-w-0">
                        <div class="relative">
                          <span
                            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-base font-semibold text-fg-subtle"
                          >
                            {{ currencySymbol(options.currency) }}
                          </span>
                          <input
                            id="purchase-custom-amount"
                            ref="customInput"
                            v-model="customAmount"
                            type="text"
                            inputmode="decimal"
                            autocomplete="off"
                            class="input h-11 pl-8 text-lg font-semibold tabular-nums"
                            :class="customError ? '!border-danger focus:!ring-danger/20' : ''"
                            :placeholder="t('payments.purchase.custom.placeholder')"
                            :aria-invalid="Boolean(customError)"
                            :disabled="submitting"
                          />
                        </div>
                        <p v-if="customError" class="mt-1.5 text-xs text-danger">{{ customError }}</p>
                        <p v-else class="hint tabular-nums">
                          {{
                            t("payments.purchase.custom.range", {
                              min: formatFiat(options.minAmountMinor, options.currency),
                              max: formatFiat(options.maxAmountMinor, options.currency),
                            })
                          }}
                          · {{ rateText }}
                        </p>
                        <div v-if="quickAmounts.length" class="mt-3 flex flex-wrap gap-1.5">
                          <button
                            v-for="m in quickAmounts"
                            :key="m"
                            type="button"
                            class="btn btn-xs tabular-nums"
                            :class="customMinor === m ? 'btn-primary' : 'btn-secondary'"
                            :disabled="submitting"
                            @click="pickQuick(m)"
                          >
                            {{ formatFiatCompact(m, options.currency) }}
                          </button>
                        </div>
                      </div>
                      <div class="rounded-lg border border-accent/20 bg-accent/[0.06] px-4 py-3 sm:min-w-[10rem] sm:text-right">
                        <p class="text-2xs font-medium text-fg-subtle">{{ t("payments.purchase.custom.credit") }}</p>
                        <p class="mt-0.5 text-xl font-bold tabular-nums text-accent">
                          {{ creditNano ? formatUsd(creditNano) : "—" }}
                        </p>
                      </div>
                    </div>
                  </div>
                </Transition>
              </div>

              <!-- Subscriptions -->
              <div v-else key="subscription">
                <EmptyState
                  v-if="!subscriptionPlans.length"
                  compact
                  icon="crown"
                  :title="t('payments.purchase.empty.subscription')"
                />
                <div
                  v-else
                  role="radiogroup"
                  :aria-label="t('payments.purchase.tabs.subscription')"
                  class="grid gap-4 pt-2.5 sm:grid-cols-2 xl:grid-cols-3"
                >
                  <div v-for="(p, i) in subscriptionPlans" :key="p.id" :class="STAGGER_CLASS" :style="stagger(i, 40, 8)">
                    <PlanCard :plan="p" :selected="selection.subscription === p.id" @select="choose(p.id)" />
                  </div>
                </div>
              </div>
            </Transition>
          </div>
        </section>

        <!-- Step 2: how to pay -->
        <UiCard icon="credit-card" :title="t('payments.purchase.methods.title')" :class="enter" :style="{ animationDelay: '80ms' }">
          <PaymentMethodPicker
            v-model="channel"
            :channels="channels"
            :currency="itemCurrency"
            :amount-minor="itemMinor"
            :disabled="submitting || redirecting"
          />
          <Transition
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            enter-from-class="opacity-0"
            leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
            leave-to-class="opacity-0"
          >
            <p v-if="selectedChannel?.provider === 'manual'" class="mt-3 flex gap-2 text-xs leading-relaxed text-fg-muted">
              <UiIcon name="info" :size="14" class="mt-px shrink-0 text-warning" />
              {{ t("payments.purchase.methods.manualNote") }}
            </p>
          </Transition>
          <Transition
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            enter-from-class="-translate-y-1 opacity-0"
            leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
            leave-to-class="opacity-0"
          >
            <p v-if="channelProblem && itemMinor !== null" class="mt-3 flex gap-2 text-xs leading-relaxed text-warning" role="status">
              <UiIcon name="alert" :size="14" class="mt-px shrink-0" />
              {{ t("payFlow.errors.payment_limit_exceeded") }}
            </p>
          </Transition>
        </UiCard>
      </div>

      <!-- Summary -->
      <aside class="min-w-0 lg:sticky lg:top-24" :class="enter" :style="{ animationDelay: '120ms' }">
        <section class="card overflow-hidden">
          <header class="flex items-center gap-3 border-b border-line/70 px-5 py-3.5">
            <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="box" :size="16" /></span>
            <h2 class="text-sm font-semibold text-fg">{{ t("payments.purchase.summary.title") }}</h2>
          </header>
          <dl class="space-y-3 px-5 py-4 text-sm">
            <div class="flex items-start justify-between gap-4">
              <dt class="shrink-0 text-fg-subtle">{{ t("payments.purchase.summary.item") }}</dt>
              <dd class="min-w-0 truncate text-right font-medium text-fg" :title="itemName">{{ itemName || "—" }}</dd>
            </div>
            <div v-if="selectedPlan?.kind === 'subscription'" class="flex items-start justify-between gap-4">
              <dt class="shrink-0 text-fg-subtle">{{ t("payments.purchase.summary.subscription") }}</dt>
              <dd class="min-w-0 text-right font-medium text-fg">
                {{
                  t("payments.subscriptionValue", {
                    group: selectedPlan.groupName || t("payments.unknownGroup"),
                    days: selectedPlan.validityDays ?? 0,
                  })
                }}
              </dd>
            </div>
            <div v-else class="flex items-start justify-between gap-4">
              <dt class="shrink-0 text-fg-subtle">{{ t("payments.purchase.summary.receive") }}</dt>
              <dd class="text-right font-semibold tabular-nums text-accent">{{ creditNano ? formatUsd(creditNano) : "—" }}</dd>
            </div>
            <div class="flex items-center justify-between gap-4">
              <dt class="shrink-0 text-fg-subtle">{{ t("payments.purchase.summary.method") }}</dt>
              <dd class="flex min-w-0 items-center justify-end gap-1.5 font-medium text-fg">
                <template v-if="selectedChannel">
                  <ChannelGlyph :provider="selectedChannel.provider" :method="selectedChannel.method" size="xs" />
                  <span class="truncate">{{ channelLabel(selectedChannel.provider, selectedChannel.method) }}</span>
                </template>
                <span v-else>—</span>
              </dd>
            </div>
            <div v-if="balanceAfter" class="flex items-center justify-between gap-4">
              <dt class="shrink-0 text-fg-subtle">{{ t("payments.purchase.summary.after") }}</dt>
              <dd class="text-right tabular-nums text-fg-muted">{{ balanceAfter }}</dd>
            </div>
          </dl>
          <div class="border-t border-dashed border-line px-5 py-4">
            <div class="flex items-baseline justify-between gap-4">
              <span class="text-sm text-fg-subtle">{{ t("payments.purchase.summary.price") }}</span>
              <span class="text-right">
                <span class="text-[28px] font-bold leading-none tracking-tight tabular-nums text-fg">
                  {{ itemMinor !== null && itemCurrency ? formatFiat(itemMinor, itemCurrency) : "—" }}
                </span>
                <span v-if="itemCurrency" class="ml-1 text-2xs font-medium text-fg-subtle">{{ itemCurrency }}</span>
              </span>
            </div>
            <button
              type="button"
              class="btn btn-primary mt-4 h-11 w-full text-[15px] shadow-glow"
              :disabled="Boolean(blocker) || submitting || redirecting"
              :aria-busy="submitting || redirecting"
              @click="pay"
            >
              <UiIcon v-if="submitting || redirecting" name="loader" :size="16" spin />
              <UiIcon v-else name="lock" :size="15" />
              <template v-if="redirecting">{{ t("payments.purchase.summary.redirecting") }}</template>
              <template v-else-if="submitting">{{ t("payments.purchase.summary.paying") }}</template>
              <template v-else-if="itemMinor !== null && itemCurrency && !blocker">
                {{ t("payments.purchase.summary.pay", { amount: formatFiat(itemMinor, itemCurrency) }) }}
              </template>
              <template v-else>{{ blocker }}</template>
            </button>
            <p class="mt-3 text-center text-2xs leading-relaxed text-fg-subtle">{{ t("payments.purchase.summary.note") }}</p>
          </div>
        </section>
      </aside>
    </div>

    <PaymentQrModal v-model:open="qrOpen" :order="qrOrder" @paid="checkout.onQrPaid" @dismissed="onQrDismissed" />
  </div>
</template>
