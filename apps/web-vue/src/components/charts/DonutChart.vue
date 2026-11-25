<script setup lang="ts">
import { computed, ref } from "vue";

/**
 * Donut for a part-to-whole split (sub2api-style model / user distribution). Keep it to <= 6
 * slices (fold the rest into "Other"); a 2px surface gap separates slices. Hovering a slice, or
 * setting `active` from a linked table row, dims the others and puts that slice's value and share
 * in the centre; arrow keys walk the slices. The table beside it carries the exact numbers.
 */
export interface DonutItem {
  key: string;
  label: string;
  value: number;
  color: string;
}

const props = withDefaults(
  defineProps<{
    items: DonutItem[];
    /** Accessible name, e.g. "Model distribution by tokens". */
    label: string;
    format?: (v: number) => string;
    /** Centre caption when nothing is hovered. */
    totalLabel?: string;
    /** Key highlighted from outside (a hovered table row). */
    active?: string | null;
    size?: number;
    thickness?: number;
  }>(),
  { format: (v: number) => String(v), totalLabel: "", active: null, size: 192, thickness: 26 },
);
const emit = defineEmits<{ (e: "update:active", key: string | null): void }>();

const hovered = ref<string | null>(null);
const current = computed(() => hovered.value ?? props.active);

const slices = computed(() => props.items.filter((i) => i.value > 0));
const total = computed(() => slices.value.reduce((s, i) => s + i.value, 0));

const R = 50; // viewBox radius
const r = computed(() => R - (props.thickness / props.size) * 100);

/** Point on a circle of radius `rad` at `frac` of a full turn, starting at 12 o'clock. */
function at(frac: number, rad: number) {
  const a = frac * Math.PI * 2 - Math.PI / 2;
  return [50 + rad * Math.cos(a), 50 + rad * Math.sin(a)] as const;
}

const arcs = computed(() => {
  const list = slices.value;
  if (!list.length || total.value <= 0) return [];
  let start = 0;
  return list.map((item) => {
    const share = item.value / total.value;
    const end = start + share;
    const outer = R;
    const inner = r.value;
    let d: string;
    if (share >= 0.9999) {
      // A full ring cannot be one arc: draw two half rings.
      d = [
        `M ${50} ${50 - outer} A ${outer} ${outer} 0 1 1 ${50} ${50 + outer} A ${outer} ${outer} 0 1 1 ${50} ${50 - outer} Z`,
        `M ${50} ${50 - inner} A ${inner} ${inner} 0 1 0 ${50} ${50 + inner} A ${inner} ${inner} 0 1 0 ${50} ${50 - inner} Z`,
      ].join(" ");
    } else {
      const large = share > 0.5 ? 1 : 0;
      const [x0, y0] = at(start, outer);
      const [x1, y1] = at(end, outer);
      const [x2, y2] = at(end, inner);
      const [x3, y3] = at(start, inner);
      d = `M ${x0} ${y0} A ${outer} ${outer} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${inner} ${inner} 0 ${large} 0 ${x3} ${y3} Z`;
    }
    start = end;
    return { ...item, share, d };
  });
});

const focused = computed(() => arcs.value.find((a) => a.key === current.value) ?? null);
const pct = (share: number) => `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;

const summary = computed(
  () => `${props.label}: ${arcs.value.map((a) => `${a.label} ${pct(a.share)}`).join(", ")}`,
);

function setHover(key: string | null) {
  hovered.value = key;
  emit("update:active", key);
}

function onKey(e: KeyboardEvent) {
  const list = arcs.value;
  if (!list.length) return;
  if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowUp") {
    e.preventDefault();
    const idx = list.findIndex((a) => a.key === current.value);
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = idx < 0 ? (step > 0 ? 0 : list.length - 1) : (idx + step + list.length) % list.length;
    setHover(list[next]!.key);
  } else if (e.key === "Escape") {
    setHover(null);
  }
}
</script>

<template>
  <div
    class="relative shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    :style="{ width: `${size}px`, height: `${size}px` }"
    role="img"
    :aria-label="summary"
    tabindex="0"
    @keydown="onKey"
    @blur="setHover(null)"
  >
    <svg viewBox="0 0 100 100" class="h-full w-full overflow-visible" aria-hidden="true">
      <circle v-if="!arcs.length" cx="50" cy="50" :r="(R + r) / 2" fill="none" class="stroke-surface-2" :stroke-width="R - r" />
      <path
        v-for="a in arcs"
        :key="a.key"
        :d="a.d"
        :fill="a.color"
        fill-rule="evenodd"
        class="cursor-pointer stroke-surface transition-opacity duration-150"
        stroke-width="1"
        stroke-linejoin="round"
        :opacity="current && current !== a.key ? 0.35 : 1"
        @pointerenter="setHover(a.key)"
        @pointerleave="setHover(null)"
      >
        <title>{{ `${a.label} · ${format(a.value)} · ${pct(a.share)}` }}</title>
      </path>
    </svg>
    <!-- Centre readout: the hovered slice, else the total. -->
    <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-8 text-center" aria-live="polite">
      <template v-if="focused">
        <span class="w-full truncate text-2xs text-fg-subtle" :title="focused.label">{{ focused.label }}</span>
        <span class="text-lg font-semibold tabular-nums text-fg">{{ format(focused.value) }}</span>
        <span class="text-2xs font-medium tabular-nums text-fg-muted">{{ pct(focused.share) }}</span>
      </template>
      <template v-else>
        <span v-if="totalLabel" class="text-2xs text-fg-subtle">{{ totalLabel }}</span>
        <span class="text-lg font-semibold tabular-nums text-fg">{{ format(total) }}</span>
      </template>
    </div>
  </div>
</template>
