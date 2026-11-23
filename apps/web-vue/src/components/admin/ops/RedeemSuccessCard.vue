<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { RedeemResult, WalletSummary } from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import { formatDateShort, formatUsd } from "../../../lib/format";

/** Celebratory (but quiet) confirmation shown after a code is redeemed. */
const props = defineProps<{ result: RedeemResult; wallet: WalletSummary | null }>();
const emit = defineEmits<{ (e: "again"): void }>();

const { t } = useI18n();

const sparks = [
  { angle: 0, tone: "bg-success" },
  { angle: 45, tone: "bg-accent" },
  { angle: 90, tone: "bg-warning" },
  { angle: 135, tone: "bg-violet" },
  { angle: 180, tone: "bg-success" },
  { angle: 225, tone: "bg-info" },
  { angle: 270, tone: "bg-accent" },
  { angle: 315, tone: "bg-warning" },
];

const headline = computed(() => {
  if (props.result.kind === "balance") return t("redeem.user.success.balance");
  if (props.result.kind === "subscription") return t("redeem.user.success.subscription");
  return t("redeem.user.success.invitation");
});
</script>

<template>
  <div
    class="relative overflow-hidden rounded-xl border border-success/30 bg-surface p-5 shadow-card sm:p-6"
    role="status"
    aria-live="polite"
  >
    <div class="pointer-events-none absolute inset-0 bg-gradient-to-br from-success/[0.09] via-transparent to-accent/[0.05]" />
    <div class="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-success/10 blur-2xl" />

    <div class="relative flex flex-col gap-5 sm:flex-row sm:items-center">
      <!-- Badge -->
      <div class="relative mx-auto h-16 w-16 shrink-0 sm:mx-0">
        <span class="ring-burst absolute inset-0 rounded-full bg-success/25" />
        <span
          v-for="(s, i) in sparks"
          :key="i"
          class="spark absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full"
          :class="s.tone"
          :style="{ '--a': `${s.angle}deg`, animationDelay: `${120 + (i % 2) * 60}ms` }"
        />
        <span class="badge-pop relative flex h-16 w-16 items-center justify-center rounded-full bg-success text-white shadow-lg dark:text-bg">
          <UiIcon name="check" :size="30" :stroke-width="2.6" />
        </span>
      </div>

      <div class="min-w-0 flex-1 text-center sm:text-left">
        <p class="rise text-xs font-semibold uppercase tracking-wider text-success" style="animation-delay: 80ms">
          {{ t("redeem.user.success.title") }}
        </p>
        <p class="rise mt-1 text-sm font-medium text-fg-muted" style="animation-delay: 140ms">{{ headline }}</p>

        <template v-if="result.kind === 'balance'">
          <p
            class="rise mt-1 font-mono text-3xl font-bold tabular-nums tracking-tight text-success sm:text-4xl"
            style="animation-delay: 200ms"
          >
            +{{ formatUsd(result.amountNanoUsd) }}
          </p>
          <p v-if="wallet" class="rise mt-1.5 text-xs text-fg-subtle" style="animation-delay: 260ms">
            {{ t("redeem.user.success.newBalance", { amount: formatUsd(wallet.availableNanoUsd) }) }}
          </p>
        </template>

        <template v-else-if="result.kind === 'subscription'">
          <p class="rise mt-1 text-xl font-bold tracking-tight text-fg sm:text-2xl" style="animation-delay: 200ms">
            {{ result.groupName ?? t("redeem.value.unknownGroup") }}
            <span v-if="result.validityDays" class="ml-1 align-middle text-sm font-medium text-violet">
              {{ t("redeem.user.success.subscriptionDays", { days: result.validityDays }) }}
            </span>
          </p>
          <p
            v-if="result.subscriptionExpiresAtIso"
            class="rise mt-1.5 inline-flex items-center gap-1.5 text-xs text-fg-subtle"
            style="animation-delay: 260ms"
          >
            <UiIcon name="calendar" :size="13" />
            {{ t("redeem.user.success.expiresAt", { date: formatDateShort(result.subscriptionExpiresAtIso) }) }}
          </p>
        </template>

        <p v-else class="rise mt-1.5 text-sm text-fg-muted" style="animation-delay: 200ms">
          {{ t("redeem.user.success.invitationHint") }}
        </p>

        <div class="rise mt-4 flex flex-wrap justify-center gap-2 sm:justify-start" style="animation-delay: 320ms">
          <button type="button" class="btn btn-secondary btn-sm" @click="emit('again')">
            <UiIcon name="gift" :size="14" />
            {{ t("redeem.user.success.again") }}
          </button>
          <RouterLink v-if="result.kind === 'subscription'" to="/subscriptions" class="btn btn-ghost btn-sm">
            {{ t("redeem.user.success.viewSubscriptions") }}
            <UiIcon name="arrow-right" :size="14" />
          </RouterLink>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.badge-pop {
  animation: badge-pop 520ms cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
.ring-burst {
  animation: ring-burst 900ms cubic-bezier(0.16, 1, 0.3, 1) 120ms both;
}
.spark {
  margin: -3px 0 0 -3px;
  animation: spark 820ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.rise {
  animation: rise 420ms cubic-bezier(0.16, 1, 0.3, 1) both;
}

@keyframes badge-pop {
  0% {
    transform: scale(0.3) rotate(-20deg);
    opacity: 0;
  }
  60% {
    transform: scale(1.08) rotate(4deg);
    opacity: 1;
  }
  100% {
    transform: scale(1) rotate(0);
  }
}
@keyframes ring-burst {
  0% {
    transform: scale(0.85);
    opacity: 0.7;
  }
  100% {
    transform: scale(2.2);
    opacity: 0;
  }
}
@keyframes spark {
  0% {
    transform: rotate(var(--a)) translateY(0) scale(0.4);
    opacity: 0;
  }
  25% {
    opacity: 1;
  }
  100% {
    transform: rotate(var(--a)) translateY(-44px) scale(1);
    opacity: 0;
  }
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .badge-pop,
  .rise {
    animation: none;
  }
  .ring-burst,
  .spark {
    display: none;
  }
}
</style>
