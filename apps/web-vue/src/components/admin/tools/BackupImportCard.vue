<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  CONFIG_BACKUP_TYPE,
  ConfigBackupFileSchema,
  type ConfigBackupFile,
  type ConfigBackupSection,
  type ConfigImportRequest,
  type ConfigImportResult,
} from "@slipgate/contracts";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { apiJson, errorText } from "../../../lib/api";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import BackupImportResult from "./BackupImportResult.vue";
import { BACKUP_SECTIONS, sectionAvailable, sectionCount, type BackupSectionMeta } from "./backupSections";
import { formatBytes, readTextFile } from "./toolsTypes";

/**
 * Configuration import: pick or drop a backup, validate it in the browser, choose sections
 * from a per-section preview, confirm, then show what the server created / skipped / replaced.
 */
const { t, locale } = useI18n();
const toast = useToastStore();

const MAX_BYTES = 20 * 1024 * 1024;

const fileMeta = ref<{ name: string; size: number } | null>(null);
const backup = ref<ConfigBackupFile | null>(null);
const parseError = ref<string | null>(null);
const reading = ref(false);
const selected = ref(new Set<ConfigBackupSection>());
const confirmOpen = ref(false);
const importing = ref(false);
const result = ref<ConfigImportResult | null>(null);
const dragDepth = ref(0);
const input = ref<HTMLInputElement | null>(null);

/* ---------------- Reading & validation ---------------- */

function reset() {
  fileMeta.value = null;
  backup.value = null;
  parseError.value = null;
  result.value = null;
  selected.value = new Set();
  if (input.value) input.value.value = "";
}

function validate(json: unknown): ConfigBackupFile | string {
  const obj = json as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || obj.type !== CONFIG_BACKUP_TYPE) {
    return t("adminTools.backup.import.errors.wrongType");
  }
  if (obj.version !== 1) return t("adminTools.backup.import.errors.wrongVersion", { version: String(obj.version ?? "?") });
  const parsed = ConfigBackupFileSchema.safeParse(obj);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue ? `${issue.path.join(".") || "/"}: ${issue.message}` : "?";
    return t("adminTools.backup.import.errors.invalid", { detail });
  }
  return parsed.data;
}

async function handleFile(file: File | undefined) {
  if (!file || reading.value || importing.value) return;
  reset();
  reading.value = true;
  try {
    let text: string;
    try {
      text = await readTextFile(file, MAX_BYTES);
    } catch (err) {
      parseError.value =
        err instanceof Error && err.message === "too_large"
          ? t("adminTools.backup.import.errors.tooLarge", { max: formatBytes(MAX_BYTES) })
          : t("adminTools.backup.import.errors.read");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      parseError.value = t("adminTools.backup.import.errors.notJson");
      return;
    }
    const checked = validate(json);
    if (typeof checked === "string") {
      parseError.value = checked;
      return;
    }
    backup.value = checked;
    fileMeta.value = { name: file.name, size: file.size };
    selected.value = new Set(BACKUP_SECTIONS.filter((s) => sectionAvailable(checked, s.key)).map((s) => s.key));
  } finally {
    reading.value = false;
    if (input.value) input.value.value = "";
  }
}

function onPick(ev: Event) {
  void handleFile((ev.target as HTMLInputElement).files?.[0]);
}

function onDragEnter() {
  dragDepth.value++;
}
function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}
function onDrop(ev: DragEvent) {
  dragDepth.value = 0;
  void handleFile(ev.dataTransfer?.files?.[0]);
}

/* ---------------- Section selection ---------------- */

interface SectionRow extends BackupSectionMeta {
  count: number;
  available: boolean;
  label: string;
  countText: string;
}

const sections = computed<SectionRow[]>(() => {
  const file = backup.value;
  if (!file) return [];
  return BACKUP_SECTIONS.map((s) => {
    const count = sectionCount(file, s.key);
    let countText: string;
    if (s.key === "plugins") {
      countText = count
        ? t("adminTools.backup.import.pluginsCount", { n: count })
        : t("adminTools.backup.import.pluginsNone");
    } else if (s.mode === "replace") {
      countText = count ? t("adminTools.backup.import.present") : t("adminTools.backup.import.absent");
    } else {
      countText = count ? t("adminTools.backup.import.count", { n: count }) : t("adminTools.backup.import.absent");
    }
    return {
      ...s,
      count,
      available: sectionAvailable(file, s.key),
      label: t(`adminTools.backup.sections.${s.key}`),
      countText,
    };
  });
});

const availableKeys = computed(() => sections.value.filter((s) => s.available).map((s) => s.key));
const allSelected = computed(() => availableKeys.value.length > 0 && availableKeys.value.every((k) => selected.value.has(k)));
const chosen = computed(() => sections.value.filter((s) => s.available && selected.value.has(s.key)));
const overwriting = computed(() => chosen.value.filter((s) => s.mode === "replace"));

function toggleSection(key: ConfigBackupSection) {
  const next = new Set(selected.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
}

function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(availableKeys.value);
}

function joinList(items: string[]): string {
  return items.join(locale.value.startsWith("zh") ? "、" : ", ");
}

/* ---------------- Import ---------------- */

function askImport() {
  if (!backup.value || chosen.value.length === 0) return;
  confirmOpen.value = true;
}

async function runImport() {
  const file = backup.value;
  if (!file || importing.value) return;
  importing.value = true;
  try {
    const body: ConfigImportRequest = { file, sections: chosen.value.map((s) => s.key) };
    result.value = await apiJson<ConfigImportResult>("/api/v1/admin/backup/import", {
      method: "POST",
      body,
      fallbackError: t("adminTools.backup.import.errors.import"),
    });
    confirmOpen.value = false;
    if (result.value.errors.length) toast.warning(t("adminTools.backup.result.errors", { n: result.value.errors.length }));
    else toast.success(t("adminTools.backup.import.done"));
  } catch (err) {
    toast.error(errorText(err, t("adminTools.backup.import.errors.import")));
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <UiCard icon="upload" :title="t('adminTools.backup.import.title')">
    <div class="space-y-4">
      <p class="text-sm leading-relaxed text-fg-muted">{{ t("adminTools.backup.import.body") }}</p>

      <!-- Drop zone -->
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="translate-y-1 opacity-0"
        leave-active-class="transition duration-100 ease-in"
        leave-to-class="opacity-0"
      >
        <div v-if="!backup" key="pick" class="space-y-3">
          <label
            class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center transition-colors duration-150 focus-within:ring-2 focus-within:ring-accent/40"
            :class="
              dragDepth > 0
                ? 'border-accent bg-accent/[0.07]'
                : 'border-line-strong bg-surface-2/40 hover:border-accent/50 hover:bg-accent/[0.04]'
            "
            @dragenter.prevent="onDragEnter"
            @dragover.prevent
            @dragleave="onDragLeave"
            @drop.prevent="onDrop"
          >
            <span
              class="icon-chip h-11 w-11 rounded-xl transition-transform duration-200 motion-reduce:transition-none"
              :class="dragDepth > 0 ? 'icon-chip-accent scale-110' : ''"
            >
              <UiIcon :name="reading ? 'loader' : 'upload'" :size="20" :spin="reading" />
            </span>
            <span class="text-sm font-medium text-fg">
              {{ reading ? t("adminTools.backup.import.reading") : t("adminTools.backup.import.pick") }}
            </span>
            <span class="text-xs text-fg-subtle">{{ t("adminTools.backup.import.drop") }}</span>
            <span class="font-mono text-2xs text-fg-subtle">slipgate-config-*.json</span>
            <input
              ref="input"
              type="file"
              accept=".json,application/json"
              class="sr-only"
              :disabled="reading"
              @change="onPick"
            />
          </label>
          <UiAlert v-if="parseError" tone="danger">{{ parseError }}</UiAlert>
        </div>

        <!-- Result -->
        <div v-else-if="result" key="result" class="space-y-4">
          <BackupImportResult :result="result" />
          <div class="flex justify-end">
            <button type="button" class="btn btn-secondary btn-sm" @click="reset">
              <UiIcon name="upload" :size="14" />
              {{ t("adminTools.backup.result.again") }}
            </button>
          </div>
        </div>

        <!-- Preview -->
        <div v-else key="preview" class="space-y-4">
          <div class="flex min-w-0 items-center gap-3 rounded-xl border border-line bg-surface-2/40 px-4 py-3">
            <span class="icon-chip icon-chip-accent h-9 w-9">
              <UiIcon name="file" :size="16" />
            </span>
            <div class="min-w-0 flex-1">
              <p class="truncate font-mono text-xs font-medium text-fg" :title="fileMeta?.name">{{ fileMeta?.name }}</p>
              <p class="mt-0.5 truncate text-2xs text-fg-subtle" :title="formatDateTime(backup.exportedAtIso)">
                {{ formatBytes(fileMeta?.size ?? 0) }} ·
                {{ t("adminTools.backup.import.exportedAt", { time: formatRelative(backup.exportedAtIso) }) }}
              </p>
            </div>
            <UiBadge tone="success" dot>v{{ backup.version }}</UiBadge>
          </div>

          <div>
            <div class="mb-2 flex items-center justify-between gap-2">
              <p class="eyebrow">{{ t("adminTools.backup.import.sections") }}</p>
              <button
                type="button"
                class="cursor-pointer text-xs font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                :disabled="importing || availableKeys.length === 0"
                @click="toggleAll"
              >
                {{ allSelected ? t("adminTools.backup.import.selectNone") : t("adminTools.backup.import.selectAll") }}
              </button>
            </div>
            <ul class="divide-y divide-line/60 overflow-hidden rounded-xl border border-line">
              <li v-for="s in sections" :key="s.key">
                <label
                  class="flex min-w-0 items-center gap-3 px-3 py-2.5 transition-colors duration-150 sm:px-4"
                  :class="
                    s.available
                      ? selected.has(s.key)
                        ? 'cursor-pointer bg-accent/[0.04] hover:bg-accent/[0.07]'
                        : 'cursor-pointer hover:bg-surface-2/50'
                      : 'cursor-not-allowed opacity-50'
                  "
                >
                  <input
                    type="checkbox"
                    class="checkbox shrink-0"
                    :checked="s.available && selected.has(s.key)"
                    :disabled="!s.available || importing"
                    @change="toggleSection(s.key)"
                  />
                  <span class="icon-chip h-7 w-7 rounded-md" :class="s.available && selected.has(s.key) ? 'icon-chip-accent' : ''">
                    <UiIcon :name="s.icon" :size="13" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm text-fg">{{ s.label }}</span>
                    <span class="block truncate text-2xs text-fg-subtle">
                      {{ s.mode === "replace" ? t("adminTools.backup.import.replaceHint") : t("adminTools.backup.import.mergeHint") }}
                    </span>
                  </span>
                  <span class="shrink-0 text-right">
                    <span class="block text-xs tabular-nums" :class="s.available ? 'text-fg' : 'text-fg-subtle'">{{ s.countText }}</span>
                    <UiBadge v-if="s.available" class="mt-1" :tone="s.mode === 'replace' ? 'warning' : 'neutral'">
                      {{ s.mode === "replace" ? t("adminTools.backup.import.modeReplace") : t("adminTools.backup.import.modeMerge") }}
                    </UiBadge>
                  </span>
                </label>
              </li>
            </ul>
            <p class="hint mt-2 flex items-start gap-1.5">
              <UiIcon name="info" :size="12" class="mt-0.5" />
              {{ t("adminTools.backup.import.linkHint") }}
            </p>
          </div>

          <div class="flex flex-wrap items-center justify-end gap-2 border-t border-line/70 pt-4">
            <span v-if="chosen.length === 0" class="mr-auto text-xs text-warning">{{ t("adminTools.backup.import.noneSelected") }}</span>
            <button type="button" class="btn btn-secondary" :disabled="importing" @click="reset">
              <UiIcon name="file" :size="15" />
              {{ t("adminTools.backup.import.replace") }}
            </button>
            <button type="button" class="btn btn-primary" :disabled="importing || chosen.length === 0" @click="askImport">
              <UiIcon name="upload" :size="15" />
              {{ t("adminTools.backup.import.action") }}
            </button>
          </div>
        </div>
      </Transition>
    </div>

    <UiModal v-model:open="confirmOpen" width="md" :title="t('adminTools.backup.import.confirm.title')" :persistent="importing">
      <template #icon>
        <span class="icon-chip icon-chip-warning h-8 w-8"><UiIcon name="upload" :size="15" /></span>
      </template>
      <div class="space-y-4">
        <p class="text-sm text-fg-muted">
          {{ t("adminTools.backup.import.confirm.body", { n: chosen.length, file: fileMeta?.name ?? "" }) }}
        </p>
        <ul class="flex flex-wrap gap-1.5">
          <li v-for="s in chosen" :key="s.key">
            <UiBadge :tone="s.mode === 'replace' ? 'warning' : 'accent'">{{ s.label }} · {{ s.countText }}</UiBadge>
          </li>
        </ul>
        <UiAlert v-if="overwriting.length" tone="warning">
          {{ t("adminTools.backup.import.confirm.overwrite", { list: joinList(overwriting.map((s) => s.label)) }) }}
        </UiAlert>
      </div>
      <template #footer>
        <button type="button" class="btn btn-secondary" :disabled="importing" @click="confirmOpen = false">
          {{ t("common.cancel") }}
        </button>
        <button type="button" class="btn btn-primary" :disabled="importing" @click="runImport">
          <UiIcon :name="importing ? 'loader' : 'check'" :size="15" :spin="importing" />
          {{ importing ? t("adminTools.backup.import.importing") : t("adminTools.backup.import.confirm.action") }}
        </button>
      </template>
    </UiModal>
  </UiCard>
</template>
