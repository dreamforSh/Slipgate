import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastTone = "success" | "danger" | "info" | "warning";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
  /** Total time on screen in ms (drives the countdown bar). */
  duration: number;
}

interface Timer {
  handle: number;
  deadline: number;
  remaining: number;
}

let seq = 0;

export const useToastStore = defineStore("toast", () => {
  const items = ref<ToastItem[]>([]);
  const timers = new Map<number, Timer>();

  function clearTimer(id: number) {
    const timer = timers.get(id);
    if (timer) window.clearTimeout(timer.handle);
    timers.delete(id);
  }

  function schedule(id: number, ms: number) {
    const handle = window.setTimeout(() => dismiss(id), ms);
    timers.set(id, { handle, deadline: Date.now() + ms, remaining: ms });
  }

  function dismiss(id: number) {
    clearTimer(id);
    items.value = items.value.filter((t) => t.id !== id);
  }

  /** Hovering a toast holds it on screen; leaving resumes the remaining time. */
  function pause(id: number) {
    const timer = timers.get(id);
    if (!timer || timer.handle === 0) return;
    window.clearTimeout(timer.handle);
    timer.remaining = Math.max(0, timer.deadline - Date.now());
    timer.handle = 0;
  }

  function resume(id: number) {
    const timer = timers.get(id);
    if (!timer || timer.handle !== 0) return;
    schedule(id, timer.remaining);
  }

  function push(tone: ToastTone, message: string, timeoutMs = tone === "danger" ? 7000 : 3800) {
    const id = ++seq;
    const kept = items.value.slice(-3);
    for (const dropped of items.value.slice(0, -3)) clearTimer(dropped.id);
    items.value = [...kept, { id, tone, message, duration: timeoutMs }];
    schedule(id, timeoutMs);
    return id;
  }

  return {
    items,
    dismiss,
    pause,
    resume,
    push,
    success: (m: string) => push("success", m),
    error: (m: string) => push("danger", m),
    info: (m: string) => push("info", m),
    warning: (m: string) => push("warning", m),
  };
});
