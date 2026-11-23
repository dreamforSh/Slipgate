<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { SystemLogCleanupRequest, SystemLogCleanupResponse } from "@slipgate/contracts";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { apiJson } from "../../../lib/api";
import { formatNumber } from "../../../lib/format";
import SystemLogErrorMeta from "./SystemLogErrorMeta.vue";
import { describeError, type ErrorInfo } from "./systemLogUtil";

/**
 * Deletes every stored entry matching the filters the table shows (all pages, the searched
 * window included). The conditions are listed so nothing is deleted by surprise.
 */
const props = defineProps<{
  open: boolean;
  body: SystemLogCleanupRequest;
  /** What the request will match, as label/value rows. */
  conditions: { label: string; value: string }[];
  /** Matching rows in the current list (an estimate: new rows may arrive meanwhile). */
  matchCount: number;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "cleaned", deleted: number): void }>();

const { t } = useI18n();

const acknowledged = ref(false);
const busy = ref(false);
const failure = ref<ErrorInfo | null>(null);

watch(
  () => props.open,
  (open) => {
    acknowledged.value = false;
    failure.value = null;
    if (!open) busy.value = false;
  },
);

async function submit() {
  if (!acknowledged.value || busy.value) return;
  busy.value = true;
  failure.value = null;
  try {
    const res = await apiJson<SystemLogCleanupResponse>("/api/v1/admin/ops/system-logs/cleanup", {
      method: "POST",
      body: props.body,
      fallbackError: t("systemLogs.cleanup.failed"),
    });
    emit("cleaned", res.deleted);
    emit("update:open", false);
  } catch (err) {
    failure.value = describeError(err, t, t("systemLogs.cleanup.failed"));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal :open="open" width="md" :title="t('systemLogs.cleanup.title')" :persistent="busy" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-danger h-8 w-8">
        <UiIcon name="trash" :size="15" />
      </span>
    </template>

    <form id="system-log-cleanup-form" class="space-y-4" @submit.prevent="submit">
      <UiAlert tone="danger">
        {{ t("systemLogs.cleanup.warning", { n: formatNumber(matchCount) }) }}
      </UiAlert>

      <div>
        <p class="eyebrow mb-2">{{ t("systemLogs.cleanup.conditions") }}</p>
        <dl class="divide-y divide-line/60 rounded-xl border border-line">
          <div v-for="c in conditions" :key="c.label" class="flex items-start gap-3 px-4 py-2">
            <dt class="w-24 shrink-0 text-xs text-fg-subtle">{{ c.label }}</dt>
            <dd class="min-w-0 flex-1 break-all font-mono text-xs text-fg">{{ c.value }}</dd>
          </div>
        </dl>
      </div>

      <label class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3.5 py-3 transition-colors hover:bg-surface-2/50">
        <input v-model="acknowledged" type="checkbox" class="checkbox mt-0.5" :disabled="busy" />
        <span class="text-sm text-fg-muted">{{ t("systemLogs.cleanup.acknowledge") }}</span>
      </label>

      <Transition enter-active-class="transition duration-200 ease-out motion-reduce:transition-none" enter-from-class="-translate-y-1 opacity-0">
        <div v-if="failure" class="flex items-start gap-1.5 text-xs text-danger" role="alert">
          <UiIcon name="alert" :size="13" class="mt-0.5 shrink-0" />
          <div class="min-w-0">
            <p class="break-words">{{ failure.message }}</p>
            <SystemLogErrorMeta :error="failure" />
          </div>
        </div>
      </Transition>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('update:open', false)">
        {{ t("common.cancel") }}
      </button>
      <button type="submit" form="system-log-cleanup-form" class="btn btn-danger-solid" :disabled="busy || !acknowledged">
        <UiIcon :name="busy ? 'loader' : 'trash'" :size="15" :spin="busy" />
        {{ busy ? t("systemLogs.cleanup.deleting") : t("systemLogs.cleanup.submit") }}
      </button>
    </template>
  </UiModal>
</template>
