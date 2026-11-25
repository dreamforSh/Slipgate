<script setup lang="ts">
import { computed } from "vue";
import type { Tone } from "../../lib/format";
import AnimatedNumber from "./AnimatedNumber.vue";
import UiIcon, { type IconName } from "./UiIcon.vue";

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    hint?: string;
    icon?: IconName;
    tone?: Tone;
    /** Tabular digits (only for values that must align with neighbours). */
    mono?: boolean;
    /** Relative change vs a reference period, e.g. 0.12 = +12%. `null` hides the chip. */
    delta?: number | null;
    /** Accessible/visible name of the reference period, e.g. "较昨日". */
    deltaLabel?: string;
    /** Whether an increase is good news (drives the chip color). */
    upIsGood?: boolean;
  }>(),
  { tone: "neutral", mono: false, delta: null, upIsGood: true },
);

const iconTone: Record<Tone, string> = {
  neutral: "",
  accent: "icon-chip-accent",
  success: "icon-chip-success",
  warning: "icon-chip-warning",
  danger: "icon-chip-danger",
  info: "icon-chip-info",
  violet: "icon-chip-violet",
};

/** Corner wash on hover, tinted like the icon chip. */
const glowTone: Record<Tone, string> = {
  neutral: "from-fg-subtle/[0.07]",
  accent: "from-accent/[0.09]",
  success: "from-success/[0.09]",
  warning: "from-warning/[0.09]",
  danger: "from-danger/[0.09]",
  info: "from-info/[0.09]",
  violet: "from-violet/[0.09]",
};

const deltaChip = computed(() => {
  const d = props.delta;
  if (d === null || d === undefined || !Number.isFinite(d)) return null;
  const pct = Math.abs(d) * 100;
  const text = `${pct >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`;
  if (Math.abs(d) < 0.0005) return { text: "0%", arrow: "", cls: "bg-surface-2 text-fg-muted" };
  const up = d > 0;
  const good = up === props.upIsGood;
  return {
    text,
    arrow: up ? "▲" : "▼",
    cls: good ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
  };
});
</script>

<template>
  <div class="card group relative flex min-w-0 flex-col overflow-hidden p-4 hover:border-line-strong/70">
    <span
      class="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-gradient-to-bl to-transparent opacity-0 blur-xl transition-opacity duration-500 group-hover:opacity-100"
      :class="glowTone[tone]"
      aria-hidden="true"
    />
    <div class="relative flex min-w-0 items-center gap-2.5">
      <span
        v-if="icon"
        class="icon-chip h-7 w-7 transition-transform duration-300 ease-spring group-hover:-rotate-6 group-hover:scale-110"
        :class="iconTone[tone]"
      >
        <UiIcon :name="icon" :size="15" />
      </span>
      <p class="truncate text-xs font-medium text-fg-subtle">{{ label }}</p>
    </div>
    <div class="relative mt-3 flex min-w-0 items-baseline gap-2">
      <p
        class="truncate text-[26px] font-semibold leading-8 tracking-tight text-fg"
        :class="mono ? 'tabular-nums' : ''"
      >
        <AnimatedNumber :value="value" />
      </p>
      <span
        v-if="deltaChip"
        class="inline-flex shrink-0 animate-pop-in items-center gap-0.5 rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums [animation-delay:350ms]"
        :class="deltaChip.cls"
        :title="deltaLabel"
      >
        <span v-if="deltaChip.arrow" aria-hidden="true">{{ deltaChip.arrow }}</span>
        {{ deltaChip.text }}
        <span v-if="deltaLabel" class="sr-only">{{ deltaLabel }}</span>
      </span>
    </div>
    <div v-if="hint || $slots.hint" class="relative mt-1 truncate text-xs text-fg-subtle">
      <slot name="hint">{{ hint }}</slot>
    </div>
    <slot name="footer" />
  </div>
</template>
