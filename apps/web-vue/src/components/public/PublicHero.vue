<script setup lang="ts">
import UiIcon, { type IconName } from "../ui/UiIcon.vue";

/** Page heading for public sub-pages: icon tile, eyebrow, title, lead text and an actions slot. */
withDefaults(
  defineProps<{
    icon: IconName;
    title: string;
    eyebrow?: string;
    subtitle?: string;
    centered?: boolean;
  }>(),
  { centered: false },
);
</script>

<template>
  <section class="relative mx-auto w-full max-w-6xl px-4 pb-6 pt-10 sm:px-6 sm:pt-14">
    <div
      class="flex flex-col gap-6"
      :class="centered ? 'items-center text-center' : 'lg:flex-row lg:items-end lg:justify-between'"
    >
      <div class="hero-in min-w-0" :class="centered ? 'flex flex-col items-center' : ''">
        <span class="hero-tile relative inline-flex h-12 w-12 items-center justify-center rounded-2xl text-accent">
          <UiIcon :name="icon" :size="22" :stroke-width="1.7" />
        </span>
        <p v-if="eyebrow" class="mt-5 text-xs font-semibold uppercase tracking-[0.14em] text-accent">{{ eyebrow }}</p>
        <h1 class="mt-2 text-3xl font-bold tracking-tight text-fg sm:text-4xl">{{ title }}</h1>
        <p v-if="subtitle" class="mt-3 max-w-2xl text-sm leading-relaxed text-fg-muted sm:text-base">{{ subtitle }}</p>
        <slot />
      </div>
      <div v-if="$slots.actions" class="hero-in hero-in-late flex flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.hero-tile {
  background:
    linear-gradient(140deg, rgb(var(--accent) / 0.16), rgb(var(--accent-glow) / 0.04)),
    rgb(var(--surface));
  box-shadow:
    inset 0 0 0 1px rgb(var(--accent) / 0.22),
    0 10px 30px -12px rgb(var(--accent-glow) / 0.55);
}
.hero-in {
  animation: hero-in 600ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.hero-in-late {
  animation-delay: 120ms;
}
@keyframes hero-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (prefers-reduced-motion: reduce) {
  .hero-in {
    animation: none;
  }
}
</style>
