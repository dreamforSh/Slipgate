<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { BackupRecord } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { formatRelative } from "../../../lib/format";
import { formatSize, formatStamp } from "./dbBackupUtil";

/** Compact identity of one backup (file, id, when, size) for dialogs. */
defineProps<{ record: BackupRecord; tone?: "accent" | "danger" }>();
const { t } = useI18n();
</script>

<template>
  <div class="flex min-w-0 items-center gap-3 rounded-xl border border-line bg-surface-2/40 px-3.5 py-3">
    <span class="icon-chip h-9 w-9" :class="tone === 'danger' ? 'icon-chip-danger' : 'icon-chip-accent'">
      <UiIcon name="database" :size="16" />
    </span>
    <div class="min-w-0 flex-1">
      <p class="truncate font-mono text-xs font-medium text-fg" :title="record.fileName">{{ record.fileName }}</p>
      <p class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-subtle">
        <span class="font-mono">{{ record.id }}</span>
        <span aria-hidden="true">·</span>
        <span :title="formatStamp(record.startedAtIso)">{{ formatRelative(record.startedAtIso) }}</span>
        <span aria-hidden="true">·</span>
        <span class="tabular-nums">{{ formatSize(record.sizeBytes) }}</span>
      </p>
    </div>
    <UiBadge :tone="record.triggeredBy === 'scheduled' ? 'violet' : 'neutral'" class="shrink-0">
      {{ t(`dbBackups.trigger.${record.triggeredBy}`) }}
    </UiBadge>
  </div>
</template>
