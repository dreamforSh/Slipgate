<script setup lang="ts">
import { minorToFiat, type PaymentOrderItem } from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import CopyButton from "../ui/CopyButton.vue";
import MarkdownView from "../ui/MarkdownView.vue";
import UiAlert from "../ui/UiAlert.vue";
import { formatFiat } from "./paymentUtil";

/** What a manual-transfer payer needs: the reference to quote, the exact amount and the admin's instructions. */
defineProps<{
  order: Pick<PaymentOrderItem, "id" | "amountMinor" | "currency">;
  instructions: string;
}>();

const { t } = useI18n();
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-3 sm:grid-cols-2">
      <div class="min-w-0 rounded-xl border border-dashed border-warning/40 bg-warning/[0.06] p-3.5">
        <p class="eyebrow">{{ t("payments.result.manual.reference") }}</p>
        <div class="mt-1.5 flex min-w-0 items-center gap-1.5">
          <code class="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-fg" :title="order.id">{{ order.id }}</code>
          <CopyButton :text="order.id" size="sm" />
        </div>
      </div>
      <div class="min-w-0 rounded-xl border border-line bg-surface-2/50 p-3.5">
        <p class="eyebrow">{{ t("payments.result.manual.amount") }}</p>
        <div class="mt-1.5 flex min-w-0 items-center gap-1.5">
          <span class="min-w-0 flex-1 truncate text-lg font-bold leading-6 tabular-nums text-fg">
            {{ formatFiat(order.amountMinor, order.currency) }}
            <span class="ml-1 text-2xs font-medium text-fg-subtle">{{ order.currency }}</span>
          </span>
          <CopyButton :text="minorToFiat(order.amountMinor)" size="sm" />
        </div>
      </div>
    </div>

    <div v-if="instructions.trim()">
      <p class="label">{{ t("payments.result.manual.instructions") }}</p>
      <div class="rounded-xl border border-line bg-surface p-4 dark:bg-surface-2/40">
        <MarkdownView :source="instructions" />
      </div>
    </div>
    <UiAlert v-else tone="warning">{{ t("payments.result.manual.noInstructions") }}</UiAlert>
  </div>
</template>
