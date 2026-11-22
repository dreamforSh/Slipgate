<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AccountImportResult } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";

/** Created / skipped / failed counts of an import, with the non-created items listed. */
const props = defineProps<{
  result: AccountImportResult;
  /** Resolves `duplicateOf` account ids to names. */
  accountNames?: ReadonlyMap<string, string>;
}>();

const { t } = useI18n();
const expanded = ref(true);

const issues = computed(() => props.result.results.filter((r) => r.outcome !== "created"));

function issueText(item: AccountImportResult["results"][number]): string {
  if (item.duplicateOf) {
    return t("accounts.importResult.duplicateOf", { name: props.accountNames?.get(item.duplicateOf) ?? item.duplicateOf });
  }
  if (item.duplicateOfIndex !== undefined) {
    return t("accounts.importResult.duplicateOfItem", { n: item.duplicateOfIndex + 1 });
  }
  return item.message ?? "";
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-1.5">
      <UiBadge tone="success" dot>{{ t("accounts.importResult.created", { n: result.created }) }}</UiBadge>
      <UiBadge :tone="result.skipped ? 'warning' : 'neutral'" dot>
        {{ t("accounts.importResult.skipped", { n: result.skipped }) }}
      </UiBadge>
      <UiBadge :tone="result.failed ? 'danger' : 'neutral'" dot>
        {{ t("accounts.importResult.failed", { n: result.failed }) }}
      </UiBadge>
      <button
        v-if="issues.length"
        type="button"
        class="ml-auto inline-flex cursor-pointer items-center gap-1 text-xs text-fg-muted hover:text-fg"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ t("accounts.importResult.details") }}
        <UiIcon name="chevron-down" :size="12" class="transition-transform" :class="expanded ? 'rotate-180' : ''" />
      </button>
    </div>
    <ul v-if="expanded && issues.length" class="max-h-48 space-y-1 overflow-y-auto rounded-lg bg-surface-2/60 p-2 text-xs">
      <li v-for="item in issues" :key="item.index" class="flex min-w-0 items-start gap-2">
        <UiIcon
          :name="item.outcome === 'failed' ? 'x-circle' : 'info'"
          :size="13"
          class="mt-0.5"
          :class="item.outcome === 'failed' ? 'text-danger' : 'text-warning'"
        />
        <span class="shrink-0 font-mono text-fg-subtle">#{{ item.index + 1 }}</span>
        <span class="shrink-0 font-medium text-fg">{{ item.name }}</span>
        <span class="min-w-0 break-words text-fg-muted">{{ issueText(item) }}</span>
      </li>
    </ul>
  </div>
</template>
