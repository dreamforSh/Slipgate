<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DB_BACKUP_DEFAULT_PREFIX, type BackupRecord, type BackupS3ConfigView } from "@slipgate/contracts";
import StatCard from "../../ui/StatCard.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { ApiError, apiJson } from "../../../lib/api";
import { formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import BackupDeleteArchiveModal from "./BackupDeleteArchiveModal.vue";
import BackupDetailDrawer from "./BackupDetailDrawer.vue";
import BackupDownloadModal from "./BackupDownloadModal.vue";
import BackupHistoryCard from "./BackupHistoryCard.vue";
import BackupLiveBanner from "./BackupLiveBanner.vue";
import BackupRestoreModal from "./BackupRestoreModal.vue";
import BackupRunModal from "./BackupRunModal.vue";
import { backupErrorText, DB_BACKUP_API, formatSize, formatStamp, isBusy } from "./dbBackupUtil";
import type { DbBackupsController } from "./useDbBackups";

/** The "Database backups" tab: status, live operation, key figures and the history with its actions. */
const props = defineProps<{ ctl: DbBackupsController }>();
const emit = defineEmits<{ (e: "configure"): void }>();

const { t } = useI18n();
const toast = useToastStore();

const status = computed(() => props.ctl.status);
const active = computed(() => props.ctl.active);
const restoring = computed(() => active.value?.kind === "restore");

/* ---------------- Availability ---------------- */

const unsupported = computed(() => (status.value && !status.value.supported ? status.value.reason ?? "check_failed" : null));
const storageMissing = computed(() => Boolean(status.value?.supported && !status.value.s3Configured));

const runBlock = computed<string | null>(() => {
  if (!status.value) return t("dbBackups.pageStatus.checking");
  if (!status.value.supported) return t("dbBackups.history.disabledUnsupported");
  if (!status.value.s3Configured) return t("dbBackups.history.disabledNoS3");
  if (props.ctl.busy) return t("dbBackups.history.disabledBusy");
  return null;
});

function blockFor(r: BackupRecord, action: "download" | "restore" | "delete"): string | null {
  if (action === "delete") return isBusy(r) || restoring.value ? t("dbBackups.history.disabledBusy") : null;
  if (r.status !== "completed") return t("dbBackups.history.disabledNotCompleted");
  if (status.value && !status.value.s3Configured) return t("dbBackups.history.disabledNoS3");
  if (action === "download") return restoring.value ? t("dbBackups.history.disabledBusy") : null;
  if (status.value && !status.value.supported) return t("dbBackups.history.disabledUnsupported");
  return props.ctl.busy ? t("dbBackups.history.disabledBusy") : null;
}

/* ---------------- Figures ---------------- */

const loaded = computed(() => props.ctl.recordsLoaded);
const lastOk = computed(() => props.ctl.records.find((r) => r.status === "completed") ?? null);
const completed = computed(() => props.ctl.records.filter((r) => r.status === "completed"));
const storedBytes = computed(() => completed.value.reduce((sum, r) => sum + r.sizeBytes, 0));
const archives = computed(() => props.ctl.records.filter((r) => r.monthlyArchive).length);
const nextRun = computed(() => (status.value?.schedule.enabled ? status.value.schedule.nextRunAtIso : null));
const activeRecord = computed(() => (active.value ? props.ctl.records.find((r) => r.id === active.value!.backupId) ?? null : null));

/* ---------------- Run now ---------------- */

const runOpen = ref(false);
const runTarget = ref("");

async function openRun() {
  if (runBlock.value) return;
  runOpen.value = true;
  try {
    const cfg = await apiJson<BackupS3ConfigView>(`${DB_BACKUP_API}/s3-config`);
    runTarget.value = cfg.bucket ? `s3://${cfg.bucket}/${cfg.prefix || DB_BACKUP_DEFAULT_PREFIX}/` : "";
  } catch {
    runTarget.value = "";
  }
}

function onStarted(record: BackupRecord) {
  props.ctl.follow("backup", record);
  toast.info(t("dbBackups.run.started"));
}

/* ---------------- Details, download, restore ---------------- */

const detailId = ref<string | null>(null);
const detail = computed(() => (detailId.value ? props.ctl.records.find((r) => r.id === detailId.value) ?? null : null));
const detailOpen = computed({
  get: () => Boolean(detail.value),
  set: (open: boolean) => {
    if (!open) detailId.value = null;
  },
});

const downloadRecord = ref<BackupRecord | null>(null);
const downloadOpen = ref(false);
const restoreRecord = ref<BackupRecord | null>(null);
const restoreOpen = ref(false);

function openDownload(r: BackupRecord) {
  if (blockFor(r, "download")) return;
  detailId.value = null;
  downloadRecord.value = r;
  downloadOpen.value = true;
}

function openRestore(r: BackupRecord) {
  if (blockFor(r, "restore")) return;
  detailId.value = null;
  restoreRecord.value = r;
  restoreOpen.value = true;
}

function onRestoreStarted(record: BackupRecord) {
  props.ctl.follow("restore", record);
  toast.warning(t("dbBackups.restore.started"));
}

/* ---------------- Delete ---------------- */

const deletingId = ref<string | null>(null);
const archiveRecord = ref<BackupRecord | null>(null);
const archiveOpen = ref(false);
const archiveError = ref<string | null>(null);

watch(archiveOpen, (open) => {
  if (!open) archiveError.value = null;
});

async function remove(r: BackupRecord, deleteArchived: boolean): Promise<boolean> {
  deletingId.value = r.id;
  try {
    await apiJson(`${DB_BACKUP_API}/${r.id}${deleteArchived ? "?deleteArchived=true" : ""}`, {
      method: "DELETE",
      fallbackError: t("dbBackups.history.deleteFailed"),
    });
    props.ctl.remove(r.id);
    if (detailId.value === r.id) detailId.value = null;
    toast.success(t("dbBackups.history.deleted"));
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === "backup_archive_protected" && !deleteArchived) {
      archiveRecord.value = r;
      archiveOpen.value = true;
    } else if (deleteArchived) {
      archiveError.value = backupErrorText(err, t("dbBackups.history.deleteFailed"));
    } else {
      toast.error(backupErrorText(err, t("dbBackups.history.deleteFailed")));
    }
    return false;
  } finally {
    deletingId.value = null;
  }
}

function onDelete(r: BackupRecord) {
  if (r.monthlyArchive) {
    detailId.value = null;
    archiveRecord.value = r;
    archiveOpen.value = true;
    return;
  }
  void remove(r, false);
}

async function confirmArchiveDelete(r: BackupRecord) {
  if (await remove(r, true)) archiveOpen.value = false;
}

const enter = "animate-slide-up [animation-fill-mode:both] motion-reduce:animate-none";
</script>

<template>
  <div class="space-y-6">
    <!-- Not available here -->
    <UiAlert v-if="unsupported" :tone="unsupported === 'check_failed' ? 'danger' : 'warning'" :title="t(`dbBackups.unsupported.${unsupported}.title`)">
      <p>{{ t(`dbBackups.unsupported.${unsupported}.body`) }}</p>
      <p v-if="status?.detail" class="mt-1.5 break-words font-mono text-2xs text-fg-subtle">
        {{ t("dbBackups.unsupported.detail", { detail: status.detail }) }}
      </p>
    </UiAlert>

    <UiAlert v-else-if="ctl.statusError && !status" tone="danger">
      {{ ctl.statusError }}
      <template #action>
        <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="ctl.statusLoading" @click="ctl.refreshAll()">
          {{ t("dbBackups.history.retry") }}
        </button>
      </template>
    </UiAlert>

    <!-- Storage not set up yet -->
    <section v-if="storageMissing && !active" class="card relative overflow-hidden p-5" :class="enter">
      <div class="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-accent/[0.07] blur-2xl" aria-hidden="true" />
      <div class="relative flex flex-wrap items-center gap-4">
        <span class="icon-chip icon-chip-accent h-11 w-11 rounded-xl"><UiIcon name="server" :size="20" /></span>
        <div class="min-w-0 flex-1 basis-60">
          <p class="text-sm font-semibold text-fg">{{ t("dbBackups.setup.title") }}</p>
          <p class="mt-1 text-xs leading-relaxed text-fg-muted">{{ t("dbBackups.setup.body") }}</p>
        </div>
        <button type="button" class="btn btn-primary max-sm:w-full" @click="emit('configure')">
          <UiIcon name="settings" :size="15" />
          {{ t("dbBackups.setup.action") }}
        </button>
      </div>
    </section>

    <!-- Running now -->
    <Transition
      enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
      enter-from-class="-translate-y-1 opacity-0"
      leave-active-class="transition duration-200 ease-in motion-reduce:transition-none"
      leave-to-class="-translate-y-1 opacity-0"
    >
      <BackupLiveBanner v-if="active" :op="active" :record="activeRecord" :now-ms="ctl.nowMs" />
    </Transition>

    <!-- Figures -->
    <div class="grid gap-3 min-[480px]:grid-cols-2 sm:gap-4 xl:grid-cols-4">
      <StatCard
        :class="enter"
        icon="check-circle"
        tone="success"
        :label="t('dbBackups.stats.last')"
        :value="!loaded ? '—' : lastOk ? formatRelative(lastOk.finishedAtIso ?? lastOk.startedAtIso, ctl.nowMs) : t('dbBackups.stats.lastNone')"
        :hint="lastOk ? `${formatSize(lastOk.sizeBytes)} · ${t(`dbBackups.trigger.${lastOk.triggeredBy}`)}` : loaded ? t('dbBackups.stats.lastNoneHint') : undefined"
      />
      <StatCard
        :class="enter"
        :style="{ animationDelay: '50ms' }"
        icon="calendar"
        tone="violet"
        :label="t('dbBackups.stats.next')"
        :value="!status ? '—' : nextRun ? formatRelative(nextRun, ctl.nowMs) : t('dbBackups.stats.nextOff')"
        :hint="nextRun ? formatStamp(nextRun) : status ? t('dbBackups.stats.nextOffHint') : undefined"
      />
      <StatCard
        :class="enter"
        :style="{ animationDelay: '100ms' }"
        icon="database"
        tone="accent"
        :label="t('dbBackups.stats.stored')"
        :value="loaded ? formatSize(storedBytes) : '—'"
        :hint="loaded ? t('dbBackups.stats.storedHint', { n: completed.length }) : undefined"
        mono
      />
      <StatCard
        :class="enter"
        :style="{ animationDelay: '150ms' }"
        icon="crown"
        tone="warning"
        :label="t('dbBackups.stats.archives')"
        :value="loaded ? archives : '—'"
        :hint="loaded ? (archives ? t('dbBackups.stats.archivesHint') : t('dbBackups.stats.archivesNone')) : undefined"
        mono
      />
    </div>

    <BackupHistoryCard
      :class="enter"
      :style="{ animationDelay: '200ms' }"
      :records="ctl.records"
      :loaded="ctl.recordsLoaded"
      :loading="ctl.recordsLoading"
      :error="ctl.recordsError"
      :live-op="active"
      :now-ms="ctl.nowMs"
      :run-block="runBlock"
      :block-for="blockFor"
      :deleting-id="deletingId"
      :storage-missing="storageMissing"
      @run="openRun"
      @refresh="ctl.refreshAll()"
      @configure="emit('configure')"
      @details="detailId = $event.id"
      @download="openDownload"
      @restore="openRestore"
      @delete="onDelete"
    />

    <BackupDetailDrawer
      v-model:open="detailOpen"
      :record="detail"
      :live-stage="active && detail && active.kind === 'backup' && active.backupId === detail.id ? active.progress : null"
      :now-ms="ctl.nowMs"
      :download-block="detail ? blockFor(detail, 'download') : null"
      :restore-block="detail ? blockFor(detail, 'restore') : null"
      :delete-blocked="detail ? Boolean(blockFor(detail, 'delete')) || deletingId === detail.id : true"
      @download="openDownload"
      @restore="openRestore"
      @delete="onDelete"
    />
    <!-- Dialogs after the drawer: same z-index, later in the DOM, so they stack on top. -->
    <BackupRunModal v-model:open="runOpen" :target="runTarget" @started="onStarted" />
    <BackupDownloadModal v-model:open="downloadOpen" :record="downloadRecord" />
    <BackupRestoreModal v-model:open="restoreOpen" :record="restoreRecord" @started="onRestoreStarted" />
    <BackupDeleteArchiveModal
      v-model:open="archiveOpen"
      :record="archiveRecord"
      :busy="Boolean(archiveRecord && deletingId === archiveRecord.id)"
      :error="archiveError"
      @confirm="confirmArchiveDelete"
    />
  </div>
</template>
