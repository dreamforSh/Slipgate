<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { UserSubscriptionItem } from "@slipgate/contracts";
import { formatDateShort, formatDateTime, formatUsd, type Tone } from "../../lib/format";
import UiAlert from "../ui/UiAlert.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiIcon from "../ui/UiIcon.vue";

/** One group subscription: status, time left and a meter per capped spend window. */
const props = withDefaults(
  defineProps<{
    item: UserSubscriptionItem;
    now: number;
    /** Wait before the meters grow, so they fill once the card has faded in. */
    growDelayMs?: number;
  }>(),
  { growDelayMs: 0 },
);
const { t } = useI18n();

const DAY_MS = 86_400_000;

const WINDOWS = [
  { key: "daily", limit: "dailyLimitNanoUsd", used: "dailyNanoUsd" },
  { key: "weekly", limit: "weeklyLimitNanoUsd", used: "weeklyNanoUsd" },
  { key: "monthly", limit: "monthlyLimitNanoUsd", used: "monthlyNanoUsd" },
] as const;

// Bars start empty and grow to their value once mounted.
const grown = ref(false);
let growTimer: number | undefined;
onMounted(() => {
  growTimer = window.setTimeout(() => requestAnimationFrame(() => (grown.value = true)), props.growDelayMs);
});
onBeforeUnmount(() => window.clearTimeout(growTimer));

const msLeft = computed(() => Date.parse(props.item.expiresAtIso) - props.now);
const state = computed<"active" | "limited" | "expired" | "revoked">(() => {
  if (props.item.status === "revoked") return "revoked";
  if (props.item.status === "expired" || msLeft.value <= 0) return "expired";
  return props.item.overLimit ? "limited" : "active";
});
const isLive = computed(() => state.value === "active" || state.value === "limited");

const statusBadge = computed<{ tone: Tone; label: string; pulse: boolean }>(() => {
  switch (state.value) {
    case "limited":
      return { tone: "warning", label: t("mySubs.status.limited"), pulse: false };
    case "expired":
      return { tone: "danger", label: t("mySubs.status.expired"), pulse: false };
    case "revoked":
      return { tone: "neutral", label: t("mySubs.status.revoked"), pulse: false };
    default:
      return { tone: "success", label: t("mySubs.status.active"), pulse: true };
  }
});

const expiry = computed<{ text: string; cls: string }>(() => {
  if (state.value === "revoked") return { text: t("mySubs.expiry.revoked"), cls: "text-fg-subtle" };
  if (state.value === "expired") return { text: t("mySubs.expiry.expired"), cls: "text-danger" };
  const ms = msLeft.value;
  const days = Math.ceil(ms / DAY_MS);
  const text = ms < DAY_MS ? t("mySubs.expiry.hoursLeft", { n: Math.max(1, Math.ceil(ms / 3_600_000)) }) : t("mySubs.expiry.daysLeft", { n: days });
  const cls = days <= 3 ? "text-danger" : days <= 7 ? "text-warning" : "text-fg";
  return { text, cls };
});

const windows = computed(() =>
  WINDOWS.flatMap((w) => {
    const limit = BigInt(props.item.limits[w.limit] || "0");
    if (limit <= 0n) return [];
    const usedNano = props.item.usage[w.used] || "0";
    const used = BigInt(usedNano);
    const pct = Number((used * 10_000n) / limit) / 100;
    const tone = pct >= 90 ? "danger" : pct >= 70 ? "warning" : "success";
    return [
      {
        key: w.key,
        label: t(`mySubs.window.${w.key}`),
        used: formatUsd(usedNano),
        limit: formatUsd(props.item.limits[w.limit]),
        pct,
        width: pct <= 0 ? 0 : Math.max(2, Math.min(100, pct)),
        bar: { success: "bg-success", warning: "bg-warning", danger: "bg-danger" }[tone],
        text: { success: "text-fg-subtle", warning: "text-warning", danger: "text-danger" }[tone],
      },
    ];
  }),
);
</script>

<template>
  <article
    class="card card-hover flex min-w-0 flex-col p-5"
    :class="isLive ? '' : 'bg-surface-2/30 dark:bg-surface/50'"
  >
    <header class="flex items-start justify-between gap-3">
      <div class="flex min-w-0 items-center gap-3">
        <span class="icon-chip h-10 w-10 rounded-xl" :class="isLive ? 'icon-chip-warning' : ''">
          <UiIcon name="crown" :size="18" />
        </span>
        <div class="min-w-0">
          <h3 class="truncate text-sm font-semibold text-fg" :title="item.groupName">{{ item.groupName }}</h3>
          <p class="mt-0.5 truncate text-2xs text-fg-subtle">{{ t("mySubs.since", { date: formatDateShort(item.startsAtIso) }) }}</p>
        </div>
      </div>
      <UiBadge :tone="statusBadge.tone" dot :pulse="statusBadge.pulse">{{ statusBadge.label }}</UiBadge>
    </header>

    <div class="mt-4 flex items-center justify-between gap-3 rounded-lg bg-surface-2/60 px-3 py-2 text-xs">
      <span class="flex min-w-0 items-center gap-1.5 text-fg-subtle">
        <UiIcon name="calendar" :size="13" />
        <span class="truncate">{{ t("mySubs.expiresOn", { date: formatDateShort(item.expiresAtIso) }) }}</span>
      </span>
      <span class="shrink-0 font-medium tabular-nums" :class="expiry.cls">{{ expiry.text }}</span>
    </div>

    <div class="mt-4 flex-1 space-y-3.5">
      <template v-if="windows.length">
        <div v-for="w in windows" :key="w.key">
          <div class="flex items-baseline justify-between gap-2 text-xs">
            <span class="text-fg-muted">{{ w.label }}</span>
            <span class="font-mono tabular-nums">
              <span class="font-medium text-fg">{{ w.used }}</span>
              <span class="text-fg-subtle"> / {{ w.limit }}</span>
            </span>
          </div>
          <div
            class="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            :aria-label="w.label"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="Math.round(Math.min(100, w.pct))"
          >
            <div
              class="h-full rounded-full transition-[width,background-color] duration-700 ease-out"
              :class="w.bar"
              :style="{ width: grown ? `${w.width}%` : '0%' }"
            />
          </div>
          <p class="mt-1 text-right text-2xs tabular-nums" :class="w.text">{{ w.pct.toFixed(1) }}%</p>
        </div>
      </template>
      <div
        v-else
        class="flex items-center gap-3 rounded-lg border border-dashed border-line px-3 py-3"
      >
        <span class="text-2xl leading-none text-success" aria-hidden="true">∞</span>
        <div class="min-w-0">
          <p class="text-sm font-medium text-fg">{{ t("mySubs.unlimited") }}</p>
          <p class="text-2xs text-fg-subtle">{{ t("mySubs.unlimitedHint") }}</p>
        </div>
      </div>
    </div>

    <UiAlert v-if="state === 'limited'" tone="warning" class="mt-4 !py-2.5 text-xs">
      {{ t("mySubs.overLimit") }}
    </UiAlert>

    <p v-if="item.usageResetAtIso" class="mt-3 flex items-center gap-1.5 text-2xs text-fg-subtle">
      <UiIcon name="rotate-ccw" :size="11" />
      {{ t("mySubs.resetNote", { time: formatDateTime(item.usageResetAtIso) }) }}
    </p>
  </article>
</template>
