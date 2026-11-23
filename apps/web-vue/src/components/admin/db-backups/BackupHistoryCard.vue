<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BackupActiveOperation, BackupRecord } from "@slipgate/contracts";
import ConfirmButton from "../../ui/ConfirmButton.vue";
import EmptyState from "../../ui/EmptyState.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiPagination from "../../ui/UiPagination.vue";
import { formatRelative } from "../../../lib/format";
import {
  formatElapsed,
  formatSize,
  formatStamp,
  retentionText,
  spanMs,
  statusText,
  STATUS_TONE,
} from "./dbBackupUtil";

type Action = "download" | "restore" | "delete";

/** Backup history: filter, table (cards on phones), per-row download / restore / delete. */
const props = defineProps<{
  records: BackupRecord[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  liveOp: BackupActiveOperation | null;
  nowMs: number;
  /** Why "Back up now" is unavailable (null = available). */
  runBlock: string | null;
  /** Why an action is unavailable for a record (null = available). */
  blockFor: (record: BackupRecord, action: Action) => string | null;
  deletingId: string | null;
  storageMissing: boolean;
}>();

const emit = defineEmits<{
  (e: "run"): void;
  (e: "refresh"): void;
  (e: "configure"): void;
  (e: "details", record: BackupRecord): void;
  (e: "download", record: BackupRecord): void;
  (e: "restore", record: BackupRecord): void;
  (e: "delete", record: BackupRecord): void;
}>();

const { t } = useI18n();

/* ---------------- Filter & paging ---------------- */

type Filter = "all" | "manual" | "scheduled" | "archived" | "failed";
const filter = ref<Filter>("all");
const page = ref(1);
const pageSize = ref(20);

const matches: Record<Filter, (r: BackupRecord) => boolean> = {
  all: () => true,
  manual: (r) => r.triggeredBy === "manual",
  scheduled: (r) => r.triggeredBy === "scheduled",
  archived: (r) => Boolean(r.monthlyArchive),
  failed: (r) => r.status === "failed",
};

const filterOptions = computed(() =>
  (["all", "manual", "scheduled", "archived", "failed"] as Filter[])
    .map((value) => ({ value, label: t(`dbBackups.history.filters.${value}`), count: props.records.filter(matches[value]).length }))
    .filter((o) => o.value === "all" || o.value === filter.value || o.count > 0),
);

const filtered = computed(() => props.records.filter(matches[filter.value]));
const pageRows = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value));

watch([filter, pageSize], () => (page.value = 1));
watch(
  () => filtered.value.length,
  (n) => {
    const last = Math.max(1, Math.ceil(n / pageSize.value));
    if (page.value > last) page.value = last;
  },
);

/* ---------------- Row helpers ---------------- */

function stageOf(r: BackupRecord) {
  return props.liveOp && props.liveOp.kind === "backup" && props.liveOp.backupId === r.id ? props.liveOp.progress : null;
}

function durationText(r: BackupRecord): string | null {
  if (r.status === "running") return formatElapsed(spanMs(r.startedAtIso, null, props.nowMs));
  return r.finishedAtIso ? t("dbBackups.history.duration", { time: formatElapsed(spanMs(r.startedAtIso, r.finishedAtIso)) }) : null;
}

function restoreBadge(r: BackupRecord): { tone: "success" | "danger" | "warning"; text: string; title?: string } | null {
  if (r.restoreStatus === "completed") {
    return { tone: "success", text: t("dbBackups.history.restoredBadge"), title: t("dbBackups.history.restoredAt", { time: formatStamp(r.restoredAtIso) }) };
  }
  if (r.restoreStatus === "failed") return { tone: "danger", text: t("dbBackups.history.restoreFailedBadge"), title: r.restoreError };
  if (r.restoreStatus === "running") return { tone: "warning", text: t("dbBackups.history.restoringBadge") };
  return null;
}

const skeletonRows = [0, 1, 2, 3];
</script>

<template>
  <UiCard flush>
    <template #header>
      <div class="flex min-w-0 items-center gap-3">
        <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="list" :size="16" /></span>
        <h2 class="truncate text-sm font-semibold text-fg">{{ t("dbBackups.history.title") }}</h2>
        <span v-if="loaded" class="rounded-full bg-surface-2 px-1.5 font-mono text-2xs leading-4 tabular-nums text-fg-subtle">{{ records.length }}</span>
      </div>
    </template>
    <template #actions>
      <button
        type="button"
        class="btn btn-ghost btn-icon btn-sm"
        :disabled="loading"
        :title="t('dbBackups.history.refresh')"
        :aria-label="t('dbBackups.history.refresh')"
        @click="emit('refresh')"
      >
        <UiIcon name="refresh" :size="15" :spin="loading" />
      </button>
      <span :title="runBlock ?? undefined">
        <button type="button" class="btn btn-primary btn-sm" :disabled="Boolean(runBlock)" @click="emit('run')">
          <UiIcon name="play" :size="14" />
          {{ t("dbBackups.history.runNow") }}
        </button>
      </span>
    </template>

    <!-- Filters -->
    <div v-if="loaded && records.length" class="scrollbar-hide overflow-x-auto border-b border-line/70 px-5 py-3">
      <SegmentedControl v-model="filter" :options="filterOptions" />
    </div>

    <!-- Loading -->
    <div v-if="!loaded && loading" class="divide-y divide-line/60" aria-busy="true">
      <div v-for="i in skeletonRows" :key="i" class="flex items-center gap-4 px-5 py-4">
        <div class="h-9 w-9 shrink-0 animate-pulse rounded-lg bg-surface-2 motion-reduce:animate-none" />
        <div class="min-w-0 flex-1 space-y-2">
          <div class="h-3 w-2/3 max-w-xs animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
          <div class="h-2.5 w-1/3 max-w-[10rem] animate-pulse rounded bg-surface-2/70 motion-reduce:animate-none" />
        </div>
        <div class="hidden h-5 w-16 animate-pulse rounded-full bg-surface-2 motion-reduce:animate-none sm:block" />
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="error && !loaded" class="p-5">
      <UiAlert tone="danger" :title="t('dbBackups.history.loadFailed')">
        {{ error }}
        <template #action>
          <button type="button" class="btn btn-secondary btn-sm shrink-0" :disabled="loading" @click="emit('refresh')">
            {{ t("dbBackups.history.retry") }}
          </button>
        </template>
      </UiAlert>
    </div>

    <!-- Empty -->
    <EmptyState v-else-if="records.length === 0" icon="database" :title="t('dbBackups.history.empty')">
      <p class="-mt-2 basis-full max-w-sm text-xs leading-relaxed text-fg-subtle">{{ t("dbBackups.history.emptyHint") }}</p>
      <button v-if="storageMissing" type="button" class="btn btn-secondary btn-sm" @click="emit('configure')">
        <UiIcon name="settings" :size="14" />
        {{ t("dbBackups.setup.action") }}
      </button>
      <button type="button" class="btn btn-primary btn-sm" :disabled="Boolean(runBlock)" :title="runBlock ?? undefined" @click="emit('run')">
        <UiIcon name="play" :size="14" />
        {{ t("dbBackups.history.runNow") }}
      </button>
    </EmptyState>

    <EmptyState v-else-if="filtered.length === 0" compact icon="filter" :title="t('dbBackups.history.emptyFiltered')">
      <button type="button" class="btn btn-secondary btn-sm" @click="filter = 'all'">{{ t("dbBackups.history.showAll") }}</button>
    </EmptyState>

    <template v-else>
      <!-- Table (md and up) -->
      <div class="table-wrap hidden md:block">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("dbBackups.history.columns.backup") }}</th>
              <th>{{ t("dbBackups.history.columns.status") }}</th>
              <th class="text-right">{{ t("dbBackups.history.columns.size") }}</th>
              <th>{{ t("dbBackups.history.columns.started") }}</th>
              <th>{{ t("dbBackups.history.columns.retention") }}</th>
              <th class="text-right">{{ t("dbBackups.history.columns.actions") }}</th>
            </tr>
          </thead>
          <TransitionGroup
            tag="tbody"
            enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
            enter-from-class="opacity-0"
            leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
            leave-to-class="opacity-0"
          >
            <tr v-for="r in pageRows" :key="r.id">
              <td class="max-w-[22rem]">
                <button
                  type="button"
                  class="group flex min-w-0 max-w-full items-center gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  :aria-label="`${t('dbBackups.history.actions.details')}: ${r.fileName}`"
                  @click="emit('details', r)"
                >
                  <span class="icon-chip h-8 w-8" :class="r.triggeredBy === 'scheduled' ? 'icon-chip-violet' : 'icon-chip-accent'">
                    <UiIcon :name="r.triggeredBy === 'scheduled' ? 'clock' : 'database'" :size="14" />
                  </span>
                  <span class="min-w-0">
                    <span class="block truncate font-mono text-xs font-medium text-fg group-hover:text-accent">{{ r.fileName }}</span>
                    <span class="mt-1 flex flex-wrap items-center gap-1">
                      <UiBadge :tone="r.triggeredBy === 'scheduled' ? 'violet' : 'neutral'">{{ t(`dbBackups.trigger.${r.triggeredBy}`) }}</UiBadge>
                      <UiBadge v-if="r.monthlyArchive" tone="accent" :title="t('dbBackups.history.archiveDates', { dates: r.monthlyArchive.dates.join(' / ') })">
                        {{ t("dbBackups.history.archiveBadge") }}
                      </UiBadge>
                      <UiBadge v-if="restoreBadge(r)" :tone="restoreBadge(r)!.tone" :title="restoreBadge(r)!.title">{{ restoreBadge(r)!.text }}</UiBadge>
                    </span>
                  </span>
                </button>
              </td>
              <td>
                <UiBadge :tone="STATUS_TONE[r.status]" dot :pulse="r.status === 'running'" :title="r.errorMessage || undefined">
                  {{ statusText(r, stageOf(r)) }}
                </UiBadge>
                <p v-if="r.status === 'failed' && r.errorMessage" class="mt-1 max-w-[14rem] truncate text-2xs text-danger" :title="r.errorMessage">
                  {{ r.errorMessage }}
                </p>
              </td>
              <td class="whitespace-nowrap text-right">
                <span class="text-xs tabular-nums text-fg">{{ r.sizeBytes ? formatSize(r.sizeBytes) : "-" }}</span>
                <p v-if="r.parts.length > 1" class="text-2xs text-fg-subtle">{{ t("dbBackups.history.parts", { n: r.parts.length }) }}</p>
              </td>
              <td class="whitespace-nowrap">
                <span class="text-xs text-fg" :title="formatStamp(r.startedAtIso)">{{ formatRelative(r.startedAtIso, nowMs) }}</span>
                <p v-if="durationText(r)" class="text-2xs tabular-nums text-fg-subtle">{{ durationText(r) }}</p>
              </td>
              <td class="whitespace-nowrap text-xs text-fg-muted">{{ retentionText(r) }}</td>
              <td>
                <div class="flex items-center justify-end gap-0.5">
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :disabled="Boolean(blockFor(r, 'download'))"
                    :title="blockFor(r, 'download') ?? t('dbBackups.history.actions.download')"
                    :aria-label="t('dbBackups.history.actions.download')"
                    @click="emit('download', r)"
                  >
                    <UiIcon name="download" :size="14" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs hover:!text-warning"
                    :disabled="Boolean(blockFor(r, 'restore'))"
                    :title="blockFor(r, 'restore') ?? t('dbBackups.history.actions.restore')"
                    :aria-label="t('dbBackups.history.actions.restore')"
                    @click="emit('restore', r)"
                  >
                    <UiIcon name="rotate-ccw" :size="14" />
                  </button>
                  <button
                    v-if="r.monthlyArchive"
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs hover:!bg-danger/10 hover:!text-danger"
                    :disabled="Boolean(blockFor(r, 'delete')) || deletingId === r.id"
                    :title="blockFor(r, 'delete') ?? t('dbBackups.history.actions.delete')"
                    :aria-label="t('dbBackups.history.actions.delete')"
                    @click="emit('delete', r)"
                  >
                    <UiIcon :name="deletingId === r.id ? 'loader' : 'trash'" :size="14" :spin="deletingId === r.id" />
                  </button>
                  <ConfirmButton
                    v-else
                    icon-only
                    :disabled="Boolean(blockFor(r, 'delete')) || deletingId === r.id"
                    @confirm="emit('delete', r)"
                  />
                  <button
                    type="button"
                    class="btn btn-ghost btn-icon btn-xs"
                    :title="t('dbBackups.history.actions.details')"
                    :aria-label="t('dbBackups.history.actions.details')"
                    @click="emit('details', r)"
                  >
                    <UiIcon name="chevron-right" :size="14" />
                  </button>
                </div>
              </td>
            </tr>
          </TransitionGroup>
        </table>
      </div>

      <!-- Cards (phones) -->
      <TransitionGroup
        tag="ul"
        class="divide-y divide-line/60 md:hidden"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        enter-from-class="opacity-0"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        leave-to-class="opacity-0"
      >
        <li v-for="r in pageRows" :key="r.id" class="px-4 py-3.5">
          <button
            type="button"
            class="flex w-full min-w-0 items-start gap-3 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            @click="emit('details', r)"
          >
            <span class="icon-chip mt-0.5 h-8 w-8" :class="r.triggeredBy === 'scheduled' ? 'icon-chip-violet' : 'icon-chip-accent'">
              <UiIcon :name="r.triggeredBy === 'scheduled' ? 'clock' : 'database'" :size="14" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate font-mono text-xs font-medium text-fg">{{ r.fileName }}</span>
              <span class="mt-1 flex flex-wrap items-center gap-1">
                <UiBadge :tone="STATUS_TONE[r.status]" dot :pulse="r.status === 'running'">{{ statusText(r, stageOf(r)) }}</UiBadge>
                <UiBadge :tone="r.triggeredBy === 'scheduled' ? 'violet' : 'neutral'">{{ t(`dbBackups.trigger.${r.triggeredBy}`) }}</UiBadge>
                <UiBadge v-if="r.monthlyArchive" tone="accent">{{ t("dbBackups.history.archiveBadge") }}</UiBadge>
                <UiBadge v-if="restoreBadge(r)" :tone="restoreBadge(r)!.tone">{{ restoreBadge(r)!.text }}</UiBadge>
              </span>
              <span class="mt-1.5 block text-2xs text-fg-subtle">
                {{ formatStamp(r.startedAtIso) }} · {{ r.sizeBytes ? formatSize(r.sizeBytes) : "-" }} · {{ retentionText(r) }}
              </span>
              <span v-if="r.status === 'failed' && r.errorMessage" class="mt-1 block truncate text-2xs text-danger">{{ r.errorMessage }}</span>
            </span>
          </button>
          <div class="mt-2.5 flex items-center justify-end gap-1.5 pl-11">
            <button
              type="button"
              class="btn btn-secondary btn-xs"
              :disabled="Boolean(blockFor(r, 'download'))"
              @click="emit('download', r)"
            >
              <UiIcon name="download" :size="13" />
              {{ t("dbBackups.history.actions.download") }}
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-xs"
              :disabled="Boolean(blockFor(r, 'restore'))"
              @click="emit('restore', r)"
            >
              <UiIcon name="rotate-ccw" :size="13" />
              {{ t("dbBackups.history.actions.restore") }}
            </button>
            <button
              v-if="r.monthlyArchive"
              type="button"
              class="btn btn-ghost btn-icon btn-xs hover:!bg-danger/10 hover:!text-danger"
              :disabled="Boolean(blockFor(r, 'delete')) || deletingId === r.id"
              :aria-label="t('dbBackups.history.actions.delete')"
              @click="emit('delete', r)"
            >
              <UiIcon name="trash" :size="13" />
            </button>
            <ConfirmButton
              v-else
              icon-only
              :disabled="Boolean(blockFor(r, 'delete')) || deletingId === r.id"
              @confirm="emit('delete', r)"
            />
          </div>
        </li>
      </TransitionGroup>

      <div v-if="filtered.length > pageSize" class="border-t border-line/70 px-5 py-3">
        <UiPagination v-model:page="page" v-model:page-size="pageSize" :total="filtered.length" />
      </div>
    </template>
  </UiCard>
</template>
