<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "../ui/UiIcon.vue";
import { IP_LIST_MAX, parseIpList } from "./keyLimits";

/** One-IP/CIDR-per-line textarea with live validation of each line. */
const text = defineModel<string>({ required: true });
const props = withDefaults(defineProps<{ id: string; label: string; hint: string; disabled?: boolean }>(), {
  disabled: false,
});

const { t } = useI18n();
const result = computed(() => parseIpList(text.value));
const firstInvalid = computed(() => result.value.invalid[0] ?? null);
const invalid = computed(() => result.value.invalid.length > 0 || result.value.tooMany);
const hintId = computed(() => `${props.id}-hint`);
</script>

<template>
  <div class="min-w-0">
    <div class="mb-1.5 flex items-baseline justify-between gap-2">
      <label :for="id" class="text-xs font-medium text-fg-muted">{{ label }}</label>
      <span class="font-mono text-2xs tabular-nums" :class="result.tooMany ? 'text-danger' : 'text-fg-subtle'">
        {{ result.entries.length }}/{{ IP_LIST_MAX }}
      </span>
    </div>
    <textarea
      :id="id"
      v-model="text"
      rows="4"
      spellcheck="false"
      autocomplete="off"
      :disabled="disabled"
      :placeholder="t('user.form.ipPlaceholder')"
      class="textarea resize-y font-mono text-xs"
      :class="invalid ? '!border-danger/60 focus:!ring-danger/20' : ''"
      :aria-invalid="invalid || undefined"
      :aria-describedby="hintId"
    />
    <p :id="hintId" class="mt-1 flex items-start gap-1 text-xs" :class="invalid ? 'text-danger' : 'text-fg-subtle'" aria-live="polite">
      <UiIcon v-if="invalid" name="alert" :size="12" class="mt-0.5" />
      <template v-if="firstInvalid">
        {{ t("user.form.ipInvalid", { line: firstInvalid.line, value: firstInvalid.value }) }}
        <span v-if="result.invalid.length > 1" class="text-fg-subtle">{{ t("user.form.ipMore", { n: result.invalid.length - 1 }) }}</span>
      </template>
      <template v-else-if="result.tooMany">{{ t("user.form.ipTooMany", { n: IP_LIST_MAX }) }}</template>
      <template v-else>{{ hint }}</template>
    </p>
  </div>
</template>
