<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

/**
 * Time-series line chart (one measure, one y-axis). Single series gets a 10% area wash;
 * multiple series get a legend. Crosshair + tooltip on hover and arrow keys.
 */
export interface TrendSeries {
  key: string;
  label: string;
  /** CSS color, e.g. `rgb(var(--viz-1))`. */
  color: string;
  values: number[];
}

const props = withDefaults(
  defineProps<{
    /** Short x-axis labels, one per point. */
    labels: string[];
    /** Tooltip titles, one per point (defaults to labels). */
    titles?: string[];
    series: TrendSeries[];
    format: (value: number) => string;
    axisFormat?: (value: number) => string;
    height?: number;
    chartLabel: string;
  }>(),
  { height: 240 },
);

const root = ref<HTMLElement | null>(null);
const width = ref(640);
let observer: ResizeObserver | null = null;

onMounted(() => {
  if (!root.value) return;
  width.value = root.value.clientWidth || 640;
  observer = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width;
    if (w) width.value = w;
  });
  observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());

const PAD = { top: 12, right: 12, bottom: 28, left: 52 };
const count = computed(() => props.labels.length);
const plotW = computed(() => Math.max(10, width.value - PAD.left - PAD.right));
const plotH = computed(() => Math.max(10, props.height - PAD.top - PAD.bottom));

/** Clean tick step: 1 / 2 / 2.5 / 5 × 10^n. */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const frac = raw / pow;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

const scale = computed(() => {
  const max = Math.max(0, ...props.series.flatMap((s) => s.values));
  const step = niceStep((max || 1) / 4);
  const top = Math.max(step, Math.ceil((max || 1) / step) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
});

const xAt = (i: number) => PAD.left + (count.value <= 1 ? plotW.value / 2 : (i / (count.value - 1)) * plotW.value);
const yAt = (v: number) => PAD.top + plotH.value - (v / scale.value.top) * plotH.value;

const paths = computed(() =>
  props.series.map((s) => {
    const pts = s.values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`);
    const line = pts.length ? `M${pts.join("L")}` : "";
    const base = (PAD.top + plotH.value).toFixed(1);
    const area = pts.length ? `${line}L${xAt(pts.length - 1).toFixed(1)},${base}L${xAt(0).toFixed(1)},${base}Z` : "";
    return { ...s, line, area };
  }),
);

const xTicks = computed(() => {
  const n = count.value;
  if (n === 0) return [];
  const want = Math.max(2, Math.min(7, Math.floor(plotW.value / 90)));
  const every = Math.max(1, Math.ceil(n / want));
  const idx: number[] = [];
  for (let i = 0; i < n; i += every) idx.push(i);
  if (idx[idx.length - 1] !== n - 1 && n - 1 - idx[idx.length - 1]! >= every / 2) idx.push(n - 1);
  return idx;
});

const active = ref<number | null>(null);

function onPointerMove(ev: PointerEvent) {
  const rect = (ev.currentTarget as SVGElement).getBoundingClientRect();
  const x = ev.clientX - rect.left - PAD.left;
  if (count.value <= 1) {
    active.value = count.value ? 0 : null;
    return;
  }
  const i = Math.round((x / plotW.value) * (count.value - 1));
  active.value = Math.max(0, Math.min(count.value - 1, i));
}

function onKeydown(ev: KeyboardEvent) {
  if (!count.value) return;
  if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
    ev.preventDefault();
    const cur = active.value ?? (ev.key === "ArrowRight" ? -1 : count.value);
    active.value = Math.max(0, Math.min(count.value - 1, cur + (ev.key === "ArrowRight" ? 1 : -1)));
  } else if (ev.key === "Escape") {
    active.value = null;
  }
}

const tooltip = computed(() => {
  const i = active.value;
  if (i === null) return null;
  const x = xAt(i);
  const flip = x > width.value * 0.6;
  return {
    i,
    x,
    style: flip ? { right: `${width.value - x + 12}px` } : { left: `${x + 12}px` },
    title: props.titles?.[i] ?? props.labels[i] ?? "",
    rows: props.series.map((s) => ({ key: s.key, label: s.label, color: s.color, value: props.format(s.values[i] ?? 0) })),
  };
});

const axisFmt = (v: number) => (props.axisFormat ?? props.format)(v);
</script>

<template>
  <div ref="root" class="relative w-full select-none">
    <div v-if="series.length > 1" class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
      <span v-for="s in series" :key="s.key" class="inline-flex items-center gap-1.5">
        <span class="inline-block h-0.5 w-3 rounded-full" :style="{ background: s.color }" />
        {{ s.label }}
      </span>
    </div>
    <svg
      :width="width"
      :height="height"
      :viewBox="`0 0 ${width} ${height}`"
      class="block overflow-visible outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      role="img"
      :aria-label="chartLabel"
      tabindex="0"
      @pointermove="onPointerMove"
      @pointerleave="active = null"
      @keydown="onKeydown"
      @blur="active = null"
    >
      <!-- grid + y ticks -->
      <g>
        <line
          v-for="tk in scale.ticks"
          :key="`g${tk}`"
          :x1="PAD.left"
          :x2="PAD.left + plotW"
          :y1="yAt(tk)"
          :y2="yAt(tk)"
          stroke="rgb(var(--border))"
          stroke-width="1"
        />
        <text
          v-for="tk in scale.ticks"
          :key="`t${tk}`"
          :x="PAD.left - 8"
          :y="yAt(tk)"
          text-anchor="end"
          dominant-baseline="middle"
          class="fill-fg-subtle text-[11px] tabular-nums"
        >
          {{ axisFmt(tk) }}
        </text>
      </g>
      <!-- x ticks -->
      <text
        v-for="i in xTicks"
        :key="`x${i}`"
        :x="xAt(i)"
        :y="height - 8"
        :text-anchor="i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle'"
        class="fill-fg-subtle text-[11px] tabular-nums"
      >
        {{ labels[i] }}
      </text>
      <!-- series -->
      <g v-for="p in paths" :key="p.key">
        <path v-if="series.length === 1" :d="p.area" :fill="p.color" fill-opacity="0.1" />
        <path :d="p.line" fill="none" :stroke="p.color" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      </g>
      <!-- crosshair -->
      <g v-if="tooltip">
        <line
          :x1="tooltip.x"
          :x2="tooltip.x"
          :y1="PAD.top"
          :y2="PAD.top + plotH"
          stroke="rgb(var(--fg-subtle))"
          stroke-opacity="0.6"
          stroke-width="1"
        />
        <circle
          v-for="p in paths"
          :key="`m${p.key}`"
          :cx="tooltip.x"
          :cy="yAt(p.values[tooltip.i] ?? 0)"
          r="4"
          :fill="p.color"
          stroke="rgb(var(--surface))"
          stroke-width="2"
        />
      </g>
      <!-- hit area -->
      <rect :x="PAD.left" :y="PAD.top" :width="plotW" :height="plotH" fill="transparent" />
    </svg>
    <div
      v-if="tooltip"
      class="pointer-events-none absolute top-6 z-10 min-w-[9rem] rounded-lg border border-line bg-surface/95 px-3 py-2 text-xs shadow-pop backdrop-blur"
      :style="tooltip.style"
      role="status"
    >
      <p class="mb-1 text-fg-subtle">{{ tooltip.title }}</p>
      <p v-for="row in tooltip.rows" :key="row.key" class="flex items-center gap-2 py-0.5">
        <span class="inline-block h-0.5 w-3 shrink-0 rounded-full" :style="{ background: row.color }" />
        <span class="font-semibold tabular-nums text-fg">{{ row.value }}</span>
        <span v-if="series.length > 1" class="truncate text-fg-subtle">{{ row.label }}</span>
      </p>
    </div>
  </div>
</template>
