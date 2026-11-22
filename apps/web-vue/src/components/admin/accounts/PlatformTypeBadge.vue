<script setup lang="ts">
import { computed } from "vue";
import type { AccountAuthKind, SubscriptionTier } from "@slipgate/contracts";
import PlatformIcon from "../../ui/PlatformIcon.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { AUTH_KIND_BADGE, planBadge, platformShortLabel, platformStyle } from "../../../lib/platformStyle";
import { PROVIDER_OPTIONS } from "../../../lib/format";

/**
 * Two-segment platform badge (provider mark + name | auth type) with the subscription plan on
 * a second row, after the linksyncx account cards. API-key and standard-tier accounts show no plan.
 */
const props = withDefaults(
  defineProps<{
    platform: string;
    authKind: AccountAuthKind;
    subscriptionTier?: SubscriptionTier;
    tierMultiplier?: number;
    /** Show the plan beside the platform segment instead of on its own row. */
    inline?: boolean;
  }>(),
  { subscriptionTier: "standard", tierMultiplier: 1, inline: false },
);

const style = computed(() => platformStyle(props.platform));
const label = computed(() => platformShortLabel(props.platform));
const fullLabel = computed(() => PROVIDER_OPTIONS.find((o) => o.value === props.platform)?.label ?? props.platform);
const auth = computed(() => AUTH_KIND_BADGE[props.authKind] ?? { label: props.authKind, icon: "key" as const });
// API keys bill per token: a subscription plan means nothing for them, whatever is stored.
const plan = computed(() =>
  props.authKind === "api_key" ? null : planBadge(props.subscriptionTier, props.tierMultiplier, props.platform),
);
</script>

<template>
  <div class="text-2xs font-medium leading-none" :class="inline ? 'inline-flex flex-wrap items-center gap-1' : 'inline-flex flex-col items-start gap-1'">
    <span class="inline-flex items-stretch overflow-hidden rounded-md" :title="`${fullLabel} · ${auth.label}`">
      <span class="inline-flex items-center gap-1 px-2 py-1" :class="style.badge">
        <PlatformIcon :platform="platform" :size="12" />
        <span class="whitespace-nowrap">{{ label }}</span>
      </span>
      <span class="inline-flex items-center gap-1 px-1.5 py-1" :class="style.type">
        <UiIcon :name="auth.icon" :size="11" />
        <span class="whitespace-nowrap">{{ auth.label }}</span>
      </span>
    </span>
    <span v-if="plan" class="inline-flex items-center rounded-md px-1.5 py-1 font-mono" :class="plan.class">
      {{ plan.label }}
    </span>
  </div>
</template>
