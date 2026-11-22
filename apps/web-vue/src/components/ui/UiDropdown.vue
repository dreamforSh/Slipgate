<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";

/**
 * Anchored popover menu: the trigger slot gets `toggle` / `open`, the default slot gets
 * `close`. Closes on outside pointer-down and Escape.
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

function toggle() {
  open.value = !open.value;
}
function close() {
  open.value = false;
}

function onPointerDown(ev: PointerEvent) {
  if (root.value && !root.value.contains(ev.target as Node)) close();
}
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") close();
}

watch(open, (value) => {
  if (value) {
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeydown);
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
    <div
      v-if="open"
      class="menu-panel absolute top-full z-50 mt-2 animate-scale-in"
      :class="[props.align === 'right' ? 'right-0 origin-top-right' : 'left-0 origin-top-left', props.widthClass]"
      role="menu"
    >
      <slot :close="close" />
    </div>
  </div>
</template>
