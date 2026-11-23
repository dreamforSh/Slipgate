<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ModelPricingRule } from "@slipgate/contracts";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { cacheIsDefault, formatPerM, isPrefixPattern, nanoToUsdText, rulePrices, STAGGER_CLASS, stagger, type PriceSet } from "./pricingUtil";

/** Rule list: table on md+, stacked cards on phones. Mutations are delegated to the page. */
const props = defineProps<{
  rules: ModelPricingRule[];
  loading: boolean;
  loaded: boolean;
  busyIds: Set<string>;
  /** Rule matched by the price tester (highlighted). */
  highlightId: string | null;
}>();

const emit = defineEmits<{
  (e: "create"): void;
  (e: "syncPresets"): void;
  (e: "edit", rule: ModelPricingRule): void;
  (e: "toggle", rule: ModelPricingRule): void;
  (e: "remove", rule: ModelPricingRule): void;
}>();

const { t } = useI18n();

type StatusFilter = "all" | "enabled" | "disabled";
const search = ref("");
const status = ref<StatusFilter>("all");

const enabledCount = computed(() => props.rules.filter((r) => r.enabled).length);
const statusOptions = computed(() => [
  { value: "all" as const, label: t("common.all"), count: props.rules.length },
  { value: "enabled" as const, label: t("common.enabled"), count: enabledCount.value },
  { value: "disabled" as const, label: t("common.disabled"), count: props.rules.length - enabledCount.value },
]);

const hasFilters = computed(() => search.value.trim() !== "" || status.value !== "all");

interface Row {
  rule: ModelPricingRule;
  prices: PriceSet;
  defaults: { read: boolean; write: boolean };
  prefix: boolean;
}

const rows = computed<Row[]>(() => {
  const q = search.value.trim().toLowerCase();
  return props.rules
    .filter((r) => {
      if (status.value === "enabled" && !r.enabled) return false;
      if (status.value === "disabled" && r.enabled) return false;
      if (q && !r.pattern.toLowerCase().includes(q) && !r.notes.toLowerCase().includes(q)) return false;
      return true;
    })
    .map((rule) => {
      const prices = rulePrices(rule);
      return { rule, prices, defaults: cacheIsDefault(prices), prefix: isPrefixPattern(rule.pattern) };
    });
});

function resetFilters() {
  search.value = "";
  status.value = "all";
}

const priceCols = [
  { key: "input", cls: "text-fg font-medium" },
  { key: "output", cls: "text-fg font-medium" },
  { key: "cacheRead", cls: "text-fg-muted" },
  { key: "cacheWrite", cls: "text-fg-muted" },
] as const;

function cacheTitle(row: Row, key: (typeof priceCols)[number]["key"]): string | undefined {
  if (key === "cacheRead" && row.defaults.read) return t("pricing.cacheDefault.read");
  if (key === "cacheWrite" && row.defaults.write) return t("pricing.cacheDefault.write");
  return undefined;
}

function extraBadges(rule: ModelPricingRule): string[] {
  const out: string[] = [];
  if (rule.perImageNanoUsd && rule.perImageNanoUsd !== "0") {
    out.push(`$${nanoToUsdText(BigInt(rule.perImageNanoUsd))}/img`);
  }
  if (rule.perVideoSecondNanoUsd && rule.perVideoSecondNanoUsd !== "0") {
    out.push(`$${nanoToUsdText(BigInt(rule.perVideoSecondNanoUsd))}/s`);
  }
  if (rule.perRequestNanoUsd && rule.perRequestNanoUsd !== "0") {
    out.push(`$${nanoToUsdText(BigInt(rule.perRequestNanoUsd))}/req`);
  }
  if (rule.longContextThresholdTokens && rule.longContextThresholdTokens > 0) {
    out.push(`>${Math.round(rule.longContextThresholdTokens / 1000)}k`);
  }
  return out;
}
</script>

<template>
  <UiCard icon="sliders" :title="t('pricing.list.title')" flush>
    <template #actions>
      <div class="scrollbar-hide max-w-full overflow-x-auto">
        <SegmentedControl v-model="status" :options="statusOptions" />
      </div>
    </template>

    <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-4 py-3 sm:px-5">
      <label class="relative min-w-[12rem] flex-1 sm:max-w-xs">
        <span class="sr-only">{{ t("common.search") }}</span>
        <UiIcon
          name="search"
          :size="14"
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
        />
        <input
          v-model="search"
          type="search"
          class="input input-sm pl-8"
          :placeholder="t('pricing.list.searchPlaceholder')"
        />
      </label>
      <span class="ml-auto hidden items-center gap-1.5 text-2xs text-fg-subtle sm:inline-flex">
        <UiIcon name="wallet" :size="12" />
        {{ t("pricing.list.unit") }}
      </span>
    </div>

    <!-- First load -->
    <div v-if="!loaded" class="divide-y divide-line/60" aria-busy="true" role="status">
      <div
        v-for="i in 4"
        :key="i"
        class="flex items-center gap-4 px-5 py-3.5 motion-safe:animate-pulse"
        :style="{ animationDelay: `${(i - 1) * 90}ms` }"
      >
        <span class="h-2.5 w-36 shrink-0 rounded-full bg-surface-2" />
        <span class="h-4 w-12 shrink-0 rounded-full bg-surface-2/80" />
        <span class="ml-auto hidden h-2.5 w-20 rounded-full bg-surface-2/70 sm:block" />
        <span class="hidden h-2.5 w-20 rounded-full bg-surface-2/70 md:block" />
        <span class="hidden h-2.5 w-24 rounded-full bg-surface-2/70 lg:block" />
      </div>
      <span class="sr-only">{{ t("common.loading") }}</span>
    </div>

    <EmptyState v-else-if="rules.length === 0" icon="sliders" :title="t('pricing.list.empty')">
      <p class="w-full max-w-sm text-xs text-fg-subtle">{{ t("pricing.list.emptyHint") }}</p>
      <div class="flex flex-wrap items-center justify-center gap-2">
        <button type="button" class="btn btn-secondary btn-sm" @click="emit('syncPresets')">
          <UiIcon name="download" :size="14" />
          {{ t("pricing.actions.syncPresets") }}
        </button>
        <button type="button" class="btn btn-primary btn-sm" @click="emit('create')">
          <UiIcon name="plus" :size="14" />
          {{ t("pricing.actions.create") }}
        </button>
      </div>
    </EmptyState>

    <EmptyState v-else-if="rows.length === 0 && hasFilters" icon="search" :title="t('pricing.list.noMatch')" compact>
      <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
        <UiIcon name="x" :size="14" />
        {{ t("pricing.list.clearFilters") }}
      </button>
    </EmptyState>

    <div v-else class="transition-opacity duration-200" :class="loading ? 'opacity-60' : ''">
      <!-- md+: table -->
      <div class="table-wrap hidden md:block">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("pricing.table.pattern") }}</th>
              <th v-for="c in priceCols" :key="c.key" class="text-right">{{ t(`pricing.table.${c.key}`) }}</th>
              <th>{{ t("pricing.table.enabled") }}</th>
              <th>{{ t("pricing.table.notes") }}</th>
              <th>{{ t("pricing.table.updated") }}</th>
              <th class="text-right"><span class="sr-only">{{ t("common.actions") }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, i) in rows"
              :key="row.rule.id"
              :class="[STAGGER_CLASS, row.rule.id === highlightId ? '!bg-accent/[0.06]' : '']"
              :style="stagger(i)"
            >
              <td class="max-w-[18rem]">
                <div class="flex min-w-0 items-center gap-2">
                  <span
                    v-if="row.rule.id === highlightId"
                    class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                    :title="t('pricing.list.matchesTester')"
                  >
                    <span class="sr-only">{{ t("pricing.list.matchesTester") }}</span>
                  </span>
                  <span
                    class="truncate font-mono text-[13px] font-medium"
                    :class="row.rule.enabled ? 'text-fg' : 'text-fg-subtle line-through decoration-fg-subtle/50'"
                    :title="row.rule.pattern"
                  >
                    {{ row.rule.pattern }}
                  </span>
                  <UiBadge v-if="row.prefix" tone="info">{{ t("pricing.kind.prefix") }}</UiBadge>
                  <UiBadge v-for="b in extraBadges(row.rule)" :key="b" tone="neutral">{{ b }}</UiBadge>
                </div>
              </td>
              <td
                v-for="c in priceCols"
                :key="c.key"
                class="whitespace-nowrap text-right font-mono text-xs tabular-nums"
                :class="[c.cls, row.rule.enabled ? '' : 'opacity-60', cacheTitle(row, c.key) ? '!text-fg-subtle' : '']"
                :title="cacheTitle(row, c.key)"
              >
                {{ formatPerM(row.prices[c.key]) }}
              </td>
              <td>
                <UiSwitch
                  :model-value="row.rule.enabled"
                  :disabled="busyIds.has(row.rule.id)"
                  :label="row.rule.enabled ? t('common.enabled') : t('common.disabled')"
                  hide-label
                  @update:model-value="emit('toggle', row.rule)"
                />
              </td>
              <td class="max-w-[14rem]">
                <p v-if="row.rule.notes" class="truncate text-xs text-fg-muted" :title="row.rule.notes">{{ row.rule.notes }}</p>
                <span v-else class="text-xs text-fg-subtle">-</span>
              </td>
              <td class="whitespace-nowrap text-xs text-fg-subtle" :title="formatDateTime(row.rule.updatedAtIso)">
                {{ formatRelative(row.rule.updatedAtIso) }}
              </td>
              <td class="text-right">
                <div class="inline-flex items-center gap-0.5">
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :disabled="busyIds.has(row.rule.id)"
                    :title="t('pricing.actions.edit')"
                    :aria-label="t('pricing.actions.edit')"
                    @click="emit('edit', row.rule)"
                  >
                    <UiIcon name="pencil" :size="13" />
                  </button>
                  <ConfirmButton icon-only :disabled="busyIds.has(row.rule.id)" @confirm="emit('remove', row.rule)" />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Phones / small tablets: cards -->
      <ul class="divide-y divide-line/60 md:hidden">
        <li
          v-for="(row, i) in rows"
          :key="row.rule.id"
          class="px-4 py-3.5 transition-colors"
          :class="[STAGGER_CLASS, row.rule.id === highlightId ? 'bg-accent/[0.06]' : '']"
          :style="stagger(i)"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                <span
                  class="break-all font-mono text-[13px] font-medium"
                  :class="row.rule.enabled ? 'text-fg' : 'text-fg-subtle line-through decoration-fg-subtle/50'"
                >
                  {{ row.rule.pattern }}
                </span>
                <UiBadge v-if="row.prefix" tone="info">{{ t("pricing.kind.prefix") }}</UiBadge>
                <UiBadge v-if="row.rule.id === highlightId" tone="accent" dot>{{ t("pricing.tester.matchedRule") }}</UiBadge>
              </div>
              <p v-if="row.rule.notes" class="mt-1 line-clamp-2 text-xs text-fg-muted">{{ row.rule.notes }}</p>
            </div>
            <UiSwitch
              :model-value="row.rule.enabled"
              :disabled="busyIds.has(row.rule.id)"
              :label="row.rule.enabled ? t('common.enabled') : t('common.disabled')"
              hide-label
              class="mt-0.5 shrink-0"
              @update:model-value="emit('toggle', row.rule)"
            />
          </div>
          <dl class="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-lg bg-surface-2/40 px-3 py-2 dark:bg-surface-2/25">
            <div v-for="c in priceCols" :key="c.key" class="flex min-w-0 items-baseline justify-between gap-2">
              <dt class="truncate text-2xs text-fg-subtle">{{ t(`pricing.table.${c.key}`) }}</dt>
              <dd class="font-mono text-xs tabular-nums" :class="cacheTitle(row, c.key) ? 'text-fg-subtle' : c.cls">
                {{ formatPerM(row.prices[c.key]) }}
              </dd>
            </div>
          </dl>
          <div class="mt-2 flex items-center justify-between gap-2">
            <span class="text-2xs text-fg-subtle" :title="formatDateTime(row.rule.updatedAtIso)">
              {{ formatRelative(row.rule.updatedAtIso) }}
            </span>
            <div class="inline-flex items-center gap-0.5">
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :disabled="busyIds.has(row.rule.id)"
                @click="emit('edit', row.rule)"
              >
                <UiIcon name="pencil" :size="13" />
                {{ t("common.edit") }}
              </button>
              <ConfirmButton :disabled="busyIds.has(row.rule.id)" @confirm="emit('remove', row.rule)" />
            </div>
          </div>
        </li>
      </ul>
    </div>
  </UiCard>
</template>
