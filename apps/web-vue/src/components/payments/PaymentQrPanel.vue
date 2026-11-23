<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { PaymentOrderItem } from "@slipgate/contracts";
import QrCode from "../me/QrCode.vue";
import UiIcon from "../ui/UiIcon.vue";
import ChannelGlyph from "./ChannelGlyph.vue";
import { detectDevice } from "./paymentFlow";
import { channelKey, countdownText, formatFiat } from "./paymentUtil";

/**
 * The QR of an in-page payment (EasyPay API mode, Alipay face-to-face, WeChat Native): the code,
 * what to scan it with, the amount and the time left. On phones it also offers the Alipay app
 * link and the provider's own page when the gateway returned one.
 */
const props = withDefaults(
  defineProps<{
    order: Pick<PaymentOrderItem, "provider" | "method" | "amountMinor" | "currency" | "expiresAtIso" | "qrCode" | "payUrl" | "checkout">;
    nowMs: number;
    size?: number;
  }>(),
  { size: 200 },
);

const { t } = useI18n();
const device = detectDevice();

const qrText = computed(() => props.order.checkout?.qrCode ?? props.order.qrCode ?? "");
const appLink = computed(() => (device !== "pc" ? (props.order.checkout?.appLink ?? null) : null));
const payUrl = computed(() => props.order.checkout?.payUrl ?? props.order.payUrl ?? null);
const expired = computed(() => {
  const at = Date.parse(props.order.expiresAtIso);
  return Number.isFinite(at) && props.nowMs >= at;
});

const scanText = computed(() => {
  const key = channelKey(props.order.provider, props.order.method);
  return key === "alipay" || key === "wxpay" || key === "qqpay" ? t(`payFlow.qr.scan.${key}`) : t("payFlow.qr.scan.generic");
});
const deviceHint = computed(() => {
  if (device === "wechat") return t("payFlow.qr.wechatHint");
  if (device === "mobile" && !appLink.value) return t("payFlow.qr.mobileHint");
  return "";
});
</script>

<template>
  <div class="flex flex-col items-center text-center">
    <p class="inline-flex items-center gap-2 text-sm font-medium text-fg">
      <ChannelGlyph :provider="order.provider" :method="order.method" size="xs" />
      {{ scanText }}
    </p>

    <div class="relative mt-4">
      <QrCode
        :text="qrText"
        :size="size"
        :label="t('payFlow.qr.qrLabel')"
        class="transition-[filter,opacity] duration-200 ease-out motion-reduce:transition-none"
        :class="expired ? 'opacity-40 blur-[2px]' : ''"
      />
      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="scale-95 opacity-0"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <div v-if="expired" class="absolute inset-0 flex items-center justify-center">
          <span class="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-xs font-semibold text-fg shadow-pop ring-1 ring-line">
            <UiIcon name="clock" :size="13" class="text-warning" />
            {{ t("payFlow.qr.expiredTitle") }}
          </span>
        </div>
      </Transition>
    </div>

    <p class="mt-4 text-2xs font-medium text-fg-subtle">{{ t("payFlow.qr.amount") }}</p>
    <p class="mt-0.5 text-2xl font-bold tracking-tight tabular-nums text-fg">
      {{ formatFiat(order.amountMinor, order.currency) }}
      <span class="ml-0.5 text-2xs font-medium text-fg-subtle">{{ order.currency }}</span>
    </p>
    <p v-if="!expired" class="mt-1.5 inline-flex items-center gap-1.5 text-xs tabular-nums text-fg-subtle">
      <UiIcon name="clock" :size="12" />
      {{ t("payFlow.qr.countdown", { time: countdownText(order.expiresAtIso, nowMs) }) }}
    </p>

    <div v-if="(appLink || payUrl) && !expired" class="mt-4 flex w-full max-w-xs flex-col gap-2">
      <a v-if="appLink" :href="appLink" class="btn btn-primary w-full">
        <UiIcon name="smartphone" :size="15" />
        {{ t("payFlow.qr.openApp") }}
      </a>
      <a v-if="payUrl" :href="payUrl" target="_blank" rel="noopener noreferrer" class="btn btn-secondary w-full">
        <UiIcon name="external-link" :size="15" />
        {{ t("payFlow.qr.openPayPage") }}
      </a>
    </div>
    <p v-if="deviceHint && !expired" class="mt-3 max-w-xs text-2xs leading-relaxed text-fg-subtle">{{ deviceHint }}</p>
  </div>
</template>
