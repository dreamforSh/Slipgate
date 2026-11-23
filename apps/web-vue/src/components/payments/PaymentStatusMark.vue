<script setup lang="ts">
import { computed } from "vue";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";

/**
 * Hero illustration for the payment result page:
 * - `pending` / `manual`: breathing rings around a spinning arc,
 * - `success`: the ring and tick draw themselves, then a small burst,
 * - `closed` / `failed`: a calm scale-in.
 * Everything collapses to the final static frame under prefers-reduced-motion.
 */
const props = defineProps<{ state: "pending" | "manual" | "success" | "closed" | "failed"; icon?: IconName }>();

const tone = computed(() => {
  switch (props.state) {
    case "success":
      return "text-success";
    case "failed":
      return "text-danger";
    case "manual":
      return "text-warning";
    case "closed":
      return "text-fg-subtle";
    default:
      return "text-accent";
  }
});

const sparks = [
  { a: "0deg", c: "var(--success)" },
  { a: "45deg", c: "var(--accent-glow)" },
  { a: "90deg", c: "var(--warning)" },
  { a: "135deg", c: "var(--info)" },
  { a: "180deg", c: "var(--success)" },
  { a: "225deg", c: "var(--accent-glow)" },
  { a: "270deg", c: "var(--warning)" },
  { a: "315deg", c: "var(--info)" },
];
</script>

<template>
  <div class="mark relative mx-auto h-24 w-24" :class="tone" aria-hidden="true">
    <!-- Waiting -->
    <template v-if="state === 'pending' || state === 'manual'">
      <span class="breathe absolute inset-0 rounded-full bg-current opacity-10" />
      <span class="breathe breathe-late absolute inset-0 rounded-full bg-current opacity-10" />
      <svg viewBox="0 0 96 96" class="relative h-24 w-24">
        <circle cx="48" cy="48" r="38" fill="none" stroke="currentColor" stroke-opacity="0.15" stroke-width="5" />
        <circle
          class="orbit"
          cx="48"
          cy="48"
          r="38"
          fill="none"
          stroke="currentColor"
          stroke-width="5"
          stroke-linecap="round"
          pathLength="100"
          stroke-dasharray="22 78"
        />
      </svg>
      <span class="absolute inset-0 flex items-center justify-center">
        <UiIcon :name="icon ?? (state === 'manual' ? 'clock' : 'credit-card')" :size="28" :stroke-width="1.7" />
      </span>
    </template>

    <!-- Paid -->
    <template v-else-if="state === 'success'">
      <span class="ping absolute inset-0 rounded-full bg-current opacity-0" />
      <span v-for="(s, i) in sparks" :key="i" class="spark" :style="{ '--a': s.a, '--c': s.c }" />
      <svg viewBox="0 0 96 96" class="relative h-24 w-24">
        <circle cx="48" cy="48" r="40" fill="currentColor" fill-opacity="0.1" />
        <circle
          class="draw-ring"
          cx="48"
          cy="48"
          r="40"
          fill="none"
          stroke="currentColor"
          stroke-width="5"
          stroke-linecap="round"
          pathLength="1"
        />
        <path
          class="draw-tick"
          d="M31 49.5 43 61l23-24"
          fill="none"
          stroke="currentColor"
          stroke-width="6"
          stroke-linecap="round"
          stroke-linejoin="round"
          pathLength="1"
        />
      </svg>
    </template>

    <!-- Closed / failed -->
    <template v-else>
      <span class="pop absolute inset-0 flex items-center justify-center rounded-full">
        <span class="absolute inset-0 rounded-full bg-current opacity-10" />
        <UiIcon :name="icon ?? (state === 'failed' ? 'x-circle' : 'clock')" :size="40" :stroke-width="1.6" />
      </span>
    </template>
  </div>
</template>

<style scoped>
.breathe {
  animation: breathe 2.4s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
.breathe-late {
  animation-delay: 1.2s;
}
@keyframes breathe {
  0% {
    transform: scale(0.85);
    opacity: 0.18;
  }
  100% {
    transform: scale(1.55);
    opacity: 0;
  }
}

.orbit {
  transform-origin: 48px 48px;
  animation: orbit 1.4s linear infinite;
}
@keyframes orbit {
  to {
    transform: rotate(360deg);
  }
}

.draw-ring {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  transform: rotate(-90deg);
  transform-origin: 48px 48px;
  animation: draw 0.6s cubic-bezier(0.65, 0, 0.35, 1) forwards;
}
.draw-tick {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: draw 0.38s 0.5s cubic-bezier(0.65, 0, 0.35, 1) forwards;
}
@keyframes draw {
  to {
    stroke-dashoffset: 0;
  }
}

.ping {
  animation: ping 1s 0.55s ease-out both;
}
@keyframes ping {
  from {
    transform: scale(0.9);
    opacity: 0.25;
  }
  to {
    transform: scale(1.7);
    opacity: 0;
  }
}

.spark {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 7px;
  height: 7px;
  margin: -3.5px;
  border-radius: 999px;
  background: rgb(var(--c));
  opacity: 0;
  animation: spark 0.75s 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes spark {
  0% {
    opacity: 1;
    transform: rotate(var(--a)) translateY(-34px) scale(1);
  }
  100% {
    opacity: 0;
    transform: rotate(var(--a)) translateY(-66px) scale(0.3);
  }
}

.pop {
  animation: pop 0.35s cubic-bezier(0.16, 1, 0.3, 1) both;
}
@keyframes pop {
  from {
    transform: scale(0.6);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .breathe,
  .orbit,
  .ping,
  .spark,
  .pop {
    animation: none;
  }
  .spark,
  .ping {
    display: none;
  }
  .draw-ring,
  .draw-tick {
    animation: none;
    stroke-dashoffset: 0;
  }
}
</style>
