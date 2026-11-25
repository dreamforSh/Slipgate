<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

/**
 * Anchored popover menu: the trigger slot gets `toggle` / `open`, the default slot gets
 * `close`. Closes on outside pointer-down and Escape; ArrowUp/ArrowDown/Home/End move focus
 * between the panel's menu items.
 */
const props = withDefaults(
  defineProps<{
    align?: "left" | "right";
    widthClass?: string;
  }>(),
  { align: "right", widthClass: "w-56" },
);

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);

function toggle() {
  open.value = !open.value;
}
function close() {
  open.value = false;
}

function onPointerDown(ev: PointerEvent) {
  if (root.value && !root.value.contains(ev.target as Node)) close();
}

function items(): HTMLElement[] {
  return Array.from(
    panel.value?.querySelectorAll<HTMLElement>(
      '[role^="menuitem"]:not([disabled]), .menu-item:not([disabled]), a[href]:not([role]), button:not([disabled]):not([role])',
    ) ?? [],
  );
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") {
    close();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(ev.key)) return;
  const list = items();
  if (!list.length) return;
  ev.preventDefault();
  const at = list.indexOf(document.activeElement as HTMLElement);
  let next = 0;
  if (ev.key === "ArrowDown") next = at < 0 ? 0 : (at + 1) % list.length;
  else if (ev.key === "ArrowUp") next = at <= 0 ? list.length - 1 : at - 1;
  else if (ev.key === "End") next = list.length - 1;
  list[next]?.focus();
}

watch(open, async (value) => {
  if (value) {
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeydown);
    await nextTick();
  } else {
    document.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("keydown", onKeydown);
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("keydown", onKeydown);
});

defineExpose({ close });
</script>

<template>
  <div ref="root" class="relative">
    <slot name="trigger" :open="open" :toggle="toggle" />
    <Transition name="menu">
      <div
        v-if="open"
        ref="panel"
        class="menu-panel absolute top-full z-50 mt-2"
        :class="[props.align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left', props.widthClass]"
        role="menu"
      >
        <slot :close="close" />
      </div>
    </Transition>
  </div>
</template>
