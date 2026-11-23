<script setup lang="ts">
import { useI18n } from "vue-i18n";
import UiCard from "../../ui/UiCard.vue";
import UiIcon, { type IconName } from "../../ui/UiIcon.vue";

/** How rule pricing combines with built-in rates and group multipliers. */
const { t } = useI18n();

const points: { key: "override" | "multiplier" | "free" | "specific"; icon: IconName; chip: string }[] = [
  { key: "override", icon: "sliders", chip: "icon-chip-accent" },
  { key: "multiplier", icon: "percent", chip: "icon-chip-violet" },
  { key: "free", icon: "shield", chip: "icon-chip-success" },
  { key: "specific", icon: "filter", chip: "icon-chip-info" },
];

/** Precedence ladder for "most specific wins" (identifiers are not translated). */
const ladder = ["claude-opus-4-1", "claude-opus-*", "claude-*"];
</script>

<template>
  <UiCard icon="info" :title="t('pricing.explainer.title')">
    <ul class="grid gap-x-6 gap-y-5 sm:grid-cols-2">
      <li v-for="p in points" :key="p.key" class="flex min-w-0 gap-3">
        <span class="icon-chip h-8 w-8" :class="p.chip"><UiIcon :name="p.icon" :size="15" /></span>
        <div class="min-w-0">
          <p class="text-sm font-medium text-fg">{{ t(`pricing.explainer.${p.key}.title`) }}</p>
          <p class="mt-0.5 text-xs leading-relaxed text-fg-muted">{{ t(`pricing.explainer.${p.key}.body`) }}</p>
          <ol
            v-if="p.key === 'specific'"
            class="mt-2 flex flex-wrap items-center gap-1"
            :aria-label="t('pricing.explainer.specific.title')"
          >
            <template v-for="step in ladder" :key="step">
              <li class="code-chip">{{ step }}</li>
              <li aria-hidden="true" class="text-fg-subtle">
                <UiIcon name="chevron-right" :size="12" />
              </li>
            </template>
            <li class="inline-flex items-center rounded-md bg-surface-2 px-1.5 py-px text-2xs text-fg-subtle ring-1 ring-inset ring-line">
              {{ t("pricing.explainer.builtin") }}
            </li>
          </ol>
        </div>
      </li>
    </ul>
    <template #footer>
      <p class="flex items-start gap-2 text-xs text-fg-subtle">
        <UiIcon name="info" :size="13" class="mt-px" />
        {{ t("pricing.explainer.units") }}
      </p>
    </template>
  </UiCard>
</template>
