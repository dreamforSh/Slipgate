<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "./UiIcon.vue";

/** Centered dialog (Linksyncx-style modal). Escape and the backdrop close it unless `persistent`. */
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
const widthClass = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };

function close() {
  emit("update:open", false);
  emit("close");
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape" && !props.persistent) close();
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      document.addEventListener("keydown", onKeydown);
      document.body.style.overflow = "hidden";
      await nextTick();
      panel.value
        ?.querySelector<HTMLElement>("[autofocus], input, select, textarea, button:not([data-modal-close])")
        ?.focus({ preventScroll: true });
    } else {
      document.removeEventListener("keydown", onKeydown);
      document.body.style.overflow = "";
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  document.body.style.overflow = "";
});
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      leave-active-class="transition duration-150 ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm sm:p-6"
        @mousedown.self="!persistent && close()"
      >
        <div
          ref="panel"
          role="dialog"
          aria-modal="true"
          :aria-label="title"
          class="flex max-h-[92vh] w-full animate-scale-in flex-col rounded-2xl border border-line bg-surface shadow-pop"
          :class="widthClass[width]"
        >
          <header class="flex items-center justify-between gap-4 border-b border-line/70 px-5 py-4">
            <div class="flex min-w-0 items-center gap-3">
              <slot name="icon" />
              <h2 class="truncate text-base font-semibold text-fg">{{ title }}</h2>
            </div>
            <button
              type="button"
              data-modal-close
              class="btn btn-ghost btn-icon btn-sm -mr-1.5"
              :aria-label="t('common.close')"
              @click="close"
            >
              <UiIcon name="x" :size="16" />
            </button>
          </header>
          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <slot />
          </div>
          <footer
            v-if="$slots.footer"
            class="flex items-center justify-end gap-2 rounded-b-2xl border-t border-line/70 bg-surface-2/40 px-5 py-3"
          >
            <slot name="footer" />
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
