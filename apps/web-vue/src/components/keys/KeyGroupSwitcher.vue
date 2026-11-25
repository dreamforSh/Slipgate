<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiKeyItem, GroupItem } from "@slipgate/contracts";
import UiIcon from "../ui/UiIcon.vue";
import UiSelect from "../ui/UiSelect.vue";

/**
 * Inline group picker for a key row. A native select so the table's scroller cannot clip
 * it; the parent PATCHes `groupId` on change and passes `busy` meanwhile.
 */
const props = withDefaults(defineProps<{ item: ApiKeyItem; groups: GroupItem[]; busy?: boolean }>(), { busy: false });
const emit = defineEmits<{ (e: "change", groupId: string): void }>();

const { t } = useI18n();

/** The key's current group may be hidden from the user's list (disabled or no longer granted). */
const missing = computed(() => !props.groups.some((g) => g.id === props.item.groupId));

/** The select is controlled by `item.groupId`, so it stays put until the parent confirms. */
function onChange(value: unknown) {
  const next = String(value ?? "");
  if (next && next !== props.item.groupId) emit("change", next);
}
</script>

<template>
  <label class="group/sw relative inline-flex max-w-full items-center">
    <span class="sr-only">{{ t("user.keys.switchGroup", { name: item.name }) }}</span>
    <UiSelect
      :model-value="item.groupId"
      :chevron="false"
      :disabled="busy"
      class="h-7 max-w-[11rem] cursor-pointer appearance-none truncate rounded-md border border-transparent bg-surface-2/70 py-0 pl-2 pr-7 text-xs font-medium text-fg outline-none transition-[border-color,background-color,box-shadow] duration-150 hover:border-line-strong hover:bg-surface focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-wait disabled:opacity-70 dark:bg-surface-2/50"
      :title="t('user.keys.switchGroup', { name: item.name })"
      @change="onChange"
    >
      <option v-if="missing" :value="item.groupId" disabled>{{ t("user.keys.groupUnavailable", { name: item.groupName }) }}</option>
      <option v-for="g in groups" :key="g.id" :value="g.id">
        {{ g.name }}{{ g.rateMultiplier !== 1 ? ` · ×${g.rateMultiplier}` : "" }}
      </option>
    </UiSelect>
    <UiIcon
      :name="busy ? 'loader' : 'chevron-down'"
      :size="13"
      :spin="busy"
      class="pointer-events-none absolute right-2 text-fg-subtle transition-colors group-hover/sw:text-fg"
    />
  </label>
</template>
