<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import type { OpsOverview } from "@slipgate/contracts";
import { formatCompact, type Tone } from "../../../lib/format";
import UiCard from "../../ui/UiCard.vue";
import UiIcon, { type IconName } from "../../ui/UiIcon.vue";
import { TONE_BG, TONE_TEXT } from "./opsFormat";

/** Upstream account pool at a glance, linking to account management. */
const props = defineProps<{ fleet: OpsOverview["fleet"] }>();

const { t } = useI18n();

const tiles = computed<{ key: string; label: string; value: number; tone: Tone; icon: IconName }[]>(() => [
  { key: "active", label: t("security.ops.fleet.active"), value: props.fleet.active, tone: "success", icon: "check-circle" },
  { key: "cooldown", label: t("security.ops.fleet.cooldown"), value: props.fleet.cooldown, tone: "warning", icon: "clock" },
  { key: "paused", label: t("security.ops.fleet.paused"), value: props.fleet.paused, tone: "neutral", icon: "pause" },
  {
    key: "failed",
    label: t("security.ops.fleet.failedTests"),
    value: props.fleet.failedTests,
    tone: props.fleet.failedTests > 0 ? "danger" : "neutral",
    icon: "x-circle",
  },
]);

const segments = computed(() => {
  const total = Math.max(1, props.fleet.accounts);
  return tiles.value
    .filter((s) => s.key !== "failed" && s.value > 0)
    .map((s) => ({ ...s, width: `${(s.value / total) * 100}%` }));
});
</script>

<template>
  <UiCard icon="database" :title="t('security.ops.fleet.title')">
    <template #actions>
      <RouterLink to="/admin/accounts" class="btn btn-ghost btn-xs">
        {{ t("security.ops.fleet.manage") }}
        <UiIcon name="arrow-right" :size="12" />
      </RouterLink>
    </template>
    <div class="flex items-baseline gap-2">
      <span class="text-[26px] font-semibold leading-8 tracking-tight text-fg">{{ formatCompact(fleet.accounts) }}</span>
      <span class="text-xs text-fg-subtle">{{ t("security.ops.fleet.total") }}</span>
    </div>
    <div class="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-2">
      <div
        v-for="s in segments"
        :key="s.key"
        class="h-full transition-[width] duration-700 ease-out"
        :class="TONE_BG[s.tone]"
        :style="{ width: s.width }"
        :title="`${s.label} · ${s.value}`"
      />
    </div>
    <div class="mt-4 grid grid-cols-2 gap-2">
      <RouterLink
        v-for="s in tiles"
        :key="s.key"
        to="/admin/accounts"
        class="group flex items-center gap-2.5 rounded-lg border border-line/70 px-3 py-2.5 transition-colors hover:border-line-strong hover:bg-surface-2/50"
      >
        <UiIcon :name="s.icon" :size="15" :class="TONE_TEXT[s.tone]" />
        <span class="min-w-0 flex-1 truncate text-xs text-fg-muted">{{ s.label }}</span>
        <span class="font-mono text-sm font-semibold tabular-nums" :class="s.value > 0 ? TONE_TEXT[s.tone] : 'text-fg-subtle'">
          {{ formatCompact(s.value) }}
        </span>
      </RouterLink>
    </div>
  </UiCard>
</template>
