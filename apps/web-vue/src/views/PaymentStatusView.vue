<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import { PAID_ORDER_STATUSES, type PublicOrderStatus } from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import OrderStatusBadge from "../components/payments/OrderStatusBadge.vue";
import PaymentStatusMark from "../components/payments/PaymentStatusMark.vue";
import { resolvePublicOrder, usePayErrors } from "../components/payments/paymentFlow";
import { formatFiat, REFUND_STATUSES } from "../components/payments/paymentUtil";
import { usePaymentLabels } from "../components/payments/usePaymentLabels";
import UiIcon, { type IconName } from "../components/ui/UiIcon.vue";
import { ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import { useAuthStore } from "../stores/auth";
import { usePortalStore } from "../stores/portal";

/**
 * Public payment result: a provider's return URL carries a signed resume token, so a payer whose
 * session is gone (another browser, the payment app's own browser) still sees whether the order
 * was paid. The BFF also checks pending orders with the provider while resolving.
 */
const POLL_MS = 5000;
const MAX_POLL_MS = 5 * 60_000;

const { t } = useI18n();
const { providerLabel } = usePaymentLabels();
const payError = usePayErrors();
const route = useRoute();
const auth = useAuthStore();
const portal = usePortalStore();

const token = computed(() => (typeof route.query.token === "string" ? route.query.token : ""));
const status = ref<PublicOrderStatus | null>(null);
const loading = ref(false);
const invalid = ref(false);
const error = ref<string | null>(null);
const polling = ref(false);

let timer: number | undefined;
let startedAt = 0;

async function resolve() {
  if (!token.value) {
    invalid.value = true;
    return;
  }
  loading.value = true;
  try {
    status.value = await resolvePublicOrder(token.value);
    error.value = null;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) invalid.value = true;
    else error.value = payError(err, t("payFlow.publicStatus.invalid"));
  } finally {
    loading.value = false;
  }
}

function schedule() {
  window.clearTimeout(timer);
  polling.value = status.value?.status === "pending" && Date.now() - startedAt < MAX_POLL_MS && document.visibilityState !== "hidden";
  if (!polling.value) return;
  timer = window.setTimeout(async () => {
    await resolve();
    schedule();
  }, POLL_MS);
}

async function refresh() {
  await resolve();
  startedAt = Date.now();
  schedule();
}

function onVisibility() {
  if (document.visibilityState === "visible" && status.value?.status === "pending") void refresh();
  else window.clearTimeout(timer);
}

onMounted(async () => {
  document.addEventListener("visibilitychange", onVisibility);
  await refresh();
});
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibility);
  window.clearTimeout(timer);
});

type Phase = "pending" | "paid" | "closed" | "refund";
const phase = computed<Phase>(() => {
  const s = status.value?.status;
  if (!s || s === "pending") return "pending";
  if (REFUND_STATUSES.has(s)) return "refund";
  if (PAID_ORDER_STATUSES.includes(s)) return "paid";
  return "closed";
});

const mark = computed<{ state: "pending" | "success" | "closed" | "failed"; icon?: IconName }>(() => {
  switch (phase.value) {
    case "paid":
      return { state: "success" };
    case "refund":
      return { state: "closed", icon: "rotate-ccw" };
    case "closed":
      return status.value?.status === "failed" ? { state: "failed" } : { state: "closed", icon: status.value?.status === "expired" ? "clock" : "x-circle" };
    default:
      return { state: "pending" };
  }
});

const signInLink = computed(() => ({
  path: "/login",
  query: { redirect: `/payment/result?order=${encodeURIComponent(status.value?.id ?? "")}` },
}));
</script>

<template>
  <AuthLayout :site-name="portal.siteName">
    <div class="card overflow-hidden">
      <!-- First load -->
      <div v-if="!status && !invalid && !error" class="flex flex-col items-center gap-4 p-10 motion-safe:animate-pulse" aria-busy="true">
        <span class="h-20 w-20 rounded-full bg-surface-2" />
        <span class="h-3 w-40 rounded-full bg-surface-2" />
        <span class="sr-only">{{ t("payFlow.publicStatus.loading") }}</span>
      </div>

      <!-- Bad link -->
      <div v-else-if="invalid" class="p-8 text-center">
        <span class="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
          <UiIcon name="x-circle" :size="22" />
        </span>
        <p class="mt-4 text-base font-semibold text-fg">{{ t("payFlow.publicStatus.invalid") }}</p>
        <p class="mt-1 text-sm text-fg-muted">{{ t("payFlow.publicStatus.invalidBody") }}</p>
        <RouterLink :to="auth.isAuthenticated ? '/orders' : '/login'" class="btn btn-primary mt-6">
          {{ auth.isAuthenticated ? t("payments.result.paid.orders") : t("payFlow.publicStatus.signIn") }}
        </RouterLink>
      </div>

      <!-- Error without a status yet -->
      <div v-else-if="!status" class="p-8 text-center">
        <span class="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-warning/10 text-warning">
          <UiIcon name="alert" :size="22" />
        </span>
        <p class="mt-4 text-sm text-fg-muted" role="alert">{{ error }}</p>
        <button type="button" class="btn btn-primary mt-6" :disabled="loading" @click="refresh">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("payFlow.publicStatus.refresh") }}
        </button>
      </div>

      <template v-else>
        <div class="relative flex flex-col items-center px-6 pb-6 pt-8 text-center">
          <div
            class="pointer-events-none absolute inset-0 bg-gradient-to-b to-transparent transition-colors duration-500"
            :class="phase === 'paid' ? 'from-success/[0.12]' : phase === 'pending' ? 'from-accent/[0.10]' : 'from-fg-subtle/[0.08]'"
          />
          <Transition
            mode="out-in"
            enter-active-class="transition duration-300 ease-out motion-reduce:transition-none"
            enter-from-class="scale-90 opacity-0"
            leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
            leave-to-class="scale-95 opacity-0"
          >
            <PaymentStatusMark :key="`${mark.state}-${mark.icon ?? ''}`" :state="mark.state" :icon="mark.icon" class="relative" />
          </Transition>
          <h1 class="relative mt-5 text-lg font-bold tracking-tight text-fg" aria-live="polite">{{ t("payFlow.publicStatus.title") }}</h1>
          <p class="relative mt-1.5 max-w-sm text-sm leading-relaxed text-fg-subtle">{{ t(`payFlow.publicStatus.statusBody.${phase}`) }}</p>
          <p v-if="polling" class="relative mt-3 inline-flex items-center gap-1.5 text-xs text-fg-subtle">
            <span class="relative flex h-2 w-2">
              <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
              <span class="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            {{ t("payFlow.publicStatus.autoRefresh") }}
          </p>
        </div>

        <dl class="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line/70 bg-surface-2/30 px-6 py-5 text-left text-xs">
          <div class="col-span-2 flex items-center justify-between gap-3">
            <dt class="text-fg-subtle">{{ t("payFlow.publicStatus.status") }}</dt>
            <dd><OrderStatusBadge :status="status.status" /></dd>
          </div>
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("payFlow.publicStatus.item") }}</dt>
            <dd class="mt-0.5 truncate text-sm font-medium text-fg">{{ status.planName || t("payments.customTopUp") }}</dd>
          </div>
          <div class="min-w-0 text-right">
            <dt class="text-fg-subtle">{{ t("payFlow.publicStatus.amount") }}</dt>
            <dd class="mt-0.5 text-sm font-semibold tabular-nums text-fg">{{ formatFiat(status.amountMinor, status.currency) }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("payFlow.publicStatus.method") }}</dt>
            <dd class="mt-0.5 truncate text-sm text-fg">{{ providerLabel(status.provider) }}</dd>
          </div>
          <div class="min-w-0 text-right">
            <dt class="text-fg-subtle">{{ status.paidAtIso ? t("payFlow.publicStatus.paidAt") : t("payFlow.publicStatus.created") }}</dt>
            <dd class="mt-0.5 text-sm tabular-nums text-fg">{{ formatDateTime(status.paidAtIso ?? status.createdAtIso) }}</dd>
          </div>
        </dl>

        <div class="flex flex-wrap items-center justify-center gap-2 border-t border-line/70 px-6 py-4">
          <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="refresh">
            <UiIcon name="refresh" :size="14" :spin="loading" />
            {{ t("payFlow.publicStatus.refresh") }}
          </button>
          <RouterLink v-if="!auth.isAuthenticated" :to="signInLink" class="btn btn-primary btn-sm">
            <UiIcon name="log-in" :size="14" />
            {{ t("payFlow.publicStatus.signIn") }}
          </RouterLink>
          <RouterLink v-else to="/orders" class="btn btn-primary btn-sm">
            <UiIcon name="list" :size="14" />
            {{ t("payments.result.paid.orders") }}
          </RouterLink>
        </div>
      </template>
    </div>
  </AuthLayout>
</template>
