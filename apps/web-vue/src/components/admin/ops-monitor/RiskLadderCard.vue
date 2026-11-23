<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { RiskBanEvent } from "@slipgate/contracts";
import type { Tone } from "../../../lib/format";
import UiCard from "../../ui/UiCard.vue";
import UiIcon, { type IconName } from "../../ui/UiIcon.vue";

/** Explains the escalating ban ladder (10m → 24h → permanent) with live counts per rung. */
withDefaults(
  defineProps<{
    counts: Record<RiskBanEvent["banDuration"], number>;
    exemptUpstream400?: boolean;
  }>(),
  { exemptUpstream400: true },
);

const { t } = useI18n();

const steps = computed<{ key: RiskBanEvent["banDuration"]; strike: number; tone: Tone; icon: IconName }[]>(() => [
  { key: "10m", strike: 1, tone: "info", icon: "clock" },
  { key: "24h", strike: 2, tone: "warning", icon: "calendar" },
  { key: "permanent", strike: 3, tone: "danger", icon: "lock" },
]);

const toneBox: Record<string, string> = {
  info: "border-info/25 bg-info/[0.05]",
  warning: "border-warning/30 bg-warning/[0.06]",
  danger: "border-danger/25 bg-danger/[0.05]",
};
const toneChip: Record<string, string> = {
  info: "icon-chip-info",
  warning: "icon-chip-warning",
  danger: "icon-chip-danger",
};
const toneText: Record<string, string> = { info: "text-info", warning: "text-warning", danger: "text-danger" };
</script>

<template>
  <UiCard icon="shield-alert" :title="t('security.risk.ladder.title')">
    <p class="text-sm text-fg-muted">{{ t("security.risk.ladder.desc") }}</p>

    <ol class="mt-4 flex flex-col gap-2 md:flex-row md:items-stretch">
      <template v-for="(s, i) in steps" :key="s.key">
        <li class="flex min-w-0 flex-1 items-center gap-3 rounded-xl border p-3.5" :class="toneBox[s.tone]">
          <span class="icon-chip h-9 w-9" :class="toneChip[s.tone]">
            <UiIcon :name="s.icon" :size="17" />
          </span>
          <div class="min-w-0 flex-1">
            <p class="text-2xs font-medium uppercase tracking-wider text-fg-subtle">{{ t("security.risk.strike", { n: s.strike }) }}</p>
            <p class="mt-0.5 text-sm font-semibold" :class="toneText[s.tone]">{{ t(`security.risk.durations.${s.key}`) }}</p>
          </div>
          <span class="font-mono text-lg font-semibold tabular-nums text-fg" :title="t('security.risk.ladder.count')">
            {{ counts[s.key] ?? 0 }}
          </span>
        </li>
        <li v-if="i < steps.length - 1" class="flex items-center justify-center text-fg-subtle" aria-hidden="true">
          <UiIcon name="arrow-right" :size="16" class="rotate-90 md:rotate-0" />
        </li>
      </template>
    </ol>

    <ul class="mt-4 space-y-1.5 text-xs text-fg-subtle">
      <li class="flex items-start gap-1.5">
        <UiIcon name="info" :size="12" class="mt-0.5 shrink-0" />
        {{ t("security.risk.ladder.escalate") }}
      </li>
      <li v-if="exemptUpstream400" class="flex items-start gap-1.5">
        <UiIcon name="check-circle" :size="12" class="mt-0.5 shrink-0 text-success" />
        {{ t("security.risk.ladder.exempt") }}
      </li>
      <li class="flex items-start gap-1.5">
        <UiIcon name="arrow-down" :size="12" class="mt-0.5 shrink-0" />
        {{ t("security.risk.ladder.downgraded") }}
      </li>
    </ul>
  </UiCard>
</template>
