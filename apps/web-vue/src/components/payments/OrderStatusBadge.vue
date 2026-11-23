<script setup lang="ts">
import type { PaymentOrderStatus } from "@slipgate/contracts";
import UiBadge from "../ui/UiBadge.vue";
import { ORDER_STATUS_PULSE, ORDER_STATUS_TONE } from "./paymentUtil";
import { usePaymentLabels } from "./usePaymentLabels";

defineProps<{ status: PaymentOrderStatus }>();

const { statusLabel } = usePaymentLabels();
</script>

<template>
  <UiBadge :tone="ORDER_STATUS_TONE[status] ?? 'neutral'" dot :pulse="ORDER_STATUS_PULSE.has(status)">
    {{ statusLabel(status) }}
  </UiBadge>
</template>
