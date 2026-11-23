<script setup lang="ts" generic="K extends string">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UiDropdown from "../../ui/UiDropdown.vue";
import UiIcon from "../../ui/UiIcon.vue";

/** Column-visibility menu for a wide table; the parent persists `hidden`. */
const props = defineProps<{ columns: { key: K; label: string }[]; defaults: K[] }>();
const hidden = defineModel<K[]>("hidden", { required: true });

const { t } = useI18n();

const hiddenSet = computed(() => new Set(hidden.value));
const visibleCount = computed(() => props.columns.filter((c) => !hiddenSet.value.has(c.key)).length);

function toggle(key: K) {
  const next = new Set(hidden.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  hidden.value = props.columns.map((c) => c.key).filter((k) => next.has(k));
}

function reset() {
  hidden.value = [...props.defaults];
}
</script>

<template>
  <UiDropdown width-class="w-60">
    <template #trigger="{ toggle: open, open: isOpen }">
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        aria-haspopup="menu"
        :aria-expanded="isOpen"
        :title="t('userLimits.columns.picker')"
        @click="open"
      >
        <UiIcon name="columns" :size="13" />
        <span class="hidden sm:inline">{{ t("userLimits.columns.picker") }}</span>
        <span class="font-mono text-2xs tabular-nums text-fg-subtle">{{ visibleCount }}/{{ columns.length }}</span>
      </button>
    </template>
    <div class="flex items-center justify-between px-2.5 pb-1 pt-1.5">
      <span class="text-2xs font-medium text-fg-subtle">{{ t("userLimits.columns.title") }}</span>
      <button type="button" class="cursor-pointer text-2xs font-medium text-accent hover:underline" @click="reset">
        {{ t("userLimits.columns.reset") }}
      </button>
    </div>
    <div class="max-h-80 overflow-y-auto">
      <button
        v-for="c in columns"
        :key="c.key"
        type="button"
        role="menuitemcheckbox"
        :aria-checked="!hiddenSet.has(c.key)"
        class="menu-item py-1.5"
        @click="toggle(c.key)"
      >
        <span
          class="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors duration-150"
          :class="hiddenSet.has(c.key) ? 'border-line-strong bg-surface' : 'border-accent bg-accent text-accent-fg'"
          aria-hidden="true"
        >
          <UiIcon v-if="!hiddenSet.has(c.key)" name="check" :size="11" :stroke-width="2.5" />
        </span>
        <span class="truncate">{{ c.label }}</span>
      </button>
    </div>
  </UiDropdown>
</template>
