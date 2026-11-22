<script setup lang="ts">
import type { Tone } from "../../lib/format";

withDefaults(
  defineProps<{
    tone?: Tone;
    dot?: boolean;
    mono?: boolean;
    pulse?: boolean;
  }>(),
  { tone: "neutral", dot: false, mono: false, pulse: false },
);

// Soft fill + same-hue hairline ring: quieter than solid chips, with a crisp edge.
const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-muted ring-fg-subtle/20",
  accent: "bg-accent/10 text-accent ring-accent/20",
  success: "bg-success/10 text-success ring-success/20",
  warning: "bg-warning/10 text-warning ring-warning/25",
  danger: "bg-danger/10 text-danger ring-danger/20",
  info: "bg-info/10 text-info ring-info/20",
  violet: "bg-violet/10 text-violet ring-violet/20",
};

const dotClass: Record<Tone, string> = {
  neutral: "bg-fg-subtle",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  violet: "bg-violet",
};
</script>

<template>
  <span
    class="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ring-inset"
    :class="[toneClass[tone], mono ? 'font-mono' : '']"
  >
    <span v-if="dot" class="relative inline-flex h-1.5 w-1.5 shrink-0">
      <span
        v-if="pulse"
        class="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
        :class="dotClass[tone]"
      />
      <span class="relative inline-flex h-1.5 w-1.5 rounded-full" :class="dotClass[tone]" />
    </span>
    <span class="truncate"><slot /></span>
  </span>
</template>
