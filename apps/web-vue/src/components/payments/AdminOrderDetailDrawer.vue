<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { PaymentOrderItem } from "@slipgate/contracts";
import { formatDateTime } from "../../lib/format";
import CopyButton from "../ui/CopyButton.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiDrawer from "../ui/UiDrawer.vue";
import UiIcon from "../ui/UiIcon.vue";
import ChannelGlyph from "./ChannelGlyph.vue";
import OrderRefundInfo from "./OrderRefundInfo.vue";
import OrderStatusBadge from "./OrderStatusBadge.vue";
import { REFUND_STATUSES } from "./paymentUtil";
import { usePaymentLabels } from "./usePaymentLabels";

/** Everything the admin console knows about one order, with its provider and refund actions. */
const props = defineProps<{ open: boolean; order: PaymentOrderItem | null; busy?: boolean }>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "verify", order: PaymentOrderItem): void;
  (e: "query-refund", order: PaymentOrderItem): void;
  (e: "refund", order: PaymentOrderItem): void;
}>();

const { t } = useI18n();
const { channelLabel, itemLabel, deliveredText, amountText, kindLabel } = usePaymentLabels();

const canVerify = computed(() => {
  const s = props.order?.status;
  return props.order?.provider !== "manual" && (s === "pending" || s === "expired" || s === "cancelled" || s === "failed");
});
const canRefund = computed(() => {
  const s = props.order?.status;
  return s === "paid" || s === "refund_requested" || s === "refund_failed";
});
const showRefund = computed(() => {
  const o = props.order;
  return Boolean(o && (REFUND_STATUSES.has(o.status) || o.refundRequestedAtIso || o.refundAmountMinor > 0));
});
</script>

<template>
  <UiDrawer :open="open" width="lg" :title="t('payFlow.detail.title')" @update:open="emit('update:open', $event)">
    <div v-if="order" class="space-y-6">
      <!-- Header -->
      <div class="flex items-start gap-3">
        <ChannelGlyph :provider="order.provider" :method="order.method" size="lg" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-base font-semibold text-fg">{{ itemLabel(order) }}</p>
          <p class="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-fg-subtle">
            <span class="truncate font-mono">{{ order.id }}</span>
            <CopyButton :text="order.id" />
          </p>
        </div>
        <div class="shrink-0 text-right">
          <p class="text-lg font-bold tabular-nums text-fg">{{ amountText(order) }}</p>
          <OrderStatusBadge :status="order.status" />
        </div>
      </div>

      <UiAlert v-if="order.deliveryError" tone="warning" :title="t('payFlow.detail.deliveryError')">{{ order.deliveryError }}</UiAlert>

      <!-- Overview -->
      <section>
        <h3 class="eyebrow">{{ t("payFlow.detail.overview") }}</h3>
        <dl class="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("payFlow.detail.user") }}</dt>
            <dd class="mt-0.5 truncate text-sm text-fg">
              <RouterLink
                :to="{ path: '/admin/users', query: { search: order.userEmail } }"
                class="transition-colors hover:text-accent"
                @click="emit('update:open', false)"
              >
                {{ order.userEmail || order.userId }}
              </RouterLink>
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("payFlow.detail.kind") }}</dt>
            <dd class="mt-0.5">
              <UiBadge :tone="order.kind === 'subscription' ? 'violet' : 'accent'">{{ kindLabel(order.kind) }}</UiBadge>
            </dd>
          </div>
          <div class="min-w-0 sm:col-span-2">
            <dt class="text-fg-subtle">{{ t("payFlow.detail.delivered") }}</dt>
            <dd class="mt-0.5 truncate text-sm tabular-nums text-fg">{{ deliveredText(order) }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("payFlow.detail.created") }}</dt>
            <dd class="mt-0.5 text-sm tabular-nums text-fg">{{ formatDateTime(order.createdAtIso) }}</dd>
          </div>
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ order.paidAtIso ? t("payFlow.detail.paid") : t("payFlow.detail.expires") }}</dt>
            <dd class="mt-0.5 text-sm tabular-nums text-fg">{{ formatDateTime(order.paidAtIso ?? order.expiresAtIso) }}</dd>
          </div>
        </dl>
      </section>

      <!-- Payment -->
      <section>
        <h3 class="eyebrow">{{ t("payFlow.detail.payment") }}</h3>
        <dl class="mt-3 grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("payFlow.detail.channel") }}</dt>
            <dd class="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-fg">
              <ChannelGlyph :provider="order.provider" :method="order.method" size="xs" />
              <span class="truncate">{{ channelLabel(order.provider, order.method) }}</span>
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-fg-subtle">{{ t("payFlow.detail.instance") }}</dt>
            <dd class="mt-0.5 truncate text-sm text-fg">
              {{ order.providerInstanceName || (order.provider === "manual" ? t("payFlow.detail.none") : t("payFlow.adminOrders.builtin")) }}
            </dd>
          </div>
          <div class="min-w-0 sm:col-span-2">
            <dt class="text-fg-subtle">{{ t("payFlow.detail.tradeNo") }}</dt>
            <dd class="mt-0.5 flex min-w-0 items-center gap-0.5">
              <template v-if="order.providerTradeNo">
                <span class="truncate font-mono text-2xs text-fg" :title="order.providerTradeNo">{{ order.providerTradeNo }}</span>
                <CopyButton :text="order.providerTradeNo" />
              </template>
              <span v-else class="text-sm text-fg-subtle">{{ t("payFlow.detail.none") }}</span>
            </dd>
          </div>
        </dl>
      </section>

      <!-- Refund -->
      <section v-if="showRefund">
        <h3 class="eyebrow">{{ t("payFlow.refundInfo.title") }}</h3>
        <div class="mt-3">
          <OrderRefundInfo :order="order" admin />
        </div>
      </section>
    </div>

    <template v-if="order" #footer>
      <button
        v-if="order.status === 'refund_pending'"
        type="button"
        class="btn btn-secondary"
        :disabled="busy"
        @click="emit('query-refund', order)"
      >
        <UiIcon name="refresh" :size="15" :spin="busy" />
        {{ t("payFlow.adminOrders.queryRefund") }}
      </button>
      <button v-if="canVerify" type="button" class="btn btn-secondary" :disabled="busy" @click="emit('verify', order)">
        <UiIcon name="search" :size="15" />
        {{ t("payFlow.verify.button") }}
      </button>
      <button v-if="canRefund" type="button" class="btn btn-danger" :disabled="busy" @click="emit('refund', order)">
        <UiIcon name="rotate-ccw" :size="15" />
        {{ order.status === "refund_requested" ? t("payFlow.adminOrders.review") : t("payments.admin.orders.actions.refund") }}
      </button>
    </template>
  </UiDrawer>
</template>
