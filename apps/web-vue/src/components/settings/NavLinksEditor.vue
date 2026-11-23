<script setup lang="ts">
import { useI18n } from "vue-i18n";
import EmptyState from "../ui/EmptyState.vue";
import UiIcon from "../ui/UiIcon.vue";

/** Editable, reorderable list of public navigation links (label + URL). */
export interface NavLinkRow {
  /** Local identity for keyed transitions; never sent to the server. */
  key: number;
  label: string;
  url: string;
}

const props = withDefaults(
  defineProps<{
    modelValue: NavLinkRow[];
    max?: number;
    errors?: { label?: string; url?: string }[];
  }>(),
  { max: 10, errors: () => [] },
);

const emit = defineEmits<{ (e: "update:modelValue", value: NavLinkRow[]): void }>();
const { t } = useI18n();

let seq = Date.now();

function update(index: number, patch: Partial<NavLinkRow>) {
  emit(
    "update:modelValue",
    props.modelValue.map((row, i) => (i === index ? { ...row, ...patch } : row)),
  );
}

function add() {
  if (props.modelValue.length >= props.max) return;
  emit("update:modelValue", [...props.modelValue, { key: ++seq, label: "", url: "" }]);
}

function remove(index: number) {
  emit(
    "update:modelValue",
    props.modelValue.filter((_, i) => i !== index),
  );
}

function move(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= props.modelValue.length) return;
  const next = [...props.modelValue];
  [next[index], next[target]] = [next[target]!, next[index]!];
  emit("update:modelValue", next);
}
</script>

<template>
  <div>
    <EmptyState v-if="!modelValue.length" compact icon="link" :title="t('settings.nav.empty')">
      <button type="button" class="btn btn-secondary btn-sm" @click="add">
        <UiIcon name="plus" :size="14" />
        {{ t("settings.nav.add") }}
      </button>
    </EmptyState>

    <template v-else>
      <TransitionGroup
        tag="ul"
        class="relative space-y-2"
        move-class="transition-transform duration-300 ease-out motion-reduce:transition-none"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="absolute inset-x-0 transition duration-150 ease-in motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <li
          v-for="(row, i) in modelValue"
          :key="row.key"
          class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 rounded-xl border border-line bg-surface-2/30 p-2.5 sm:gap-3"
        >
          <span
            class="mt-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 font-mono text-2xs tabular-nums text-fg-subtle ring-1 ring-inset ring-line"
          >
            {{ i + 1 }}
          </span>
          <div class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div class="min-w-0">
              <input
                :value="row.label"
                type="text"
                maxlength="40"
                class="input input-sm"
                :class="errors[i]?.label ? '!border-danger/60 focus:!ring-danger/20' : ''"
                :placeholder="t('settings.nav.labelPlaceholder')"
                :aria-label="t('settings.nav.label', { n: i + 1 })"
                @input="update(i, { label: ($event.target as HTMLInputElement).value })"
              />
              <p v-if="errors[i]?.label" class="mt-1 text-2xs text-danger">{{ errors[i]?.label }}</p>
            </div>
            <div class="min-w-0">
              <input
                :value="row.url"
                type="text"
                inputmode="url"
                spellcheck="false"
                maxlength="2048"
                class="input input-sm font-mono"
                :class="errors[i]?.url ? '!border-danger/60 focus:!ring-danger/20' : ''"
                :placeholder="t('settings.nav.urlPlaceholder')"
                :aria-label="t('settings.nav.url', { n: i + 1 })"
                @input="update(i, { url: ($event.target as HTMLInputElement).value })"
              />
              <p v-if="errors[i]?.url" class="mt-1 text-2xs text-danger">{{ errors[i]?.url }}</p>
            </div>
          </div>
          <div class="flex items-center gap-0.5">
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs"
              :disabled="i === 0"
              :title="t('settings.nav.moveUp')"
              :aria-label="t('settings.nav.moveUp')"
              @click="move(i, -1)"
            >
              <UiIcon name="arrow-up" :size="13" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs"
              :disabled="i === modelValue.length - 1"
              :title="t('settings.nav.moveDown')"
              :aria-label="t('settings.nav.moveDown')"
              @click="move(i, 1)"
            >
              <UiIcon name="arrow-down" :size="13" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-icon btn-xs hover:!bg-danger/10 hover:!text-danger"
              :title="t('common.remove')"
              :aria-label="t('common.remove')"
              @click="remove(i)"
            >
              <UiIcon name="trash" :size="13" />
            </button>
          </div>
        </li>
      </TransitionGroup>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button type="button" class="btn btn-secondary btn-sm" :disabled="modelValue.length >= max" @click="add">
          <UiIcon name="plus" :size="14" />
          {{ t("settings.nav.add") }}
        </button>
        <span class="text-xs tabular-nums text-fg-subtle">{{ t("settings.nav.count", { n: modelValue.length, max }) }}</span>
      </div>
    </template>
  </div>
</template>
