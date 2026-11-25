<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { lockBodyScroll, unlockBodyScroll } from "../../lib/scrollLock";
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
const body = ref<HTMLElement | null>(null);
/** The header picks up a hairline shadow once the body scrolls under it. */
const scrolled = ref(false);

const widthClass = { md: "max-w-md", lg: "max-w-xl", xl: "max-w-3xl" };

/** Matches the drawer/body transitions in style.css (`.drawer-*`). */
const DURATION = { enter: 560, leave: 260 };

let locked = false;

function close() {
  emit("update:open", false);
  emit("close");
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") close();
}

function onScroll() {
  scrolled.value = (body.value?.scrollTop ?? 0) > 4;
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
      scrolled.value = false;
      await nextTick();
      const first = panel.value?.querySelector<HTMLElement>("input, select, textarea, button:not([data-drawer-close])");
      first?.focus({ preventScroll: true });
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
    <Transition name="fade">
      <div v-if="open" class="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" aria-hidden="true" @click="close" />
    </Transition>
    <Transition name="drawer" :duration="DURATION">
      <aside
        v-if="open"
        ref="panel"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        class="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-surface shadow-pop"
        :class="widthClass[width]"
      >
        <header
          class="relative z-10 flex items-start justify-between gap-4 border-b px-5 py-4 transition-[border-color,box-shadow] duration-200"
          :class="scrolled ? 'border-line shadow-[0_6px_16px_-12px_rgb(var(--shadow)/0.35)]' : 'border-line/70'"
        >
          <div class="min-w-0">
            <h2 class="text-base font-semibold text-fg">{{ title }}</h2>
          </div>
          <button
            type="button"
            data-drawer-close
            class="btn btn-ghost btn-icon btn-sm group -mr-1.5"
            :aria-label="t('common.close')"
            @click="close"
          >
            <UiIcon name="x" :size="16" class="transition-transform duration-200 ease-out group-hover:rotate-90" />
          </button>
        </header>
        <div ref="body" class="drawer-body flex-1 overflow-y-auto overscroll-contain px-5 py-5" @scroll.passive="onScroll">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-line bg-surface-2/40 px-5 py-3">
          <slot name="footer" />
        </footer>
      </aside>
    </Transition>
  </Teleport>
</template>
