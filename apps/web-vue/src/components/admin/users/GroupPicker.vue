<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { GroupItem } from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";

/** Toggle-chip multi-select of exclusive groups a user may bind keys to. */
const props = defineProps<{
  groups: GroupItem[];
  disabled?: boolean;
}>();
const model = defineModel<string[]>({ required: true });

const { t } = useI18n();

const selected = computed(() => new Set(model.value));

function toggle(id: string) {
  if (props.disabled) return;
  const next = new Set(model.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  model.value = [...next];
}
</script>

<template>
  <div>
    <div class="mb-1.5 flex items-baseline justify-between gap-3">
      <span class="label mb-0">{{ t("adminUsers.form.allowedGroups") }}</span>
      <span v-if="groups.length" class="text-2xs tabular-nums text-fg-subtle">
        {{ t("adminUsers.form.selectedGroups", { n: groups.filter((g) => selected.has(g.id)).length }) }}
      </span>
    </div>
    <div
      class="rounded-lg border border-line bg-surface-2/40 p-2"
      role="group"
      :aria-label="t('adminUsers.form.allowedGroups')"
    >
      <p v-if="groups.length === 0" class="flex items-center gap-2 px-1.5 py-1 text-xs text-fg-subtle">
        <UiIcon name="lock" :size="13" />
        {{ t("adminUsers.form.noExclusiveGroups") }}
      </p>
      <div v-else class="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
        <button
          v-for="g in groups"
          :key="g.id"
          type="button"
          role="checkbox"
          :aria-checked="selected.has(g.id)"
          :disabled="disabled"
          class="inline-flex h-7 max-w-full cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-[color,background-color,border-color] duration-150 disabled:cursor-not-allowed disabled:opacity-60"
          :class="
            selected.has(g.id)
              ? 'border-violet/30 bg-violet/10 text-violet'
              : 'border-line bg-surface text-fg-muted hover:border-line-strong hover:text-fg dark:bg-surface-2/60'
          "
          :title="g.description || g.name"
          @click="toggle(g.id)"
        >
          <UiIcon :name="selected.has(g.id) ? 'check' : 'plus'" :size="12" />
          <span class="truncate">{{ g.name }}</span>
          <span v-if="!g.enabled" class="text-2xs text-fg-subtle">· {{ t("common.disabled") }}</span>
        </button>
      </div>
    </div>
    <p class="hint">{{ t("adminUsers.form.allowedGroupsHint") }}</p>
  </div>
</template>
