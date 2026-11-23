<script setup lang="ts">
import { computed } from "vue";
import type { PaymentChannel, PaymentCurrency } from "@slipgate/contracts";
import UiIcon from "../ui/UiIcon.vue";
import ChannelGlyph from "./ChannelGlyph.vue";
import { channelBlock, channelId, formatFiat, sortChannels, type ChannelBlock } from "./paymentUtil";
import { usePaymentLabels } from "./usePaymentLabels";

/**
 * Radio grid of the payment channels the BFF offers. `modelValue` is a `channelId`. Channels
 * that cannot take the item (CNY-only gateway, today's limit used up, amount outside the
 * single-order range) stay visible but disabled, with the reason in place of the hint.
 */
const props = defineProps<{
  channels: PaymentChannel[];
  modelValue: string | null;
  /** Currency of the item being bought; EasyPay and the official Alipay / WeChat Pay only settle CNY. */
  currency: PaymentCurrency | null;
  /** Price of the item, fiat minor units (null while nothing valid is chosen). */
  amountMinor?: number | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{ (e: "update:modelValue", value: string): void }>();
const { t, channelLabel, channelHint } = usePaymentLabels();

function blockText(b: ChannelBlock): string {
  const cur = props.currency ?? "CNY";
  switch (b.kind) {
    case "currency":
      return t("payments.purchase.methods.cnyOnly");
    case "soldOut":
      return t("payFlow.limits.soldOut");
    case "unavailable":
      return t("payFlow.limits.unavailable");
    case "range":
      if (b.min > 0 && b.max > 0) return t("payFlow.limits.range", { min: formatFiat(b.min, cur), max: formatFiat(b.max, cur) });
      return b.min > 0 ? t("payFlow.limits.min", { min: formatFiat(b.min, cur) }) : t("payFlow.limits.max", { max: formatFiat(b.max, cur) });
    case "remaining":
      return t("payFlow.limits.remaining", { amount: formatFiat(b.remaining, cur) });
  }
}

const rows = computed(() =>
  sortChannels(props.channels).map((ch) => {
    const block = channelBlock(ch, props.currency, props.amountMinor ?? null);
    return {
      id: channelId(ch),
      channel: ch,
      blocked: block !== null,
      note: block ? blockText(block) : channelHint(ch.provider, ch.method),
    };
  }),
);

function pick(id: string, blocked: boolean) {
  if (blocked || props.disabled) return;
  emit("update:modelValue", id);
}
</script>

<template>
  <div
    role="radiogroup"
    :aria-label="t('payments.purchase.methods.title')"
    class="grid grid-cols-1 gap-2.5 min-[440px]:grid-cols-2 2xl:grid-cols-3"
  >
    <button
      v-for="row in rows"
      :key="row.id"
      type="button"
      role="radio"
      :aria-checked="modelValue === row.id"
      :aria-disabled="row.blocked || disabled"
      :disabled="row.blocked || disabled"
      class="relative flex min-w-0 items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow,opacity] duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50"
      :class="
        modelValue === row.id
          ? 'border-accent bg-accent/[0.05] ring-1 ring-accent'
          : 'border-line/80 bg-surface hover:border-line-strong hover:bg-surface-2/50 dark:bg-surface-2/30'
      "
      @click="pick(row.id, row.blocked)"
    >
      <ChannelGlyph :provider="row.channel.provider" :method="row.channel.method" />
      <span class="min-w-0 flex-1">
        <span class="block truncate text-sm font-semibold text-fg">
          {{ channelLabel(row.channel.provider, row.channel.method) }}
        </span>
        <span class="mt-0.5 block truncate text-2xs" :class="row.blocked ? 'text-warning' : 'text-fg-subtle'" :title="row.note">
          {{ row.note }}
        </span>
      </span>
      <span
        class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
        :class="modelValue === row.id ? 'border-accent-solid bg-accent-solid text-accent-fg' : 'border-line-strong'"
        aria-hidden="true"
      >
        <UiIcon
          name="check"
          :size="10"
          :stroke-width="3.2"
          class="transition-[opacity,transform] duration-200"
          :class="modelValue === row.id ? 'scale-100 opacity-100' : 'scale-50 opacity-0'"
        />
      </span>
    </button>
  </div>
</template>
