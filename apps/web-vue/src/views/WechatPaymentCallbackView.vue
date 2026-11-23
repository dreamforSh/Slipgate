<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import type { CreateOrderResponse, WechatOAuthExchangeResponse } from "@slipgate/contracts";
import AuthLayout from "../components/AuthLayout.vue";
import { payApi, takePendingPurchase, usePayErrors } from "../components/payments/paymentFlow";
import { useCheckoutFlow } from "../components/payments/useCheckoutFlow";
import UiIcon, { type IconName } from "../components/ui/UiIcon.vue";
import { usePortalStore } from "../stores/portal";

/**
 * Return page of the WeChat payment OAuth (snsapi_base): trades `code` + `state` for a short-lived
 * resume token proving the payer's openid, repeats the purchase saved before leaving with
 * device "wechat", then opens WeChat Pay (JSAPI) and lands on the result page.
 */
const { t } = useI18n();
const route = useRoute();
const portal = usePortalStore();
const payError = usePayErrors();
const checkout = useCheckoutFlow();

type Step = "exchanging" | "creating" | "invoking";
const step = ref<Step>("exchanging");
const failure = ref<string | null>(null);

const STEPS: { key: Step; icon: IconName }[] = [
  { key: "exchanging", icon: "shield" },
  { key: "creating", icon: "file" },
  { key: "invoking", icon: "smartphone" },
];
const stepIndex = computed(() => STEPS.findIndex((s) => s.key === step.value));

const queryText = (v: unknown) => (typeof v === "string" ? v.trim() : "");

onMounted(async () => {
  const code = queryText(route.query.code);
  const state = queryText(route.query.state);
  // The code is single-use: drop it from the address bar so a reload cannot replay it.
  history.replaceState(history.state, "", window.location.pathname);
  if (!code || !state) {
    failure.value = t("payFlow.wechat.missingCode");
    return;
  }
  const purchase = takePendingPurchase();
  if (!purchase) {
    failure.value = t("payFlow.wechat.missingPurchase");
    return;
  }
  try {
    const { wechatResumeToken } = await payApi<WechatOAuthExchangeResponse>("/api/v1/user/payments/wechat/oauth", {
      method: "POST",
      body: { code, state },
    });
    step.value = "creating";
    const res = await payApi<CreateOrderResponse>("/api/v1/user/orders", {
      method: "POST",
      body: { ...purchase, device: "wechat", wechatResumeToken },
    });
    step.value = "invoking";
    await checkout.proceed(res.order, res.checkout);
  } catch (err) {
    failure.value = payError(err, t("payFlow.wechat.failedTitle"), { conflict: t("payFlow.errors.tooManyPending") });
  }
});

const stepText = computed(() => t(`payFlow.wechat.${step.value}`));
</script>

<template>
  <AuthLayout :site-name="portal.siteName">
    <div class="card p-8 text-center">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <div v-if="!failure" key="busy" role="status" aria-live="polite">
          <span class="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-success/10 text-success">
            <UiIcon name="loader" :size="22" spin />
          </span>
          <p class="mt-4 text-base font-semibold text-fg">{{ t("payFlow.wechat.title") }}</p>
          <p class="mt-1 text-sm text-fg-muted">{{ stepText }}</p>
          <ol class="mx-auto mt-6 flex max-w-[14rem] items-center justify-between" :aria-label="t('payFlow.wechat.title')">
            <li v-for="(s, i) in STEPS" :key="s.key" class="flex flex-1 items-center last:flex-none">
              <span
                class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ring-1 ring-inset transition-colors duration-200"
                :class="
                  i < stepIndex
                    ? 'bg-success text-white ring-success dark:text-bg'
                    : i === stepIndex
                      ? 'bg-success/10 text-success ring-success/40'
                      : 'bg-surface-2 text-fg-subtle ring-line'
                "
                :aria-current="i === stepIndex ? 'step' : undefined"
              >
                <UiIcon :name="i < stepIndex ? 'check' : s.icon" :size="14" />
              </span>
              <span
                v-if="i < STEPS.length - 1"
                class="mx-1.5 h-px flex-1 transition-colors duration-200"
                :class="i < stepIndex ? 'bg-success' : 'bg-line'"
              />
            </li>
          </ol>
        </div>
        <div v-else key="failed">
          <span class="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-danger/10 text-danger">
            <UiIcon name="x-circle" :size="22" />
          </span>
          <p class="mt-4 text-base font-semibold text-fg">{{ t("payFlow.wechat.failedTitle") }}</p>
          <p class="mt-1 text-sm text-fg-muted" role="alert">{{ failure }}</p>
          <div class="mt-6 flex flex-wrap justify-center gap-2">
            <RouterLink to="/purchase" class="btn btn-primary">
              <UiIcon name="rotate-ccw" :size="15" />
              {{ t("payFlow.wechat.back") }}
            </RouterLink>
            <RouterLink to="/orders" class="btn btn-secondary">
              <UiIcon name="list" :size="15" />
              {{ t("payFlow.wechat.orders") }}
            </RouterLink>
          </div>
        </div>
      </Transition>
    </div>
  </AuthLayout>
</template>
