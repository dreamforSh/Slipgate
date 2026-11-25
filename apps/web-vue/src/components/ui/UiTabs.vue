<script setup lang="ts" generic="K extends string">
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from "vue";
import UiIcon, { type IconName } from "./UiIcon.vue";

const props = defineProps<{
  modelValue: K;
  tabs: { key: K; label: string; count?: number; icon?: IconName }[];
}>();

const emit = defineEmits<{ (e: "update:modelValue", value: K): void }>();

/* ---------------- Sliding ink bar ----------------
 * One underline glides between tabs instead of each tab fading its own. It is measured from
 * the active button (offsetLeft inside the scroller), so it scrolls with overflowing tabs. */
const list = ref<HTMLElement | null>(null);
const buttons = new Map<string, HTMLElement>();
const ink = ref<{ left: number; width: number } | null>(null);
/** The first placement snaps; only later moves animate. */
const inkAnimated = ref(false);

function setButton(key: string, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLElement) buttons.set(key, el);
  else buttons.delete(key);
}

function measure() {
  const el = buttons.get(props.modelValue);
  if (!el || !el.offsetWidth) {
    ink.value = null;
    return;
  }
  const inset = 8;
  ink.value = { left: el.offsetLeft + inset, width: Math.max(0, el.offsetWidth - inset * 2) };
}

/** Keep the selected tab visible inside a horizontally scrolling tab bar (without scrolling the page). */
function reveal() {
  const el = buttons.get(props.modelValue);
  const box = list.value;
  if (!el || !box || box.scrollWidth <= box.clientWidth) return;
  const left = el.offsetLeft - 16;
  const right = el.offsetLeft + el.offsetWidth + 16 - box.clientWidth;
  if (box.scrollLeft > left) box.scrollTo({ left, behavior: "smooth" });
  else if (box.scrollLeft < right) box.scrollTo({ left: right, behavior: "smooth" });
}

watch(
  () => [props.modelValue, props.tabs.map((t) => `${t.key}:${t.label}:${t.count ?? ""}`).join("|")],
  async () => {
    await nextTick();
    measure();
    reveal();
  },
);

let observer: ResizeObserver | null = null;
onMounted(() => {
  measure();
  requestAnimationFrame(() => (inkAnimated.value = true));
  if (typeof ResizeObserver !== "undefined" && list.value) {
    observer = new ResizeObserver(() => measure());
    observer.observe(list.value);
  }
});
onBeforeUnmount(() => observer?.disconnect());

function select(key: K) {
  emit("update:modelValue", key);
}

/** Arrow keys move between tabs (with wraparound), Home/End jump to the ends. */
function onKeydown(ev: KeyboardEvent) {
  const keys = props.tabs.map((t) => t.key);
  const at = keys.indexOf(props.modelValue);
  let next = at;
  if (ev.key === "ArrowRight") next = (at + 1) % keys.length;
  else if (ev.key === "ArrowLeft") next = (at - 1 + keys.length) % keys.length;
  else if (ev.key === "Home") next = 0;
  else if (ev.key === "End") next = keys.length - 1;
  else return;
  ev.preventDefault();
  const key = keys[next]!;
  select(key);
  void nextTick(() => buttons.get(key)?.focus());
}
</script>

<template>
  <div ref="list" class="scrollbar-hide relative flex gap-1 overflow-x-auto overflow-y-hidden border-b border-line" role="tablist" @keydown="onKeydown">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      :ref="(el) => setButton(tab.key, el)"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.key"
      :tabindex="modelValue === tab.key ? 0 : -1"
      class="group relative inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 px-3 text-sm font-medium transition-colors duration-200 focus:outline-none focus-visible:text-fg"
      :class="modelValue === tab.key ? 'text-accent' : 'text-fg-subtle hover:text-fg'"
      @click="select(tab.key)"
    >
      <!-- Hover/focus wash sits inside the tab, above the bottom border. -->
      <span
        class="absolute inset-x-0.5 inset-y-1.5 rounded-md bg-surface-2 opacity-0 transition-opacity duration-150 group-hover:opacity-60 group-focus-visible:opacity-100"
        :class="modelValue === tab.key ? '!opacity-0' : ''"
        aria-hidden="true"
      />
      <UiIcon
        v-if="tab.icon"
        :name="tab.icon"
        :size="15"
        class="relative transition-transform duration-300 ease-spring"
        :class="modelValue === tab.key ? 'scale-110' : 'group-hover:scale-105'"
      />
      <span class="relative">{{ tab.label }}</span>
      <span
        v-if="tab.count !== undefined"
        class="relative rounded-full px-1.5 font-mono text-2xs leading-4 tabular-nums transition-colors duration-200"
        :class="modelValue === tab.key ? 'bg-accent/10 text-accent' : 'bg-surface-2 text-fg-subtle'"
      >
        {{ tab.count }}
      </span>
      <!-- Fallback underline until the shared ink bar has been measured. -->
      <span
        v-if="!ink && modelValue === tab.key"
        class="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent"
        aria-hidden="true"
      />
    </button>
    <span
      v-if="ink"
      class="pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-accent shadow-[0_0_8px_rgb(var(--accent-glow)/0.5)]"
      :class="inkAnimated ? 'transition-[transform,width] duration-300 ease-out' : ''"
      :style="{ width: `${ink.width}px`, transform: `translateX(${ink.left}px)` }"
      aria-hidden="true"
    />
  </div>
</template>
