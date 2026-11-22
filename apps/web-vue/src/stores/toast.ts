import { defineStore } from "pinia";
import { ref } from "vue";

export type ToastTone = "success" | "danger" | "info" | "warning";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

let seq = 0;

export const useToastStore = defineStore("toast", () => {
  const items = ref<ToastItem[]>([]);

  function dismiss(id: number) {
    items.value = items.value.filter((t) => t.id !== id);
  }

  function push(tone: ToastTone, message: string, timeoutMs = tone === "danger" ? 7000 : 3800) {
    const id = ++seq;
    items.value = [...items.value.slice(-3), { id, tone, message }];
    window.setTimeout(() => dismiss(id), timeoutMs);
    return id;
  }

  return {
    items,
    dismiss,
    push,
    success: (m: string) => push("success", m),
    error: (m: string) => push("danger", m),
    info: (m: string) => push("info", m),
    warning: (m: string) => push("warning", m),
  };
});
