<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { normalizeRegistrationEmailSuffix } from "@slipgate/contracts";
import UiIcon from "../ui/UiIcon.vue";

/**
 * Sign-up email suffix allowlist as chips: "corp.com" / "@corp.com" (that exact domain) or
 * "*.edu.cn" (the domain and every subdomain). Enter, comma, space or a paste of many commits;
 * entries are stored in the BFF's normalised form; invalid ones are reported, never added.
 */
const props = withDefaults(defineProps<{ max?: number; inputId?: string; invalid?: boolean }>(), { max: 100, invalid: false });
const model = defineModel<string[]>({ required: true });

const { t } = useI18n();

const text = ref("");
const rejected = ref<string[]>([]);
const input = ref<HTMLInputElement | null>(null);

function commit(raw: string) {
  const parts = raw
    .split(/[\s,;，；、]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return;
  const next = [...model.value];
  const bad: string[] = [];
  for (const p of parts) {
    const normalized = normalizeRegistrationEmailSuffix(p);
    if (normalized === null) {
      bad.push(p);
      continue;
    }
    if (!normalized || next.includes(normalized) || next.length >= props.max) continue;
    next.push(normalized);
  }
  rejected.value = bad;
  model.value = next;
}

function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Enter" || ev.key === "," || ev.key === ";" || (ev.key === " " && text.value.trim())) {
    ev.preventDefault();
    if (!text.value.trim()) return;
    commit(text.value);
    text.value = "";
  } else if (ev.key === "Backspace" && text.value === "" && model.value.length > 0) {
    model.value = model.value.slice(0, -1);
  }
}

function onPaste(ev: ClipboardEvent) {
  const pasted = ev.clipboardData?.getData("text") ?? "";
  if (!/[\s,;，；、]/.test(pasted.trim())) return;
  ev.preventDefault();
  commit(`${text.value} ${pasted}`);
  text.value = "";
}

function onBlur() {
  if (!text.value.trim()) return;
  commit(text.value);
  text.value = "";
}

function remove(entry: string) {
  model.value = model.value.filter((e) => e !== entry);
  input.value?.focus();
}

defineExpose({ flush: onBlur });
</script>

<template>
  <div>
    <div
      class="flex min-h-[2.75rem] w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border bg-surface px-2 py-1.5 shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 hover:border-line-strong dark:bg-surface-2/50"
      :class="invalid ? 'border-danger/60' : 'border-line'"
      @click="input?.focus()"
    >
      <TransitionGroup
        enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        enter-from-class="scale-90 opacity-0"
        leave-to-class="scale-90 opacity-0"
      >
        <span
          v-for="entry in model"
          :key="entry"
          class="inline-flex max-w-full items-center gap-1 rounded-full py-0.5 pl-2 pr-1 font-mono text-xs font-medium ring-1 ring-inset"
          :class="entry.startsWith('*.') ? 'bg-violet/10 text-violet ring-violet/20' : 'bg-accent/10 text-accent ring-accent/20'"
          :title="entry.startsWith('*.') ? t('authGuards.settings.emailPolicy.wildcardTitle', { domain: entry.slice(2) }) : t('authGuards.settings.emailPolicy.exactTitle', { domain: entry.slice(1) })"
        >
          <UiIcon :name="entry.startsWith('*.') ? 'layers' : 'mail'" :size="11" class="shrink-0 opacity-80" />
          <span class="truncate">{{ entry }}</span>
          <button
            type="button"
            class="inline-flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-fg/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            :aria-label="t('authGuards.settings.emailPolicy.remove', { entry })"
            @click.stop="remove(entry)"
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
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        class="h-7 min-w-[9rem] flex-1 border-0 bg-transparent px-1 font-mono text-sm text-fg outline-none placeholder:font-sans placeholder:text-fg-subtle focus:ring-0"
        :placeholder="model.length === 0 ? t('authGuards.settings.emailPolicy.placeholder') : t('authGuards.settings.emailPolicy.placeholderMore')"
        :disabled="model.length >= max"
        @keydown="onKeydown"
        @paste="onPaste"
        @blur="onBlur"
      />
    </div>
    <div class="mt-1 flex flex-wrap items-start justify-between gap-x-3 gap-y-1 text-xs">
      <p v-if="rejected.length" class="flex min-w-0 items-start gap-1 break-words text-warning" role="alert">
        <UiIcon name="alert" :size="12" class="mt-0.5 shrink-0" />
        {{ t("authGuards.settings.emailPolicy.rejected", { list: rejected.join(", ") }) }}
      </p>
      <span v-else class="text-fg-subtle">{{ t("authGuards.settings.emailPolicy.inputHint") }}</span>
      <span class="shrink-0 tabular-nums text-fg-subtle">{{ model.length }}/{{ max }}</span>
    </div>
  </div>
</template>
