<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { lockBodyScroll, unlockBodyScroll } from "../../lib/scrollLock";
import UiIcon from "./UiIcon.vue";

/**
 * Centered dialog (a bottom sheet on phones). Escape and the backdrop close it unless
 * `persistent`, in which case the panel gives a short shake instead.
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    width?: "sm" | "md" | "lg" | "xl";
    persistent?: boolean;
  }>(),
  { width: "md", persistent: false },
);
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "close"): void }>();

const { t } = useI18n();
const panel = ref<HTMLElement | null>(null);
const widthClass = { sm: "sm:max-w-sm", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-4xl" };

/** Matches the longest panel transition in style.css (`.modal-*`). */
const DURATION = { enter: 420, leave: 180 };

const shaking = ref(false);
let locked = false;

function close() {
  emit("update:open", false);
  emit("close");
}

/** A dismiss attempt on a persistent dialog: nudge the panel so the refusal is visible. */
function refuse() {
  shaking.value = false;
  void nextTick(() => {
    shaking.value = true;
  });
}

function dismiss() {
  if (props.persistent) refuse();
  else close();
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") dismiss();
}

function setLocked(next: boolean) {
  if (next === locked) return;
  locked = next;
  if (next) lockBodyScroll();
  else unlockBodyScroll();
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      document.addEventListener("keydown", onKeydown);
      setLocked(true);
      await nextTick();
      // An explicit [autofocus] wins even when it comes later in the DOM (e.g. a footer confirm
      // button after Cancel); a selector list alone would pick the first match in document order.
      const target =
        panel.value?.querySelector<HTMLElement>("[autofocus]") ??
        panel.value?.querySelector<HTMLElement>("input, select, textarea, button:not([data-modal-close])");
      target?.focus({ preventScroll: true });
    } else {
      document.removeEventListener("keydown", onKeydown);
      setLocked(false);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  setLocked(false);
});
</script>

<template>
  <Teleport to="body">
    <Transition name="modal" :duration="DURATION">
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-6"
        @mousedown.self="dismiss"
      >
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          class="modal-panel relative flex max-h-[92vh] w-full flex-col rounded-t-2xl border border-b-0 border-line bg-surface shadow-pop sm:rounded-2xl sm:border-b"
          :class="[widthClass[width], { 'animate-shake': shaking }]"
          @animationend="shaking = false"
        >
          <!-- Grab handle hints that the sheet belongs to the bottom edge on phones. -->
          <span class="absolute left-1/2 top-1.5 h-1 w-10 -translate-x-1/2 rounded-full bg-line-strong/80 sm:hidden" aria-hidden="true" />
          <header class="flex items-center justify-between gap-4 border-b border-line/70 px-5 py-4">
            <div class="flex min-w-0 items-center gap-3">
              <slot name="icon" />
              <h2 class="truncate text-base font-semibold text-fg">{{ title }}</h2>
            </div>
            <button
              type="button"
              data-modal-close
              class="btn btn-ghost btn-icon btn-sm group -mr-1.5"
              :aria-label="t('common.close')"
              @click="close"
            >
              <UiIcon name="x" :size="16" class="transition-transform duration-200 ease-out group-hover:rotate-90" />
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
            <slot />
          </div>
          <footer
            v-if="$slots.footer"
            class="flex items-center justify-end gap-2 border-t border-line/70 bg-surface-2/40 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-b-2xl sm:pb-3"
          >
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
