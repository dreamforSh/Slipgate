<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "../../ui/UiIcon.vue";

/**
 * Email list as removable chips: type and press Enter / comma / space, or paste many at
 * once (any whitespace, comma or semicolon separates). Backspace on an empty field removes
 * the last chip. Invalid entries are reported through `invalid`, never added.
 */
const props = withDefaults(defineProps<{ max?: number; placeholder?: string; inputId?: string }>(), { max: 100 });
const model = defineModel<string[]>({ required: true });

const { t } = useI18n();

const text = ref("");
const invalid = ref<string[]>([]);
const input = ref<HTMLInputElement | null>(null);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function commit(raw: string) {
  const parts = raw
    .split(/[\s,;，；]+/)
    .map((p) => p.trim().replace(/^<|>$/g, ""))
    .filter(Boolean);
  if (parts.length === 0) return;
  const next = [...model.value];
  const seen = new Set(next.map((e) => e.toLowerCase()));
  const bad: string[] = [];
  for (const p of parts) {
    if (!EMAIL_RE.test(p)) {
      bad.push(p);
      continue;
    }
    const key = p.toLowerCase();
    if (seen.has(key) || next.length >= props.max) continue;
    seen.add(key);
    next.push(p);
  }
  invalid.value = bad;
  model.value = next;
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Enter" || ev.key === "," || ev.key === ";" || (ev.key === " " && text.value.trim())) {
    if (!text.value.trim()) {
      // Let an empty Enter submit the surrounding form.
      if (ev.key === "Enter") return;
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
    commit(text.value);
    text.value = "";
  } else if (ev.key === "Backspace" && text.value === "" && model.value.length > 0) {
    model.value = model.value.slice(0, -1);
  }
}

function onPaste(ev: ClipboardEvent) {
  const pasted = ev.clipboardData?.getData("text") ?? "";
  if (!/[\s,;，；]/.test(pasted.trim())) return;
  ev.preventDefault();
  commit(`${text.value} ${pasted}`);
  text.value = "";
}

function onBlur() {
  if (text.value.trim()) {
    commit(text.value);
    text.value = "";
  }
}

function remove(email: string) {
  model.value = model.value.filter((e) => e !== email);
  input.value?.focus();
}

/** Clear the "invalid" note (e.g. when the modal reopens). */
function reset() {
  text.value = "";
  invalid.value = [];
}

/** Commit whatever is still typed (called before submit). */
function flush() {
  onBlur();
}

defineExpose({ reset, flush });
</script>

<template>
  <div>
    <div
      class="flex min-h-[2.75rem] w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 hover:border-line-strong dark:bg-surface-2/50"
      @click="input?.focus()"
    >
      <TransitionGroup
        enter-active-class="transition duration-150 ease-out"
        leave-active-class="transition duration-100 ease-in"
        enter-from-class="scale-90 opacity-0"
        leave-to-class="scale-90 opacity-0"
      >
        <span
          v-for="email in model"
          :key="email"
          class="inline-flex max-w-full items-center gap-1 rounded-full bg-accent/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-accent ring-1 ring-inset ring-accent/20"
        >
          <span class="truncate">{{ email }}</span>
          <button
            type="button"
            class="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-accent/20"
            :aria-label="t('subscriptions.assign.removeEmail', { email })"
            @click.stop="remove(email)"
          >
            <UiIcon name="x" :size="10" />
          </button>
        </span>
      </TransitionGroup>
      <input
        :id="inputId"
        ref="input"
        v-model="text"
        type="text"
        inputmode="email"
        autocomplete="off"
        spellcheck="false"
        class="h-7 min-w-[10rem] flex-1 border-0 bg-transparent px-1 text-sm text-fg outline-none placeholder:text-fg-subtle focus:ring-0"
        :placeholder="model.length === 0 ? placeholder : ''"
        @keydown="onKeydown"
        @paste="onPaste"
        @blur="onBlur"
      />
    </div>
    <div class="mt-1 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs">
      <p v-if="invalid.length" class="min-w-0 break-words text-warning">
        {{ t("subscriptions.assign.invalidEmail", { list: invalid.join(", ") }) }}
      </p>
      <span v-else />
      <span class="shrink-0 tabular-nums text-fg-subtle">{{ t("subscriptions.assign.usersCount", { n: model.length }) }}</span>
    </div>
  </div>
</template>
