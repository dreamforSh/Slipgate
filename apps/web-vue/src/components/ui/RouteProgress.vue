<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useRouter } from "vue-router";

/**
 * Thin accent bar across the top of the viewport while a navigation is pending (auth guards,
 * lazy route chunks). It only appears when a navigation takes longer than SHOW_DELAY_MS, so
 * instant page switches never flash it, then trickles toward 90% and completes on arrival.
 */
const SHOW_DELAY_MS = 120;

const router = useRouter();
const visible = ref(false);
const progress = ref(0);
let showTimer: number | undefined;
let trickleTimer: number | undefined;
let hideTimer: number | undefined;
let pending = false;

function clearTimers() {
  window.clearTimeout(showTimer);
  window.clearInterval(trickleTimer);
  window.clearTimeout(hideTimer);
}

function start() {
  if (pending) return;
  pending = true;
  clearTimers();
  showTimer = window.setTimeout(() => {
    progress.value = 0.08;
    visible.value = true;
    trickleTimer = window.setInterval(() => {
      // Ease toward (never reach) 90% so long loads still look alive.
      progress.value += (0.9 - progress.value) * 0.12;
    }, 180);
  }, SHOW_DELAY_MS);
}

function done() {
  if (!pending) return;
  pending = false;
  clearTimers();
  if (!visible.value) return;
  progress.value = 1;
  hideTimer = window.setTimeout(() => {
    visible.value = false;
    progress.value = 0;
  }, 260);
}

const removeBefore = router.beforeEach((to, from) => {
  // Query/hash-only updates on the same page are not page loads.
  if (to.path !== from.path) start();
});
const removeAfter = router.afterEach(() => done());
const removeError = router.onError(() => done());

onBeforeUnmount(() => {
  removeBefore();
  removeAfter();
  removeError();
  clearTimers();
});
</script>

<template>
  <div class="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5" aria-hidden="true">
    <div
      class="route-progress h-full origin-left bg-accent"
      :class="visible ? 'opacity-100' : 'opacity-0'"
      :style="{ transform: `scaleX(${progress})` }"
    />
  </div>
</template>

<style scoped>
.route-progress {
  box-shadow:
    0 0 10px rgb(var(--accent-glow) / 0.7),
    0 0 4px rgb(var(--accent-glow) / 0.5);
  transition:
    transform 240ms var(--ease-out),
    opacity 240ms ease 80ms;
}
</style>
