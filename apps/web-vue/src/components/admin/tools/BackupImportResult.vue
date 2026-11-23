<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ConfigImportResult } from "@slipgate/contracts";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import { BACKUP_SECTIONS } from "./backupSections";

/** Per-section created / skipped / replaced counts of a configuration import, plus its errors. */
const props = defineProps<{ result: ConfigImportResult }>();

const { t } = useI18n();

interface Row {
  key: string;
  label: string;
  created: number;
  skipped: number;
  updated: boolean;
}

const rows = computed<Row[]>(() => {
  const r = props.result;
  const known = BACKUP_SECTIONS.map((s) => s.key as string);
  // Keep the restore order, then anything the server reports that the console does not know yet.
  const keys = [
    ...known,
    ...[...Object.keys(r.created), ...Object.keys(r.skipped), ...r.updated].filter((k) => !known.includes(k)),
  ];
  return [...new Set(keys)]
    .map((key) => ({
      key,
      label: known.includes(key) ? t(`adminTools.backup.sections.${key}`) : key,
      created: r.created[key] ?? 0,
      skipped: r.skipped[key] ?? 0,
      updated: r.updated.includes(key),
    }))
    .filter((row) => row.created || row.skipped || row.updated);
});

const totals = computed(() => ({
  created: rows.value.reduce((n, r) => n + r.created, 0),
  skipped: rows.value.reduce((n, r) => n + r.skipped, 0),
  updated: rows.value.filter((r) => r.updated).length,
}));

const hasErrors = computed(() => props.result.errors.length > 0);
</script>

<template>
  <div class="space-y-3">
    <div class="flex min-w-0 items-center gap-3">
      <span class="icon-chip h-9 w-9" :class="hasErrors ? 'icon-chip-warning' : 'icon-chip-success'">
        <UiIcon :name="hasErrors ? 'alert' : 'check-circle'" :size="17" />
      </span>
      <div class="min-w-0">
        <p class="text-sm font-semibold text-fg">{{ t("adminTools.backup.result.title") }}</p>
        <p class="mt-0.5 text-xs text-fg-muted">{{ t("adminTools.backup.result.totals", totals) }}</p>
      </div>
    </div>

    <div v-if="rows.length" class="overflow-hidden rounded-lg border border-line">
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("adminTools.backup.result.section") }}</th>
              <th class="text-right">{{ t("adminTools.backup.result.created") }}</th>
              <th class="text-right">{{ t("adminTools.backup.result.skipped") }}</th>
              <th class="text-right">{{ t("adminTools.backup.result.updated") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.key">
              <td class="whitespace-nowrap text-xs text-fg">{{ row.label }}</td>
              <td class="text-right font-mono text-xs tabular-nums" :class="row.created ? 'font-semibold text-success' : 'text-fg-subtle'">
                {{ row.created || "-" }}
              </td>
              <td class="text-right font-mono text-xs tabular-nums" :class="row.skipped ? 'text-fg-muted' : 'text-fg-subtle'">
                {{ row.skipped || "-" }}
              </td>
              <td class="text-right">
                <UiBadge v-if="row.updated" tone="info">{{ t("adminTools.backup.result.updated") }}</UiBadge>
                <span v-else class="text-xs text-fg-subtle">-</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <p v-else-if="!hasErrors" class="rounded-lg bg-surface-2/60 px-3 py-2.5 text-xs text-fg-muted">
      {{ t("adminTools.backup.result.none") }}
    </p>

    <div v-if="hasErrors" class="rounded-lg border border-danger/25 bg-danger/[0.06] p-3">
      <p class="flex items-center gap-1.5 text-xs font-semibold text-danger">
        <UiIcon name="x-circle" :size="13" />
        {{ t("adminTools.backup.result.errors", { n: result.errors.length }) }}
      </p>
      <ul class="mt-2 max-h-48 space-y-1 overflow-y-auto font-mono text-2xs leading-relaxed text-fg">
        <li v-for="(err, i) in result.errors" :key="i" class="break-words">{{ err }}</li>
      </ul>
    </div>
  </div>
</template>
