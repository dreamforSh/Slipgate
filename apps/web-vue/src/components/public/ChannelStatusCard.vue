<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ChannelStatusItem } from "@slipgate/contracts";
import { formatCompact, formatDurationMs, formatRelative } from "../../lib/format";
import { platformShortLabel, platformStyle } from "../../lib/platformStyle";
import PlatformIcon from "../ui/PlatformIcon.vue";
import UiBadge from "../ui/UiBadge.vue";
import StatusTimeline from "./StatusTimeline.vue";
import { HEALTH_META, RATE_TEXT, formatRate, rateTone } from "./health";

/** One public channel (group): health badge, 24h figures and the 48-bucket timeline. */
const props = withDefaults(
  defineProps<{
    item: ChannelStatusItem;
    bucketMinutes: number;
    /** Clock for relative times (ticks in the parent). */
    now: number;
    stagger?: number;
  }>(),
  { stagger: 0 },
);

const { t } = useI18n();

const meta = computed(() => HEALTH_META[props.item.health]);
const lastRequest = computed(() =>
  props.item.lastRequestAtIso
    ? t("public.status.metric.lastRequest", { time: formatRelative(props.item.lastRequestAtIso, props.now) })
    : t("public.status.metric.never"),
);
const capacity = computed(() => (props.item.totalAccounts ? props.item.activeAccounts / props.item.totalAccounts : 0));
const capacityClass = computed(() =>
  props.item.activeAccounts === 0 ? "bg-danger/70" : capacity.value < 0.5 ? "bg-warning/80" : "bg-success/75",
);
</script>

<template>
  <article class="card card-hover flex min-w-0 flex-col p-5">
    <header class="flex items-start gap-3">
      <span class="icon-chip h-10 w-10 rounded-xl" :class="platformStyle(item.platform).badge">
        <PlatformIcon :platform="item.platform" :size="18" />
      </span>
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-sm font-semibold text-fg" :title="item.name">{{ item.name }}</h3>
        <p class="mt-0.5 truncate text-xs text-fg-subtle">{{ platformShortLabel(item.platform) }} · {{ lastRequest }}</p>
      </div>
      <UiBadge :tone="meta.tone" dot :pulse="item.health === 'operational'">
        {{ t(`public.status.health.${item.health}`) }}
      </UiBadge>
    </header>

    <dl class="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <div class="rounded-lg bg-surface-2/60 px-3 py-2.5 dark:bg-surface-2/40">
        <dt class="truncate text-2xs text-fg-subtle">{{ t("public.status.metric.successRate") }}</dt>
        <dd class="mt-1 text-base font-semibold tabular-nums" :class="RATE_TEXT[rateTone(item.successRate24h)]">
          {{ formatRate(item.successRate24h) }}
        </dd>
      </div>
      <div class="rounded-lg bg-surface-2/60 px-3 py-2.5 dark:bg-surface-2/40">
        <dt class="truncate text-2xs text-fg-subtle">{{ t("public.status.metric.ttft") }}</dt>
        <dd class="mt-1 text-base font-semibold tabular-nums text-fg">
          {{ item.avgTtftMs24h > 0 ? formatDurationMs(item.avgTtftMs24h) : "—" }}
        </dd>
      </div>
      <div class="rounded-lg bg-surface-2/60 px-3 py-2.5 dark:bg-surface-2/40">
        <dt class="truncate text-2xs text-fg-subtle">{{ t("public.status.metric.requests") }}</dt>
        <dd class="mt-1 text-base font-semibold tabular-nums text-fg">{{ formatCompact(item.requests24h) }}</dd>
      </div>
      <div class="rounded-lg bg-surface-2/60 px-3 py-2.5 dark:bg-surface-2/40">
        <dt class="truncate text-2xs text-fg-subtle">{{ t("public.status.metric.accounts") }}</dt>
        <dd class="mt-1 text-base font-semibold tabular-nums text-fg">
          {{ item.activeAccounts }}<span class="text-xs font-normal text-fg-subtle"> / {{ item.totalAccounts }}</span>
        </dd>
        <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3/70" aria-hidden="true">
          <div class="h-full rounded-full transition-[width] duration-500" :class="capacityClass" :style="{ width: `${Math.round(capacity * 100)}%` }" />
        </div>
      </div>
    </dl>

    <StatusTimeline
      class="mt-5"
      :buckets="item.buckets"
      :bucket-minutes="bucketMinutes"
      :label="t('public.status.timeline.label', { name: item.name })"
      :stagger="stagger"
    />
  </article>
</template>
