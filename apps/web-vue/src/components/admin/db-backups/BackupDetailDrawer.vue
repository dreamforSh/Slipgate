<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { BackupOperationStage, BackupRecord } from "@slipgate/contracts";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import CopyButton from "../../ui/CopyButton.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiDrawer from "../../ui/UiDrawer.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { formatRelative } from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";
import {
  actorText,
  formatElapsed,
  formatSize,
  formatStamp,
  retentionText,
  spanMs,
  statusText,
  STATUS_TONE,
} from "./dbBackupUtil";

/** Everything stored about one backup: timings, object keys and checksums, restore and archive history. */
const props = defineProps<{
  open: boolean;
  record: BackupRecord | null;
  liveStage: BackupOperationStage | null;
  nowMs: number;
  /** Why download / restore are unavailable right now (null = available). */
  downloadBlock: string | null;
  restoreBlock: string | null;
  deleteBlocked: boolean;
}>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "download", record: BackupRecord): void;
  (e: "restore", record: BackupRecord): void;
  (e: "delete", record: BackupRecord): void;
}>();

const { t } = useI18n();
const auth = useAuthStore();

const r = computed(() => props.record);
const objectKey = computed(() => {
  const rec = r.value;
  if (!rec) return "";
  if (rec.s3Key) return rec.s3Key;
  const first = rec.parts[0]?.s3Key ?? "";
  return first ? first.slice(0, first.lastIndexOf("/") + 1) : "";
});

const rows = computed(() => {
  const rec = r.value;
  if (!rec) return [];
  const list: { key: string; label: string; value: string; mono?: boolean; copy?: boolean; title?: string }[] = [
    { key: "id", label: t("dbBackups.detail.id"), value: rec.id, mono: true, copy: true },
    { key: "trigger", label: t("dbBackups.detail.trigger"), value: t(`dbBackups.trigger.${rec.triggeredBy}`) },
    { key: "createdBy", label: t("dbBackups.detail.createdBy"), value: actorText(rec.createdBy, auth.user?.id), mono: Boolean(rec.createdBy && rec.createdBy !== auth.user?.id) },
    { key: "size", label: t("dbBackups.detail.size"), value: rec.sizeBytes ? `${formatSize(rec.sizeBytes)} (${rec.sizeBytes.toLocaleString("en-US")} B)` : "-" },
    { key: "started", label: t("dbBackups.detail.started"), value: formatStamp(rec.startedAtIso), title: rec.startedAtIso },
    { key: "finished", label: t("dbBackups.detail.finished"), value: formatStamp(rec.finishedAtIso), title: rec.finishedAtIso ?? undefined },
    { key: "duration", label: t("dbBackups.detail.duration"), value: formatElapsed(spanMs(rec.startedAtIso, rec.finishedAtIso, props.nowMs)) },
    { key: "expires", label: t("dbBackups.detail.expires"), value: retentionText(rec) },
  ];
  if (rec.scheduledForIso) {
    list.push({ key: "slot", label: t("dbBackups.detail.scheduledFor"), value: formatStamp(rec.scheduledForIso), title: rec.scheduledForIso });
  }
  return list;
});

const restoreRows = computed(() => {
  const rec = r.value;
  if (!rec || !rec.restoreStatus) return [];
  return [
    { key: "started", label: t("dbBackups.detail.restoreStarted"), value: formatStamp(rec.restoreStartedAtIso) },
    { key: "done", label: t("dbBackups.detail.restoredAt"), value: formatStamp(rec.restoredAtIso) },
    { key: "by", label: t("dbBackups.detail.restoredBy"), value: rec.restoredBy ? actorText(rec.restoredBy, auth.user?.id) : "-" },
  ];
});

const restoreTone = computed(() =>
  r.value?.restoreStatus === "completed" ? "success" : r.value?.restoreStatus === "failed" ? "danger" : "warning",
);
</script>

<template>
  <UiDrawer :open="open" width="lg" :title="t('dbBackups.detail.title')" @update:open="emit('update:open', $event)">
    <div v-if="r" class="space-y-6">
      <!-- Identity -->
      <div class="flex min-w-0 items-start gap-3">
        <span class="icon-chip icon-chip-accent h-10 w-10 rounded-xl">
          <UiIcon name="database" :size="18" />
        </span>
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-1">
            <p class="min-w-0 truncate font-mono text-sm font-medium text-fg" :title="r.fileName">{{ r.fileName }}</p>
            <CopyButton :text="r.fileName" />
          </div>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
            <UiBadge :tone="STATUS_TONE[r.status]" dot :pulse="r.status === 'running'">{{ statusText(r, liveStage) }}</UiBadge>
            <UiBadge :tone="r.triggeredBy === 'scheduled' ? 'violet' : 'neutral'">{{ t(`dbBackups.trigger.${r.triggeredBy}`) }}</UiBadge>
            <UiBadge v-if="r.monthlyArchive" tone="accent">
              <UiIcon name="crown" :size="10" class="-ml-0.5 mr-0.5 inline" />{{ t("dbBackups.history.archiveBadge") }}
            </UiBadge>
          </div>
        </div>
      </div>

      <UiAlert v-if="r.status === 'failed' && r.errorMessage" tone="danger" :title="t('dbBackups.detail.error')">
        <span class="break-all font-mono text-xs">{{ r.errorMessage }}</span>
      </UiAlert>

      <!-- Overview -->
      <section>
        <h3 class="eyebrow mb-3">{{ t("dbBackups.detail.overview") }}</h3>
        <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <div v-for="row in rows" :key="row.key" class="min-w-0">
            <dt class="text-xs text-fg-subtle">{{ row.label }}</dt>
            <dd class="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-fg" :class="row.mono ? 'font-mono' : ''" :title="row.title">
              <span class="min-w-0 truncate">{{ row.value }}</span>
              <CopyButton v-if="row.copy" :text="row.value" />
            </dd>
          </div>
          <div v-if="objectKey" class="min-w-0 sm:col-span-2">
            <dt class="text-xs text-fg-subtle">{{ t("dbBackups.detail.objectKey") }}</dt>
            <dd class="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-xs text-fg">
              <span class="min-w-0 break-all">{{ objectKey }}</span>
              <CopyButton :text="objectKey" />
            </dd>
          </div>
        </dl>
      </section>

      <!-- Parts -->
      <section v-if="r.parts.length">
        <div class="mb-3 flex items-baseline justify-between gap-2">
          <h3 class="eyebrow">{{ t("dbBackups.detail.partsTitle") }}</h3>
          <span v-if="r.parts.length > 1" class="text-2xs text-fg-subtle">{{ t("dbBackups.detail.partsHint") }}</span>
        </div>
        <ul class="divide-y divide-line/60 overflow-hidden rounded-xl border border-line">
          <li v-for="p in r.parts" :key="p.index" class="flex min-w-0 items-center gap-3 px-3 py-2.5">
            <span class="icon-chip h-7 w-7 rounded-md font-mono text-2xs font-semibold tabular-nums">{{ p.index }}</span>
            <div class="min-w-0 flex-1">
              <p class="text-xs tabular-nums text-fg">{{ formatSize(p.sizeBytes) }}</p>
              <p class="flex min-w-0 items-center gap-1 text-2xs text-fg-subtle">
                <span class="shrink-0">SHA-256</span>
                <code class="min-w-0 truncate font-mono" :title="p.sha256">{{ p.sha256 }}</code>
              </p>
            </div>
            <CopyButton :text="p.sha256" />
          </li>
        </ul>
      </section>

      <!-- Restore -->
      <section>
        <h3 class="eyebrow mb-3">{{ t("dbBackups.detail.restoreTitle") }}</h3>
        <p v-if="!r.restoreStatus" class="text-xs text-fg-subtle">{{ t("dbBackups.detail.never") }}</p>
        <div v-else class="space-y-3">
          <UiBadge :tone="restoreTone" dot :pulse="r.restoreStatus === 'running'">
            {{
              r.restoreStatus === "completed"
                ? t("dbBackups.history.restoredBadge")
                : r.restoreStatus === "failed"
                  ? t("dbBackups.history.restoreFailedBadge")
                  : t("dbBackups.history.restoringBadge")
            }}
          </UiBadge>
          <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-3">
            <div v-for="row in restoreRows" :key="row.key" class="min-w-0">
              <dt class="text-xs text-fg-subtle">{{ row.label }}</dt>
              <dd class="mt-0.5 truncate text-xs text-fg">{{ row.value }}</dd>
            </div>
          </dl>
          <UiAlert v-if="r.restoreError" tone="danger" :title="t('dbBackups.detail.restoreError')">
            <span class="break-all font-mono text-xs">{{ r.restoreError }}</span>
          </UiAlert>
        </div>
      </section>

      <!-- Archive -->
      <section v-if="r.monthlyArchive">
        <h3 class="eyebrow mb-3">{{ t("dbBackups.detail.archiveTitle") }}</h3>
        <dl class="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <div class="min-w-0">
            <dt class="text-xs text-fg-subtle">{{ t("dbBackups.detail.archiveDates") }}</dt>
            <dd class="mt-1 flex flex-wrap gap-1">
              <span v-for="d in r.monthlyArchive.dates" :key="d" class="code-chip">{{ d }}</span>
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-fg-subtle">{{ t("dbBackups.detail.archiveRetention") }}</dt>
            <dd class="mt-0.5 text-xs text-fg">{{ retentionText(r) }}</dd>
          </div>
        </dl>
      </section>

      <p class="text-2xs text-fg-subtle" :title="r.startedAtIso">{{ formatRelative(r.startedAtIso) }}</p>
    </div>

    <template #footer>
      <div v-if="r" class="flex w-full flex-wrap items-center justify-end gap-2">
        <button
          v-if="r.monthlyArchive"
          type="button"
          class="btn btn-ghost btn-sm mr-auto hover:!bg-danger/10 hover:!text-danger"
          :disabled="deleteBlocked"
          @click="emit('delete', r)"
        >
          <UiIcon name="trash" :size="14" />
          {{ t("dbBackups.history.actions.delete") }}
        </button>
        <ConfirmButton v-else class="mr-auto" size="sm" :disabled="deleteBlocked" @confirm="emit('delete', r)" />
        <button type="button" class="btn btn-secondary" :disabled="Boolean(restoreBlock)" :title="restoreBlock ?? undefined" @click="emit('restore', r)">
          <UiIcon name="rotate-ccw" :size="14" />
          {{ t("dbBackups.history.actions.restore") }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="Boolean(downloadBlock)" :title="downloadBlock ?? undefined" @click="emit('download', r)">
          <UiIcon name="download" :size="14" />
          {{ t("dbBackups.history.actions.download") }}
        </button>
      </div>
    </template>
  </UiDrawer>
</template>
