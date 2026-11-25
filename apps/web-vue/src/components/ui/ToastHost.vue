<script setup lang="ts">
import { ref } from "vue";
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
const tone: Record<ToastTone, { icon: string; chip: string; bar: string }> = {
  success: { icon: "text-success", chip: "bg-success/10 ring-success/20", bar: "bg-success" },
  danger: { icon: "text-danger", chip: "bg-danger/10 ring-danger/20", bar: "bg-danger" },
  info: { icon: "text-accent", chip: "bg-accent/10 ring-accent/20", bar: "bg-accent" },
  warning: { icon: "text-warning", chip: "bg-warning/10 ring-warning/25", bar: "bg-warning" },
};

/** Toasts under the pointer keep their countdown paused (CSS bar + store timer together). */
const hovered = ref<number | null>(null);
function enter(id: number) {
  hovered.value = id;
  toast.pause(id);
}
function leave(id: number) {
  if (hovered.value === id) hovered.value = null;
  toast.resume(id);
}
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center p-4 sm:inset-x-auto sm:right-0 sm:items-end"
      aria-live="polite"
    >
      <TransitionGroup name="toast">
        <!-- Grid wrapper collapses its row on leave so the stack closes up smoothly. -->
        <div v-for="item in toast.items" :key="item.id" class="toast-slot grid w-full max-w-sm sm:w-auto">
          <div class="toast-clip min-h-0">
            <div
              class="toast pointer-events-auto relative flex min-w-0 items-start gap-3 overflow-hidden rounded-xl border border-line bg-surface/95 py-3 pl-3 pr-3.5 text-sm shadow-pop backdrop-blur-xl sm:w-[360px]"
              role="status"
              @mouseenter="enter(item.id)"
              @mouseleave="leave(item.id)"
              @focusin="enter(item.id)"
              @focusout="leave(item.id)"
            >
              <span class="toast-icon inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset" :class="tone[item.tone].chip">
                <UiIcon :name="icon[item.tone]" :size="16" :class="tone[item.tone].icon" />
              </span>
              <p class="min-w-0 flex-1 break-words pt-[3px] leading-relaxed text-fg">{{ item.message }}</p>
              <button
                type="button"
                class="-mr-1 mt-0.5 rounded-md p-1 text-fg-subtle transition-[color,background-color,transform] duration-150 hover:rotate-90 hover:bg-surface-2 hover:text-fg"
                :aria-label="t('common.dismiss')"
                @click="toast.dismiss(item.id)"
              >
                <UiIcon name="x" :size="14" />
              </button>
              <span
                class="toast-progress absolute inset-x-0 bottom-0 h-0.5 origin-left opacity-60"
                :class="tone[item.tone].bar"
                :style="{ animationDuration: `${item.duration}ms`, animationPlayState: hovered === item.id ? 'paused' : 'running' }"
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-slot {
  grid-template-rows: 1fr;
  padding-bottom: 0.5rem;
}
.toast-progress {
  animation-name: toast-countdown;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
.toast-icon {
  animation: pop-in 420ms var(--ease-spring) 80ms backwards;
}

.toast-enter-active {
  transition:
    opacity 200ms ease-out,
    transform 460ms var(--ease-spring-soft);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(28px) scale(0.96);
}
.toast-leave-active {
  transition:
    opacity 160ms var(--ease-in),
    transform 200ms var(--ease-in),
    grid-template-rows 240ms var(--ease-standard) 80ms,
    padding-bottom 240ms var(--ease-standard) 80ms;
}
.toast-leave-active > .toast-clip {
  overflow: hidden;
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(28px) scale(0.96);
  grid-template-rows: 0fr;
  padding-bottom: 0;
}
@media (max-width: 639px) {
  .toast-enter-from,
  .toast-leave-to {
    transform: translateY(-16px) scale(0.96);
  }
}

@keyframes toast-countdown {
  from {
    transform: scaleX(1);
  }
  to {
    transform: scaleX(0);
  }
}
@keyframes pop-in {
  0% {
    opacity: 0;
    transform: scale(0.5);
  }
  60% {
    opacity: 1;
    transform: scale(1.1);
  }
}
</style>
