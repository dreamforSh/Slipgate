<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type { OrderVerifyResult, PaymentOptions, PaymentOrderItem } from "@slipgate/contracts";
import { formatUsdAny } from "../../components/admin/ops/opsUtil";
import ChannelGlyph from "../../components/payments/ChannelGlyph.vue";
import ManualTransferPanel from "../../components/payments/ManualTransferPanel.vue";
import OrderRefundInfo from "../../components/payments/OrderRefundInfo.vue";
import OrderStatusBadge from "../../components/payments/OrderStatusBadge.vue";
import PaymentQrPanel from "../../components/payments/PaymentQrPanel.vue";
import PaymentStatusMark from "../../components/payments/PaymentStatusMark.vue";
import RefundRequestModal from "../../components/payments/RefundRequestModal.vue";
import { detectDevice, invokeWechatPay, usePayErrors } from "../../components/payments/paymentFlow";
import { countdownText, formatFiat, refreshWallet, REFUND_STATUSES } from "../../components/payments/paymentUtil";
import { usePaymentLabels } from "../../components/payments/usePaymentLabels";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import { useNow } from "../../composables/useNow";
import { ApiError, apiJson, errorText } from "../../lib/api";
import { formatDateTime, formatUsd } from "../../lib/format";
import { useAnnouncementStore } from "../../stores/announcements";
import { useAuthStore } from "../../stores/auth";
import { useToastStore } from "../../stores/toast";

const POLL_MS = 3000;
const MAX_POLL_MS = 5 * 60_000;
/** Every Nth poll asks the provider instead of only re-reading the order (~12 s; the BFF allows 20/min). */
const VERIFY_EVERY = 4;

const { t, channelLabel, itemLabel, deliveredText, amountText } = usePaymentLabels();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const toast = useToastStore();
const payError = usePayErrors();
const now = useNow(1000);
const device = detectDevice();

const orderId = computed(() => (typeof route.query.order === "string" ? route.query.order.trim() : ""));
/** Provider return URLs carry a signed resume token (public status page when the order is not ours). */
const resumeToken = computed(() => (typeof route.query.token === "string" ? route.query.token : ""));
/** Stripe's cancel_url (and a cancelled WeChat Pay sheet) land here with `cancelled=1` while the order is still pending. */
const returnedCancelled = computed(() => route.query.cancelled === "1");

const order = ref<PaymentOrderItem | null>(null);
const loading = ref(false);
const loadError = ref<string | null>(null);
const notFound = ref(false);
const manualInstructions = ref("");
/** The payer came back from a cancelled checkout but says they paid anyway: watch for it. */
const acknowledged = ref(false);

/* ---------------- Loading ---------------- */

let instructionsLoaded = false;

async function loadInstructions() {
  if (instructionsLoaded) return;
  instructionsLoaded = true;
  try {
    const opts = await apiJson<PaymentOptions>("/api/v1/user/payments/options");
    manualInstructions.value = opts.manualInstructions;
  } catch {
    instructionsLoaded = false;
  }
}

function applyOrder(next: PaymentOrderItem) {
  const before = order.value?.status;
  // A list or verify read may omit the checkout of a still-pending order: keep the one we had.
  order.value = next.status === "pending" && !next.checkout && order.value?.checkout ? { ...next, checkout: order.value.checkout } : next;
  if (next.status === "paid" && before !== "paid") {
    void refreshWallet();
    // A subscription purchase changes no balance but can make targeted announcements visible.
    useAnnouncementStore().recheck();
  }
  if (next.provider === "manual") void loadInstructions();
}

async function fetchOrder(): Promise<void> {
  const id = orderId.value;
  if (!id) return;
  loading.value = true;
  try {
    const res = await apiJson<{ order: PaymentOrderItem }>(`/api/v1/user/orders/${encodeURIComponent(id)}`, {
      fallbackError: t("payments.result.loadFailed"),
    });
    if (id !== orderId.value) return;
    applyOrder(res.order);
    loadError.value = null;
    notFound.value = false;
  } catch (err) {
    if (id !== orderId.value) return;
    notFound.value = err instanceof ApiError && err.status === 404;
    // Not this account's order, but the link proves who may see its status: show the public page.
    if (notFound.value && resumeToken.value) {
      void router.replace({ path: "/payment/status", query: route.query });
      return;
    }
    loadError.value = errorText(err, t("payments.result.loadFailed"));
  } finally {
    loading.value = false;
  }
}

/* ---------------- Provider check ---------------- */

const verifying = ref(false);

/** POST /verify: asks the provider about a pending / expired order (recovers missed notifications). */
async function verifyOrder(manual: boolean): Promise<void> {
  const id = orderId.value;
  if (!id || verifying.value) return;
  verifying.value = true;
  try {
    const res = await apiJson<OrderVerifyResult>(`/api/v1/user/orders/${encodeURIComponent(id)}/verify`, { method: "POST" });
    if (id !== orderId.value) return;
    applyOrder(res.order);
    loadError.value = null;
    if (!manual) return;
    if (res.recovered) toast.success(t("payFlow.verify.recovered"));
    else if (res.message) toast.warning(t("payFlow.verify.unknown", { message: res.message }));
    else if (res.order.status === "pending" && res.providerStatus === "pending") toast.info(t("payFlow.qr.notYet"));
  } catch (err) {
    // Rate-limited or offline: a plain read still shows any notification that arrived.
    if (manual && !(err instanceof ApiError && err.status === 429)) toast.error(payError(err, t("payFlow.verify.unknownPlain")));
    await fetchOrder();
  } finally {
    verifying.value = false;
  }
}

/* ---------------- Polling (3s, provider check every ~12s, ≤5 min, paused while hidden) ---------------- */

let timer: number | undefined;
let pollStartedAt = 0;
let ticks = 0;
const polling = ref(false);
const timedOut = ref(false);
const hidden = ref(typeof document !== "undefined" && document.visibilityState === "hidden");

const shouldPoll = computed(
  () => order.value?.status === "pending" && (!returnedCancelled.value || acknowledged.value),
);

function stopPolling() {
  window.clearTimeout(timer);
  timer = undefined;
  polling.value = false;
}

function schedule() {
  window.clearTimeout(timer);
  if (!shouldPoll.value || hidden.value) {
    polling.value = false;
    return;
  }
  if (Date.now() - pollStartedAt > MAX_POLL_MS) {
    polling.value = false;
    timedOut.value = true;
    return;
  }
  polling.value = true;
  timer = window.setTimeout(async () => {
    ticks++;
    if (ticks % VERIFY_EVERY === 0 && order.value?.provider !== "manual") await verifyOrder(false);
    else await fetchOrder();
    schedule();
  }, POLL_MS);
}

function startPolling() {
  timedOut.value = false;
  pollStartedAt = Date.now();
  ticks = 0;
  schedule();
}

function onVisibility() {
  hidden.value = document.visibilityState === "hidden";
  if (hidden.value) {
    window.clearTimeout(timer);
    polling.value = false;
  } else if (shouldPoll.value && !timedOut.value) {
    void fetchOrder().then(schedule);
  }
}

/** The refresh button: a provider check (falls back to a read), then a fresh polling window. */
async function refreshStatus() {
  if (order.value && (order.value.status === "pending" || order.value.status === "expired") && order.value.provider !== "manual") {
    await verifyOrder(true);
  } else {
    await fetchOrder();
  }
  if (shouldPoll.value) startPolling();
}

async function confirmPaid() {
  acknowledged.value = true;
  await refreshStatus();
}

async function init() {
  stopPolling();
  order.value = null;
  loadError.value = null;
  notFound.value = false;
  acknowledged.value = false;
  timedOut.value = false;
  if (!orderId.value) return;
  await fetchOrder();
  if (shouldPoll.value) startPolling();
}

onMounted(() => {
  document.addEventListener("visibilitychange", onVisibility);
  void init();
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibility);
  stopPolling();
});
watch(orderId, () => void init());
watch(shouldPoll, (on) => {
  if (!on) stopPolling();
});

/* ---------------- Cancel ---------------- */

const cancelling = ref(false);

async function cancelOrder() {
  const o = order.value;
  if (!o || cancelling.value) return;
  cancelling.value = true;
  try {
    const res = await apiJson<{ order: PaymentOrderItem }>(`/api/v1/user/orders/${encodeURIComponent(o.id)}/cancel`, {
      method: "POST",
      fallbackError: t("payments.result.cancelFailed"),
    });
    applyOrder(res.order);
    stopPolling();
    // Cancelling asks the provider first: an order it reports paid is delivered instead.
    if (res.order.status === "cancelled") toast.success(t("payments.result.cancelSuccess"));
  } catch (err) {
    toast.error(payError(err, t("payments.result.cancelFailed")));
    void fetchOrder();
  } finally {
    cancelling.value = false;
  }
}

/* ---------------- Resume a pending payment ---------------- */

const checkout = computed(() => (order.value?.status === "pending" ? order.value.checkout : null));
const qrInline = computed(() => checkout.value?.flow === "qrcode" && Boolean(checkout.value.qrCode));
const reopenUrl = computed(() => {
  const c = checkout.value;
  if (c && c.flow !== "redirect") return null;
  return c?.payUrl ?? order.value?.payUrl ?? null;
});
const wechatPayable = computed(() => checkout.value?.flow === "jsapi" && Boolean(checkout.value.jsapi) && device === "wechat");
const airwallexPayable = computed(() => checkout.value?.flow === "airwallex" && Boolean(checkout.value.airwallex));

const invoking = ref(false);

async function payInWechat() {
  const params = checkout.value?.jsapi;
  if (!params || invoking.value) return;
  invoking.value = true;
  try {
    const outcome = await invokeWechatPay(params);
    if (outcome === "ok") {
      acknowledged.value = true;
      await refreshStatus();
    } else if (outcome === "cancel") toast.info(t("payFlow.checkout.wechatCancelled"));
    else if (outcome === "unavailable") toast.warning(t("payFlow.checkout.wechatUnavailable"));
    else toast.warning(t("payFlow.checkout.wechatFailed"));
  } finally {
    invoking.value = false;
  }
}

/* ---------------- Refund request ---------------- */

const refundOpen = ref(false);

function onRefundRequested(next: PaymentOrderItem) {
  applyOrder(next);
}

/* ---------------- View state ---------------- */

type View =
  | "missing"
  | "loading"
  | "error"
  | "paid"
  | "pending"
  | "manual"
  | "returned"
  | "cancelled"
  | "expired"
  | "refunded"
  | "failed"
  | "refund_requested"
  | "refund_pending"
  | "refund_failed"
  | "partially_refunded";

const view = computed<View>(() => {
  if (!orderId.value) return "missing";
  const o = order.value;
  if (!o) return loadError.value ? "error" : "loading";
  if (o.status === "paid") return "paid";
  if (o.status === "pending") {
    if (returnedCancelled.value && !acknowledged.value) return "returned";
    return o.provider === "manual" ? "manual" : "pending";
  }
  return o.status;
});

const isRefundView = computed(() => order.value !== null && REFUND_STATUSES.has(order.value.status));

const mark = computed<{ state: "pending" | "manual" | "success" | "closed" | "failed"; icon?: IconName }>(() => {
  switch (view.value) {
    case "paid":
      return { state: "success" };
    case "manual":
      return { state: "manual" };
    case "pending":
      return timedOut.value ? { state: "closed", icon: "clock" } : { state: "pending" };
    case "failed":
      return { state: "failed" };
    case "expired":
      return { state: "closed", icon: "clock" };
    case "refund_requested":
    case "refund_pending":
    case "refund_failed":
      return { state: "manual", icon: "rotate-ccw" };
    case "refunded":
    case "partially_refunded":
      return { state: "closed", icon: "rotate-ccw" };
    default:
      return { state: "closed", icon: "x-circle" };
  }
});

const glow = computed(() => {
  switch (view.value) {
    case "paid":
      return "from-success/[0.12]";
    case "pending":
      return "from-accent/[0.10]";
    case "manual":
    case "returned":
    case "refund_requested":
    case "refund_pending":
    case "refund_failed":
      return "from-warning/[0.09]";
    case "failed":
      return "from-danger/[0.08]";
    default:
      return "from-fg-subtle/[0.08]";
  }
});

const heroTitle = computed(() => {
  switch (view.value) {
    case "paid":
      return t("payments.result.paid.title");
    case "pending":
      return timedOut.value ? t("payments.result.pending.timeoutTitle") : t("payments.result.pending.title");
    case "manual":
      return t("payments.result.manual.title");
    case "returned":
      return t("payments.result.returned.title");
    case "cancelled":
    case "expired":
    case "refunded":
    case "failed":
      return t(`payments.result.${view.value}.title`);
    case "refund_requested":
    case "refund_pending":
    case "refund_failed":
    case "partially_refunded":
      return t(`payFlow.result.${view.value}.title`);
    default:
      return "";
  }
});

const heroBody = computed(() => {
  const o = order.value;
  switch (view.value) {
    case "paid":
      return o ? `${itemLabel(o)} · ${amountText(o)}` : "";
    case "pending":
      if (timedOut.value) return t("payments.result.pending.timeoutBody");
      return qrInline.value ? "" : t("payments.result.pending.body");
    case "manual":
      return t("payments.result.manual.body");
    case "returned":
      return t("payments.result.returned.body");
    case "cancelled":
    case "expired":
    case "refunded":
    case "failed":
      return t(`payments.result.${view.value}.body`);
    case "refund_requested":
    case "refund_pending":
    case "refund_failed":
    case "partially_refunded":
      return t(`payFlow.result.${view.value}.body`);
    default:
      return "";
  }
});

const deliveredLine = computed(() => {
  const o = order.value;
  if (!o) return "";
  if (o.kind === "subscription") {
    return t("payments.result.paid.subscribed", { group: o.groupName || t("payments.unknownGroup"), days: o.validityDays ?? 0 });
  }
  return t("payments.result.paid.credited", { amount: formatUsd(o.creditNanoUsd) });
});

const isWaiting = computed(() => view.value === "pending" || view.value === "manual");
const countdown = computed(() => (order.value ? countdownText(order.value.expiresAtIso, now.value) : "-"));
const showRefundCard = computed(() => {
  const o = order.value;
  return Boolean(o && (isRefundView.value || o.refundRequestedAtIso || o.refundAmountMinor > 0));
});
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6">
    <PageHeader :title="t('nav.paymentResult')">
      <template #actions>
        <RouterLink to="/orders" class="btn btn-secondary">
          <UiIcon name="list" :size="15" />
          {{ t("payments.result.paid.orders") }}
        </RouterLink>
      </template>
    </PageHeader>

    <!-- No order id -->
    <section v-if="view === 'missing'" class="card">
      <EmptyState icon="inbox" :title="t('payments.result.missing.title')">
        <p class="w-full max-w-sm text-xs text-fg-subtle">{{ t("payments.result.missing.body") }}</p>
        <RouterLink to="/orders" class="btn btn-secondary btn-sm">
          <UiIcon name="list" :size="14" />
          {{ t("payments.result.paid.orders") }}
        </RouterLink>
      </EmptyState>
    </section>

    <!-- Load failure -->
    <section v-else-if="view === 'error'" class="card">
      <EmptyState icon="x-circle" :title="notFound ? t('payments.result.notFound') : (loadError ?? t('payments.result.loadFailed'))">
        <button v-if="!notFound" type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="refreshStatus">
          <UiIcon name="refresh" :size="14" :spin="loading" />
          {{ t("payments.result.pending.refresh") }}
        </button>
        <RouterLink to="/orders" class="btn btn-secondary btn-sm">
          <UiIcon name="list" :size="14" />
          {{ t("payments.result.paid.orders") }}
        </RouterLink>
      </EmptyState>
    </section>

    <!-- First load -->
    <div v-else-if="view === 'loading'" class="space-y-6" aria-busy="true">
      <div class="card flex h-80 flex-col items-center justify-center gap-5 motion-safe:animate-pulse">
        <span class="h-24 w-24 rounded-full bg-surface-2" />
        <span class="h-3 w-40 rounded-full bg-surface-2" />
        <span class="h-2.5 w-64 max-w-[80%] rounded-full bg-surface-2/70" />
      </div>
    </div>

    <template v-else-if="order">
      <!-- Hero -->
      <section class="card relative overflow-hidden animate-slide-up motion-reduce:animate-none">
        <div
          class="pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent transition-colors duration-500"
          :class="glow"
        />
        <div class="relative flex flex-col items-center px-5 pb-8 pt-10 text-center sm:px-8">
          <Transition
            mode="out-in"
            enter-active-class="transition duration-300 ease-out motion-reduce:transition-none"
            enter-from-class="scale-90 opacity-0"
            leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
            leave-to-class="scale-95 opacity-0"
          >
            <PaymentStatusMark v-if="!(view === 'pending' && qrInline && !timedOut)" :key="`${mark.state}-${mark.icon ?? ''}`" :state="mark.state" :icon="mark.icon" />
          </Transition>

          <h2 class="text-xl font-bold tracking-tight text-fg" :class="view === 'pending' && qrInline && !timedOut ? '' : 'mt-6'" aria-live="polite">
            {{ heroTitle }}
          </h2>
          <p v-if="heroBody" class="mt-1.5 max-w-md text-sm leading-relaxed text-fg-subtle">{{ heroBody }}</p>

          <!-- Pending in-page QR: the code itself -->
          <div v-if="view === 'pending' && qrInline" class="mt-5 w-full max-w-sm rounded-2xl border border-line bg-surface/80 p-5 shadow-sm">
            <PaymentQrPanel :order="order" :now-ms="now" :size="188" />
          </div>

          <!-- Paid: what arrived -->
          <template v-if="view === 'paid'">
            <div
              class="mt-5 inline-flex max-w-full items-center gap-2 rounded-full bg-success/10 px-4 py-1.5 text-sm font-semibold text-success ring-1 ring-inset ring-success/20 animate-slide-up [animation-delay:700ms] [animation-fill-mode:both] motion-reduce:animate-none"
            >
              <UiIcon :name="order.kind === 'subscription' ? 'crown' : 'zap'" :size="15" class="shrink-0" />
              <span class="truncate">{{ deliveredLine }}</span>
            </div>
            <p v-if="auth.wallet" class="mt-3 text-xs text-fg-subtle">
              {{ t("payments.result.paid.balance") }}
              <span class="ml-1 font-semibold tabular-nums text-fg">{{ formatUsdAny(auth.wallet.availableNanoUsd) }}</span>
            </p>
          </template>

          <!-- Refunded part -->
          <p
            v-if="(view === 'partially_refunded' || view === 'refunded' || view === 'refund_pending') && order.refundAmountMinor > 0"
            class="mt-4 inline-flex items-center gap-1.5 rounded-full bg-violet/10 px-3.5 py-1 text-xs font-semibold tabular-nums text-violet ring-1 ring-inset ring-violet/20"
          >
            <UiIcon name="rotate-ccw" :size="12" />
            {{ t("payFlow.result.refundedAmount", { amount: formatFiat(order.refundAmountMinor, order.currency) }) }}
          </p>

          <!-- Waiting: live status line -->
          <div v-if="isWaiting" class="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-xs text-fg-subtle">
            <span v-if="hidden" class="inline-flex items-center gap-1.5">
              <UiIcon name="pause" :size="12" />
              {{ t("payments.result.pending.paused") }}
            </span>
            <span v-else-if="polling || verifying" class="inline-flex items-center gap-1.5">
              <span class="relative flex h-2 w-2">
                <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
                <span class="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              <template v-if="verifying">{{ t("payFlow.qr.checking") }}</template>
              <template v-else>{{ view === "manual" ? t("payments.result.manual.waiting") : t("payments.result.pending.checking") }}</template>
            </span>
            <span v-if="!qrInline" class="inline-flex items-center gap-1.5 tabular-nums">
              <UiIcon name="clock" :size="12" />
              {{ t("payments.result.pending.countdown", { time: countdown }) }}
            </span>
          </div>

          <!-- Actions -->
          <div class="mt-6 flex flex-wrap items-center justify-center gap-2">
            <template v-if="view === 'paid'">
              <RouterLink to="/dashboard" class="btn btn-primary">
                <UiIcon name="home" :size="15" />
                {{ t("payments.result.paid.dashboard") }}
              </RouterLink>
              <RouterLink v-if="order.kind === 'subscription'" to="/subscriptions" class="btn btn-secondary">
                <UiIcon name="crown" :size="15" />
                {{ t("payments.result.paid.subscriptions") }}
              </RouterLink>
              <RouterLink to="/orders" class="btn btn-secondary">
                <UiIcon name="list" :size="15" />
                {{ t("payments.result.paid.orders") }}
              </RouterLink>
              <button v-if="order.canRequestRefund" type="button" class="btn btn-ghost" @click="refundOpen = true">
                <UiIcon name="rotate-ccw" :size="15" />
                {{ t("payFlow.refundRequest.button") }}
              </button>
            </template>

            <template v-else-if="view === 'pending' || view === 'returned'">
              <a v-if="reopenUrl" :href="reopenUrl" class="btn btn-primary" rel="noopener">
                <UiIcon name="external-link" :size="15" />
                {{ t("payments.result.pending.reopen") }}
              </a>
              <RouterLink
                v-else-if="airwallexPayable"
                :to="{ path: '/payment/airwallex', query: { order: order.id } }"
                class="btn btn-primary"
              >
                <UiIcon name="credit-card" :size="15" />
                {{ t("payFlow.checkout.continueAirwallex") }}
              </RouterLink>
              <button v-else-if="wechatPayable" type="button" class="btn btn-primary" :disabled="invoking" @click="payInWechat">
                <UiIcon :name="invoking ? 'loader' : 'smartphone'" :size="15" :spin="invoking" />
                {{ t("payFlow.checkout.payInWechat") }}
              </button>
              <button
                v-if="view === 'returned'"
                type="button"
                class="btn btn-secondary"
                :disabled="loading || verifying"
                @click="confirmPaid"
              >
                <UiIcon name="check-circle" :size="15" />
                {{ t("payments.result.returned.paidAnyway") }}
              </button>
              <button v-else type="button" class="btn btn-secondary" :disabled="loading || verifying" @click="refreshStatus">
                <UiIcon :name="verifying ? 'loader' : 'refresh'" :size="15" :spin="loading || verifying" />
                {{ qrInline ? t("payFlow.qr.check") : t("payments.result.pending.refresh") }}
              </button>
              <RouterLink v-if="view === 'returned'" to="/purchase" class="btn btn-ghost">
                <UiIcon name="rotate-ccw" :size="15" />
                {{ t("payments.result.retry") }}
              </RouterLink>
            </template>

            <template v-else-if="view === 'manual'">
              <button type="button" class="btn btn-secondary" :disabled="loading" @click="refreshStatus">
                <UiIcon name="refresh" :size="15" :spin="loading" />
                {{ t("payments.result.pending.refresh") }}
              </button>
            </template>

            <template v-else-if="isRefundView">
              <RouterLink to="/orders" class="btn btn-secondary">
                <UiIcon name="list" :size="15" />
                {{ t("payments.result.paid.orders") }}
              </RouterLink>
              <RouterLink to="/dashboard" class="btn btn-ghost">
                <UiIcon name="home" :size="15" />
                {{ t("payments.result.paid.dashboard") }}
              </RouterLink>
            </template>

            <template v-else>
              <RouterLink to="/purchase" class="btn btn-primary">
                <UiIcon name="rotate-ccw" :size="15" />
                {{ t("payments.result.retry") }}
              </RouterLink>
              <button v-if="view === 'expired'" type="button" class="btn btn-secondary" :disabled="loading || verifying" @click="refreshStatus">
                <UiIcon :name="verifying ? 'loader' : 'refresh'" :size="15" :spin="loading || verifying" />
                {{ t("payments.result.pending.refresh") }}
              </button>
              <RouterLink to="/orders" class="btn btn-secondary">
                <UiIcon name="list" :size="15" />
                {{ t("payments.result.paid.orders") }}
              </RouterLink>
            </template>

            <ConfirmButton
              v-if="order.status === 'pending'"
              size="sm"
              icon="x-circle"
              :disabled="cancelling"
              :label="t('payments.result.cancelOrder')"
              :confirm-label="t('payments.result.confirmCancel')"
              @confirm="cancelOrder"
            />
          </div>
        </div>
      </section>

      <!-- Manual transfer details -->
      <UiCard
        v-if="view === 'manual'"
        icon="file"
        :title="t('payments.result.manual.instructions')"
        class="animate-slide-up [animation-delay:60ms] [animation-fill-mode:both] motion-reduce:animate-none"
      >
        <ManualTransferPanel :order="order" :instructions="manualInstructions" />
      </UiCard>

      <!-- Refund details -->
      <UiCard
        v-if="showRefundCard"
        icon="rotate-ccw"
        :title="t('payFlow.refundInfo.title')"
        class="animate-slide-up [animation-delay:60ms] [animation-fill-mode:both] motion-reduce:animate-none"
      >
        <template #actions>
          <OrderStatusBadge :status="order.status" />
        </template>
        <OrderRefundInfo :order="order" />
      </UiCard>

      <!-- Order details -->
      <UiCard
        icon="list"
        :title="t('payments.result.summary.title')"
        class="animate-slide-up [animation-delay:100ms] [animation-fill-mode:both] motion-reduce:animate-none"
      >
        <template #actions>
          <OrderStatusBadge :status="order.status" />
        </template>
        <dl class="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-xs text-fg-subtle">{{ t("payments.result.summary.id") }}</dt>
            <dd class="mt-0.5 flex min-w-0 items-center gap-1">
              <span class="truncate font-mono text-xs text-fg" :title="order.id">{{ order.id }}</span>
              <CopyButton :text="order.id" />
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-fg-subtle">{{ t("payments.result.summary.item") }}</dt>
            <dd class="mt-0.5 truncate text-sm font-medium text-fg">{{ itemLabel(order) }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-fg-subtle">{{ t("payments.result.summary.amount") }}</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums text-fg">
              {{ amountText(order) }}
              <span class="ml-0.5 text-2xs font-medium text-fg-subtle">{{ order.currency }}</span>
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-fg-subtle">{{ t("payments.result.summary.delivered") }}</dt>
            <dd class="mt-0.5 truncate text-sm tabular-nums text-fg">{{ deliveredText(order) }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-fg-subtle">{{ t("payments.result.summary.method") }}</dt>
            <dd class="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-fg">
              <ChannelGlyph :provider="order.provider" :method="order.method" size="xs" />
              <span class="truncate">{{ channelLabel(order.provider, order.method) }}</span>
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-fg-subtle">
              {{ order.paidAtIso ? t("payments.result.summary.paid") : t("payments.result.summary.created") }}
            </dt>
            <dd class="mt-0.5 text-sm tabular-nums text-fg">{{ formatDateTime(order.paidAtIso ?? order.createdAtIso) }}</dd>
          </div>
        </dl>
      </UiCard>
    </template>

    <RefundRequestModal v-model:open="refundOpen" :order="order" @done="onRefundRequested" />
  </div>
</template>
