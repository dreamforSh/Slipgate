<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ChannelStatusBucket } from "@slipgate/contracts";
import { formatDurationMs, formatNumber } from "../../lib/format";
import { RATE_BAR, RATE_TEXT, formatRate, rateTone } from "./health";

/**
 * 24h uptime strip: one bar per bucket colored by its success rate (muted without traffic).
 * Hover a bar, or focus the strip and use ←/→, to see the interval's numbers.
 */
const props = withDefaults(
  defineProps<{
    buckets: ChannelStatusBucket[];
    bucketMinutes: number;
    label: string;
    /** Base delay (ms) for the grow-in animation, to stagger cards. */
    stagger?: number;
  }>(),
  { stagger: 0 },
);

const { t, locale } = useI18n();
const active = ref<number | null>(null);

const tip = computed(() => {
  const i = active.value;
  if (i === null) return null;
  const b = props.buckets[i];
  if (!b) return null;
  const start = new Date(b.startIso);
  const end = new Date(start.getTime() + props.bucketMinutes * 60_000);
  const time = (d: Date) => d.toLocaleTimeString(locale.value, { hour: "2-digit", minute: "2-digit" });
  const day = start.toLocaleDateString(locale.value, { month: "numeric", day: "numeric" });
  const pos = (i + 0.5) / props.buckets.length;
  const style: Record<string, string> =
    pos < 0.2 ? { left: "0px" } : pos > 0.8 ? { right: "0px" } : { left: `${pos * 100}%`, transform: "translateX(-50%)" };
  return {
    range: `${day} ${time(start)} – ${time(end)}`,
    bucket: b,
    tone: rateTone(b.successRate),
    style,
  };
});

function onKeydown(ev: KeyboardEvent) {
  const n = props.buckets.length;
  if (!n) return;
  if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
    ev.preventDefault();
    const step = ev.key === "ArrowRight" ? 1 : -1;
    const cur = active.value ?? (step > 0 ? -1 : n);
    active.value = Math.max(0, Math.min(n - 1, cur + step));
  } else if (ev.key === "Home") {
    ev.preventDefault();
    active.value = 0;
  } else if (ev.key === "End") {
    ev.preventDefault();
    active.value = n - 1;
  } else if (ev.key === "Escape") {
    active.value = null;
  }
}

function onFocus() {
  if (active.value === null && props.buckets.length) active.value = props.buckets.length - 1;
}
</script>

<template>
  <div class="relative">
    <div
      class="flex h-9 items-stretch gap-[2px] rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface sm:gap-[3px]"
      tabindex="0"
      role="group"
      :aria-label="label"
      @keydown="onKeydown"
      @focus="onFocus"
      @blur="active = null"
      @pointerleave="active = null"
    >
      <span
        v-for="(b, i) in buckets"
        :key="i"
        class="bar min-w-0 flex-1 origin-bottom rounded-[3px] transition-[transform,opacity,filter] duration-150"
        :class="[
          RATE_BAR[rateTone(b.successRate)],
          active === i ? 'scale-y-[1.14] brightness-110' : active !== null ? 'opacity-60' : '',
        ]"
        :style="{ animationDelay: `${stagger + i * 12}ms` }"
        @pointerenter="active = i"
      />
    </div>

    <Transition
      enter-active-class="transition duration-150 ease-out"
      enter-from-class="opacity-0 translate-y-1"
      leave-active-class="transition duration-100 ease-in"
      leave-to-class="opacity-0"
    >
      <div
        v-if="tip"
        class="pointer-events-none absolute bottom-full z-20 mb-2.5 w-max min-w-[10.5rem] max-w-[15rem] rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-pop backdrop-blur"
        :style="tip.style"
        role="status"
      >
        <p class="font-medium tabular-nums text-fg">{{ tip.range }}</p>
        <p v-if="tip.bucket.requests === 0" class="mt-1 text-fg-subtle">{{ t("public.status.timeline.noTraffic") }}</p>
        <dl v-else class="mt-1.5 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
          <dt class="text-fg-subtle">{{ t("public.status.timeline.requests") }}</dt>
          <dd class="text-right tabular-nums text-fg">{{ formatNumber(tip.bucket.requests) }}</dd>
          <dt class="text-fg-subtle">{{ t("public.status.timeline.errors") }}</dt>
          <dd class="text-right tabular-nums" :class="tip.bucket.errors ? 'text-danger' : 'text-fg'">{{ formatNumber(tip.bucket.errors) }}</dd>
          <dt class="text-fg-subtle">{{ t("public.status.timeline.successRate") }}</dt>
          <dd class="text-right font-semibold tabular-nums" :class="RATE_TEXT[tip.tone]">{{ formatRate(tip.bucket.successRate) }}</dd>
          <dt class="text-fg-subtle">{{ t("public.status.timeline.ttft") }}</dt>
          <dd class="text-right tabular-nums text-fg">{{ tip.bucket.avgTtftMs > 0 ? formatDurationMs(tip.bucket.avgTtftMs) : "—" }}</dd>
        </dl>
      </div>
    </Transition>

    <div class="mt-1.5 flex justify-between text-2xs text-fg-subtle" aria-hidden="true">
      <span>{{ t("public.status.timeline.start") }}</span>
      <span class="hidden sm:inline">{{ t("public.status.timeline.mid") }}</span>
      <span>{{ t("public.status.timeline.end") }}</span>
    </div>
  </div>
</template>

<style scoped>
.bar {
  animation: bar-grow 560ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
}
@keyframes bar-grow {
  from {
    opacity: 0;
    transform: scaleY(0.15);
  }
  to {
    opacity: 1;
    transform: scaleY(1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar {
    animation: none;
  }
}
</style>
