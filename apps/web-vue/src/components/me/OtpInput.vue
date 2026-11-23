<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

/**
 * Six-box one-time-code input: auto-advance, backspace to the previous box, arrow keys,
 * and paste / SMS-style autofill of the whole code into any box. The value is digits only.
 * Emits `complete` once every box is filled.
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    length?: number;
    disabled?: boolean;
    invalid?: boolean;
    autofocus?: boolean;
    /** Accessible name of the group. */
    label?: string;
    idPrefix?: string;
  }>(),
  { length: 6, disabled: false, invalid: false, autofocus: false, idPrefix: "otp" },
);

const emit = defineEmits<{
  (e: "update:modelValue", value: string): void;
  (e: "complete", value: string): void;
}>();

const { t } = useI18n();
const boxes = ref<HTMLInputElement[]>([]);
const digits = computed(() => Array.from({ length: props.length }, (_, i) => props.modelValue[i] ?? ""));
const half = computed(() => Math.floor(props.length / 2));

function setBox(el: Element | null, i: number) {
  if (el) boxes.value[i] = el as HTMLInputElement;
}

function focusBox(i: number) {
  const idx = Math.max(0, Math.min(props.length - 1, i));
  const el = boxes.value[idx];
  el?.focus();
  el?.select();
}

/** Focus the first empty box (or the last one when full). */
function focus() {
  focusBox(Math.min(props.modelValue.length, props.length - 1));
}

function commit(next: string) {
  const clean = next.replace(/\D/g, "").slice(0, props.length);
  if (clean !== props.modelValue) emit("update:modelValue", clean);
  if (clean.length === props.length && clean !== props.modelValue) emit("complete", clean);
  return clean;
}

/** Writes `text` starting at box `i`, keeping the value contiguous. */
function writeAt(i: number, text: string) {
  const current = props.modelValue;
  const start = Math.min(i, current.length);
  const next = commit(current.slice(0, start) + text + current.slice(start + text.length));
  void nextTick(() => focusBox(Math.min(start + text.length, props.length - 1, next.length)));
}

function onInput(i: number, ev: Event) {
  const el = ev.target as HTMLInputElement;
  const typed = el.value.replace(/\D/g, "");
  // Keep the DOM in step with the model even when the keystroke was rejected.
  el.value = digits.value[i] ?? "";
  if (!typed) {
    // Virtual keyboards may delete without a usable Backspace keydown.
    if ((ev as InputEvent).inputType?.startsWith("delete") && digits.value[i]) {
      commit(props.modelValue.slice(0, i) + props.modelValue.slice(i + 1));
    }
    return;
  }
  if (typed.length >= props.length) {
    // Autofill dropped the whole code into one box.
    writeAt(0, typed.slice(0, props.length));
  } else if (typed.length > 1 && digits.value[i]) {
    // Typed into a filled box without replacing its selection: keep the new keystroke.
    writeAt(i, typed.slice(-1));
  } else {
    writeAt(i, typed);
  }
}

function onKeydown(i: number, ev: KeyboardEvent) {
  if (ev.key === "Backspace") {
    ev.preventDefault();
    const current = props.modelValue;
    if (digits.value[i]) {
      commit(current.slice(0, i) + current.slice(i + 1));
      void nextTick(() => focusBox(i));
    } else if (i > 0) {
      commit(current.slice(0, i - 1) + current.slice(i));
      void nextTick(() => focusBox(i - 1));
    }
  } else if (ev.key === "Delete") {
    ev.preventDefault();
    commit(props.modelValue.slice(0, i) + props.modelValue.slice(i + 1));
  } else if (ev.key === "ArrowLeft") {
    ev.preventDefault();
    focusBox(i - 1);
  } else if (ev.key === "ArrowRight") {
    ev.preventDefault();
    focusBox(Math.min(i + 1, props.modelValue.length));
  } else if (ev.key === "Home") {
    ev.preventDefault();
    focusBox(0);
  } else if (ev.key === "End") {
    ev.preventDefault();
    focus();
  }
}

function onPaste(i: number, ev: ClipboardEvent) {
  const text = ev.clipboardData?.getData("text") ?? "";
  const pasted = text.replace(/\D/g, "");
  ev.preventDefault();
  if (!pasted) return;
  // A full code replaces everything regardless of which box got the paste.
  writeAt(pasted.length >= props.length ? 0 : i, pasted.length >= props.length ? pasted.slice(0, props.length) : pasted);
}

function onFocus(i: number) {
  // Boxes fill left to right: clicking past the first gap jumps back to it.
  if (i > props.modelValue.length) focusBox(props.modelValue.length);
  else boxes.value[i]?.select();
}

onMounted(() => {
  if (props.autofocus) void nextTick(focus);
});

watch(
  () => props.disabled,
  (disabled, was) => {
    if (was && !disabled && props.autofocus) void nextTick(focus);
  },
);

defineExpose({ focus });
</script>

<template>
  <div
    role="group"
    :aria-label="label ?? t('security.otp.label')"
    class="flex items-center justify-center gap-1.5 sm:gap-2"
    :class="invalid ? 'otp-shake' : ''"
  >
    <template v-for="(d, i) in digits" :key="i">
      <span v-if="i === half && length > 4" class="h-px w-2 shrink-0 bg-line-strong sm:w-3" aria-hidden="true" />
      <input
        :id="`${idPrefix}-${i}`"
        :ref="(el) => setBox(el as Element | null, i)"
        :value="d"
        type="text"
        inputmode="numeric"
        pattern="[0-9]*"
        :autocomplete="i === 0 ? 'one-time-code' : 'off'"
        :disabled="disabled"
        :aria-label="t('security.otp.digit', { n: i + 1 })"
        :aria-invalid="invalid || undefined"
        class="h-12 w-10 min-w-0 rounded-lg border bg-surface text-center font-mono text-xl font-semibold text-fg shadow-sm outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-surface-2/50 sm:h-12 sm:w-11"
        :class="
          invalid
            ? 'border-danger/60 focus:border-danger focus:ring-danger/20'
            : d
              ? 'border-accent/50 focus:border-accent focus:ring-accent/20'
              : 'border-line hover:border-line-strong focus:border-accent focus:ring-accent/20'
        "
        @input="onInput(i, $event)"
        @keydown="onKeydown(i, $event)"
        @paste="onPaste(i, $event)"
        @focus="onFocus(i)"
      />
    </template>
  </div>
</template>

<style scoped>
.otp-shake {
  animation: otp-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97);
}
@keyframes otp-shake {
  10%,
  90% {
    transform: translateX(-1px);
  }
  20%,
  80% {
    transform: translateX(2px);
  }
  30%,
  50%,
  70% {
    transform: translateX(-4px);
  }
  40%,
  60% {
    transform: translateX(4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .otp-shake {
    animation: none;
  }
}
</style>
