<script setup lang="ts">
import { useToastStore, type ToastTone } from "../../stores/toast";
import UiIcon, { type IconName } from "./UiIcon.vue";

const toast = useToastStore();

const icon: Record<ToastTone, IconName> = {
  success: "check-circle",
  danger: "x-circle",
  info: "info",
  warning: "alert",
};
const tone: Record<ToastTone, string> = {
  success: "text-success",
  danger: "text-danger",
  info: "text-info",
  warning: "text-warning",
};
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
      aria-live="polite"
    >
      <TransitionGroup
        enter-active-class="transition duration-200 ease-out"
        leave-active-class="transition duration-150 ease-in"
        enter-from-class="translate-y-2 opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-for="t in toast.items"
          :key="t.id"
          class="pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border border-line bg-surface px-3.5 py-3 text-sm shadow-pop"
          role="status"
        >
          <UiIcon :name="icon[t.tone]" :size="16" class="mt-0.5" :class="tone[t.tone]" />
          <p class="min-w-0 flex-1 break-words text-fg">{{ t.message }}</p>
          <button
            type="button"
            class="-mr-1 -mt-0.5 rounded p-0.5 text-fg-subtle transition-colors hover:text-fg"
            aria-label="关闭通知"
            @click="toast.dismiss(t.id)"
          >
            <UiIcon name="x" :size="14" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
