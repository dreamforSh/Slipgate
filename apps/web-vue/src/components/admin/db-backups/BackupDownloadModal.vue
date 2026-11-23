<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BackupDownloadResponse, BackupRecord } from "@slipgate/contracts";
import CopyButton from "../../ui/CopyButton.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { apiJson } from "../../../lib/api";
import { formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import BackupStepUpFields from "./BackupStepUpFields.vue";
import BackupSummary from "./BackupSummary.vue";
import { backupErrorText, DB_BACKUP_API, formatSize, formatStamp } from "./dbBackupUtil";
import { useBackupStepUp } from "./useBackupStepUp";

/**
 * Download: re-check the password (and two-factor code), then hand out short-lived signed links,
 * one per stored part. A single-part backup starts downloading right away.
 */
const props = defineProps<{ open: boolean; record: BackupRecord | null }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const { t } = useI18n();
const toast = useToastStore();
const stepUp = useBackupStepUp();

const busy = ref(false);
const result = ref<BackupDownloadResponse | null>(null);
const fields = ref<InstanceType<typeof BackupStepUpFields> | null>(null);

watch(
  () => props.open,
  (open) => {
    result.value = null;
    busy.value = false;
    if (open) stepUp.reset();
    else stepUp.dispose();
  },
);

const canSubmit = computed(() => !busy.value && stepUp.ready.value);

function startDownload(url: string, fileName: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function submit() {
  const record = props.record;
  if (!record || !canSubmit.value) return;
  busy.value = true;
  stepUp.clearErrors();
  try {
    const res = await apiJson<BackupDownloadResponse>(`${DB_BACKUP_API}/${record.id}/download`, {
      method: "POST",
      body: stepUp.payload(),
      fallbackError: t("dbBackups.download.failed"),
    });
    stepUp.dispose();
    result.value = res;
    const only = res.parts.length === 1 ? res.parts[0] : undefined;
    if (only) {
      startDownload(only.url, only.fileName);
      toast.success(t("dbBackups.download.started", { file: only.fileName }));
    }
  } catch (err) {
    if (!stepUp.absorb(err)) stepUp.formError.value = backupErrorText(err, t("dbBackups.download.failed"));
    if (stepUp.codeError.value) {
      await nextTick();
      fields.value?.focusCode();
    }
  } finally {
    busy.value = false;
  }
}

function again() {
  result.value = null;
  stepUp.reset();
}

const multi = computed(() => (result.value?.parts.length ?? 0) > 1);
const unixJoin = computed(() => (result.value ? `cat ${result.value.fileName}.part-* > ${result.value.fileName}` : ""));
const windowsJoin = computed(() =>
  result.value ? `copy /b ${result.value.parts.map((p) => p.fileName).join("+")} ${result.value.fileName}` : "",
);
</script>

<template>
  <UiModal
    :open="open"
    :width="result && multi ? 'lg' : 'md'"
    :title="t('dbBackups.download.title')"
    :persistent="busy"
    @update:open="emit('update:open', $event)"
  >
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="download" :size="15" /></span>
    </template>

    <div v-if="record" class="space-y-4">
      <BackupSummary :record="record" />

      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <!-- Step 1: re-authenticate -->
        <form v-if="!result" key="auth" id="db-backup-download-form" class="space-y-4" novalidate @submit.prevent="submit">
          <p class="flex items-start gap-2 text-xs leading-relaxed text-fg-muted">
            <UiIcon name="lock" :size="13" class="mt-px shrink-0 text-fg-subtle" />
            {{ t("dbBackups.download.intro") }}
          </p>
          <BackupStepUpFields
            ref="fields"
            v-model:password="stepUp.password.value"
            v-model:code="stepUp.code.value"
            id-prefix="db-backup-download"
            :need-totp="stepUp.needTotp.value"
            :checking="stepUp.checking.value"
            :disabled="busy"
            :password-error="stepUp.passwordError.value"
            :code-error="stepUp.codeError.value"
            @complete="submit"
          />
          <UiAlert v-if="stepUp.formError.value" tone="danger">{{ stepUp.formError.value }}</UiAlert>
        </form>

        <!-- Step 2: links -->
        <div v-else key="links" class="space-y-4">
          <UiAlert tone="success" :title="t('dbBackups.download.ready')">
            <span :title="formatStamp(result.expiresAtIso)">
              {{ t("dbBackups.download.expires", { time: formatStamp(result.expiresAtIso) }) }}
              ({{ formatRelative(result.expiresAtIso) }})
            </span>
          </UiAlert>

          <p v-if="multi" class="text-xs leading-relaxed text-fg-muted">
            {{ t("dbBackups.download.multiBody", { n: result.parts.length, file: result.fileName }) }}
          </p>

          <ul class="divide-y divide-line/60 overflow-hidden rounded-xl border border-line">
            <li v-for="p in result.parts" :key="p.index" class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-3 sm:flex-nowrap sm:px-4">
              <span class="icon-chip h-8 w-8 font-mono text-2xs font-semibold tabular-nums">{{ p.index }}</span>
              <div class="min-w-0 flex-1">
                <p class="truncate font-mono text-xs text-fg" :title="p.fileName">
                  <span v-if="multi" class="mr-1.5 font-sans text-fg-subtle">{{ t("dbBackups.download.part", { n: p.index }) }}</span>
                  {{ p.fileName }}
                </p>
                <p class="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-fg-subtle">
                  <span class="shrink-0 tabular-nums">{{ formatSize(p.sizeBytes) }}</span>
                  <span aria-hidden="true">·</span>
                  <span class="shrink-0">SHA-256</span>
                  <code class="min-w-0 truncate font-mono" :title="p.sha256">{{ p.sha256 }}</code>
                  <CopyButton :text="p.sha256" />
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1.5 max-sm:w-full max-sm:[&>*]:flex-1">
                <a
                  v-if="p.presignedUrl"
                  :href="p.presignedUrl"
                  class="btn btn-ghost btn-sm"
                  rel="noopener noreferrer"
                  :title="t('dbBackups.download.directHint')"
                >
                  <UiIcon name="external-link" :size="13" />
                  {{ t("dbBackups.download.direct") }}
                </a>
                <a :href="p.url" :download="p.fileName" class="btn btn-primary btn-sm" rel="noopener">
                  <UiIcon name="download" :size="13" />
                  {{ t("dbBackups.download.download") }}
                </a>
              </div>
            </li>
          </ul>

          <div v-if="multi" class="grid gap-2 sm:grid-cols-2">
            <div v-for="cmd in [{ k: 'unix', v: unixJoin }, { k: 'windows', v: windowsJoin }]" :key="cmd.k" class="min-w-0">
              <p class="label">{{ t(`dbBackups.download.${cmd.k}`) }}</p>
              <div class="flex min-w-0 items-center gap-1 rounded-lg border border-line bg-surface-2/50 py-1 pl-3 pr-1">
                <code class="min-w-0 flex-1 truncate font-mono text-2xs text-fg" :title="cmd.v">{{ cmd.v }}</code>
                <CopyButton :text="cmd.v" />
              </div>
            </div>
          </div>

          <ul class="space-y-1.5 text-2xs leading-relaxed text-fg-subtle">
            <li class="flex items-start gap-1.5"><UiIcon name="shield" :size="12" class="mt-px shrink-0" />{{ t("dbBackups.download.verify") }}</li>
            <li class="flex items-start gap-1.5"><UiIcon name="info" :size="12" class="mt-px shrink-0" />{{ t("dbBackups.download.restoreHint") }}</li>
            <li v-if="result.parts.some((p) => p.presignedUrl)" class="flex items-start gap-1.5">
              <UiIcon name="external-link" :size="12" class="mt-px shrink-0" />{{ t("dbBackups.download.directHint") }}
            </li>
          </ul>
        </div>
      </Transition>
    </div>

    <template #footer>
      <template v-if="!result">
        <button type="button" class="btn btn-secondary" :disabled="busy" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
        <button type="submit" form="db-backup-download-form" class="btn btn-primary" :disabled="!canSubmit">
          <UiIcon :name="busy ? 'loader' : 'download'" :size="15" :spin="busy" />
          {{ busy ? t("dbBackups.download.preparing") : t("dbBackups.download.action") }}
        </button>
      </template>
      <template v-else>
        <button type="button" class="btn btn-ghost" @click="again">
          <UiIcon name="refresh" :size="14" />
          {{ t("dbBackups.download.again") }}
        </button>
        <button type="button" class="btn btn-primary" @click="emit('update:open', false)">{{ t("common.close") }}</button>
      </template>
    </template>
  </UiModal>
</template>
