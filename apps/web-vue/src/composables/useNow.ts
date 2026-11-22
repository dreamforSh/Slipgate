import { onBeforeUnmount, ref } from "vue";

/** A clock ref that ticks every `intervalMs`, for relative times and deadline checks. */
export function useNow(intervalMs = 30_000) {
  const now = ref(Date.now());
  const timer = window.setInterval(() => (now.value = Date.now()), intervalMs);
  onBeforeUnmount(() => window.clearInterval(timer));
  return now;
}
