<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

/**
 * Renders a value and, when it holds exactly one number ("$1,234.56", "98.2%", "42"),
 * counts up to it on mount and tweens between numbers when it changes. Prefix/suffix,
 * decimal places and thousands separators are preserved, and the final frame is always the
 * original string verbatim (so precision-sensitive money values are never re-rounded).
 * Anything else (dates, "12/20", "—") renders as-is.
 */
const props = withDefaults(
  defineProps<{
    value: string | number;
    /** Tween length in ms. */
    duration?: number;
    /** Count up from zero on first render. */
    fromZero?: boolean;
  }>(),
  { duration: 800, fromZero: true },
);

interface Parsed {
  prefix: string;
  suffix: string;
  num: number;
  decimals: number;
  grouped: boolean;
}

/** Prefix and suffix must be digit-free, so only single-number strings animate. */
const SINGLE_NUMBER = /^([^\d]*?)(-?\d[\d,]*(?:\.\d+)?)([^\d]*)$/;

function parse(value: string | number): Parsed | null {
  const text = String(value);
  const m = SINGLE_NUMBER.exec(text);
  if (!m) return null;
  const raw = m[2]!;
  const num = Number(raw.replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  const dot = raw.indexOf(".");
  return { prefix: m[1]!, suffix: m[3]!, num, decimals: dot === -1 ? 0 : raw.length - dot - 1, grouped: raw.includes(",") };
}

function format(p: Parsed, n: number): string {
  let body = Math.abs(n).toFixed(p.decimals);
  if (p.grouped) {
    const [int, frac] = body.split(".");
    body = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac !== undefined ? `.${frac}` : "");
  }
  return `${p.prefix}${n < 0 ? "-" : ""}${body}${p.suffix}`;
}

const shown = ref(String(props.value));
let frame = 0;
let current: number | null = null;

function reducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function tweenTo(value: string | number, from: number | null) {
  cancelAnimationFrame(frame);
  const target = parse(value);
  const text = String(value);
  if (!target || from === null || from === target.num || reducedMotion() || document.hidden) {
    shown.value = text;
    current = target?.num ?? null;
    return;
  }
  const start = performance.now();
  const delta = target.num - from;
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / props.duration);
    const eased = 1 - Math.pow(1 - t, 4);
    current = from + delta * eased;
    if (t < 1) {
      shown.value = format(target, current);
      frame = requestAnimationFrame(step);
    } else {
      current = target.num;
      shown.value = text;
    }
  };
  frame = requestAnimationFrame(step);
}

onMounted(() => {
  const p = parse(props.value);
  if (p && props.fromZero) {
    shown.value = format(p, 0);
    tweenTo(props.value, 0);
  } else {
    current = p?.num ?? null;
  }
});

watch(
  () => props.value,
  (next, prev) => {
    // Only tween between two numbers of the same shape (same prefix/suffix).
    const a = parse(prev);
    const b = parse(next);
    const comparable = a && b && a.prefix === b.prefix && a.suffix === b.suffix;
    tweenTo(next, comparable ? (current ?? a.num) : null);
  },
);

onBeforeUnmount(() => cancelAnimationFrame(frame));
</script>

<template>
  <span class="tabular-nums">{{ shown }}</span>
</template>
