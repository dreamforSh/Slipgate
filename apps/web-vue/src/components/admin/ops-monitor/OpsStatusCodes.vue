<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { OpsOverview } from "@slipgate/contracts";
import { formatCompact, formatNumber } from "../../../lib/format";
import EmptyState from "../../ui/EmptyState.vue";
import UiCard from "../../ui/UiCard.vue";
import { TONE_BG, TONE_TEXT, statusTone } from "./opsFormat";

/** Status-code mix: one stacked bar by code plus a ranked list of codes with shares. */
const props = defineProps<{ codes: OpsOverview["statusCodes"] }>();

const { t } = useI18n();

const total = computed(() => props.codes.reduce((s, c) => s + c.count, 0));
const rows = computed(() =>
  [...props.codes]
    .sort((a, b) => b.count - a.count)
    .map((c) => ({
      ...c,
      tone: statusTone(c.code),
      share: total.value > 0 ? c.count / total.value : 0,
    })),
);

/** Class totals (2xx / 3xx / 4xx / 5xx) for the summary line. */
const classes = computed(() => {
  const out = new Map<string, number>();
  for (const c of props.codes) {
    const key = c.code >= 100 && c.code < 600 ? `${Math.floor(c.code / 100)}xx` : "other";
    out.set(key, (out.get(key) ?? 0) + c.count);
  }
  return [...out.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count, tone: statusTone(key === "other" ? 0 : Number(key[0]) * 100) }));
});

const ready = ref(false);
onMounted(() => requestAnimationFrame(() => (ready.value = true)));

function pct(share: number) {
  return `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
}
</script>

<template>
  <UiCard icon="chart" :title="t('security.ops.status.title')">
    <template #actions>
      <span class="font-mono text-xs tabular-nums text-fg-subtle">{{ formatCompact(total) }}</span>
    </template>
    <EmptyState v-if="total === 0" compact icon="chart" :title="t('security.ops.status.empty')" />
    <template v-else>
      <div class="flex h-2.5 overflow-hidden rounded-full bg-surface-2" role="img" :aria-label="t('security.ops.status.title')">
        <div
          v-for="r in rows"
          :key="r.code"
          class="h-full transition-[width] duration-700 ease-out first:rounded-l-full last:rounded-r-full [&:not(:last-child)]:border-r [&:not(:last-child)]:border-surface"
          :class="TONE_BG[r.tone]"
          :style="{ width: ready ? `${r.share * 100}%` : '0%' }"
          :title="`${r.code} · ${formatNumber(r.count)} · ${pct(r.share)}`"
        />
      </div>
      <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span v-for="c in classes" :key="c.key" class="inline-flex items-center gap-1.5 text-fg-muted">
          <span class="h-2 w-2 rounded-full" :class="TONE_BG[c.tone]" />
          <span class="font-mono">{{ c.key === "other" ? t("security.ops.status.other") : c.key }}</span>
          <span class="font-mono tabular-nums text-fg">{{ formatCompact(c.count) }}</span>
        </span>
      </div>
      <ul class="mt-3 space-y-0.5">
        <li
          v-for="r in rows.slice(0, 10)"
          :key="r.code"
          class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2/60"
        >
          <span class="w-11 shrink-0 font-mono text-xs font-semibold" :class="TONE_TEXT[r.tone]">{{ r.code || "—" }}</span>
          <span class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
            <span
              class="block h-full rounded-full transition-[width] duration-700 ease-out"
              :class="TONE_BG[r.tone]"
              :style="{ width: ready ? `${Math.max(2, r.share * 100)}%` : '0%' }"
            />
          </span>
          <span class="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-fg">{{ formatCompact(r.count) }}</span>
          <span class="w-11 shrink-0 text-right font-mono text-2xs tabular-nums text-fg-subtle">{{ pct(r.share) }}</span>
        </li>
      </ul>
    </template>
  </UiCard>
</template>
