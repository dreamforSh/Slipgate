<script setup lang="ts">
import { computed } from "vue";
import UiIcon from "../../ui/UiIcon.vue";
import CellPopover from "./CellPopover.vue";
import { useLimitText } from "./limits";

/**
 * Live concurrency of one user as "in flight / cap" (Linksyncx UserConcurrencyCell) with the
 * current-minute RPM in a popover. `live` false = slipgate-net unreachable (counts unknown).
 */
const props = defineProps<{
  stat: { inFlight: number | null; rpmUsed: number | null; concurrencyLimit: number; rpmLimit: number } | null;
  live: boolean;
  loading?: boolean;
}>();

const { t, capText } = useLimitText();

const tone = computed(() => {
  const s = props.stat;
  if (!s || s.inFlight === null) return "bg-surface-2 text-fg-subtle ring-line";
  if (s.concurrencyLimit > 0 && s.inFlight >= s.concurrencyLimit) return "bg-danger/10 text-danger ring-danger/20";
  if (s.inFlight > 0) return "bg-warning/10 text-warning ring-warning/25";
  return "bg-surface-2 text-fg-muted ring-line";
});

function pct(used: number | null, limit: number): number {
  if (used === null || limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}
</script>

<template>
  <div v-if="!stat" class="h-5 w-14 rounded-md bg-surface-2" :class="loading ? 'motion-safe:animate-pulse' : ''" :aria-busy="loading || undefined" />
  <CellPopover v-else :label="t('userLimits.live.label')" width-class="w-60">
    <span
      class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums ring-1 ring-inset transition-colors duration-200"
      :class="tone"
    >
      <UiIcon name="activity" :size="11" />
      <span>{{ stat.inFlight ?? "—" }}</span>
      <span class="opacity-50">/</span>
      <span>{{ stat.concurrencyLimit > 0 ? stat.concurrencyLimit : "∞" }}</span>
    </span>
    <template #content>
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="text-2xs font-medium text-fg-subtle">{{ t("userLimits.live.title") }}</span>
        <span
          class="inline-flex items-center gap-1 rounded-full px-1.5 text-2xs font-medium"
          :class="live ? 'bg-success/10 text-success' : 'bg-surface-2 text-fg-subtle'"
        >
          <span class="h-1.5 w-1.5 rounded-full" :class="live ? 'bg-success' : 'bg-fg-subtle'" />
          {{ live ? t("userLimits.live.live") : t("userLimits.live.offline") }}
        </span>
      </div>
      <dl class="space-y-2.5">
        <div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-fg-subtle">{{ t("userLimits.live.concurrency") }}</dt>
            <dd class="font-mono tabular-nums text-fg">
              {{ stat.inFlight ?? "—" }} / {{ capText(stat.concurrencyLimit, "concurrency") }}
            </dd>
          </div>
          <div v-if="stat.concurrencyLimit > 0" class="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
            <div class="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" :style="{ width: `${pct(stat.inFlight, stat.concurrencyLimit)}%` }" />
          </div>
        </div>
        <div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-fg-subtle">{{ t("userLimits.live.rpm") }}</dt>
            <dd class="font-mono tabular-nums text-fg">{{ stat.rpmUsed ?? "—" }} / {{ capText(stat.rpmLimit, "rpm") }}</dd>
          </div>
          <div v-if="stat.rpmLimit > 0" class="mt-1 h-1 overflow-hidden rounded-full bg-surface-3">
            <div class="h-full rounded-full bg-info transition-[width] duration-300 ease-out" :style="{ width: `${pct(stat.rpmUsed, stat.rpmLimit)}%` }" />
          </div>
        </div>
      </dl>
      <p v-if="!live" class="mt-2.5 text-2xs leading-4 text-fg-subtle">{{ t("userLimits.live.offlineHint") }}</p>
    </template>
  </CellPopover>
</template>
