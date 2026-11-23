<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BackupRecord, RestoreBackupRequest } from "@slipgate/contracts";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { ApiError, apiJson } from "../../../lib/api";
import BackupStepUpFields from "./BackupStepUpFields.vue";
import BackupSummary from "./BackupSummary.vue";
import { backupErrorText, DB_BACKUP_API } from "./dbBackupUtil";
import { useBackupStepUp } from "./useBackupStepUp";

/**
 * Restore replaces the whole database. The admin types the backup id by hand and re-enters the
 * password (and two-factor code); the server checks all of it again.
 */
const props = defineProps<{ open: boolean; record: BackupRecord | null }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "started", record: BackupRecord): void }>();

const { t } = useI18n();
const stepUp = useBackupStepUp();

const confirmText = ref("");
const confirmError = ref<string | null>(null);
const busy = ref(false);
const fields = ref<InstanceType<typeof BackupStepUpFields> | null>(null);

watch(
  () => props.open,
  (open) => {
    confirmText.value = "";
    confirmError.value = null;
    busy.value = false;
    if (open) stepUp.reset();
    else stepUp.dispose();
  },
);

watch(confirmText, () => (confirmError.value = null));

const confirmed = computed(() => Boolean(props.record) && confirmText.value.trim() === props.record?.id);
const canSubmit = computed(() => !busy.value && confirmed.value && stepUp.ready.value);

async function submit() {
  const record = props.record;
  if (!record || !canSubmit.value) return;
  busy.value = true;
  stepUp.clearErrors();
  try {
    const body: RestoreBackupRequest = { ...stepUp.payload(), confirm: confirmText.value.trim() };
    const started = await apiJson<BackupRecord>(`${DB_BACKUP_API}/${record.id}/restore`, {
      method: "POST",
      body,
      fallbackError: t("dbBackups.restore.startFailed"),
    });
    emit("started", started);
    emit("update:open", false);
  } catch (err) {
    if (err instanceof ApiError && err.code === "confirm_mismatch") confirmError.value = backupErrorText(err, "");
    else if (!stepUp.absorb(err)) stepUp.formError.value = backupErrorText(err, t("dbBackups.restore.startFailed"));
    if (stepUp.codeError.value) {
      await nextTick();
      fields.value?.focusCode();
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UiModal :open="open" width="md" :title="t('dbBackups.restore.title')" :persistent="busy" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-danger h-8 w-8"><UiIcon name="rotate-ccw" :size="15" /></span>
    </template>

    <form v-if="record" id="db-backup-restore-form" class="space-y-4" novalidate @submit.prevent="submit">
      <UiAlert tone="danger" :title="t('dbBackups.restore.warningTitle')">
        <p>{{ t("dbBackups.restore.warning") }}</p>
      </UiAlert>

      <div>
        <p class="label">{{ t("dbBackups.restore.backupLabel") }}</p>
        <BackupSummary :record="record" tone="danger" />
      </div>

      <ul class="space-y-1.5 text-xs leading-relaxed text-fg-muted">
        <li class="flex items-start gap-2"><UiIcon name="shield" :size="13" class="mt-px shrink-0 text-success" />{{ t("dbBackups.restore.safety") }}</li>
        <li class="flex items-start gap-2"><UiIcon name="log-in" :size="13" class="mt-px shrink-0 text-warning" />{{ t("dbBackups.restore.session") }}</li>
      </ul>

      <div class="border-t border-line/70 pt-4">
        <label for="db-backup-restore-confirm" class="label">
          {{ t("dbBackups.restore.confirmLabel") }}
          <span class="text-danger">*</span>
        </label>
        <div class="relative">
          <input
            id="db-backup-restore-confirm"
            v-model="confirmText"
            type="text"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            maxlength="64"
            class="input pr-9 font-mono"
            :class="confirmError ? '!border-danger focus:!ring-danger/20' : confirmed ? '!border-success/60' : ''"
            :placeholder="record.id"
            :disabled="busy"
            :aria-invalid="Boolean(confirmError) || undefined"
            aria-describedby="db-backup-restore-confirm-hint"
          />
          <Transition
            enter-active-class="transition duration-150 ease-out motion-reduce:transition-none"
            enter-from-class="scale-50 opacity-0"
            leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
            leave-to-class="scale-50 opacity-0"
          >
            <UiIcon v-if="confirmed" name="check-circle" :size="15" class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-success" />
          </Transition>
        </div>
        <p v-if="confirmError" class="mt-1 flex items-start gap-1 text-xs text-danger" role="alert">
          <UiIcon name="alert" :size="12" class="mt-0.5" />
          {{ confirmError }}
        </p>
        <p v-else id="db-backup-restore-confirm-hint" class="hint">
          {{ t("dbBackups.restore.confirmHint", { id: record.id }) }}
        </p>
      </div>

      <BackupStepUpFields
        ref="fields"
        v-model:password="stepUp.password.value"
        v-model:code="stepUp.code.value"
        id-prefix="db-backup-restore"
        :need-totp="stepUp.needTotp.value"
        :checking="stepUp.checking.value"
        :disabled="busy"
        :password-error="stepUp.passwordError.value"
        :code-error="stepUp.codeError.value"
      />

      <UiAlert v-if="stepUp.formError.value" tone="danger">{{ stepUp.formError.value }}</UiAlert>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
      <button type="submit" form="db-backup-restore-form" class="btn btn-danger-solid" :disabled="!canSubmit">
        <UiIcon :name="busy ? 'loader' : 'rotate-ccw'" :size="15" :spin="busy" />
        {{ busy ? t("dbBackups.restore.submitting") : t("dbBackups.restore.action") }}
      </button>
    </template>
  </UiModal>
</template>
