<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { PAID_ORDER_STATUSES, type OrderVerifyResult, type PaymentOrderItem } from "@slipgate/contracts";
import { useNow } from "../../composables/useNow";
import { apiJson } from "../../lib/api";
import { useToastStore } from "../../stores/toast";
import ConfirmButton from "../ui/ConfirmButton.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import PaymentQrPanel from "./PaymentQrPanel.vue";
import PaymentStatusMark from "./PaymentStatusMark.vue";
import { resultLink, usePayErrors } from "./paymentFlow";
import { prefersReducedMotion } from "./paymentUtil";

/**
 * In-page QR payment: shows the code and watches the order (a light read every 3 s, a provider
 * check every 15 s, paused while the tab is hidden). Emits `paid` once the money arrived and
 * `changed` whenever the order is updated; closing it keeps the order for later.
 */
const props = defineProps<{ open: boolean; order: PaymentOrderItem | null }>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "paid", order: PaymentOrderItem): void;
  (e: "changed", order: PaymentOrderItem): void;
  (e: "dismissed", order: PaymentOrderItem): void;
}>();

const READ_MS = 3000;
const VERIFY_EVERY = 5;

const { t } = useI18n();
const toast = useToastStore();
const payError = usePayErrors();
const now = useNow(1000);

const current = ref<PaymentOrderItem | null>(null);
const state = ref<"waiting" | "paid" | "closed">("waiting");
const checking = ref(false);
const cancelling = ref(false);
const hidden = ref(typeof document !== "undefined" && document.visibilityState === "hidden");

let timer: number | undefined;
let ticks = 0;
let paidTimer: number | undefined;

const shown = computed(() => current.value ?? props.order);
const isPaid = (o: PaymentOrderItem) => PAID_ORDER_STATUSES.includes(o.status);

function apply(o: PaymentOrderItem) {
  // Keep the checkout the modal was opened with: list reads may not repeat it.
  current.value = { ...o, checkout: o.checkout ?? current.value?.checkout ?? null, qrCode: o.qrCode ?? current.value?.qrCode ?? null };
  emit("changed", o);
  if (state.value !== "waiting") return;
  if (isPaid(o)) {
    state.value = "paid";
    stop();
    window.clearTimeout(paidTimer);
    paidTimer = window.setTimeout(() => emit("paid", o), prefersReducedMotion() ? 0 : 1100);
  } else if (o.status !== "pending") {
    state.value = "closed";
    stop();
  }
}

async function read() {
  const id = shown.value?.id;
  if (!id) return;
  try {
    const res = await apiJson<{ order: PaymentOrderItem }>(`/api/v1/user/orders/${encodeURIComponent(id)}`);
    if (props.open && shown.value?.id === id) apply(res.order);
  } catch {
    // A missed read is retried on the next tick.
  }
}

/** Asks the provider; `manual` = the payer pressed "I have paid" (feedback toasts). */
async function verify(manual: boolean) {
  const id = shown.value?.id;
  if (!id || checking.value) return;
  checking.value = true;
  try {
    const res = await apiJson<OrderVerifyResult>(`/api/v1/user/orders/${encodeURIComponent(id)}/verify`, { method: "POST" });
    if (!props.open || shown.value?.id !== id) return;
    apply(res.order);
    if (!manual || isPaid(res.order)) return;
    if (res.message) toast.warning(t("payFlow.verify.unknown", { message: res.message }));
    else toast.info(t("payFlow.qr.notYet"));
  } catch (err) {
    if (manual) toast.error(payError(err, t("payFlow.verify.unknownPlain")));
  } finally {
    checking.value = false;
  }
}

function stop() {
  window.clearTimeout(timer);
  timer = undefined;
}

function schedule() {
  stop();
  if (!props.open || state.value !== "waiting" || hidden.value) return;
  timer = window.setTimeout(async () => {
    ticks++;
    if (ticks % VERIFY_EVERY === 0) await verify(false);
    else await read();
    schedule();
  }, READ_MS);
}

async function cancelOrder() {
  const o = shown.value;
  if (!o || cancelling.value) return;
  cancelling.value = true;
  try {
    const res = await apiJson<{ order: PaymentOrderItem }>(`/api/v1/user/orders/${encodeURIComponent(o.id)}/cancel`, { method: "POST" });
    apply(res.order);
    if (!isPaid(res.order)) toast.success(t("payments.result.cancelSuccess"));
  } catch (err) {
    toast.error(payError(err, t("payments.result.cancelFailed")));
  } finally {
    cancelling.value = false;
  }
}

function onVisibility() {
  hidden.value = document.visibilityState === "hidden";
  if (hidden.value) stop();
  else if (props.open && state.value === "waiting") void read().then(schedule);
}

function close() {
  const o = shown.value;
  emit("update:open", false);
  if (o && state.value === "waiting") emit("dismissed", o);
}

watch(
  () => [props.open, props.order?.id] as const,
  ([open]) => {
    stop();
    window.clearTimeout(paidTimer);
    if (!open) return;
    current.value = props.order;
    state.value = "waiting";
    ticks = 0;
    if (props.order && props.order.status !== "pending") apply(props.order);
    schedule();
  },
  { immediate: true },
);

onMounted(() => document.addEventListener("visibilitychange", onVisibility));
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", onVisibility);
  stop();
  window.clearTimeout(paidTimer);
});
</script>

<template>
  <UiModal :open="open" width="sm" :title="t('payFlow.qr.title')" @update:open="(v) => (v ? emit('update:open', true) : close())">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="qr-code" :size="15" /></span>
    </template>

    <div v-if="shown" class="min-h-[22rem]">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="scale-[0.98] opacity-0"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <div v-if="state === 'waiting'" key="waiting">
          <PaymentQrPanel :order="shown" :now-ms="now" />
          <p class="mt-4 flex items-center justify-center gap-1.5 text-xs text-fg-subtle" aria-live="polite">
            <template v-if="hidden">
              <UiIcon name="pause" :size="12" />
              {{ t("payFlow.qr.paused") }}
            </template>
            <template v-else>
              <span class="relative flex h-2 w-2">
                <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60 motion-reduce:animate-none" />
                <span class="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              {{ checking ? t("payFlow.qr.checking") : t("payFlow.qr.waiting") }}
            </template>
          </p>
        </div>

        <div v-else-if="state === 'paid'" key="paid" class="flex flex-col items-center py-8 text-center">
          <PaymentStatusMark state="success" />
          <p class="mt-6 text-base font-semibold text-fg" aria-live="polite">{{ t("payFlow.qr.paid") }}</p>
        </div>

        <div v-else key="closed" class="flex flex-col items-center py-8 text-center">
          <PaymentStatusMark state="closed" :icon="shown.status === 'expired' ? 'clock' : 'x-circle'" />
          <p class="mt-6 text-base font-semibold text-fg" aria-live="polite">
            {{ shown.status === "expired" ? t("payFlow.qr.expiredTitle") : t("payFlow.qr.closedTitle") }}
          </p>
          <p class="mt-1.5 max-w-xs text-sm text-fg-subtle">
            {{ shown.status === "expired" ? t("payFlow.qr.expiredBody") : t("payFlow.qr.closedBody") }}
          </p>
          <div class="mt-5 flex flex-wrap justify-center gap-2">
            <RouterLink to="/purchase" class="btn btn-primary btn-sm" @click="emit('update:open', false)">
              <UiIcon name="rotate-ccw" :size="14" />
              {{ t("payFlow.qr.backToPurchase") }}
            </RouterLink>
            <RouterLink :to="resultLink(shown.id)" class="btn btn-secondary btn-sm" @click="emit('update:open', false)">
              {{ t("payFlow.qr.viewOrder") }}
            </RouterLink>
          </div>
        </div>
      </Transition>
    </div>

    <template v-if="state === 'waiting'" #footer>
      <!-- Primary first in the DOM so the dialog focuses it; the cancel sits visually on the left. -->
      <button type="button" class="btn btn-primary" :disabled="checking || cancelling" @click="verify(true)">
        <UiIcon :name="checking ? 'loader' : 'check-circle'" :size="15" :spin="checking" />
        {{ t("payFlow.qr.check") }}
      </button>
      <ConfirmButton
        size="sm"
        icon="x-circle"
        class="order-first mr-auto"
        :disabled="cancelling || checking"
        :label="t('payFlow.qr.cancel')"
        :confirm-label="t('payFlow.qr.confirmCancel')"
        @confirm="cancelOrder"
      />
    </template>
  </UiModal>
</template>
