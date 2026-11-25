<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  AccountImportFormatError,
  parseAccountImportSources,
  parseImportJsonText,
  subscriptionTierMultiplier,
  type AccountImportParseResult,
  type AccountImportResult,
  type AccountImportSource,
  type ExecutionMode,
  type GroupItem,
} from "@slipgate/contracts";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import ImportResultSummary from "./ImportResultSummary.vue";
import PlatformTypeBadge from "./PlatformTypeBadge.vue";
import { EXECUTION_MODES, MODE_ICON } from "./accountDisplay";
import { accountStatusLabel, executionModeLabel, formatDateShort } from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";

/**
 * Bulk import from a Slipgate backup, a sub2api / linksyncx data export, or CLIProxyAPI (CPA)
 * auth files (one file per account, so several files can be picked or dropped at once).
 * Files are parsed in the browser (credentials never round-trip just for a preview); the
 * server validates each item again and skips credentials it already holds.
 */
const props = defineProps<{
  open: boolean;
  groups: GroupItem[];
  defaultGroupId: string;
  accountNames: ReadonlyMap<string, string>;
}>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "imported"): void }>();

const { t, te } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

const PREVIEW_LIMIT = 50;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 5000;

interface PickedFile {
  name: string;
  size: number;
  text: string;
}

type Source = "file" | "paste";
const source = ref<Source>("file");
const files = ref<PickedFile[]>([]);
const pasteText = ref("");
const reading = ref(false);
const fileError = ref<string | null>(null);
const dragDepth = ref(0);
const targetGroupId = ref("");
const matchGroupName = ref(true);
const matchPlatform = ref(true);
const subscriptionMode = ref<ExecutionMode>("stealth_http");
const apiKeyMode = ref<ExecutionMode>("direct_api");
const importPaused = ref(false);
const skipExisting = ref(true);
const importing = ref(false);
const result = ref<AccountImportResult | null>(null);
const showSkipped = ref(false);
/** Drops stale reads when another pick lands before the previous one finished. */
let readSeq = 0;

const sourceOptions = computed(() => [
  { value: "file" as const, label: t("accounts.import.sourceFile") },
  { value: "paste" as const, label: t("accounts.import.sourcePaste") },
]);

function clearFiles() {
  readSeq += 1;
  files.value = [];
  fileError.value = null;
  reading.value = false;
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    source.value = "file";
    clearFiles();
    pasteText.value = "";
    dragDepth.value = 0;
    result.value = null;
    showSkipped.value = false;
    importPaused.value = false;
    skipExisting.value = true;
    matchPlatform.value = true;
    // The group is optional: "" imports the accounts ungrouped.
    targetGroupId.value = props.defaultGroupId;
  },
);

/** JSON is parsed once per text change; the access-mode options only re-run the mapping. */
const documents = computed<AccountImportSource[] | null>(() => {
  if (source.value === "paste") {
    const text = pasteText.value.trim();
    return text ? [{ name: "", value: parseImportJsonText(text) }] : null;
  }
  if (!files.value.length) return null;
  return files.value.map((f) => ({ name: f.name, value: parseImportJsonText(f.text) }));
});

function formatErrorText(err: unknown): string {
  if (err instanceof AccountImportFormatError) return t(`accounts.import.fileErrors.${err.code}`);
  return err instanceof Error ? err.message : String(err);
}

const parseOutcome = computed<{ result: AccountImportParseResult | null; error: string | null }>(() => {
  const docs = documents.value;
  if (!docs) return { result: null, error: null };
  try {
    return {
      result: parseAccountImportSources(docs, { subscriptionMode: subscriptionMode.value, apiKeyMode: apiKeyMode.value }),
      error: null,
    };
  } catch (err) {
    return { result: null, error: t("accounts.import.parseError", { message: formatErrorText(err) }) };
  }
});

const parsed = computed(() => (source.value === "file" && fileError.value ? null : parseOutcome.value.result));
const parseError = computed(() => (source.value === "file" ? fileError.value : null) ?? parseOutcome.value.error);

const isJsonFile = (f: File) => /\.json$/i.test(f.name);

async function addFiles(list: File[]) {
  const seq = ++readSeq;
  if (!list.length) {
    files.value = [];
    fileError.value = t("accounts.import.parseError", { message: t("accounts.import.noJsonFiles") });
    reading.value = false;
    return;
  }
  result.value = null;
  showSkipped.value = false;
  const total = list.reduce((sum, f) => sum + f.size, 0);
  if (list.length > MAX_FILES || total > MAX_TOTAL_BYTES) {
    // Drop the previous pick too, so a rejected one cannot import stale content.
    files.value = [];
    reading.value = false;
    fileError.value = t("accounts.import.parseError", {
      message:
        list.length > MAX_FILES
          ? t("accounts.import.tooManyFiles", { max: MAX_FILES })
          : t("accounts.import.tooLarge", { max: MAX_TOTAL_BYTES / 1024 / 1024 }),
    });
    return;
  }
  fileError.value = null;
  reading.value = true;
  // An unreadable file reads as empty text and is reported as "not JSON" with the rest.
  const picked = await Promise.all(
    list.map(async (f) => ({ name: f.name, size: f.size, text: await f.text().catch(() => "") })),
  );
  if (seq !== readSeq) return;
  files.value = picked.sort((a, b) => a.name.localeCompare(b.name));
  reading.value = false;
}

function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const list = Array.from(input.files ?? []);
  input.value = "";
  if (list.length) void addFiles(list);
}

/** A CPA auth directory holds one JSON file per account; non-JSON files in it are ignored. */
function pickFolder() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.webkitdirectory = true;
  input.addEventListener("change", () => {
    const list = Array.from(input.files ?? []);
    if (list.length) void addFiles(list.filter(isJsonFile));
  });
  input.click();
}

function readEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** Files of dropped entries; folders are walked (JSON files only, a few levels deep). */
async function collectEntries(entries: FileSystemEntry[], depth = 0): Promise<File[]> {
  const out: File[] = [];
  for (const entry of entries) {
    if (out.length > MAX_FILES) break;
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) => (entry as FileSystemFileEntry).file(resolve, () => resolve(null)));
      if (file && (depth === 0 || isJsonFile(file))) out.push(file);
    } else if (entry.isDirectory && depth < 3) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries returns batches (about 100 in Chromium) until an empty one.
      for (let batch = await readEntries(reader); batch.length; batch = await readEntries(reader)) {
        out.push(...(await collectEntries(batch, depth + 1)));
      }
    }
  }
  return out;
}

function onDragEnter() {
  dragDepth.value += 1;
}

function onDragLeave() {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}

function onDrop(ev: DragEvent) {
  dragDepth.value = 0;
  const dt = ev.dataTransfer;
  if (!dt) return;
  // Entries must be taken synchronously: the drag data store closes when the handler returns.
  const entries = Array.from(dt.items ?? [])
    .map((item) => (item.kind === "file" ? item.webkitGetAsEntry?.() : null))
    .filter((entry): entry is FileSystemEntry => !!entry);
  const plainFiles = Array.from(dt.files);
  if (!entries.length) {
    if (plainFiles.length) void addFiles(plainFiles);
    return;
  }
  const seq = ++readSeq;
  reading.value = true;
  void collectEntries(entries)
    .catch(() => plainFiles)
    .then((list) => {
      if (seq === readSeq) void addFiles(list);
    });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const filesSummary = computed(() => {
  const list = files.value;
  if (!list.length) return "";
  if (list.length === 1) return t("accounts.import.fileName", { name: list[0]!.name });
  const size = formatBytes(list.reduce((sum, f) => sum + f.size, 0));
  return t("accounts.import.filesSelected", { count: list.length, size });
});

const groupByName = computed(() => new Map(props.groups.map((g) => [g.name.toLowerCase(), g.id])));

/** First group per platform, enabled groups first (composite groups never match a platform). */
const groupByPlatform = computed(() => {
  const map = new Map<string, string>();
  for (const g of [...props.groups].sort((a, b) => Number(b.enabled) - Number(a.enabled))) {
    if (g.platform !== "composite" && !map.has(g.platform)) map.set(g.platform, g.id);
  }
  return map;
});

const targetPlatform = computed(() => props.groups.find((g) => g.id === targetGroupId.value)?.platform ?? null);

function groupFor(draft: { groupName: string | null; platform: string }): string {
  if (matchGroupName.value && draft.groupName) {
    const match = groupByName.value.get(draft.groupName.toLowerCase());
    if (match) return match;
  }
  // A CPA folder mixes providers: land each account in a group of its own platform.
  // Only relative to a chosen group; "no group" keeps every unmatched account ungrouped.
  if (matchPlatform.value && targetGroupId.value && targetPlatform.value !== draft.platform) {
    const match = groupByPlatform.value.get(draft.platform);
    if (match) return match;
  }
  return targetGroupId.value;
}

/** The platform option is only offered when it would move at least one account. */
const showMatchPlatform = computed(
  () =>
    !!targetGroupId.value &&
    (parsed.value?.drafts.some((d) => targetPlatform.value !== d.platform && groupByPlatform.value.has(d.platform)) ?? false),
);

const groupNameById = computed(() => new Map(props.groups.map((g) => [g.id, g.name])));

function reasonText(reason: string, detail: string): string {
  const key = `accounts.import.reasons.${reason}`;
  if (!te(key)) return reason;
  if (reason === "unrecognized_file") {
    const errKey = `accounts.import.fileErrors.${detail}`;
    return t(key, { detail: te(errKey) ? t(errKey) : detail });
  }
  return t(key, { detail });
}

const formatsText = computed(() =>
  (parsed.value?.formats ?? []).map((f) => t(`accounts.import.formats.${f}`)).join(" + "),
);

/** Access-mode pickers only matter for accounts that did not bring a mode of their own. */
const showSubscriptionMode = computed(
  () => parsed.value?.drafts.some((d) => d.origin !== "slipgate" && d.authKind !== "api_key") ?? false,
);
const showApiKeyMode = computed(
  () => parsed.value?.drafts.some((d) => d.origin !== "slipgate" && d.authKind === "api_key") ?? false,
);

const previewRows = computed(() =>
  (parsed.value?.drafts ?? []).slice(0, PREVIEW_LIMIT).map((d, i) => ({
    ...d,
    key: `${i}-${d.name}`,
    groupLabel: groupNameById.value.get(groupFor(d)) ?? t("accounts.ungrouped"),
    tierMultiplier: subscriptionTierMultiplier(d.platform, d.subscriptionTier),
  })),
);

const canImport = computed(
  () => !reading.value && !!parsed.value?.drafts.length && !importing.value,
);

async function runImport() {
  const p = parsed.value;
  if (!p || !canImport.value) return;
  importing.value = true;
  const items = p.drafts.map(({ groupName, sourceLabel: _source, origin: _origin, ...draft }) => ({
    ...draft,
    groupId: groupFor({ groupName, platform: draft.platform }),
    status: importPaused.value ? "paused" : draft.status,
  }));
  const merged: AccountImportResult = { created: 0, skipped: 0, failed: 0, results: [] };
  try {
    for (let offset = 0; offset < items.length; offset += 1000) {
      const res = await auth.apiFetch("/api/v1/admin/accounts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: items.slice(offset, offset + 1000), skipExisting: skipExisting.value }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        toast.error(data.message ?? t("accounts.errors.importFailed"));
        break;
      }
      const part = (await res.json()) as AccountImportResult;
      merged.created += part.created;
      merged.skipped += part.skipped;
      merged.failed += part.failed;
      merged.results.push(
        ...part.results.map((r) => ({
          ...r,
          index: r.index + offset,
          duplicateOfIndex: r.duplicateOfIndex === undefined ? undefined : r.duplicateOfIndex + offset,
        })),
      );
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : t("accounts.errors.importFailed"));
  } finally {
    importing.value = false;
  }
  if (merged.results.length) {
    result.value = merged;
    if (merged.created > 0) emit("imported");
  }
}

function startOver() {
  result.value = null;
  clearFiles();
  pasteText.value = "";
}
</script>

<template>
  <UiModal :open="open" :title="t('accounts.import.title')" width="xl" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="upload" :size="16" /></span>
    </template>

    <!-- Result -->
    <div v-if="result" class="space-y-4">
      <UiAlert :tone="result.failed ? 'warning' : 'success'" :title="t('accounts.import.resultTitle')" />
      <ImportResultSummary :result="result" :account-names="accountNames" />
    </div>

    <div v-else class="space-y-5">
      <!-- Source -->
      <div class="space-y-3">
        <SegmentedControl v-model="source" :options="sourceOptions" />
        <template v-if="source === 'file'">
          <label
            class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors"
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
            <UiIcon :name="reading ? 'loader' : 'file'" :size="22" :spin="reading" class="text-fg-subtle" />
            <span class="text-sm font-medium text-fg">
              {{ reading ? t("accounts.import.reading") : filesSummary || t("accounts.import.pickFile") }}
            </span>
            <span class="text-2xs text-fg-subtle">
              {{ t("accounts.import.dropHint") }}
              <button type="button" class="cursor-pointer font-medium text-accent hover:underline" @click.stop.prevent="pickFolder">
                {{ t("accounts.import.pickFolder") }}
              </button>
            </span>
            <span class="text-2xs text-fg-subtle">
              {{ t("accounts.import.formats.slipgate") }} · {{ t("accounts.import.formats.sub2api") }} ·
              {{ t("accounts.import.formats.cpa") }}
            </span>
            <input type="file" accept=".json,application/json" multiple class="sr-only" @change="onFile" />
          </label>
          <div v-if="files.length > 1 && !reading" class="flex items-center justify-between gap-2 text-2xs text-fg-subtle">
            <span class="min-w-0 truncate font-mono">
              {{ files.slice(0, 3).map((f) => f.name).join(", ") }}<template v-if="files.length > 3"> …</template>
            </span>
            <button type="button" class="inline-flex shrink-0 cursor-pointer items-center gap-1 hover:text-fg" @click="clearFiles">
              <UiIcon name="x" :size="12" />
              {{ t("accounts.import.clearFiles") }}
            </button>
          </div>
        </template>
        <textarea
          v-else
          v-model="pasteText"
          rows="8"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('accounts.import.pastePlaceholder')"
          class="textarea font-mono text-xs"
        />
        <UiAlert v-if="parseError" tone="danger">{{ parseError }}</UiAlert>
        <div v-else-if="parsed" class="flex flex-wrap items-center gap-2 text-sm">
          <UiBadge tone="accent">
            {{ t("accounts.import.detected", { format: formatsText, count: parsed.drafts.length }) }}
          </UiBadge>
          <button
            v-if="parsed.skipped.length"
            type="button"
            class="inline-flex cursor-pointer items-center gap-1 text-xs text-warning hover:underline"
            :aria-expanded="showSkipped"
            @click="showSkipped = !showSkipped"
          >
            <UiIcon name="alert" :size="13" />
            {{ t("accounts.import.skippedCount", { count: parsed.skipped.length }) }}
          </button>
        </div>
        <ul v-if="parsed && showSkipped" class="max-h-32 space-y-1 overflow-y-auto rounded-lg bg-surface-2/60 p-2 text-xs">
          <li v-for="s in parsed.skipped" :key="s.index" class="flex gap-2">
            <span class="font-mono text-fg-subtle">#{{ s.index + 1 }}</span>
            <span class="min-w-0 truncate font-medium text-fg">{{ s.name }}</span>
            <span class="shrink-0 text-fg-muted">{{ reasonText(s.reason, s.detail) }}</span>
          </li>
        </ul>
        <UiAlert v-if="parsed?.formats.includes('cpa')" tone="info" :title="t('accounts.import.cpaHintTitle')">
          {{ t("accounts.import.cpaHint") }}
        </UiAlert>
      </div>

      <!-- Options -->
      <div v-if="parsed?.drafts.length" class="grid gap-4 sm:grid-cols-2">
        <label class="block min-w-0">
          <span class="label">{{ t("accounts.import.targetGroup") }}</span>
          <select v-model="targetGroupId" class="select">
            <option value="">{{ t("accounts.form.noGroup") }}</option>
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
          <span v-if="!targetGroupId" class="mt-1 block text-2xs leading-relaxed text-fg-subtle">{{ t("accounts.import.noGroupHint") }}</span>
        </label>
        <div class="flex flex-col justify-end gap-2 pb-1">
          <label v-if="parsed.formats.includes('slipgate')" class="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
            <input v-model="matchGroupName" type="checkbox" class="checkbox" />
            {{ t("accounts.import.matchGroupName") }}
          </label>
          <label v-if="showMatchPlatform" class="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
            <input v-model="matchPlatform" type="checkbox" class="checkbox" />
            {{ t("accounts.import.matchPlatform") }}
          </label>
          <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
            <input v-model="importPaused" type="checkbox" class="checkbox" />
            {{ t("accounts.import.importPaused") }}
          </label>
          <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
            <input v-model="skipExisting" type="checkbox" class="checkbox" />
            {{ t("accounts.import.skipExisting") }}
          </label>
        </div>
        <label v-if="showSubscriptionMode" class="block min-w-0">
          <span class="label">{{ t("accounts.import.subscriptionMode") }}</span>
          <select v-model="subscriptionMode" class="select">
            <option v-for="m in EXECUTION_MODES" :key="m" :value="m">{{ executionModeLabel(m) }}</option>
          </select>
        </label>
        <label v-if="showApiKeyMode" class="block min-w-0">
          <span class="label">{{ t("accounts.import.apiKeyMode") }}</span>
          <select v-model="apiKeyMode" class="select">
            <option v-for="m in EXECUTION_MODES" :key="m" :value="m">{{ executionModeLabel(m) }}</option>
          </select>
        </label>
      </div>

      <!-- Preview -->
      <div v-if="previewRows.length" class="space-y-2">
        <p class="eyebrow">{{ t("accounts.import.preview") }}</p>
        <div class="table-wrap max-h-72 overflow-y-auto rounded-lg border border-line/70">
          <table class="data-table">
            <thead>
              <tr>
                <th>{{ t("accounts.columns.name") }}</th>
                <th>{{ t("accounts.columns.platform") }}</th>
                <th>{{ t("accounts.columns.group") }}</th>
                <th>{{ t("accounts.columns.limits") }}</th>
                <th>{{ t("accounts.columns.expires") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in previewRows" :key="row.key">
                <td class="max-w-[14rem]">
                  <p class="flex items-center gap-1.5 text-xs font-medium text-fg">
                    <span class="truncate">{{ row.name }}</span>
                    <UiBadge v-if="row.status === 'paused' || importPaused" tone="neutral" class="shrink-0">
                      {{ accountStatusLabel("paused") }}
                    </UiBadge>
                  </p>
                  <p v-if="row.sourceLabel || row.notes" class="truncate font-mono text-2xs text-fg-subtle">
                    {{ [row.sourceLabel, row.notes].filter(Boolean).join(" · ") }}
                  </p>
                </td>
                <td class="whitespace-nowrap">
                  <PlatformTypeBadge
                    inline
                    :platform="row.platform"
                    :auth-kind="row.authKind"
                    :subscription-tier="row.subscriptionTier"
                    :tier-multiplier="row.tierMultiplier"
                  />
                  <p class="mt-1 flex items-center gap-1 text-2xs text-fg-subtle">
                    <UiIcon :name="MODE_ICON[row.executionMode]" :size="11" />
                    {{ executionModeLabel(row.executionMode) }}
                  </p>
                </td>
                <td class="max-w-[9rem] truncate text-xs text-fg-muted">{{ row.groupLabel }}</td>
                <td class="whitespace-nowrap font-mono text-xs">{{ row.maxConcurrency }} / #{{ row.priority }}</td>
                <td class="whitespace-nowrap font-mono text-xs text-fg-muted">
                  {{ row.expiresAtIso ? formatDateShort(row.expiresAtIso) : "—" }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="(parsed?.drafts.length ?? 0) > PREVIEW_LIMIT" class="text-2xs text-fg-subtle">
          {{ t("accounts.import.previewMore", { shown: PREVIEW_LIMIT, total: parsed?.drafts.length ?? 0 }) }}
        </p>
      </div>
    </div>

    <template #footer>
      <template v-if="result">
        <button type="button" class="btn btn-secondary" @click="startOver">{{ t("accounts.import.again") }}</button>
        <button type="button" class="btn btn-primary" @click="emit('update:open', false)">{{ t("common.close") }}</button>
      </template>
      <template v-else>
        <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">{{ t("common.cancel") }}</button>
        <button type="button" class="btn btn-primary" :disabled="!canImport" @click="runImport">
          <UiIcon :name="importing ? 'loader' : 'upload'" :size="14" :spin="importing" />
          {{ importing ? t("accounts.import.importing") : t("accounts.import.submit", { count: parsed?.drafts.length ?? 0 }) }}
        </button>
      </template>
    </template>
  </UiModal>
</template>
