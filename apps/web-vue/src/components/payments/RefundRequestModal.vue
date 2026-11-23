<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { PaymentOrderItem } from "@slipgate/contracts";
import { apiJson } from "../../lib/api";
import { formatUsd } from "../../lib/format";
import { useToastStore } from "../../stores/toast";
import UiAlert from "../ui/UiAlert.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import ChannelGlyph from "./ChannelGlyph.vue";
import { usePayErrors } from "./paymentFlow";
import { refreshWallet } from "./paymentUtil";
import { usePaymentLabels } from "./usePaymentLabels";

/** A payer asks for a paid top-up to be refunded (POST /user/orders/:id/refund-request). */
const props = defineProps<{ open: boolean; order: PaymentOrderItem | null }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "done", order: PaymentOrderItem): void }>();

const REASON_MAX = 500;

const { t } = useI18n();
const { itemLabel, amountText, channelLabel } = usePaymentLabels();
const toast = useToastStore();
const payError = usePayErrors();

const reason = ref("");
const touched = ref(false);
const busy = ref(false);
const serverError = ref<string | null>(null);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    reason.value = "";
    touched.value = false;
    serverError.value = null;
  },
);

const reasonError = computed(() => (touched.value && reason.value.trim() === "" ? t("payFlow.refundRequest.reasonRequired") : null));

async function submit() {
  const o = props.order;
  touched.value = true;
  if (!o || busy.value || reason.value.trim() === "") return;
  busy.value = true;
  serverError.value = null;
  try {
    const res = await apiJson<{ order: PaymentOrderItem }>(`/api/v1/user/orders/${encodeURIComponent(o.id)}/refund-request`, {
      method: "POST",
      body: { reason: reason.value.trim() },
    });
    toast.success(t("payFlow.refundRequest.success"));
    emit("done", res.order);
    emit("update:open", false);
    void refreshWallet();
  } catch (err) {
    serverError.value = payError(err, t("payFlow.refundRequest.failed"), { conflict: t("payFlow.refundRequest.balanceShort") });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal :open="open" width="md" :title="t('payFlow.refundRequest.title')" :persistent="busy" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-info h-8 w-8"><UiIcon name="rotate-ccw" :size="15" /></span>
    </template>
    <form v-if="order" id="refund-request-form" class="space-y-4" novalidate @submit.prevent="submit">
      <div class="flex items-center gap-3 rounded-xl border border-line bg-surface-2/40 p-3.5">
        <ChannelGlyph :provider="order.provider" :method="order.method" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-fg">{{ itemLabel(order) }}</p>
          <p class="mt-0.5 truncate text-2xs text-fg-subtle">
            {{ channelLabel(order.provider, order.method) }} · <span class="font-mono">{{ order.id }}</span>
          </p>
        </div>
        <p class="shrink-0 text-base font-semibold tabular-nums text-fg">{{ amountText(order) }}</p>
      </div>

      <p class="text-sm leading-relaxed text-fg-muted">{{ t("payFlow.refundRequest.body") }}</p>
      <p class="flex items-center gap-2 rounded-lg bg-warning/[0.07] px-3 py-2 text-xs tabular-nums text-warning">
        <UiIcon name="wallet" :size="13" class="shrink-0" />
        {{ t("payFlow.refundRequest.reclaim", { amount: formatUsd(order.creditNanoUsd) }) }}
      </p>

      <div>
        <div class="mb-1.5 flex items-center justify-between gap-2">
          <label for="refund-request-reason" class="text-xs font-medium text-fg-muted">
            {{ t("payFlow.refundRequest.reason") }} <span class="text-danger">*</span>
          </label>
          <span class="text-2xs tabular-nums" :class="reason.length > REASON_MAX * 0.9 ? 'text-warning' : 'text-fg-subtle'">
            {{ reason.length }} / {{ REASON_MAX }}
          </span>
        </div>
        <textarea
          id="refund-request-reason"
          v-model="reason"
          rows="4"
          :maxlength="REASON_MAX"
          class="textarea"
          :class="reasonError ? '!border-danger focus:!ring-danger/20' : ''"
          :placeholder="t('payFlow.refundRequest.reasonPlaceholder')"
          :aria-invalid="Boolean(reasonError)"
          aria-describedby="refund-request-reason-error"
          :disabled="busy"
          @blur="touched = true"
        />
        <p v-if="reasonError" id="refund-request-reason-error" class="mt-1 text-xs text-danger" role="alert">{{ reasonError }}</p>
      </div>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <UiAlert v-if="serverError" tone="danger">{{ serverError }}</UiAlert>
      </Transition>
    </form>
    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button type="submit" form="refund-request-form" class="btn btn-primary" :disabled="busy">
        <UiIcon v-if="busy" name="loader" :size="15" spin />
        {{ t("payFlow.refundRequest.submit") }}
      </button>
    </template>
  </UiModal>
</template>
