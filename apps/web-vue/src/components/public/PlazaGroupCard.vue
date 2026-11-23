<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { PlazaGroup, PlazaModel } from "@slipgate/contracts";
import { platformShortLabel, platformStyle } from "../../lib/platformStyle";
import PlatformIcon from "../ui/PlatformIcon.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiIcon from "../ui/UiIcon.vue";
import { formatPerMillion, usdPerMillion } from "./publicUtils";

/** One plaza group: platform, billing, multiplier, capacity and its (filtered) model chips. */
const props = defineProps<{
  group: PlazaGroup;
  /** Model id that was just copied (shows a check on its chip). */
  copied: string | null;
  /** The group's list multiplier when `group.rateMultiplier` is the viewer's own custom rate. */
  listRate?: number | null;
}>();
const emit = defineEmits<{ (e: "copy", id: string): void }>();

const { t } = useI18n();
const LIMIT = 12;
const expanded = ref(false);

const style = computed(() => platformStyle(props.group.platform));
const shown = computed(() => (expanded.value ? props.group.models : props.group.models.slice(0, LIMIT)));
const multiplier = computed(() => Number(props.group.rateMultiplier.toFixed(3)));
const multiplierTone = computed(() => (multiplier.value < 1 ? "success" : multiplier.value > 1 ? "warning" : "neutral"));

function priceTitle(m: PlazaModel): string {
  const k = props.group.rateMultiplier;
  const prices = t("public.plaza.priceTitle", {
    input: formatPerMillion(usdPerMillion(m.price.inputNanoPerToken, k)),
    output: formatPerMillion(usdPerMillion(m.price.outputNanoPerToken, k)),
  });
  return `${m.id}\n${prices}\n${t("public.plaza.copyHint")}`;
}
</script>

<template>
  <article class="card card-hover relative flex h-full min-w-0 flex-col overflow-hidden">
    <div class="h-1 w-full shrink-0" :class="style.bar" aria-hidden="true" />
    <div class="flex flex-1 flex-col p-5">
      <header class="flex items-start gap-3">
        <span class="icon-chip h-10 w-10 rounded-xl" :class="style.badge">
          <PlatformIcon :platform="group.platform" :size="18" />
        </span>
        <div class="min-w-0 flex-1">
          <h3 class="truncate text-sm font-semibold text-fg" :title="group.name">{{ group.name }}</h3>
          <p class="mt-0.5 text-xs text-fg-subtle">{{ platformShortLabel(group.platform) }}</p>
        </div>
        <UiBadge :tone="group.billing === 'subscription' ? 'violet' : 'accent'">
          {{ t(`public.plaza.billing.${group.billing}`) }}
        </UiBadge>
      </header>

      <p class="mt-3 line-clamp-2 min-h-[2.5rem] text-sm leading-5" :class="group.description ? 'text-fg-muted' : 'text-fg-subtle'">
        {{ group.description || t("public.plaza.noDescription") }}
      </p>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <UiBadge :tone="multiplierTone" mono :title="t('public.plaza.multiplierHint')">
          {{ t("public.plaza.multiplier", { n: multiplier }) }}
        </UiBadge>
        <span
          v-if="listRate !== null && listRate !== undefined && listRate !== group.rateMultiplier"
          class="inline-flex items-center gap-1 text-2xs text-fg-subtle"
          :title="t('userLimits.plaza.customHint')"
        >
          <span class="font-mono line-through">×{{ Number(listRate.toFixed(3)) }}</span>
          <span
            class="rounded-full px-1.5 font-medium"
            :class="group.rateMultiplier < listRate ? 'bg-success/10 text-success' : 'bg-warning/10 text-warning'"
          >
            {{ t("userLimits.plaza.custom") }}
          </span>
        </span>
        <UiBadge :tone="group.activeAccounts > 0 ? 'success' : 'neutral'" dot>
          {{ group.activeAccounts > 0 ? t("public.plaza.activeAccounts", { n: group.activeAccounts }) : t("public.plaza.noAccounts") }}
        </UiBadge>
        <span class="ml-auto text-2xs text-fg-subtle">{{ t("public.plaza.modelsCount", { n: group.models.length }) }}</span>
      </div>

      <div class="mt-4 flex-1 border-t border-line/70 pt-4">
        <p v-if="!group.models.length" class="text-xs text-fg-subtle">{{ t("public.plaza.noModels") }}</p>
        <ul v-else class="flex flex-wrap gap-1.5">
          <li v-for="m in shown" :key="m.id" class="min-w-0 max-w-full">
            <button
              type="button"
              class="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-2xs transition-colors duration-150"
              :class="
                copied === m.id
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-line/80 bg-surface-2/60 text-fg-muted hover:border-accent/40 hover:bg-accent/[0.06] hover:text-accent'
              "
              :title="priceTitle(m)"
              @click="emit('copy', m.id)"
            >
              <UiIcon v-if="copied === m.id" name="check" :size="11" />
              <PlatformIcon v-else :platform="m.provider" :size="11" class="opacity-80" />
              <span class="truncate">{{ m.id }}</span>
            </button>
          </li>
        </ul>
        <button
          v-if="group.models.length > LIMIT"
          type="button"
          class="mt-3 inline-flex cursor-pointer items-center gap-1 text-xs font-medium text-accent hover:underline"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          {{ expanded ? t("public.plaza.showLess") : t("public.plaza.showAll", { n: group.models.length }) }}
          <UiIcon name="chevron-down" :size="13" class="transition-transform duration-200" :class="expanded ? 'rotate-180' : ''" />
        </button>
      </div>
    </div>
  </article>
</template>
