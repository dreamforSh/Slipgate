<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import UiIcon from "../../ui/UiIcon.vue";
import UiSelect from "../../ui/UiSelect.vue";
import {
  EMPTY_NODE_FILTER,
  NODE_BIND_FILTERS,
  NODE_SORT_KEYS,
  NODE_STATUSES,
  nodeFilterActive,
  type NodeFilter,
  type NodeSortKey,
} from "./nodeFilters";

/** Search + status / occupancy / type / subscription filters and sorting for exit-node lists. */
const props = defineProps<{
  modelValue: NodeFilter;
  sort: NodeSortKey;
  dir: "asc" | "desc";
  /** Proxy types present in the list (lower-case). */
  types: string[];
  /** Subscriptions to filter by; omit to hide the subscription filter. */
  subscriptions?: { id: string; name: string }[];
  /** Shown / total, for the count label. */
  shown: number;
  total: number;
}>();
const emit = defineEmits<{
  (e: "update:modelValue", value: NodeFilter): void;
  (e: "update:sort", value: NodeSortKey): void;
  (e: "update:dir", value: "asc" | "desc"): void;
}>();

const { t } = useI18n();

function set<K extends keyof NodeFilter>(key: K, value: NodeFilter[K]) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}

const active = computed(() => nodeFilterActive(props.modelValue));
</script>

<template>
  <div class="flex flex-wrap items-center gap-2">
    <div class="relative min-w-[12rem] flex-1 sm:max-w-xs">
      <UiIcon name="search" :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
      <input
        :value="modelValue.query"
        type="search"
        class="input input-sm pl-8"
        :placeholder="t('clash.filters.search')"
        :aria-label="t('clash.filters.search')"
        @input="set('query', ($event.target as HTMLInputElement).value)"
      />
    </div>
    <UiSelect
      :model-value="modelValue.status"
      class="select input-sm w-auto min-w-[8rem]"
      :aria-label="t('clash.filters.status')"
      @update:model-value="set('status', $event as NodeFilter['status'])"
    >
      <option value="all">{{ t("clash.filters.allStatuses") }}</option>
      <option v-for="s in NODE_STATUSES" :key="s" :value="s">{{ t(`clash.filters.statuses.${s}`) }}</option>
    </UiSelect>
    <UiSelect
      :model-value="modelValue.bind"
      class="select input-sm w-auto min-w-[8rem]"
      :aria-label="t('clash.filters.bind')"
      @update:model-value="set('bind', $event as NodeFilter['bind'])"
    >
      <option v-for="b in NODE_BIND_FILTERS" :key="b" :value="b">{{ t(`clash.filters.binds.${b}`) }}</option>
    </UiSelect>
    <UiSelect
      v-if="types.length > 1"
      :model-value="modelValue.type"
      class="select input-sm w-auto min-w-[7rem]"
      :aria-label="t('clash.filters.type')"
      @update:model-value="set('type', String($event))"
    >
      <option value="all">{{ t("clash.filters.allTypes") }}</option>
      <option v-for="ty in types" :key="ty" :value="ty">{{ ty.toUpperCase() }}</option>
    </UiSelect>
    <UiSelect
      v-if="subscriptions && subscriptions.length > 1"
      :model-value="modelValue.subscriptionId"
      class="select input-sm w-auto min-w-[9rem]"
      :aria-label="t('clash.filters.subscription')"
      @update:model-value="set('subscriptionId', String($event))"
    >
      <option value="all">{{ t("clash.filters.allSubscriptions") }}</option>
      <option v-for="s in subscriptions" :key="s.id" :value="s.id">{{ s.name }}</option>
    </UiSelect>
    <div class="flex items-center gap-1">
      <UiSelect
        :model-value="sort"
        class="select input-sm w-auto"
        :aria-label="t('clash.filters.sort')"
        @update:model-value="emit('update:sort', $event as NodeSortKey)"
      >
        <option v-for="k in NODE_SORT_KEYS" :key="k" :value="k">{{ t(`clash.filters.sorts.${k}`) }}</option>
      </UiSelect>
      <button
        v-if="sort !== 'recommended'"
        type="button"
        class="btn btn-ghost btn-sm px-2"
        :title="dir === 'asc' ? t('clash.filters.asc') : t('clash.filters.desc')"
        :aria-label="dir === 'asc' ? t('clash.filters.asc') : t('clash.filters.desc')"
        @click="emit('update:dir', dir === 'asc' ? 'desc' : 'asc')"
      >
        <UiIcon :name="dir === 'asc' ? 'arrow-up' : 'arrow-down'" :size="13" />
      </button>
    </div>
    <span class="ml-auto text-2xs text-fg-subtle">{{ t("clash.filters.count", { shown, total }) }}</span>
    <button v-if="active" type="button" class="btn btn-ghost btn-xs" @click="emit('update:modelValue', { ...EMPTY_NODE_FILTER })">
      <UiIcon name="x" :size="12" />
      {{ t("clash.filters.clear") }}
    </button>
  </div>
</template>
