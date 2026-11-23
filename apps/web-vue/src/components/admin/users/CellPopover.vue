<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId } from "vue";

/**
 * Hover / focus popover for dense table cells. Teleported and fixed-positioned so a scrolling
 * table cannot clip it; opens below the trigger and flips above near the viewport bottom.
 * The trigger is a real button (keyboard focus opens it, Escape closes it).
 */
const props = withDefaults(defineProps<{ label: string; widthClass?: string; disabled?: boolean }>(), {
  widthClass: "w-64",
  disabled: false,
});

const id = useId();
const open = ref(false);
const trigger = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const pos = ref({ top: 0, left: 0 });
let showTimer: number | undefined;
let hideTimer: number | undefined;

function place() {
  if (!trigger.value || !panel.value) return;
  const gap = 6;
  const margin = 8;
  const a = trigger.value.getBoundingClientRect();
  const { width, height } = panel.value.getBoundingClientRect();
  const below = a.bottom + gap;
  const top = below + height + margin <= window.innerHeight ? below : Math.max(margin, a.top - gap - height);
  const left = Math.min(Math.max(margin, a.left + a.width / 2 - width / 2), window.innerWidth - width - margin);
  pos.value = { top, left };
}

function onKey(ev: KeyboardEvent) {
  if (ev.key === "Escape") hide(true);
}

function bind(on: boolean) {
  const m = on ? "addEventListener" : "removeEventListener";
  window[m]("scroll", onScroll, true);
  window[m]("resize", onScroll);
  document[m]("keydown", onKey as EventListener);
}
function onScroll() {
  hide(true);
}

function show() {
  if (props.disabled) return;
  window.clearTimeout(hideTimer);
  window.clearTimeout(showTimer);
  showTimer = window.setTimeout(async () => {
    if (open.value) return;
    open.value = true;
    bind(true);
    await nextTick();
    place();
  }, 120);
}

function hide(now = false) {
  window.clearTimeout(showTimer);
  window.clearTimeout(hideTimer);
  const close = () => {
    if (!open.value) return;
    open.value = false;
    bind(false);
  };
  if (now) close();
  else hideTimer = window.setTimeout(close, 120);
}

onBeforeUnmount(() => {
  window.clearTimeout(showTimer);
  window.clearTimeout(hideTimer);
  bind(false);
});
</script>

<template>
  <span class="inline-flex max-w-full">
    <button
      ref="trigger"
      type="button"
      class="inline-flex max-w-full cursor-default items-center rounded-md text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40"
      :aria-describedby="open ? id : undefined"
      :aria-expanded="open"
      @mouseenter="show"
      @mouseleave="hide()"
      @focus="show"
      @blur="hide()"
      @click="open ? hide(true) : show()"
    >
      <slot />
      <span class="sr-only">{{ label }}</span>
    </button>
    <Teleport to="body">
      <Transition
        enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        enter-from-class="translate-y-0.5 opacity-0"
        leave-to-class="opacity-0"
      >
        <div
          v-if="open"
          :id="id"
          ref="panel"
          role="tooltip"
          class="menu-panel fixed z-[70] p-3 text-xs"
          :class="widthClass"
          :style="{ top: `${pos.top}px`, left: `${pos.left}px` }"
          @mouseenter="show"
          @mouseleave="hide()"
        >
          <slot name="content" />
        </div>
      </Transition>
    </Teleport>
  </span>
</template>
