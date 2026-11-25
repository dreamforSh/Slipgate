<script setup lang="ts" generic="V extends string">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";

const props = withDefaults(
  defineProps<{
    modelValue: V;
    options: { value: V; label: string; count?: number; disabled?: boolean }[];
    size?: "sm" | "md";
    block?: boolean;
  }>(),
  { size: "sm", block: false },
);

const emit = defineEmits<{ (e: "update:modelValue", value: V): void }>();

/* ---------------- Sliding thumb ----------------
 * A single raised pill glides behind the selected option. Until it has been measured (or if
 * the control is hidden), the selected button paints its own background instead. */
const root = ref<HTMLElement | null>(null);
const buttons = new Map<string, HTMLElement>();
const thumb = ref<{ left: number; width: number } | null>(null);
const thumbAnimated = ref(false);

function setButton(value: string, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLElement) buttons.set(value, el);
  else buttons.delete(value);
}

function measure() {
  const el = buttons.get(props.modelValue);
  thumb.value = el && el.offsetWidth ? { left: el.offsetLeft, width: el.offsetWidth } : null;
}

watch(
  () => [props.modelValue, props.options.map((o) => `${o.value}:${o.label}:${o.count ?? ""}`).join("|")],
  async () => {
    await nextTick();
    measure();
  },
);

let observer: ResizeObserver | null = null;
onMounted(() => {
  measure();
  requestAnimationFrame(() => (thumbAnimated.value = true));
  if (typeof ResizeObserver !== "undefined" && root.value) {
    observer = new ResizeObserver(() => measure());
    observer.observe(root.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());

const selectedFill = "bg-surface text-fg shadow-sm ring-1 ring-fg/5 dark:bg-surface-3 dark:ring-white/10";
</script>

<template>
  <div
    ref="root"
    class="relative inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5"
    :class="block ? 'flex w-full' : ''"
    role="radiogroup"
  >
    <span
      v-if="thumb"
      class="pointer-events-none absolute bottom-0.5 left-0 top-0.5 rounded-md"
      :class="[selectedFill, thumbAnimated ? 'transition-[transform,width] duration-300 ease-out' : '']"
      :style="{ width: `${thumb.width}px`, transform: `translateX(${thumb.left}px)` }"
      aria-hidden="true"
    />
    <button
      v-for="opt in options"
      :key="opt.value"
      :ref="(el) => setButton(opt.value, el)"
      type="button"
      role="radio"
      :aria-checked="modelValue === opt.value"
      :disabled="opt.disabled"
      class="relative inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[color,transform] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 active:scale-[0.96] motion-reduce:active:scale-100"
      :class="[
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        block ? 'flex-1' : '',
        modelValue === opt.value ? (thumb ? 'text-fg' : selectedFill) : 'text-fg-subtle hover:text-fg',
        opt.disabled ? 'cursor-not-allowed opacity-40 hover:text-fg-subtle active:scale-100' : '',
      ]"
      @click="!opt.disabled && emit('update:modelValue', opt.value)"
    >
      {{ opt.label }}
      <span
        v-if="opt.count !== undefined"
        class="rounded-full px-1.5 font-mono text-[10px] leading-4 tabular-nums transition-colors duration-200"
        :class="modelValue === opt.value ? 'bg-accent/10 text-accent' : 'bg-surface-3/70 text-fg-subtle dark:bg-surface/60'"
      >
        {{ opt.count }}
      </span>
    </button>
  </div>
</template>
