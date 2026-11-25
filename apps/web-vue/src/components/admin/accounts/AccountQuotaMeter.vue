<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { accountQuotaLimited, type AccountQuota } from "@slipgate/contracts";
import { formatRelative, formatUsd } from "../../../lib/format";

/** Spend-quota usage of one account, one thin bar per limit that is set; nothing without limits. */
const props = defineProps<{ quota: AccountQuota }>();

const { t } = useI18n();

const rows = computed(() => {
  const q = props.quota;
  if (!accountQuotaLimited(q)) return [];
  const all = [
    { key: "daily" as const, limit: q.dailyLimitNanoUsd, used: q.dailyUsedNanoUsd, over: q.state === "daily_exceeded" },
    { key: "weekly" as const, limit: q.weeklyLimitNanoUsd, used: q.weeklyUsedNanoUsd, over: q.state === "weekly_exceeded" },
    { key: "total" as const, limit: q.totalLimitNanoUsd, used: q.totalUsedNanoUsd, over: q.state === "total_exceeded" },
  ];
  return all
    .filter((r) => r.limit !== "0")
    .map((r) => {
      const limit = BigInt(r.limit);
      const used = BigInt(r.used);
      const pct = Number((used * 10000n) / limit) / 100;
      return { ...r, pct: Math.min(100, pct), full: used >= limit || r.over };
    });
});

const title = computed(() =>
  props.quota.resetAtIso ? t("accounts.quota.sinceReset", { time: formatRelative(props.quota.resetAtIso) }) : undefined,
);
</script>

<template>
  <div v-if="rows.length" class="space-y-1" :title="title">
    <div v-for="r in rows" :key="r.key" class="flex items-center gap-2 text-2xs">
      <span class="w-6 shrink-0 text-fg-subtle">{{ t(`accounts.quota.short.${r.key}`) }}</span>
      <span class="h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-surface-2">
        <span
          class="block h-full rounded-full"
          :class="r.full ? 'bg-danger' : r.pct >= 80 ? 'bg-warning' : 'bg-accent'"
          :style="{ width: `${r.pct}%` }"
        />
      </span>
      <span class="shrink-0 font-mono tabular-nums" :class="r.full ? 'text-danger' : 'text-fg-muted'">
        {{ formatUsd(r.used) }} / {{ formatUsd(r.limit) }}
      </span>
    </div>
  </div>
</template>
