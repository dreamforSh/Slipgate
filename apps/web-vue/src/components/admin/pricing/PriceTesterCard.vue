<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { GroupItem, ModelPricingRule } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import {
  applyMultiplier,
  builtinTierFor,
  formatPerM,
  isPrefixPattern,
  matchIgnoringEnabled,
  matchPricingRule,
  multiplierText,
  PATTERN_MAX,
  PATTERN_RE,
  presetFromPrices,
  rulePrices,
  SAMPLE_MODELS,
  type RulePreset,
} from "./pricingUtil";

/** Type a model id → which rule (or built-in tier) prices it, and at what rate. */
const props = defineProps<{
  rules: ModelPricingRule[];
  groups: GroupItem[];
}>();

const emit = defineEmits<{
  (e: "match", ruleId: string | null): void;
  (e: "edit", rule: ModelPricingRule): void;
  (e: "create", preset: RulePreset): void;
}>();

const { t } = useI18n();

const model = ref("");
const groupId = ref("");
const query = computed(() => model.value.trim());

const group = computed(() => props.groups.find((g) => g.id === groupId.value) ?? null);
const multiplier = computed(() => group.value?.rateMultiplier ?? 1);

const matched = computed(() => (query.value ? matchPricingRule(props.rules, query.value) : null));
const tier = computed(() => builtinTierFor(query.value));

/** A disabled rule that would beat whatever matches today. */
const dormant = computed(() => {
  if (!query.value) return null;
  const best = matchIgnoringEnabled(props.rules, query.value);
  return best && !best.enabled && best.id !== matched.value?.id ? best : null;
});

const prices = computed(() => (matched.value ? rulePrices(matched.value) : tier.value.prices));

const tiles = computed(() =>
  (["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => ({
    key,
    base: prices.value[key],
    effective: applyMultiplier(prices.value[key], multiplier.value),
  })),
);

/** Re-animate the result only when what decides the price changes, not on every keystroke. */
const resultKey = computed(() => {
  if (!query.value) return "empty";
  return `${matched.value?.id ?? `builtin:${tier.value.key}`}|${groupId.value}`;
});

const canCreate = computed(() => query.value.length <= PATTERN_MAX && PATTERN_RE.test(query.value));

watch(
  () => matched.value?.id ?? null,
  (id) => emit("match", id),
  { immediate: true },
);

const sortedGroups = computed(() =>
  [...props.groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
);

function createRule() {
  if (!canCreate.value) return;
  emit("create", presetFromPrices(query.value, tier.value.prices));
}
</script>

<template>
  <UiCard icon="search" :title="t('pricing.tester.title')">
    <p class="text-xs text-fg-subtle">{{ t("pricing.tester.hint") }}</p>

    <div class="mt-3 space-y-2.5">
      <label class="relative block">
        <span class="sr-only">{{ t("pricing.tester.model") }}</span>
        <UiIcon
          name="search"
          :size="14"
          class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
        <input
          v-model="model"
          type="text"
          class="input pl-9 pr-9 font-mono text-[13px]"
          :placeholder="t('pricing.tester.placeholder')"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          maxlength="200"
        />
        <button
          v-if="model"
          type="button"
          class="absolute right-1.5 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          :aria-label="t('pricing.tester.clear')"
          :title="t('pricing.tester.clear')"
          @click="model = ''"
        >
          <UiIcon name="x" :size="13" />
        </button>
      </label>

      <div class="flex flex-wrap items-center gap-1.5" role="group" :aria-label="t('pricing.tester.samples')">
        <button
          v-for="m in SAMPLE_MODELS"
          :key="m"
          type="button"
          class="rounded-md px-1.5 py-0.5 font-mono text-2xs ring-1 ring-inset transition-colors"
          :class="
            query === m
              ? 'bg-accent/10 text-accent ring-accent/25'
              : 'bg-surface-2 text-fg-muted ring-line hover:text-fg hover:ring-line-strong'
          "
          :aria-pressed="query === m"
          @click="model = m"
        >
          {{ m }}
        </button>
      </div>

      <label v-if="groups.length" class="flex items-center gap-2">
        <span class="shrink-0 text-xs text-fg-subtle">{{ t("pricing.tester.group") }}</span>
        <select v-model="groupId" class="select input-sm min-w-0 flex-1">
          <option value="">{{ t("pricing.preview.noGroup") }}</option>
          <option v-for="g in sortedGroups" :key="g.id" :value="g.id">
            {{ g.name }} · {{ multiplierText(g.rateMultiplier) }}
          </option>
        </select>
      </label>
    </div>

    <div class="mt-4" aria-live="polite">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-1 opacity-0"
        leave-active-class="transition duration-100 ease-in"
        leave-to-class="opacity-0"
      >
        <div
          v-if="!query"
          key="empty"
          class="flex items-center gap-3 rounded-lg border border-dashed border-line-strong/70 px-4 py-5 text-xs text-fg-subtle"
        >
          <span class="icon-chip h-8 w-8"><UiIcon name="radar" :size="15" /></span>
          {{ t("pricing.tester.empty") }}
        </div>

        <div v-else :key="resultKey" class="space-y-3">
          <div
            class="flex flex-wrap items-start justify-between gap-2 rounded-lg border px-3 py-2.5"
            :class="matched ? 'border-accent/25 bg-accent/[0.05]' : 'border-line bg-surface-2/40'"
          >
            <div class="min-w-0 space-y-1.5">
              <template v-if="matched">
                <div class="flex flex-wrap items-center gap-1.5">
                  <UiBadge tone="accent" dot>{{ t("pricing.tester.matchedRule") }}</UiBadge>
                  <UiBadge :tone="isPrefixPattern(matched.pattern) ? 'info' : 'neutral'">
                    {{ isPrefixPattern(matched.pattern) ? t("pricing.tester.prefixMatch") : t("pricing.tester.exactMatch") }}
                  </UiBadge>
                </div>
                <p class="break-all font-mono text-[13px] font-medium text-fg">{{ matched.pattern }}</p>
                <p v-if="matched.notes" class="truncate text-2xs text-fg-subtle" :title="matched.notes">{{ matched.notes }}</p>
              </template>
              <template v-else>
                <UiBadge tone="neutral" dot>{{ t("pricing.tester.builtin") }}</UiBadge>
                <p class="text-[13px] font-medium text-fg">
                  {{ t("pricing.tester.builtinTier", { tier: t(`pricing.builtin.tiers.${tier.key}`) }) }}
                </p>
              </template>
            </div>
            <button
              v-if="matched"
              type="button"
              class="btn btn-ghost btn-xs"
              @click="emit('edit', matched)"
            >
              <UiIcon name="pencil" :size="12" />
              {{ t("pricing.actions.editMatched") }}
            </button>
            <button
              v-else
              type="button"
              class="btn btn-secondary btn-xs"
              :disabled="!canCreate"
              @click="createRule"
            >
              <UiIcon name="plus" :size="12" />
              {{ t("pricing.actions.createForModel") }}
            </button>
          </div>

          <dl class="grid grid-cols-2 gap-2">
            <div
              v-for="tile in tiles"
              :key="tile.key"
              class="min-w-0 rounded-lg border border-line/70 bg-surface-2/30 px-3 py-2.5 dark:bg-surface-2/20"
            >
              <dt class="truncate text-2xs font-medium text-fg-subtle">{{ t(`pricing.table.${tile.key}`) }}</dt>
              <dd class="mt-1 flex min-w-0 items-baseline gap-1">
                <span class="truncate font-mono text-base font-semibold tabular-nums text-fg">
                  {{ formatPerM(multiplier === 1 ? tile.base : tile.effective) }}
                </span>
                <span class="shrink-0 text-2xs text-fg-subtle">{{ t("pricing.table.perM") }}</span>
              </dd>
              <dd v-if="multiplier !== 1" class="mt-0.5 truncate font-mono text-2xs tabular-nums text-fg-subtle">
                {{ formatPerM(tile.base) }} × {{ multiplierText(multiplier) }}
              </dd>
            </div>
          </dl>

          <p v-if="multiplier !== 1 && group" class="flex items-center gap-1.5 text-2xs text-fg-subtle">
            <UiIcon name="percent" :size="12" class="text-violet" />
            {{ group.name }} · {{ t("pricing.tester.withMultiplier", { mult: multiplierText(multiplier) }) }}
          </p>

          <p
            v-if="dormant"
            class="flex items-start gap-1.5 rounded-md bg-warning/[0.07] px-2.5 py-2 text-2xs leading-relaxed text-warning ring-1 ring-inset ring-warning/20"
          >
            <UiIcon name="alert" :size="12" class="mt-0.5" />
            <span class="text-fg-muted">{{ t("pricing.tester.disabledWouldMatch", { pattern: dormant.pattern }) }}</span>
          </p>
        </div>
      </Transition>
    </div>
  </UiCard>
</template>
