<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiIcon from "../ui/UiIcon.vue";
import { USAGE_RANGES, toDatetimeLocal, type UsageFilters, type UsageRange } from "./useUsageLogs";
import UiSelect from "../ui/UiSelect.vue";

/** Time window, group, model, outcome and (admin) user / (self) API-key filters. */
defineProps<{
  mode: "admin" | "user";
  groups: { id: string; name: string }[];
  apiKeys?: { id: string; name: string; groupName: string }[];
  rangeInvalid: boolean;
  hasFilters: boolean;
}>();
const model = defineModel<UsageFilters>({ required: true });
const emit = defineEmits<{ (e: "reset"): void }>();

const { t } = useI18n();

const rangeOptions = computed(() => USAGE_RANGES.map((value) => ({ value, label: t(`usageLogs.ranges.${value}`) })));

function set<K extends keyof UsageFilters>(key: K, value: UsageFilters[K]) {
  model.value = { ...model.value, [key]: value };
}

function setRange(range: UsageRange) {
  if (range === "custom" && (!model.value.start || !model.value.end)) {
    const now = Date.now();
    model.value = {
      ...model.value,
      range,
      start: model.value.start || toDatetimeLocal(now - 7 * 86_400_000),
      end: model.value.end || toDatetimeLocal(now),
    };
    return;
  }
  set("range", range);
}

function inputValue(ev: Event): string {
  return (ev.target as HTMLInputElement | HTMLSelectElement).value;
}
</script>

<template>
  <div class="card p-3 sm:p-4">
    <div class="flex flex-wrap items-center gap-2">
      <SegmentedControl
        :model-value="model.range"
        :options="rangeOptions"
        :aria-label="t('usageLogs.filters.range')"
        @update:model-value="setRange"
      />
      <Transition
        enter-active-class="transition duration-200 ease-out"
        leave-active-class="transition duration-150 ease-in"
        enter-from-class="-translate-x-1 opacity-0"
        leave-to-class="-translate-x-1 opacity-0"
      >
        <div v-if="model.range === 'custom'" class="flex flex-wrap items-center gap-1.5">
          <label class="sr-only" for="usage-start">{{ t("usageLogs.filters.start") }}</label>
          <input
            id="usage-start"
            type="datetime-local"
            class="input input-sm w-auto"
            :class="rangeInvalid ? '!border-danger' : ''"
            :value="model.start"
            :max="model.end || undefined"
            @change="set('start', inputValue($event))"
          />
          <UiIcon name="arrow-right" :size="13" class="text-fg-subtle" />
          <label class="sr-only" for="usage-end">{{ t("usageLogs.filters.end") }}</label>
          <input
            id="usage-end"
            type="datetime-local"
            class="input input-sm w-auto"
            :class="rangeInvalid ? '!border-danger' : ''"
            :value="model.end"
            :min="model.start || undefined"
            @change="set('end', inputValue($event))"
          />
        </div>
      </Transition>
      <p v-if="rangeInvalid" class="flex items-center gap-1 text-xs text-danger animate-fade-in">
        <UiIcon name="alert" :size="12" />
        {{ t("usageLogs.filters.invalidRange") }}
      </p>
    </div>

    <div class="mt-3 flex flex-wrap items-center gap-2">
      <UiSelect
        v-if="mode === 'user' && apiKeys"
        class="select input-sm w-auto min-w-[9rem] max-w-full"
        :aria-label="t('usageLogs.filters.apiKey')"
        :model-value="model.apiKeyId"
        @change="set('apiKeyId', String($event))"
      >
        <option value="">{{ t("usageLogs.filters.allKeys") }}</option>
        <option v-for="k in apiKeys" :key="k.id" :value="k.id">{{ k.name }} · {{ k.groupName }}</option>
      </UiSelect>
      <label v-if="mode === 'admin'" class="relative min-w-[10rem] flex-1 sm:max-w-[14rem]">
        <span class="sr-only">{{ t("usageLogs.filters.userId") }}</span>
        <UiIcon name="user" :size="13" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <input
          type="search"
          class="input input-sm pl-8 font-mono"
          spellcheck="false"
          :placeholder="t('usageLogs.filters.userIdPlaceholder')"
          :value="model.userId"
          @input="set('userId', inputValue($event))"
        />
      </label>
      <UiSelect
        class="select input-sm w-auto min-w-[8.5rem] max-w-full"
        :aria-label="t('usageLogs.filters.group')"
        :model-value="model.groupId"
        @change="set('groupId', String($event))"
      >
        <option value="">{{ t("usageLogs.filters.allGroups") }}</option>
        <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
      </UiSelect>
      <label class="relative min-w-[10rem] flex-1 sm:max-w-[14rem]">
        <span class="sr-only">{{ t("usageLogs.filters.model") }}</span>
        <UiIcon name="cpu" :size="13" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
        <input
          type="search"
          class="input input-sm pl-8"
          spellcheck="false"
          :placeholder="t('usageLogs.filters.modelPlaceholder')"
          :value="model.model"
          @input="set('model', inputValue($event))"
        />
      </label>
      <UiSelect
        class="select input-sm w-auto min-w-[7.5rem]"
        :aria-label="t('usageLogs.filters.outcome')"
        :model-value="model.outcome"
        @change="set('outcome', $event as UsageFilters['outcome'])"
      >
        <option value="">{{ t("usageLogs.filters.allOutcomes") }}</option>
        <option value="success">{{ t("usageLogs.filters.success") }}</option>
        <option value="error">{{ t("usageLogs.filters.error") }}</option>
      </UiSelect>
      <button
        v-if="hasFilters"
        type="button"
        class="btn btn-ghost btn-sm animate-fade-in"
        @click="emit('reset')"
      >
        <UiIcon name="x" :size="13" />
        {{ t("usageLogs.filters.reset") }}
      </button>
    </div>
  </div>
</template>
