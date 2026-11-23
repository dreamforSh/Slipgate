<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { PaymentOrderItem } from "@slipgate/contracts";
import { formatDateTime, formatUsd } from "../../lib/format";
import CopyButton from "../ui/CopyButton.vue";
import { formatFiat } from "./paymentUtil";

/**
 * What happened to an order's refund: the payer's request (time, reason), the refunded amount,
 * the note, the gateway's refund id, the balance taken back and a failure reason. Admin views
 * also see the provider refund id and the reclaimed balance.
 */
const props = withDefaults(
  defineProps<{
    order: Pick<
      PaymentOrderItem,
      | "status"
      | "amountMinor"
      | "currency"
      | "refundAmountMinor"
      | "refundReason"
      | "refundError"
      | "providerRefundId"
      | "refundReclaimedNanoUsd"
      | "refundedAtIso"
      | "refundRequestedAtIso"
      | "refundRequestReason"
    >;
    admin?: boolean;
  }>(),
  { admin: false },
);

const { t } = useI18n();

const reclaimed = computed(() => {
  try {
    return BigInt(props.order.refundReclaimedNanoUsd || "0") > 0n ? props.order.refundReclaimedNanoUsd : null;
  } catch {
    return null;
  }
});

const showAmount = computed(() => props.order.refundAmountMinor > 0);
</script>

<template>
  <div class="space-y-3">
    <div
      v-if="order.refundRequestedAtIso || order.refundRequestReason"
      class="rounded-xl border border-info/25 bg-info/[0.05] p-3.5 text-xs"
    >
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p class="font-medium text-info">{{ t("payFlow.refundInfo.requestReason") }}</p>
        <p v-if="order.refundRequestedAtIso" class="tabular-nums text-fg-subtle">
          {{ t("payFlow.refundInfo.requestedAt") }} · {{ formatDateTime(order.refundRequestedAtIso) }}
        </p>
      </div>
      <p v-if="order.refundRequestReason" class="mt-1.5 whitespace-pre-line break-words text-sm leading-relaxed text-fg">
        {{ order.refundRequestReason }}
      </p>
    </div>

    <dl v-if="showAmount || order.refundReason || order.refundError || order.refundedAtIso" class="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
      <div v-if="showAmount" class="min-w-0">
        <dt class="text-fg-subtle">{{ t("payFlow.refundInfo.amount") }}</dt>
        <dd class="mt-0.5 text-sm font-semibold tabular-nums text-fg">
          {{ formatFiat(order.refundAmountMinor, order.currency) }}
          <span class="text-2xs font-normal text-fg-subtle">/ {{ formatFiat(order.amountMinor, order.currency) }}</span>
        </dd>
      </div>
      <div v-if="order.refundedAtIso" class="min-w-0">
        <dt class="text-fg-subtle">{{ t("payFlow.refundInfo.refundedAt") }}</dt>
        <dd class="mt-0.5 text-sm tabular-nums text-fg">{{ formatDateTime(order.refundedAtIso) }}</dd>
      </div>
      <div v-if="admin && reclaimed" class="min-w-0">
        <dt class="text-fg-subtle">{{ t("payFlow.refundInfo.reclaimed") }}</dt>
        <dd class="mt-0.5 text-sm tabular-nums text-fg">{{ formatUsd(reclaimed) }}</dd>
      </div>
      <div v-if="admin && order.providerRefundId" class="min-w-0">
        <dt class="text-fg-subtle">{{ t("payFlow.refundInfo.providerRefundId") }}</dt>
        <dd class="mt-0.5 flex min-w-0 items-center gap-0.5">
          <span class="truncate font-mono text-2xs text-fg" :title="order.providerRefundId">{{ order.providerRefundId }}</span>
          <CopyButton :text="order.providerRefundId" />
        </dd>
      </div>
      <div v-if="order.refundReason" class="min-w-0 sm:col-span-2">
        <dt class="text-fg-subtle">{{ t("payFlow.refundInfo.reason") }}</dt>
        <dd class="mt-0.5 whitespace-pre-line break-words text-sm text-fg">{{ order.refundReason }}</dd>
      </div>
      <div v-if="admin && order.refundError" class="min-w-0 sm:col-span-2">
        <dt class="text-fg-subtle">{{ t("payFlow.refundInfo.error") }}</dt>
        <dd class="mt-0.5 break-words text-sm text-danger">{{ order.refundError }}</dd>
      </div>
    </dl>
  </div>
</template>
