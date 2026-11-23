<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BackupRecord } from "@slipgate/contracts";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import BackupSummary from "./BackupSummary.vue";

/** Monthly archive copies are protected: deleting one is an explicit, separate confirmation. */
const props = defineProps<{ open: boolean; record: BackupRecord | null; busy: boolean; error: string | null }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "confirm", record: BackupRecord): void }>();

const { t } = useI18n();
const armed = ref(false);

watch(
  () => props.open,
  () => (armed.value = false),
);
</script>

<template>
  <UiModal :open="open" width="md" :title="t('dbBackups.deleteArchive.title')" :persistent="busy" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-danger h-8 w-8"><UiIcon name="trash" :size="15" /></span>
    </template>
    <div v-if="record" class="space-y-4">
      <BackupSummary :record="record" tone="danger" />
      <p class="text-sm leading-relaxed text-fg-muted">{{ t("dbBackups.deleteArchive.body", { file: record.fileName }) }}</p>
      <p v-if="record.monthlyArchive" class="flex items-center gap-1.5 text-xs text-fg-subtle">
        <UiIcon name="calendar" :size="13" class="shrink-0" />
        {{ t("dbBackups.history.archiveDates", { dates: record.monthlyArchive.dates.join(" / ") }) }}
      </p>
      <label class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-xs text-fg transition-colors hover:bg-surface-2/50">
        <input v-model="armed" type="checkbox" class="checkbox mt-px shrink-0" :disabled="busy" />
        <span>{{ t("dbBackups.deleteArchive.ack") }}</span>
      </label>
      <UiAlert v-if="error" tone="danger">{{ error }}</UiAlert>
    </div>
    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button type="button" class="btn btn-danger-solid" :disabled="busy || !armed || !record" @click="record && emit('confirm', record)">
        <UiIcon :name="busy ? 'loader' : 'trash'" :size="15" :spin="busy" />
        {{ busy ? t("dbBackups.deleteArchive.deleting") : t("dbBackups.deleteArchive.action") }}
      </button>
    </template>
  </UiModal>
</template>
