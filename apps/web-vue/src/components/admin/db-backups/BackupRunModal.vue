<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BackupRecord, CreateBackupRequest } from "@slipgate/contracts";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { apiJson } from "../../../lib/api";
import { formatDateShort } from "../../../lib/format";
import { backupErrorText, DB_BACKUP_API } from "./dbBackupUtil";

/** "Back up now": pick how long the manual backup is kept, then start it (202, runs in the background). */
const props = defineProps<{ open: boolean; target: string }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "started", record: BackupRecord): void }>();

const { t } = useI18n();

type Preset = "7" | "14" | "30" | "90" | "0" | "custom";
const PRESETS: { value: Preset; key: string }[] = [
  { value: "7", key: "d7" },
  { value: "14", key: "d14" },
  { value: "30", key: "d30" },
  { value: "90", key: "d90" },
  { value: "0", key: "never" },
  { value: "custom", key: "custom" },
];

const preset = ref<Preset>("14");
const custom = ref<number | string>(14);
const busy = ref(false);
const failure = ref<string | null>(null);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    preset.value = "14";
    custom.value = 14;
    failure.value = null;
  },
);

const days = computed<number | null>(() => {
  if (preset.value !== "custom") return Number(preset.value);
  const n = typeof custom.value === "number" ? custom.value : Number(custom.value);
  return custom.value !== "" && Number.isInteger(n) && n >= 0 && n <= 3650 ? n : null;
});

const expiryText = computed(() => {
  if (days.value === null) return t("dbBackups.run.invalid");
  if (days.value === 0) return t("dbBackups.run.keepForever");
  return t("dbBackups.run.expireOn", { date: formatDateShort(new Date(Date.now() + days.value * 86_400_000).toISOString()) });
});

async function start() {
  if (busy.value || days.value === null) return;
  busy.value = true;
  failure.value = null;
  try {
    const body: CreateBackupRequest = { expireDays: days.value };
    const record = await apiJson<BackupRecord>(DB_BACKUP_API, { method: "POST", body, fallbackError: t("dbBackups.run.startFailed") });
    emit("started", record);
    emit("update:open", false);
  } catch (err) {
    failure.value = backupErrorText(err, t("dbBackups.run.startFailed"));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal :open="open" width="md" :title="t('dbBackups.run.title')" :persistent="busy" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="database" :size="15" /></span>
    </template>

    <form id="db-backup-run-form" class="space-y-5" novalidate @submit.prevent="start">
      <p class="text-sm leading-relaxed text-fg-muted">{{ t("dbBackups.run.body") }}</p>

      <fieldset>
        <legend class="label">{{ t("dbBackups.run.expire") }}</legend>
        <div class="grid grid-cols-3 gap-2 sm:grid-cols-6">
          <button
            v-for="p in PRESETS"
            :key="p.value"
            type="button"
            :aria-pressed="preset === p.value"
            :disabled="busy"
            class="h-9 rounded-lg border px-2 text-xs font-medium transition-[border-color,background-color,color] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
            :class="
              preset === p.value
                ? 'border-accent bg-accent/[0.07] text-accent'
                : 'border-line text-fg-muted hover:border-line-strong hover:bg-surface-2/60 hover:text-fg'
            "
            @click="preset = p.value"
          >
            {{ t(`dbBackups.run.presets.${p.key}`) }}
          </button>
        </div>
      </fieldset>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <div v-if="preset === 'custom'">
          <label for="db-backup-run-days" class="label">{{ t("dbBackups.run.customLabel") }}</label>
          <div class="flex items-center gap-2">
            <input
              id="db-backup-run-days"
              v-model.number="custom"
              type="number"
              min="0"
              max="3650"
              step="1"
              inputmode="numeric"
              class="input w-32 tabular-nums"
              :class="days === null ? '!border-danger focus:!ring-danger/20' : ''"
              :disabled="busy"
              :aria-invalid="days === null || undefined"
            />
            <span class="text-xs text-fg-muted">{{ t("dbBackups.schedule.unitDays") }}</span>
          </div>
          <p class="hint">{{ t("dbBackups.run.customHint") }}</p>
        </div>
      </Transition>

      <ul class="space-y-1.5 rounded-xl border border-line bg-surface-2/40 px-3.5 py-3 text-xs text-fg-muted">
        <li class="flex items-start gap-2" :class="days === null ? 'text-danger' : ''" aria-live="polite">
          <UiIcon name="clock" :size="13" class="mt-px shrink-0" />
          <span class="min-w-0">{{ expiryText }}</span>
        </li>
        <li v-if="target" class="flex items-start gap-2">
          <UiIcon name="upload" :size="13" class="mt-px shrink-0" />
          <span class="min-w-0 break-all">{{ t("dbBackups.run.target", { target }) }}</span>
        </li>
      </ul>

      <UiAlert v-if="failure" tone="danger">{{ failure }}</UiAlert>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button type="submit" form="db-backup-run-form" class="btn btn-primary" :disabled="busy || days === null">
        <UiIcon :name="busy ? 'loader' : 'play'" :size="15" :spin="busy" />
        {{ busy ? t("dbBackups.run.starting") : t("dbBackups.run.action") }}
      </button>
    </template>
  </UiModal>
</template>
