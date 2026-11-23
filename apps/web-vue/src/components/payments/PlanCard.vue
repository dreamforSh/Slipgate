<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { PaymentPlan } from "@slipgate/contracts";
import { formatUsd } from "../../lib/format";
import UiIcon from "../ui/UiIcon.vue";
import { currencySymbol, formatFiat, groupedFiat, perDayMinor } from "./paymentUtil";

export type PlanCardPlan = Pick<
  PaymentPlan,
  "name" | "description" | "kind" | "priceMinor" | "currency" | "creditNanoUsd" | "groupName" | "validityDays" | "badge"
>;

/**
 * A purchasable plan. Interactive cards behave as radio options (the parent owns the
 * `role="radiogroup"`); static cards are used for the admin editor preview.
 */
const props = withDefaults(
  defineProps<{
    plan: PlanCardPlan;
    selected?: boolean;
    interactive?: boolean;
    /** Whole-percent bonus over the base rate (recharge plans). */
    bonusPct?: number | null;
    /** Shown when the name is still empty (editor preview). */
    placeholderName?: string;
  }>(),
  { selected: false, interactive: true, bonusPct: null, placeholderName: "" },
);

const emit = defineEmits<{ (e: "select"): void }>();
const { t } = useI18n();

const isSub = computed(() => props.plan.kind === "subscription");
const symbol = computed(() => currencySymbol(props.plan.currency));
/** "12" for whole amounts, "12.50" otherwise. */
const priceText = computed(() => groupedFiat(Math.max(0, props.plan.priceMinor)).replace(/\.00$/, ""));
const perDay = computed(() => {
  if (!isSub.value) return null;
  const minor = perDayMinor(props.plan.priceMinor, props.plan.validityDays);
  return minor === null ? null : formatFiat(minor, props.plan.currency);
});

const surface = computed(() => {
  if (props.selected) return "border-accent bg-accent/[0.04] shadow-glow ring-1 ring-accent dark:bg-accent/[0.07]";
  if (props.interactive) {
    return "border-line/80 shadow-card hover:-translate-y-0.5 hover:border-line-strong hover:shadow-card-hover motion-reduce:hover:translate-y-0";
  }
  return "border-line/80 shadow-card";
});

function onClick() {
  if (props.interactive) emit("select");
}
</script>

<template>
  <component
    :is="interactive ? 'button' : 'div'"
    :type="interactive ? 'button' : undefined"
    :role="interactive ? 'radio' : undefined"
    :aria-checked="interactive ? selected : undefined"
    class="group relative flex h-full w-full min-w-0 flex-col rounded-xl border bg-surface p-4 text-left transition-[border-color,box-shadow,transform,background-color] duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 dark:bg-surface/70"
    :class="surface"
    @click="onClick"
  >
    <!-- Ribbon -->
    <span
      v-if="plan.badge"
      class="absolute -top-2.5 right-4 inline-flex max-w-[65%] items-center gap-1 rounded-full bg-accent-solid px-2.5 py-0.5 text-2xs font-semibold text-accent-fg shadow-glow"
    >
      <UiIcon name="sparkles" :size="11" class="shrink-0" />
      <span class="truncate">{{ plan.badge }}</span>
    </span>

    <div class="flex items-start gap-3">
      <span class="icon-chip h-9 w-9" :class="isSub ? 'icon-chip-violet' : 'icon-chip-accent'">
        <UiIcon :name="isSub ? 'crown' : 'wallet'" :size="17" />
      </span>
      <div class="min-w-0 flex-1 pt-0.5">
        <p class="truncate text-sm font-semibold text-fg" :class="plan.name ? '' : 'text-fg-subtle'">
          {{ plan.name || placeholderName }}
        </p>
        <p v-if="isSub" class="mt-0.5 flex items-center gap-1 truncate text-xs text-fg-muted">
          <UiIcon name="layers" :size="11" class="shrink-0 text-violet" />
          <span class="truncate">{{ plan.groupName || t("payments.unknownGroup") }}</span>
        </p>
        <p v-else class="mt-0.5 truncate text-xs text-fg-subtle">{{ t("payments.kinds.recharge") }}</p>
      </div>
      <span
        v-if="interactive"
        class="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-200"
        :class="selected ? 'border-accent-solid bg-accent-solid text-accent-fg' : 'border-line-strong bg-surface group-hover:border-fg-subtle'"
        aria-hidden="true"
      >
        <UiIcon
          name="check"
          :size="12"
          :stroke-width="3"
          class="transition-[opacity,transform] duration-200 ease-out"
          :class="selected ? 'scale-100 opacity-100' : 'scale-50 opacity-0'"
        />
      </span>
    </div>

    <div class="mt-4 flex items-baseline gap-1">
      <span class="text-sm font-semibold text-fg-muted">{{ symbol }}</span>
      <span class="text-[28px] font-bold leading-none tracking-tight tabular-nums text-fg">{{ priceText }}</span>
      <span v-if="isSub && plan.validityDays" class="ml-1 text-xs text-fg-subtle">
        / {{ t("payments.days", { n: plan.validityDays }) }}
      </span>
    </div>

    <div class="mt-2.5 flex min-h-[1.375rem] flex-wrap items-center gap-1.5">
      <template v-if="!isSub">
        <span class="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-2xs font-semibold tabular-nums text-accent">
          <UiIcon name="zap" :size="11" />
          {{ t("payments.credit", { amount: formatUsd(plan.creditNanoUsd) }) }}
        </span>
        <span
          v-if="bonusPct"
          class="inline-flex items-center rounded-full bg-success/10 px-2 py-0.5 text-2xs font-semibold tabular-nums text-success"
        >
          {{ t("payments.bonus", { pct: bonusPct }) }}
        </span>
      </template>
      <span v-else-if="perDay" class="text-2xs tabular-nums text-fg-subtle">{{ t("payments.perDay", { price: perDay }) }}</span>
    </div>

    <p v-if="plan.description" class="mt-3 line-clamp-2 text-xs leading-relaxed text-fg-muted" :title="plan.description">
      {{ plan.description }}
    </p>
  </component>
</template>
