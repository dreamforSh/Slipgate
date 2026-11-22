<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  AccountImportFormatError,
  parseAccountImportFile,
  subscriptionTierMultiplier,
  type AccountImportParseResult,
  type AccountImportResult,
  type ExecutionMode,
  type GroupItem,
} from "@slipgate/contracts";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import ImportResultSummary from "./ImportResultSummary.vue";
import { EXECUTION_MODES, tierBadge, tierTone } from "./accountDisplay";
import { PROVIDER_OPTIONS, executionModeLabel, formatDateShort } from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";

/**
 * Bulk import from a Slipgate backup or a sub2api / linksyncx data export. The file is parsed
 * in the browser (credentials never round-trip just for a preview); the server validates
 * each item again and skips credentials it already holds.
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
const MAX_FILE_BYTES = 20 * 1024 * 1024;

type Source = "file" | "paste";
const source = ref<Source>("file");
const fileName = ref("");
const rawText = ref("");
const fileError = ref<string | null>(null);
const targetGroupId = ref("");
const matchGroupName = ref(true);
const subscriptionMode = ref<ExecutionMode>("stealth_http");
const apiKeyMode = ref<ExecutionMode>("direct_api");
const importPaused = ref(false);
const skipExisting = ref(true);
const importing = ref(false);
const result = ref<AccountImportResult | null>(null);
const showSkipped = ref(false);

const sourceOptions = computed(() => [
  { value: "file" as const, label: t("accounts.import.sourceFile") },
  { value: "paste" as const, label: t("accounts.import.sourcePaste") },
]);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    source.value = "file";
    fileName.value = "";
    rawText.value = "";
    fileError.value = null;
    result.value = null;
    showSkipped.value = false;
    importPaused.value = false;
    skipExisting.value = true;
    targetGroupId.value = props.defaultGroupId || props.groups[0]?.id || "";
  },
);

/** JSON is parsed once per text change; the access-mode options only re-run the mapping. */
const json = computed<{ ok: true; value: unknown } | { ok: false } | null>(() => {
  const text = rawText.value.trim();
  if (!text) return null;
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
});

const parseOutcome = computed<{ result: AccountImportParseResult | null; error: string | null }>(() => {
  const doc = json.value;
  if (!doc) return { result: null, error: null };
  if (!doc.ok) return { result: null, error: t("accounts.import.parseError", { message: t("accounts.import.notJson") }) };
  try {
    return {
      result: parseAccountImportFile(doc.value, { subscriptionMode: subscriptionMode.value, apiKeyMode: apiKeyMode.value }),
      error: null,
    };
  } catch (err) {
    const message = err instanceof AccountImportFormatError || err instanceof Error ? err.message : String(err);
    return { result: null, error: t("accounts.import.parseError", { message }) };
  }
});

const parsed = computed(() => parseOutcome.value.result);
const parseError = computed(() => fileError.value ?? parseOutcome.value.error);

async function onFile(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    // Drop the previous file too, so the rejected pick cannot import stale content.
    rawText.value = "";
    fileName.value = "";
    fileError.value = t("accounts.import.parseError", { message: `> ${MAX_FILE_BYTES / 1024 / 1024} MB` });
    return;
  }
  fileError.value = null;
  fileName.value = file.name;
  result.value = null;
  rawText.value = await file.text();
}

const groupByName = computed(() => new Map(props.groups.map((g) => [g.name.toLowerCase(), g.id])));

function groupFor(groupName: string | null): string {
  if (matchGroupName.value && groupName) {
    const match = groupByName.value.get(groupName.toLowerCase());
    if (match) return match;
  }
  return targetGroupId.value;
}

const groupNameById = computed(() => new Map(props.groups.map((g) => [g.id, g.name])));
const platformLabel = (p: string) => PROVIDER_OPTIONS.find((o) => o.value === p)?.label ?? p;

function reasonText(reason: string, detail: string): string {
  const key = `accounts.import.reasons.${reason}`;
  return te(key) ? t(key, { detail }) : reason;
}

const previewRows = computed(() =>
  (parsed.value?.drafts ?? []).slice(0, PREVIEW_LIMIT).map((d, i) => ({
    ...d,
    key: `${i}-${d.name}`,
    groupLabel: groupNameById.value.get(groupFor(d.groupName)) ?? "",
    tierMultiplier: subscriptionTierMultiplier(d.platform, d.subscriptionTier),
  })),
);

const canImport = computed(
  () => !fileError.value && !!parsed.value?.drafts.length && !!targetGroupId.value && !importing.value,
);

async function runImport() {
  const p = parsed.value;
  if (!p || !canImport.value) return;
  importing.value = true;
  const items = p.drafts.map(({ groupName, sourceLabel: _source, ...draft }) => ({
    ...draft,
    groupId: groupFor(groupName),
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
  rawText.value = "";
  fileName.value = "";
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
        <label
          v-if="source === 'file'"
          class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface-2/40 px-4 py-8 text-center transition-colors hover:border-accent/50 hover:bg-accent/[0.04]"
        >
          <UiIcon name="file" :size="22" class="text-fg-subtle" />
          <span class="text-sm font-medium text-fg">{{ fileName ? t("accounts.import.fileName", { name: fileName }) : t("accounts.import.pickFile") }}</span>
          <span class="text-2xs text-fg-subtle">{{ t("accounts.import.formats.slipgate") }} · {{ t("accounts.import.formats.sub2api") }}</span>
          <input type="file" accept=".json,application/json" class="sr-only" @change="onFile" />
        </label>
        <textarea
          v-else
          v-model="rawText"
          rows="8"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('accounts.import.pastePlaceholder')"
          class="textarea font-mono text-xs"
        />
        <UiAlert v-if="parseError" tone="danger">{{ parseError }}</UiAlert>
        <div v-else-if="parsed" class="flex flex-wrap items-center gap-2 text-sm">
          <UiBadge tone="accent">
            {{ t("accounts.import.detected", { format: t(`accounts.import.formats.${parsed.format}`), count: parsed.drafts.length }) }}
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
            <span class="font-medium text-fg">{{ s.name }}</span>
            <span class="text-fg-muted">{{ reasonText(s.reason, s.detail) }}</span>
          </li>
        </ul>
      </div>

      <!-- Options -->
      <div v-if="parsed?.drafts.length" class="grid gap-4 sm:grid-cols-2">
        <label class="block min-w-0">
          <span class="label">{{ t("accounts.import.targetGroup") }} <span class="text-danger">*</span></span>
          <select v-model="targetGroupId" class="select">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
          </select>
        </label>
        <div class="flex flex-col justify-end gap-2 pb-1">
          <label v-if="parsed.format === 'slipgate'" class="inline-flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
            <input v-model="matchGroupName" type="checkbox" class="checkbox" />
            {{ t("accounts.import.matchGroupName") }}
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
        <template v-if="parsed.format === 'sub2api'">
          <label class="block min-w-0">
            <span class="label">{{ t("accounts.import.subscriptionMode") }}</span>
            <select v-model="subscriptionMode" class="select">
              <option v-for="m in EXECUTION_MODES" :key="m" :value="m">{{ executionModeLabel(m) }}</option>
            </select>
          </label>
          <label class="block min-w-0">
            <span class="label">{{ t("accounts.import.apiKeyMode") }}</span>
            <select v-model="apiKeyMode" class="select">
              <option v-for="m in EXECUTION_MODES" :key="m" :value="m">{{ executionModeLabel(m) }}</option>
            </select>
          </label>
        </template>
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
                <td class="max-w-[12rem]">
                  <p class="truncate text-xs font-medium text-fg">{{ row.name }}</p>
                  <p v-if="row.sourceLabel" class="truncate font-mono text-2xs text-fg-subtle">{{ row.sourceLabel }}</p>
                </td>
                <td class="whitespace-nowrap">
                  <span class="text-xs text-fg">{{ platformLabel(row.platform) }}</span>
                  <UiBadge :tone="tierTone(row)" mono class="ml-1">{{ tierBadge(row) }}</UiBadge>
                  <p class="text-2xs text-fg-subtle">{{ executionModeLabel(row.executionMode) }}</p>
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
