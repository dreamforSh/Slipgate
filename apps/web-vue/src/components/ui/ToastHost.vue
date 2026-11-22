<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useToastStore, type ToastTone } from "../../stores/toast";
import UiIcon, { type IconName } from "./UiIcon.vue";

const { t } = useI18n();
const toast = useToastStore();

const icon: Record<ToastTone, IconName> = {
  success: "check-circle",
  danger: "x-circle",
  info: "info",
  warning: "alert",
};
const tone: Record<ToastTone, { icon: string; edge: string }> = {
  success: { icon: "text-success", edge: "border-l-success" },
  danger: { icon: "text-danger", edge: "border-l-danger" },
  info: { icon: "text-accent", edge: "border-l-accent" },
  warning: { icon: "text-warning", edge: "border-l-warning" },
};
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end"
      aria-live="polite"
    >
      <TransitionGroup
        enter-active-class="transition duration-200 ease-out"
        leave-active-class="transition duration-150 ease-in"
        enter-from-class="translate-x-4 opacity-0"
        leave-to-class="translate-x-2 opacity-0"
      >
        <div
          v-for="item in toast.items"
          :key="item.id"
          class="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border border-l-4 border-line bg-surface px-4 py-3 text-sm shadow-pop sm:min-w-[320px]"
          :class="tone[item.tone].edge"
          role="status"
        >
          <UiIcon :name="icon[item.tone]" :size="18" class="mt-px" :class="tone[item.tone].icon" />
          <p class="min-w-0 flex-1 break-words leading-relaxed text-fg">{{ item.message }}</p>
          <button
            type="button"
            class="-mr-1 rounded-md p-0.5 text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg"
            :aria-label="t('common.dismiss')"
            @click="toast.dismiss(item.id)"
          >
            <UiIcon name="x" :size="14" />
          </button>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>
