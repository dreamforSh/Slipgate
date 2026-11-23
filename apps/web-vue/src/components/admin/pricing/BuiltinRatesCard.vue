<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { usePersistentState } from "../../../composables/usePersistentState";
import UiIcon from "../../ui/UiIcon.vue";
import { BUILTIN_TIERS, formatPerM, type BuiltinTier } from "./pricingUtil";

/** Collapsible reference of the core's fallback rates (used when no rule matches). */
const emit = defineEmits<{ (e: "override", tier: BuiltinTier): void }>();

const { t } = useI18n();
const open = usePersistentState("slipgate_pricing_builtin_open", false, (v): v is boolean => typeof v === "boolean");

const priceKeys = ["input", "output", "cacheRead", "cacheWrite"] as const;
</script>

<template>
  <section class="card min-w-0">
    <h2>
      <button
        type="button"
        class="flex min-h-[3.5rem] w-full items-center gap-3 rounded-xl px-5 py-3 text-left transition-colors hover:bg-surface-2/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
        :class="open ? 'rounded-b-none' : ''"
        :aria-expanded="open"
        aria-controls="pricing-builtin-panel"
        @click="open = !open"
      >
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="book-open" :size="16" /></span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-sm font-semibold text-fg">{{ t("pricing.builtin.title") }}</span>
        </span>
        <span class="inline-flex shrink-0 items-center gap-1 text-xs text-fg-subtle">
          <span class="hidden sm:inline">{{ open ? t("pricing.builtin.hide") : t("pricing.builtin.show") }}</span>
          <UiIcon
            name="chevron-down"
            :size="15"
            class="transition-transform duration-200 ease-out"
            :class="open ? 'rotate-180' : ''"
          />
        </span>
      </button>
    </h2>

    <div
      id="pricing-builtin-panel"
      class="grid transition-[grid-template-rows] duration-300 ease-out"
      :class="open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
      :inert="!open"
    >
      <div class="min-h-0 overflow-hidden">
        <div class="border-t border-line/70">
          <p class="flex items-start gap-2 px-5 py-3 text-xs leading-relaxed text-fg-subtle">
            <UiIcon name="info" :size="13" class="mt-px" />
            {{ t("pricing.builtin.hint") }}
          </p>

          <!-- sm+: reference table -->
          <div class="table-wrap hidden border-t border-line/70 sm:block">
            <table class="data-table">
              <thead>
                <tr>
                  <th>{{ t("pricing.builtin.tier") }}</th>
                  <th>{{ t("pricing.builtin.match") }}</th>
                  <th v-for="k in priceKeys" :key="k" class="text-right">{{ t(`pricing.table.${k}`) }}</th>
                  <th class="text-right"><span class="sr-only">{{ t("common.actions") }}</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="tier in BUILTIN_TIERS" :key="tier.key">
                  <td class="whitespace-nowrap text-sm font-medium text-fg">{{ t(`pricing.builtin.tiers.${tier.key}`) }}</td>
                  <td>
                    <span v-if="tier.contains" class="text-xs text-fg-muted">
                      {{ t("pricing.builtin.contains", { text: tier.matchers[0] }) }}
                    </span>
                    <span v-else-if="tier.matchers.length" class="flex flex-wrap gap-1">
                      <span v-for="m in tier.matchers" :key="m" class="code-chip">{{ m }}</span>
                    </span>
                    <span v-else class="text-xs text-fg-subtle">{{ t("pricing.builtin.fallback") }}</span>
                  </td>
                  <td
                    v-for="k in priceKeys"
                    :key="k"
                    class="whitespace-nowrap text-right font-mono text-xs tabular-nums"
                    :class="k === 'input' || k === 'output' ? 'text-fg' : 'text-fg-muted'"
                  >
                    {{ formatPerM(tier.prices[k]) }}
                  </td>
                  <td class="text-right">
                    <button
                      v-if="tier.suggestPattern"
                      type="button"
                      class="btn btn-ghost btn-xs"
                      :title="t('pricing.actions.overrideTitle')"
                      @click="emit('override', tier)"
                    >
                      <UiIcon name="plus" :size="12" />
                      {{ t("pricing.actions.override") }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- phones: stacked rows -->
          <ul class="divide-y divide-line/60 border-t border-line/70 sm:hidden">
            <li v-for="tier in BUILTIN_TIERS" :key="tier.key" class="px-4 py-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="text-sm font-medium text-fg">{{ t(`pricing.builtin.tiers.${tier.key}`) }}</p>
                  <p class="mt-1 flex flex-wrap gap-1 text-2xs text-fg-subtle">
                    <template v-if="tier.contains">{{ t("pricing.builtin.contains", { text: tier.matchers[0] }) }}</template>
                    <template v-else-if="tier.matchers.length">
                      <span v-for="m in tier.matchers" :key="m" class="code-chip">{{ m }}</span>
                    </template>
                    <template v-else>{{ t("pricing.builtin.fallback") }}</template>
                  </p>
                </div>
                <button
                  v-if="tier.suggestPattern"
                  type="button"
                  class="btn btn-ghost btn-xs shrink-0"
                  :title="t('pricing.actions.overrideTitle')"
                  @click="emit('override', tier)"
                >
                  <UiIcon name="plus" :size="12" />
                  {{ t("pricing.actions.override") }}
                </button>
              </div>
              <dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                <div v-for="k in priceKeys" :key="k" class="flex items-baseline justify-between gap-2">
                  <dt class="text-2xs text-fg-subtle">{{ t(`pricing.table.${k}`) }}</dt>
                  <dd class="font-mono text-xs tabular-nums text-fg">{{ formatPerM(tier.prices[k]) }}</dd>
                </div>
              </dl>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
