<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "../../ui/UiIcon.vue";

/**
 * Inline priority editor (sub2api style): − value +, or click the value to type one. Rapid
 * clicks coalesce into one `commit` after a short pause; Enter / blur commit typed values,
 * Escape cancels. Lower numbers schedule first; the range matches the account schema.
 */
const props = defineProps<{
  value: number;
  disabled?: boolean;
  /** Account name for screen-reader labels. */
  name: string;
}>();
const emit = defineEmits<{ (e: "commit", value: number): void }>();

const { t } = useI18n();

const MIN = 0;
const MAX = 10000;
const COMMIT_DELAY_MS = 600;

const draft = ref(props.value);
const editing = ref(false);
const typed = ref("");
const input = ref<HTMLInputElement | null>(null);
let timer: number | undefined;

watch(
  () => props.value,
  (v) => {
    if (!editing.value && timer === undefined) draft.value = v;
  },
);

const clamp = (v: number) => Math.min(MAX, Math.max(MIN, Math.round(v)));

function flush() {
  window.clearTimeout(timer);
  timer = undefined;
  if (draft.value !== props.value) emit("commit", draft.value);
}

function step(delta: number) {
  if (props.disabled) return;
  draft.value = clamp(draft.value + delta);
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, COMMIT_DELAY_MS);
}

async function startEdit() {
  if (props.disabled) return;
  typed.value = String(draft.value);
  editing.value = true;
  await Promise.resolve();
  input.value?.focus();
  input.value?.select();
}

function finishEdit(save: boolean) {
  if (!editing.value) return;
  editing.value = false;
  const n = Number(typed.value);
  if (save && typed.value.trim() !== "" && Number.isFinite(n)) {
    draft.value = clamp(n);
    flush();
  } else {
    draft.value = props.value;
  }
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Enter") {
    ev.preventDefault();
    finishEdit(true);
  } else if (ev.key === "Escape") {
    // Keep a surrounding dialog open; only the edit is cancelled.
    ev.stopPropagation();
    finishEdit(false);
  } else if (ev.key === "ArrowUp" || ev.key === "ArrowDown") {
    ev.preventDefault();
    const n = Number(typed.value);
    typed.value = String(clamp((Number.isFinite(n) ? n : draft.value) + (ev.key === "ArrowUp" ? 1 : -1)));
  }
}

onBeforeUnmount(() => {
  if (timer !== undefined) flush();
});
</script>

<template>
  <span
    class="inline-flex items-center rounded-md border border-line bg-surface-2/50 font-mono text-xs tabular-nums transition-colors hover:border-line-strong"
    :class="disabled ? 'opacity-60' : ''"
    :title="t('accounts.priority.hint')"
  >
    <button
      type="button"
      class="flex h-6 w-5 cursor-pointer items-center justify-center rounded-l-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed"
      :disabled="disabled || draft <= MIN"
      :aria-label="t('accounts.priority.decrease', { name })"
      @click="step(-1)"
    >
      <UiIcon name="minus" :size="11" />
    </button>
    <input
      v-if="editing"
      ref="input"
      v-model="typed"
      type="text"
      inputmode="numeric"
      class="h-6 w-11 border-x border-line bg-surface px-1 text-center text-xs text-fg outline-none focus:ring-2 focus:ring-accent/25"
      :aria-label="t('accounts.priority.label', { name })"
      @keydown="onKeydown"
      @blur="finishEdit(true)"
    />
    <button
      v-else
      type="button"
      class="h-6 min-w-[2.75rem] cursor-text border-x border-line px-1 text-center text-fg transition-colors hover:bg-surface-2 disabled:cursor-not-allowed"
      :class="draft !== value ? 'text-accent' : ''"
      :disabled="disabled"
      :aria-label="t('accounts.priority.label', { name })"
      @click="startEdit"
    >
      #{{ draft }}
    </button>
    <button
      type="button"
      class="flex h-6 w-5 cursor-pointer items-center justify-center rounded-r-md text-fg-subtle transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed"
      :disabled="disabled || draft >= MAX"
      :aria-label="t('accounts.priority.increase', { name })"
      @click="step(1)"
    >
      <UiIcon name="plus" :size="11" />
    </button>
  </span>
</template>
