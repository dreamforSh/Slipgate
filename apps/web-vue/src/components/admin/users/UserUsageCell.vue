<script setup lang="ts">
import { computed } from "vue";
import type { PlatformUsage } from "@slipgate/contracts";
import { formatUsd } from "../../../lib/format";
import { platformShortLabel } from "../../../lib/platformStyle";
import PlatformIcon from "../../ui/PlatformIcon.vue";
import UiIcon from "../../ui/UiIcon.vue";
import CellPopover from "./CellPopover.vue";
import { useLimitText } from "./limits";

/**
 * Today / 30-day spend of one user with a per-platform breakdown popover (Linksyncx
 * PlatformUsageBreakdown). Amounts are nano-USD digit strings; null while the figures load.
 */
const props = defineProps<{
  usage: { todayNanoUsd: string; totalNanoUsd: string; byPlatform: PlatformUsage[] } | null;
  windowDays: number;
  loading?: boolean;
}>();

const { t } = useLimitText();

/** Breakdown rows plus an "other" row when the platforms do not add up to the totals. */
const rows = computed(() => {
  const u = props.usage;
  if (!u) return [];
  const list = u.byPlatform.map((p) => ({ key: p.platform, label: platformShortLabel(p.platform), today: p.todayNanoUsd, total: p.totalNanoUsd, other: false }));
  const sumToday = u.byPlatform.reduce((s, p) => s + BigInt(p.todayNanoUsd), 0n);
  const sumTotal = u.byPlatform.reduce((s, p) => s + BigInt(p.totalNanoUsd), 0n);
  const restToday = BigInt(u.todayNanoUsd) - sumToday;
  const restTotal = BigInt(u.totalNanoUsd) - sumTotal;
  if (restToday > 0n || restTotal > 0n) {
    list.push({
      key: "__other__",
      label: t("userLimits.usage.other"),
      today: (restToday > 0n ? restToday : 0n).toString(),
      total: (restTotal > 0n ? restTotal : 0n).toString(),
      other: true,
    });
  }
  return list;
});

const idle = computed(() => !props.usage || (props.usage.todayNanoUsd === "0" && props.usage.totalNanoUsd === "0"));
</script>

<template>
  <div v-if="!usage" class="space-y-1" :aria-busy="loading || undefined">
    <span class="block h-2.5 w-16 rounded-full bg-surface-2" :class="loading ? 'motion-safe:animate-pulse' : ''" />
    <span class="block h-2 w-12 rounded-full bg-surface-2/70" :class="loading ? 'motion-safe:animate-pulse' : ''" />
  </div>
  <CellPopover
    v-else
    :label="t('userLimits.usage.breakdownLabel')"
    :disabled="rows.length === 0"
    width-class="w-72"
  >
    <span class="grid grid-cols-[auto_auto] items-baseline gap-x-2 text-xs leading-5">
      <span class="text-fg-subtle">{{ t("userLimits.usage.today") }}</span>
      <span class="text-right font-mono tabular-nums" :class="usage.todayNanoUsd === '0' ? 'text-fg-subtle' : 'font-medium text-fg'">
        {{ formatUsd(usage.todayNanoUsd) }}
      </span>
      <span class="text-fg-subtle">{{ t("userLimits.usage.total", { n: windowDays }) }}</span>
      <span class="inline-flex items-center justify-end gap-1 font-mono tabular-nums" :class="idle ? 'text-fg-subtle' : 'text-fg-muted'">
        {{ formatUsd(usage.totalNanoUsd) }}
        <UiIcon v-if="rows.length" name="info" :size="11" class="text-fg-subtle" />
      </span>
    </span>
    <template #content>
      <div class="mb-2 flex items-center justify-between gap-3 border-b border-line/70 pb-1.5 text-2xs text-fg-subtle">
        <span class="font-medium">{{ t("userLimits.usage.byPlatform") }}</span>
        <span class="font-mono">{{ t("userLimits.usage.today") }} / {{ t("userLimits.usage.total", { n: windowDays }) }}</span>
      </div>
      <ul class="space-y-1">
        <li v-for="r in rows" :key="r.key" class="flex items-center justify-between gap-3" :class="r.other ? 'italic text-fg-subtle' : 'text-fg'">
          <span class="flex min-w-0 items-center gap-1.5">
            <PlatformIcon v-if="!r.other" :platform="r.key" :size="12" />
            <span class="truncate">{{ r.label }}</span>
          </span>
          <span class="shrink-0 font-mono tabular-nums">
            {{ formatUsd(r.today) }}<span class="px-1 text-fg-subtle">/</span>{{ formatUsd(r.total) }}
          </span>
        </li>
      </ul>
    </template>
  </CellPopover>
</template>
