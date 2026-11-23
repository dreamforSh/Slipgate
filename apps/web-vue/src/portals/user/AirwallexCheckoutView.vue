<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type { PaymentOrderItem } from "@slipgate/contracts";
import ChannelGlyph from "../../components/payments/ChannelGlyph.vue";
import {
  mountAirwallexDropIn,
  openAirwallexHosted,
  resultLink,
  usePayErrors,
  type AirwallexElement,
} from "../../components/payments/paymentFlow";
import { countdownText } from "../../components/payments/paymentUtil";
import { usePaymentLabels } from "../../components/payments/usePaymentLabels";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { useNow } from "../../composables/useNow";
import { apiJson } from "../../lib/api";

/**
 * Airwallex checkout: loads the order's payment intent (checkout.airwallex) into Airwallex's
 * embedded drop-in; builds without it go to the hosted checkout page. Success lands on the
 * result page, which confirms the payment with the BFF (webhook or provider check).
 */
const { t, locale } = useI18n();
const { itemLabel, amountText } = usePaymentLabels();
const route = useRoute();
const router = useRouter();
const payError = usePayErrors();
const now = useNow(1000);

const orderId = computed(() => (typeof route.query.order === "string" ? route.query.order.trim() : ""));
const order = ref<PaymentOrderItem | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);
const sdkState = ref<"idle" | "loading" | "ready" | "failed" | "redirecting">("idle");
const formError = ref<string | null>(null);
const container = ref<HTMLElement | null>(null);

let element: AirwallexElement | null = null;

const intent = computed(() => (order.value?.status === "pending" ? (order.value.checkout?.airwallex ?? null) : null));
const sdkLocale = computed(() => (locale.value.toLowerCase().startsWith("zh") ? "zh" : "en"));
const successUrl = computed(() => `${window.location.origin}/payment/result?order=${encodeURIComponent(orderId.value)}`);

async function loadOrder() {
  if (!orderId.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const res = await apiJson<{ order: PaymentOrderItem }>(`/api/v1/user/orders/${encodeURIComponent(orderId.value)}`);
    order.value = res.order;
    loadError.value = null;
  } catch (err) {
    loadError.value = payError(err, t("payments.result.loadFailed"));
  } finally {
    loading.value = false;
  }
}

function teardown() {
  try {
    element?.unmount?.();
    element?.destroy?.();
  } catch {
    // The SDK may already have removed it.
  }
  element = null;
}

async function mount() {
  const c = intent.value;
  if (!c) return;
  teardown();
  sdkState.value = "loading";
  formError.value = null;
  await nextTick();
  try {
    const target = container.value;
    const el = target ? await mountAirwallexDropIn(c, target, sdkLocale.value) : null;
    if (!el) {
      // This SDK build cannot embed the drop-in: use the hosted page instead.
      sdkState.value = "redirecting";
      await openAirwallexHosted(c, successUrl.value, sdkLocale.value);
      return;
    }
    element = el;
    el.on("ready", () => (sdkState.value = "ready"));
    el.on("success", () => void router.replace(resultLink(orderId.value)));
    el.on("error", (ev) => {
      const detail = (ev as { detail?: { error?: { message?: string } } })?.detail?.error?.message;
      formError.value = detail || t("payFlow.airwallex.failedBody");
    });
    // Some builds emit no "ready": show the form once it is mounted.
    window.setTimeout(() => {
      if (sdkState.value === "loading") sdkState.value = "ready";
    }, 1500);
  } catch {
    sdkState.value = "failed";
  }
}

async function hosted() {
  const c = intent.value;
  if (!c) return;
  sdkState.value = "redirecting";
  try {
    await openAirwallexHosted(c, successUrl.value, sdkLocale.value);
  } catch {
    sdkState.value = "failed";
  }
}

onMounted(async () => {
  await loadOrder();
  if (intent.value) void mount();
});
onBeforeUnmount(teardown);
watch(orderId, async () => {
  teardown();
  await loadOrder();
  if (intent.value) void mount();
});

const expired = computed(() => {
  const at = order.value ? Date.parse(order.value.expiresAtIso) : Number.NaN;
  return Number.isFinite(at) && now.value >= at;
});
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <PageHeader :title="t('payFlow.airwallex.title')">
      <template #actions>
        <RouterLink v-if="orderId" :to="resultLink(orderId)" class="btn btn-secondary">
          <UiIcon name="list" :size="15" />
          <span class="hidden sm:inline">{{ t("payFlow.airwallex.status") }}</span>
        </RouterLink>
      </template>
    </PageHeader>

    <!-- First load -->
    <div v-if="loading && !order" class="card h-96 motion-safe:animate-pulse" aria-busy="true">
      <div class="space-y-3 p-6">
        <span class="block h-3 w-1/3 rounded-full bg-surface-2" />
        <span class="block h-2.5 w-1/2 rounded-full bg-surface-2/70" />
        <span class="mt-8 block h-48 rounded-xl bg-surface-2/60" />
      </div>
    </div>

    <section v-else-if="!orderId || loadError" class="card">
      <EmptyState icon="x-circle" :title="loadError ?? t('payments.result.missing.title')">
        <button v-if="loadError" type="button" class="btn btn-secondary btn-sm" @click="loadOrder">
          <UiIcon name="refresh" :size="14" />
          {{ t("payFlow.airwallex.retry") }}
        </button>
        <RouterLink to="/orders" class="btn btn-secondary btn-sm">
          <UiIcon name="list" :size="14" />
          {{ t("payments.result.paid.orders") }}
        </RouterLink>
      </EmptyState>
    </section>

    <section v-else-if="order && !intent" class="card">
      <EmptyState icon="check-circle" :title="t('payFlow.airwallex.notPayable')">
        <RouterLink :to="resultLink(order.id)" class="btn btn-primary btn-sm">
          {{ t("payFlow.airwallex.status") }}
          <UiIcon name="chevron-right" :size="14" />
        </RouterLink>
      </EmptyState>
    </section>

    <template v-else-if="order && intent">
      <!-- Summary -->
      <section class="card relative overflow-hidden animate-slide-up motion-reduce:animate-none">
        <div class="pointer-events-none absolute inset-0 bg-gradient-to-br from-danger/[0.06] via-transparent to-accent/[0.06]" />
        <div class="relative flex flex-wrap items-center gap-4 p-5">
          <ChannelGlyph provider="airwallex" size="lg" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold text-fg">{{ itemLabel(order) }}</p>
            <p class="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-fg-subtle">
              {{ t("payFlow.airwallex.orderId") }}
              <span class="truncate font-mono">{{ order.id }}</span>
              <CopyButton :text="order.id" />
            </p>
          </div>
          <div class="text-right">
            <p class="text-2xs font-medium text-fg-subtle">{{ t("payFlow.airwallex.amount") }}</p>
            <p class="text-2xl font-bold tracking-tight tabular-nums text-fg">
              {{ amountText(order) }}
              <span class="text-2xs font-medium text-fg-subtle">{{ order.currency }}</span>
            </p>
            <p v-if="!expired" class="mt-0.5 text-2xs tabular-nums text-fg-subtle">
              {{ t("payFlow.qr.countdown", { time: countdownText(order.expiresAtIso, now) }) }}
            </p>
          </div>
        </div>
      </section>

      <UiAlert v-if="expired" tone="warning">{{ t("payFlow.qr.expiredBody") }}</UiAlert>

      <!-- Drop-in -->
      <section class="card animate-slide-up [animation-delay:60ms] [animation-fill-mode:both] motion-reduce:animate-none">
        <header class="flex items-center gap-3 border-b border-line/70 px-5 py-3.5">
          <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="lock" :size="15" /></span>
          <p class="min-w-0 flex-1 text-xs leading-relaxed text-fg-subtle">{{ t("payFlow.airwallex.body") }}</p>
        </header>

        <div class="p-5">
          <Transition
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            enter-from-class="opacity-0"
            leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
            leave-to-class="opacity-0"
          >
            <div v-if="sdkState === 'loading' || sdkState === 'redirecting'" class="flex flex-col items-center gap-3 py-10 text-sm text-fg-subtle" role="status">
              <UiIcon name="loader" :size="22" spin class="text-accent" />
              {{ sdkState === "redirecting" ? t("payFlow.checkout.redirecting") : t("payFlow.airwallex.loading") }}
            </div>
          </Transition>

          <div v-if="sdkState === 'failed'" class="space-y-4">
            <UiAlert tone="danger" :title="t('payFlow.airwallex.failedTitle')">{{ t("payFlow.airwallex.failedBody") }}</UiAlert>
            <div class="flex flex-wrap gap-2">
              <button type="button" class="btn btn-primary" @click="mount">
                <UiIcon name="refresh" :size="15" />
                {{ t("payFlow.airwallex.retry") }}
              </button>
              <button type="button" class="btn btn-secondary" @click="hosted">
                <UiIcon name="external-link" :size="15" />
                {{ t("payFlow.airwallex.hosted") }}
              </button>
            </div>
          </div>

          <UiAlert v-if="formError && sdkState === 'ready'" tone="danger" class="mb-4">{{ formError }}</UiAlert>

          <!-- Airwallex mounts its iframe here; hidden (not removed) while loading. -->
          <div
            ref="container"
            class="min-h-[2rem] transition-opacity duration-200 motion-reduce:transition-none"
            :class="sdkState === 'ready' ? 'opacity-100' : 'pointer-events-none h-0 overflow-hidden opacity-0'"
          />

          <div v-if="sdkState === 'ready'" class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line/70 pt-4">
            <p class="flex min-w-0 items-center gap-1.5 text-2xs text-fg-subtle">
              <UiIcon name="shield" :size="12" class="shrink-0" />
              {{ t("payFlow.airwallex.secured") }}
            </p>
            <button type="button" class="btn btn-ghost btn-sm" @click="hosted">
              <UiIcon name="external-link" :size="13" />
              {{ t("payFlow.airwallex.hosted") }}
            </button>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
