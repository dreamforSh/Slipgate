<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "./UiIcon.vue";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    width?: "md" | "lg" | "xl";
  }>(),
  { width: "md" },
);

const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "close"): void }>();

const { t } = useI18n();
const panel = ref<HTMLElement | null>(null);

const widthClass = { md: "max-w-md", lg: "max-w-xl", xl: "max-w-3xl" };

function close() {
  emit("update:open", false);
  emit("close");
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") close();
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      document.addEventListener("keydown", onKeydown);
      document.body.style.overflow = "hidden";
      await nextTick();
      const first = panel.value?.querySelector<HTMLElement>("input, select, textarea, button:not([data-drawer-close])");
      first?.focus({ preventScroll: true });
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
      enter-active-class="transition-opacity duration-200 ease-out"
      leave-active-class="transition-opacity duration-150 ease-in"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="open" class="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" aria-hidden="true" @click="close" />
    </Transition>
    <Transition
      enter-active-class="transition-transform duration-300 ease-out"
      leave-active-class="transition-transform duration-200 ease-in"
      enter-from-class="translate-x-full"
      leave-to-class="translate-x-full"
    >
      <aside
        v-if="open"
        ref="panel"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        class="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface shadow-pop"
        :class="widthClass[width]"
      >
        <header class="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-fg">{{ title }}</h2>
          </div>
          <button
            type="button"
            data-drawer-close
            class="btn btn-ghost btn-icon btn-sm -mr-1.5"
            :aria-label="t('common.close')"
            @click="close"
          >
            <UiIcon name="x" :size="16" />
          </button>
        </header>
        <div class="flex-1 overflow-y-auto px-5 py-5">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-line bg-surface-2/40 px-5 py-3">
          <slot name="footer" />
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
