<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { minorToFiat, type AdminRefundRequest, type AdminRefundResult, type PaymentOrderItem } from "@slipgate/contracts";
import { apiJson } from "../../lib/api";
import { formatDateTime, formatUsd } from "../../lib/format";
import ConfirmButton from "../ui/ConfirmButton.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import ChannelGlyph from "./ChannelGlyph.vue";
import { PayApiError, payApi, usePayErrors } from "./paymentFlow";
import { currencySymbol, formatFiat, parseFiatInput } from "./paymentUtil";
import { usePaymentLabels } from "./usePaymentLabels";

/**
 * Admin refund (POST /admin/payments/orders/:id/refund): full or partial amount, a note, whether
 * the money goes back through the provider or the refund is only recorded, and whether the
 * delivered balance / subscription days are taken back in proportion. Also reviews a payer's
 * request (approve = refund, reject = back to paid) and retries a failed or stuck refund.
 */
const props = defineProps<{ open: boolean; order: PaymentOrderItem | null }>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "done", result: AdminRefundResult): void;
  (e: "rejected", order: PaymentOrderItem): void;
}>();

const REASON_MAX = 500;

const { t } = useI18n();
const { itemLabel, deliveredText, amountText, channelLabel } = usePaymentLabels();
const payError = usePayErrors();

type Route = "provider" | "record";

const amount = ref("");
const reason = ref("");
const route = ref<Route>("provider");
const reclaim = ref(true);
const force = ref(false);
const forceInfo = ref<{ balance: string; reclaim: string } | null>(null);
const unavailable = ref<string | null>(null);
const serverError = ref<string | null>(null);
const busy = ref(false);
const rejecting = ref(false);

const isManual = computed(() => props.order?.provider === "manual");
const mode = computed<"review" | "retry" | "refund">(() => {
  const s = props.order?.status;
  if (s === "refund_requested") return "review";
  if (s === "refund_failed" || s === "refund_pending") return "retry";
  return "refund";
});
const title = computed(() =>
  mode.value === "review" ? t("payFlow.adminRefund.reviewTitle") : mode.value === "retry" ? t("payFlow.adminRefund.retryTitle") : t("payFlow.adminRefund.title"),
);

watch(
  () => [props.open, props.order?.id] as const,
  ([open]) => {
    const o = props.order;
    if (!open || !o) return;
    const previous = o.refundAmountMinor > 0 && mode.value === "retry" ? o.refundAmountMinor : o.amountMinor;
    amount.value = minorToFiat(previous);
    reason.value = (o.refundReason ?? o.refundRequestReason ?? "").slice(0, REASON_MAX);
    route.value = o.provider === "manual" ? "record" : "provider";
    reclaim.value = true;
    force.value = false;
    forceInfo.value = null;
    unavailable.value = null;
    serverError.value = null;
  },
  { immediate: true },
);

/* ---------------- Amount ---------------- */

const amountMinor = computed(() => parseFiatInput(amount.value));
const amountError = computed(() => {
  const o = props.order;
  if (!o) return null;
  const m = amountMinor.value;
  if (m === null || m <= 0 || m > o.amountMinor) return t("payFlow.adminRefund.amountInvalid", { max: formatFiat(o.amountMinor, o.currency) });
  return null;
});
const isPartial = computed(() => Boolean(props.order && amountMinor.value !== null && amountMinor.value < props.order.amountMinor));

function setFull() {
  if (props.order) amount.value = minorToFiat(props.order.amountMinor);
}

/* ---------------- What is taken back ---------------- */

const share = (whole: bigint): bigint => {
  const o = props.order;
  const m = amountMinor.value;
  if (!o || m === null || m <= 0 || o.amountMinor <= 0) return 0n;
  return (whole * BigInt(Math.min(m, o.amountMinor))) / BigInt(o.amountMinor);
};

const reclaimKind = computed<"balance" | "days" | null>(() => {
  const o = props.order;
  if (!o) return null;
  if (o.kind === "recharge") {
    try {
      return BigInt(o.creditNanoUsd) > 0n ? "balance" : null;
    } catch {
      return null;
    }
  }
  return o.deliveryError ? null : "days";
});

const reclaimHint = computed(() => {
  const o = props.order;
  if (!o) return "";
  if (reclaimKind.value === "balance") {
    return t("payFlow.adminRefund.reclaimBalanceHint", { amount: formatUsd(share(BigInt(o.creditNanoUsd)).toString()) });
  }
  if (reclaimKind.value === "days") {
    const days = Math.max(1, Math.round(Number(share(BigInt((o.validityDays ?? 0) * 1000))) / 1000));
    return t("payFlow.adminRefund.reclaimDaysHint", { group: o.groupName || t("payments.unknownGroup"), days });
  }
  return "";
});

const routeOptions = computed<{ value: Route; label: string }[]>(() => [
  { value: "provider", label: t("payFlow.adminRefund.viaProvider") },
  { value: "record", label: t("payFlow.adminRefund.record") },
]);

watch(route, () => {
  unavailable.value = null;
});

/* ---------------- Submit ---------------- */

async function submit() {
  const o = props.order;
  if (!o || busy.value || amountError.value || amountMinor.value === null) return;
  busy.value = true;
  serverError.value = null;
  const body: AdminRefundRequest = {
    amount: minorToFiat(amountMinor.value),
    reason: reason.value.trim(),
    reclaim: reclaimKind.value !== null && reclaim.value,
    force: force.value,
    viaProvider: !isManual.value && route.value === "provider",
  };
  try {
    const res = await payApi<AdminRefundResult>(`/api/v1/admin/payments/orders/${encodeURIComponent(o.id)}/refund`, {
      method: "POST",
      body,
    });
    emit("done", res);
    emit("update:open", false);
  } catch (err) {
    if (err instanceof PayApiError && err.code === "refund_requires_force") {
      forceInfo.value = { balance: String(err.body.balanceNanoUsd ?? "0"), reclaim: String(err.body.reclaimNanoUsd ?? "0") };
      force.value = true;
    } else if (err instanceof PayApiError && err.code === "refund_unavailable") {
      unavailable.value = err.message;
    } else {
      serverError.value = payError(err, t("payFlow.adminRefund.failed"), { conflict: t("payFlow.errors.refundConflict") });
    }
  } finally {
    busy.value = false;
  }
}

function useRecord() {
  route.value = "record";
  unavailable.value = null;
}

async function reject() {
  const o = props.order;
  if (!o || rejecting.value) return;
  rejecting.value = true;
  serverError.value = null;
  try {
    const res = await apiJson<{ order: PaymentOrderItem }>(`/api/v1/admin/payments/orders/${encodeURIComponent(o.id)}/action`, {
      method: "POST",
      body: { action: "reject_refund", reclaimBalance: false },
    });
    emit("rejected", res.order);
    emit("update:open", false);
  } catch (err) {
    serverError.value = payError(err, t("payments.admin.orders.errors.action"), { conflict: t("payFlow.errors.refundConflict") });
  } finally {
    rejecting.value = false;
  }
}

const canReject = computed(() => props.order?.status === "refund_requested" || props.order?.status === "refund_failed");
const working = computed(() => busy.value || rejecting.value);
const submitLabel = computed(() => {
  if (forceInfo.value) return t("payFlow.adminRefund.forceSubmit");
  return mode.value === "review" ? t("payFlow.adminRefund.approve") : t("payFlow.adminRefund.submit");
});

const enter = {
  "enter-active-class": "transition duration-200 ease-out motion-reduce:transition-none",
  "enter-from-class": "-translate-y-1 opacity-0",
  "leave-active-class": "transition duration-150 ease-in motion-reduce:transition-none",
  "leave-to-class": "opacity-0",
};
</script>

<template>
  <UiModal :open="open" width="md" :title="title" :persistent="working" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip h-8 w-8" :class="mode === 'review' ? 'icon-chip-info' : 'icon-chip-danger'">
        <UiIcon name="rotate-ccw" :size="15" />
      </span>
    </template>

    <form v-if="order" id="admin-refund-form" class="space-y-4" novalidate @submit.prevent="submit">
      <!-- The payer's request -->
      <div v-if="order.refundRequestedAtIso || order.refundRequestReason" class="rounded-xl border border-info/25 bg-info/[0.05] p-3.5 text-xs">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p class="font-medium text-info">{{ t("payFlow.adminRefund.request") }}</p>
          <p v-if="order.refundRequestedAtIso" class="tabular-nums text-fg-subtle">{{ formatDateTime(order.refundRequestedAtIso) }}</p>
        </div>
        <p v-if="order.refundRequestReason" class="mt-1.5 whitespace-pre-line break-words text-sm leading-relaxed text-fg">
          {{ order.refundRequestReason }}
        </p>
      </div>

      <!-- Order -->
      <dl class="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-line bg-surface-2/40 p-3.5 text-xs">
        <div class="col-span-2 min-w-0">
          <dt class="text-fg-subtle">{{ t("payments.admin.orders.summary.order") }}</dt>
          <dd class="mt-0.5 truncate font-mono text-fg">{{ order.id }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-fg-subtle">{{ t("payments.admin.orders.summary.user") }}</dt>
          <dd class="mt-0.5 truncate text-fg">{{ order.userEmail || order.userId }}</dd>
        </div>
        <div class="min-w-0">
          <dt class="text-fg-subtle">{{ t("payments.admin.orders.summary.amount") }}</dt>
          <dd class="mt-0.5 font-semibold tabular-nums text-fg">{{ amountText(order) }}</dd>
        </div>
        <div class="col-span-2 min-w-0">
          <dt class="text-fg-subtle">{{ t("payments.admin.orders.summary.item") }}</dt>
          <dd class="mt-0.5 truncate text-fg">{{ itemLabel(order) }} · {{ deliveredText(order) }}</dd>
        </div>
        <div class="col-span-2 min-w-0">
          <dt class="text-fg-subtle">{{ t("payFlow.detail.channel") }}</dt>
          <dd class="mt-0.5 flex min-w-0 items-center gap-1.5 text-fg">
            <ChannelGlyph :provider="order.provider" :method="order.method" size="xs" />
            <span class="truncate">
              {{ channelLabel(order.provider, order.method) }}
              <template v-if="order.providerInstanceName"> · {{ order.providerInstanceName }}</template>
            </span>
          </dd>
        </div>
      </dl>

      <UiAlert v-if="order.refundError && mode === 'retry'" tone="danger">
        {{ t("payFlow.adminRefund.failedBefore", { error: order.refundError }) }}
      </UiAlert>

      <!-- Amount -->
      <div>
        <label for="admin-refund-amount" class="label">{{ t("payFlow.adminRefund.amount") }}</label>
        <div class="flex gap-2">
          <div class="relative min-w-0 flex-1">
            <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-fg-subtle">
              {{ currencySymbol(order.currency) }}
            </span>
            <input
              id="admin-refund-amount"
              v-model="amount"
              type="text"
              inputmode="decimal"
              autocomplete="off"
              class="input pl-7 tabular-nums"
              :class="amountError ? '!border-danger focus:!ring-danger/20' : ''"
              :aria-invalid="Boolean(amountError)"
              aria-describedby="admin-refund-amount-hint"
              :disabled="working || Boolean(forceInfo)"
            />
          </div>
          <button type="button" class="btn btn-secondary shrink-0" :disabled="working || Boolean(forceInfo) || !isPartial" @click="setFull">
            {{ t("payFlow.adminRefund.full") }}
          </button>
        </div>
        <p v-if="amountError" id="admin-refund-amount-hint" class="mt-1 text-xs text-danger" role="alert">{{ amountError }}</p>
        <p v-else id="admin-refund-amount-hint" class="hint tabular-nums">
          {{ t("payFlow.adminRefund.amountHint", { max: formatFiat(order.amountMinor, order.currency) }) }}
        </p>
      </div>

      <!-- Route -->
      <div v-if="!isManual">
        <p class="label">{{ t("payFlow.adminRefund.route") }}</p>
        <SegmentedControl v-model="route" :options="routeOptions" size="md" block />
        <p class="hint">{{ route === "provider" ? t("payFlow.adminRefund.viaProviderHint") : t("payFlow.adminRefund.recordHint") }}</p>
      </div>
      <p v-else class="flex gap-2 text-xs leading-relaxed text-fg-subtle">
        <UiIcon name="info" :size="14" class="mt-px shrink-0" />
        {{ t("payFlow.adminRefund.manualRecord") }}
      </p>

      <Transition v-bind="enter">
        <UiAlert v-if="unavailable" tone="warning" :title="t('payFlow.adminRefund.unavailableTitle')">
          {{ unavailable }}
          <template #action>
            <button type="button" class="btn btn-secondary btn-sm shrink-0 self-start" @click="useRecord">
              {{ t("payFlow.adminRefund.switchToRecord") }}
            </button>
          </template>
        </UiAlert>
      </Transition>

      <!-- Reclaim -->
      <div v-if="reclaimKind" class="flex items-start justify-between gap-4 rounded-xl border border-line p-3.5">
        <div class="min-w-0">
          <p class="text-sm font-medium text-fg">
            {{ reclaimKind === "balance" ? t("payFlow.adminRefund.reclaimBalance") : t("payFlow.adminRefund.reclaimDays") }}
          </p>
          <p class="mt-0.5 text-xs tabular-nums text-fg-subtle">{{ reclaim ? reclaimHint : t("payFlow.adminRefund.noReclaim") }}</p>
        </div>
        <UiSwitch
          v-model="reclaim"
          tone="accent"
          :disabled="working || Boolean(forceInfo)"
          :label="reclaimKind === 'balance' ? t('payFlow.adminRefund.reclaimBalance') : t('payFlow.adminRefund.reclaimDays')"
          hide-label
        />
      </div>
      <p v-else-if="order.kind === 'subscription'" class="flex gap-2 text-xs leading-relaxed text-fg-subtle">
        <UiIcon name="info" :size="14" class="mt-px shrink-0" />
        {{ t("payments.admin.orders.refund.subscriptionNote") }}
      </p>

      <Transition v-bind="enter">
        <UiAlert v-if="forceInfo" tone="warning" :title="t('payFlow.adminRefund.forceTitle')">
          {{ t("payFlow.adminRefund.forceBody", { reclaim: formatUsd(forceInfo.reclaim), balance: formatUsd(forceInfo.balance) }) }}
        </UiAlert>
      </Transition>

      <!-- Note -->
      <div>
        <div class="mb-1.5 flex items-center justify-between gap-2">
          <label for="admin-refund-reason" class="text-xs font-medium text-fg-muted">{{ t("payFlow.adminRefund.reason") }}</label>
          <span class="text-2xs tabular-nums text-fg-subtle">{{ reason.length }} / {{ REASON_MAX }}</span>
        </div>
        <textarea
          id="admin-refund-reason"
          v-model="reason"
          rows="2"
          :maxlength="REASON_MAX"
          class="textarea"
          :placeholder="t('payFlow.adminRefund.reasonPlaceholder')"
          :disabled="working"
        />
      </div>

      <p class="flex gap-2 text-xs leading-relaxed text-fg-subtle">
        <UiIcon name="info" :size="14" class="mt-px shrink-0" />
        {{ t("payFlow.adminRefund.rebateNote") }}
      </p>

      <Transition v-bind="enter">
        <UiAlert v-if="serverError" tone="danger">{{ serverError }}</UiAlert>
      </Transition>
    </form>

    <template #footer>
      <ConfirmButton
        v-if="canReject"
        size="sm"
        icon="x-circle"
        class="order-first mr-auto"
        :disabled="working"
        :label="t('payFlow.adminRefund.rejectRequest')"
        :confirm-label="t('payFlow.adminRefund.confirmReject')"
        @confirm="reject"
      />
      <button type="button" class="btn btn-secondary" :disabled="working" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button
        type="submit"
        form="admin-refund-form"
        class="btn"
        :class="mode === 'review' && !forceInfo ? 'btn-primary' : 'btn-danger-solid'"
        :disabled="working || Boolean(amountError)"
      >
        <UiIcon v-if="busy" name="loader" :size="15" spin />
        {{ submitLabel }}
      </button>
    </template>
  </UiModal>
</template>
