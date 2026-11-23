<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "../../ui/UiIcon.vue";

/** A user's granted (exclusive) groups as compact chips: the first `max`, then "+N". */
const props = withDefaults(defineProps<{ ids: string[]; names: Map<string, string>; max?: number }>(), { max: 2 });

const { t } = useI18n();

const named = computed(() => props.ids.map((id) => ({ id, name: props.names.get(id) ?? id, known: props.names.has(id) })));
const shown = computed(() => named.value.slice(0, props.max));
const rest = computed(() => named.value.slice(props.max));
const restTitle = computed(() => rest.value.map((g) => g.name).join("\n"));
</script>

<template>
  <span v-if="ids.length === 0" class="text-xs text-fg-subtle">—</span>
  <span v-else class="flex max-w-[14rem] flex-wrap items-center gap-1" :aria-label="t('userLimits.columns.groups')">
    <span
      v-for="g in shown"
      :key="g.id"
      class="inline-flex max-w-[8.5rem] items-center gap-1 rounded-full bg-violet/10 px-2 py-0.5 text-2xs font-medium text-violet ring-1 ring-inset ring-violet/20"
      :class="g.known ? '' : 'opacity-60'"
      :title="g.known ? g.name : t('userLimits.groups.unknown', { id: g.id })"
    >
      <UiIcon name="lock" :size="9" />
      <span class="truncate">{{ g.name }}</span>
    </span>
    <span
      v-if="rest.length"
      class="rounded-full bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-fg-muted ring-1 ring-inset ring-line"
      :title="restTitle"
    >
      +{{ rest.length }}
    </span>
  </span>
</template>
