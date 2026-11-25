<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type {
  AnnouncementAudience,
  AnnouncementItem,
  AnnouncementLevel,
  AnnouncementStatus,
  UpsertAnnouncementRequest,
} from "@slipgate/contracts";
import FormField from "../../ui/FormField.vue";
import MarkdownView from "../../ui/MarkdownView.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiAlert from "../../ui/UiAlert.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import UiSwitch from "../../ui/UiSwitch.vue";
import { ApiError, apiJson, errorText } from "../../../lib/api";
import { useToastStore } from "../../../stores/toast";
import AnnouncementTargetingEditor from "./AnnouncementTargetingEditor.vue";
import {
  draftFromTargeting,
  isBrokenTargeting,
  targetingFromDraft,
  useSubscriptionGroups,
  validateDraft,
  type TargetingDraft,
} from "./announcementTargeting";
import { isoToLocalInput, localInputToIso, type AnnouncementEditorMode } from "./opsUtil";
import UiSelect from "../../ui/UiSelect.vue";

/** Create / edit / duplicate an announcement with a Markdown editor and live preview. */
const props = defineProps<{ open: boolean; mode: AnnouncementEditorMode; item: AnnouncementItem | null }>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "saved", item: AnnouncementItem, created: boolean): void;
}>();

const { t } = useI18n();
const toast = useToastStore();

interface EditorForm {
  title: string;
  content: string;
  level: AnnouncementLevel;
  status: AnnouncementStatus;
  audience: AnnouncementAudience;
  pinned: boolean;
  popup: boolean;
  startsLocal: string;
  endsLocal: string;
}

const form = reactive<EditorForm>({
  title: "",
  content: "",
  level: "info",
  status: "draft",
  audience: "all",
  pinned: false,
  popup: false,
  startsLocal: "",
  endsLocal: "",
});
const saving = ref(false);
const attempted = ref(false);
const pane = ref<"write" | "preview">("write");
const textarea = ref<HTMLTextAreaElement | null>(null);
const targeting = ref<TargetingDraft>(draftFromTargeting(null));
/** The stored rule no longer parses (it matches nobody until it is set again). */
const brokenRule = ref(false);
const subGroups = useSubscriptionGroups();

const modalTitle = computed(() =>
  props.mode === "edit"
    ? t("annAdmin.editor.editTitle")
    : props.mode === "duplicate"
      ? t("annAdmin.editor.duplicateTitle")
      : t("annAdmin.editor.createTitle"),
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    attempted.value = false;
    pane.value = "write";
    const it = props.item;
    const dup = props.mode === "duplicate";
    Object.assign(form, {
      title: it ? (dup ? `${it.title}${t("annAdmin.copySuffix")}`.slice(0, 120) : it.title) : "",
      content: it?.content ?? "",
      level: it?.level ?? "info",
      status: dup ? "draft" : (it?.status ?? "draft"),
      audience: it?.audience ?? "all",
      pinned: it?.pinned ?? false,
      popup: it?.popup ?? false,
      startsLocal: isoToLocalInput(it?.startsAtIso),
      endsLocal: isoToLocalInput(it?.endsAtIso),
    } satisfies EditorForm);
    targeting.value = draftFromTargeting(it?.targeting);
    brokenRule.value = isBrokenTargeting(it?.targeting);
    // Group names / validity for the picker; a failure only shows a retry inside the editor.
    void subGroups.load(true);
  },
  { immediate: true },
);

const levelOptions = computed(() =>
  (["info", "success", "warning", "important"] as const).map((value) => ({ value, label: t(`annAdmin.levels.${value}`) })),
);
const statusOptions = computed(() =>
  (["draft", "published", "archived"] as const).map((value) => ({ value, label: t(`annAdmin.statuses.${value}`) })),
);
const audienceOptions = computed(() =>
  (["all", "users", "admins"] as const).map((value) => ({ value, label: t(`annAdmin.audiences.${value}`) })),
);
const paneOptions = computed(() => [
  { value: "write" as const, label: t("annAdmin.editor.write") },
  { value: "preview" as const, label: t("annAdmin.editor.preview") },
]);

const levelDot: Record<AnnouncementLevel, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  important: "bg-danger",
};

/* ---------------- Validation ---------------- */

const errors = computed(() => {
  const e: Partial<Record<"title" | "window", string>> = {};
  if (!form.title.trim()) e.title = t("annAdmin.editor.errors.title");
  const s = localInputToIso(form.startsLocal);
  const en = localInputToIso(form.endsLocal);
  if (s && en && Date.parse(s) >= Date.parse(en)) e.window = t("annAdmin.editor.errors.window");
  return e;
});
const shown = computed(() => (attempted.value ? errors.value : {}));
const targetingIssues = computed(() => validateDraft(targeting.value, subGroups.validIds.value));
const audienceLabel = computed(() => t(`annAdmin.audiences.${form.audience}`));

/* ---------------- Markdown toolbar ---------------- */

function applyEdit(next: string, selStart: number, selEnd: number) {
  form.content = next;
  void nextTick(() => {
    const el = textarea.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange(selStart, selEnd);
  });
}

function wrap(before: string, after: string, sample: string) {
  const el = textarea.value;
  if (!el) return;
  const { selectionStart: s, selectionEnd: e, value } = el;
  const selected = value.slice(s, e) || sample;
  const next = value.slice(0, s) + before + selected + after + value.slice(e);
  applyEdit(next, s + before.length, s + before.length + selected.length);
}

function insertLink() {
  const el = textarea.value;
  if (!el) return;
  const { selectionStart: s, selectionEnd: e, value } = el;
  const text = value.slice(s, e) || t("annAdmin.editor.toolbar.linkSample");
  const url = "https://";
  const snippet = `[${text}](${url})`;
  const urlStart = s + text.length + 3;
  applyEdit(value.slice(0, s) + snippet + value.slice(e), urlStart, urlStart + url.length);
}

function insertList() {
  const el = textarea.value;
  if (!el) return;
  const { selectionStart: s, selectionEnd: e, value } = el;
  const lineStart = value.lastIndexOf("\n", s - 1) + 1;
  const block = value.slice(lineStart, e) || t("annAdmin.editor.toolbar.listSample");
  const listed = block
    .split("\n")
    .map((line) => (/^\s*[-*]\s/.test(line) ? line : `- ${line}`))
    .join("\n");
  const next = value.slice(0, lineStart) + listed + value.slice(Math.max(e, lineStart));
  applyEdit(next, lineStart, lineStart + listed.length);
}

function insertCode() {
  const el = textarea.value;
  if (!el) return;
  const selected = el.value.slice(el.selectionStart, el.selectionEnd);
  if (selected.includes("\n")) wrap("```\n", "\n```", selected);
  else wrap("`", "`", t("annAdmin.editor.toolbar.codeSample"));
}

const tools = computed(() => [
  { key: "bold", label: t("annAdmin.editor.toolbar.bold"), glyph: "B", cls: "font-bold", run: () => wrap("**", "**", t("annAdmin.editor.toolbar.boldSample")) },
  { key: "italic", label: t("annAdmin.editor.toolbar.italic"), glyph: "I", cls: "font-serif italic", run: () => wrap("*", "*", t("annAdmin.editor.toolbar.italicSample")) },
  { key: "link", label: t("annAdmin.editor.toolbar.link"), icon: "link" as const, run: insertLink },
  { key: "list", label: t("annAdmin.editor.toolbar.list"), icon: "list" as const, run: insertList },
  { key: "code", label: t("annAdmin.editor.toolbar.code"), icon: "braces" as const, run: insertCode },
]);

function onKeydown(ev: KeyboardEvent) {
  if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  const key = ev.key.toLowerCase();
  if (key === "b") {
    ev.preventDefault();
    wrap("**", "**", t("annAdmin.editor.toolbar.boldSample"));
  } else if (key === "i") {
    ev.preventDefault();
    wrap("*", "*", t("annAdmin.editor.toolbar.italicSample"));
  } else if (key === "k") {
    ev.preventDefault();
    insertLink();
  }
}

/* ---------------- Submit ---------------- */

const targetingBox = ref<HTMLElement | null>(null);

/** Friendly copy for a refused targeting rule (the server answers 400 with a Zod path message). */
function saveErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return t("annAdmin.errors.notFound");
    if (err.status === 400 && /targeting/i.test(err.message)) {
      if (/not a subscription group/i.test(err.message)) {
        // A group was deleted or re-billed meanwhile: refresh the picker so it shows as stale.
        void subGroups.load(true);
        return t("annAdmin.targeting.errors.unknownGroups");
      }
      return t("annAdmin.targeting.errors.invalid");
    }
  }
  return errorText(err, t("annAdmin.errors.save"));
}

async function submit() {
  attempted.value = true;
  if (Object.keys(errors.value).length > 0) return;
  const issues = targetingIssues.value;
  if (issues.count > 0) {
    toast.error(t("annAdmin.targeting.errors.fix", { n: issues.count }));
    targetingBox.value?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
    });
    return;
  }
  const body: UpsertAnnouncementRequest = {
    title: form.title.trim(),
    content: form.content,
    level: form.level,
    status: form.status,
    audience: form.audience,
    targeting: targetingFromDraft(targeting.value),
    pinned: form.pinned,
    popup: form.popup,
    startsAtIso: localInputToIso(form.startsLocal),
    endsAtIso: localInputToIso(form.endsLocal),
  };
  saving.value = true;
  try {
    const editingId = props.mode === "edit" ? props.item?.id : undefined;
    const { item } = editingId
      ? await apiJson<{ item: AnnouncementItem }>(`/api/v1/admin/announcements/${encodeURIComponent(editingId)}`, {
          method: "PUT",
          body,
          fallbackError: t("annAdmin.errors.save"),
        })
      : await apiJson<{ item: AnnouncementItem }>("/api/v1/admin/announcements", {
          method: "POST",
          body,
          fallbackError: t("annAdmin.errors.save"),
        });
    emit("saved", item, !editingId);
    emit("update:open", false);
  } catch (err) {
    toast.error(saveErrorText(err));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UiModal :open="open" width="xl" :title="modalTitle" :persistent="saving" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8">
        <UiIcon :name="mode === 'edit' ? 'pencil' : mode === 'duplicate' ? 'copy' : 'megaphone'" :size="15" />
      </span>
    </template>

    <form id="announcement-form" class="space-y-4" novalidate @submit.prevent="submit">
      <FormField :label="t('annAdmin.editor.title')" required>
        <input
          v-model="form.title"
          type="text"
          maxlength="120"
          class="input"
          :class="shown.title ? '!border-danger' : ''"
          :placeholder="t('annAdmin.editor.titlePlaceholder')"
        />
        <p v-if="shown.title" class="mt-1 text-xs text-danger">{{ shown.title }}</p>
      </FormField>

      <div class="grid gap-4 sm:grid-cols-3">
        <FormField :label="t('annAdmin.editor.level')">
          <span class="relative block">
            <span
              class="pointer-events-none absolute left-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
              :class="levelDot[form.level]"
            />
            <UiSelect v-model="form.level" class="select pl-7">
              <option v-for="o in levelOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </UiSelect>
          </span>
        </FormField>
        <FormField :label="t('annAdmin.editor.status')">
          <UiSelect v-model="form.status" class="select">
            <option v-for="o in statusOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </UiSelect>
        </FormField>
        <FormField :label="t('annAdmin.editor.audience')">
          <UiSelect v-model="form.audience" class="select">
            <option v-for="o in audienceOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </UiSelect>
        </FormField>
      </div>

      <div ref="targetingBox" class="scroll-mt-4 space-y-2">
        <UiAlert v-if="brokenRule && targetingIssues.emptyGroups.size > 0" tone="warning" :title="t('annAdmin.targeting.broken')">
          {{ t("annAdmin.targeting.brokenHint") }}
        </UiAlert>
        <AnnouncementTargetingEditor
          v-model="targeting"
          :groups="subGroups.subscriptionGroups.value"
          :groups-by-id="subGroups.byId.value"
          :groups-loading="subGroups.loading.value"
          :groups-failed="subGroups.failed.value"
          :issues="targetingIssues"
          :show-errors="attempted"
          :audience-label="audienceLabel"
          :disabled="saving"
          @retry-groups="subGroups.load(true)"
        />
      </div>

      <div class="grid gap-3 sm:grid-cols-2">
        <div class="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/40 px-3.5 py-3">
          <div class="min-w-0">
            <p class="flex items-center gap-2 text-sm font-medium text-fg">
              <UiIcon name="arrow-up" :size="14" class="text-accent" />
              {{ t("annAdmin.editor.pinned") }}
            </p>
            <p class="mt-0.5 text-xs text-fg-subtle">{{ t("annAdmin.editor.pinnedHint") }}</p>
          </div>
          <UiSwitch v-model="form.pinned" tone="accent" :label="t('annAdmin.editor.pinned')" hide-label />
        </div>
        <div class="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface-2/40 px-3.5 py-3">
          <div class="min-w-0">
            <p class="flex items-center gap-2 text-sm font-medium text-fg">
              <UiIcon name="bell" :size="14" class="text-violet" />
              {{ t("annAdmin.editor.popup") }}
            </p>
            <p class="mt-0.5 text-xs text-fg-subtle">{{ t("annAdmin.editor.popupHint") }}</p>
          </div>
          <UiSwitch v-model="form.popup" tone="accent" :label="t('annAdmin.editor.popup')" hide-label />
        </div>
      </div>

      <div>
        <div class="grid gap-4 sm:grid-cols-2">
          <FormField :label="t('annAdmin.editor.startsAt')">
            <input v-model="form.startsLocal" type="datetime-local" class="input" />
          </FormField>
          <FormField :label="t('annAdmin.editor.endsAt')">
            <input
              v-model="form.endsLocal"
              type="datetime-local"
              class="input"
              :class="shown.window ? '!border-danger' : ''"
              :min="form.startsLocal || undefined"
            />
          </FormField>
        </div>
        <p class="mt-1 text-xs" :class="shown.window ? 'text-danger' : 'text-fg-subtle'">
          {{ shown.window ?? t("annAdmin.editor.windowHint") }}
        </p>
      </div>

      <div>
        <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <span class="label !mb-0">{{ t("annAdmin.editor.content") }}</span>
          <SegmentedControl v-model="pane" :options="paneOptions" class="lg:hidden" />
        </div>

        <div class="overflow-hidden rounded-xl border border-line focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15">
          <div class="flex items-center gap-0.5 border-b border-line bg-surface-2/50 px-1.5 py-1">
            <button
              v-for="tool in tools"
              :key="tool.key"
              type="button"
              class="btn btn-ghost btn-icon btn-xs"
              :title="tool.label"
              :aria-label="tool.label"
              :disabled="pane === 'preview'"
              @mousedown.prevent
              @click="tool.run"
            >
              <UiIcon v-if="tool.icon" :name="tool.icon" :size="14" />
              <span v-else class="text-sm leading-none" :class="tool.cls">{{ tool.glyph }}</span>
            </button>
            <span class="ml-auto hidden truncate pr-1.5 text-2xs text-fg-subtle sm:inline">
              {{ t("annAdmin.editor.contentHint") }}
            </span>
          </div>
          <div class="grid lg:grid-cols-2">
            <textarea
              ref="textarea"
              v-model="form.content"
              rows="14"
              spellcheck="false"
              maxlength="20000"
              class="block min-h-[18rem] w-full resize-y border-0 bg-surface px-3.5 py-3 font-mono text-xs leading-relaxed text-fg outline-none placeholder:text-fg-subtle dark:bg-surface-2/30"
              :class="pane === 'preview' ? 'hidden lg:block' : ''"
              :placeholder="t('annAdmin.editor.contentPlaceholder')"
              :aria-label="t('annAdmin.editor.content')"
              @keydown="onKeydown"
            />
            <div
              class="max-h-[28rem] min-h-[18rem] overflow-y-auto border-line bg-surface-2/20 px-4 py-3 lg:border-l"
              :class="pane === 'write' ? 'hidden lg:block' : ''"
              aria-live="polite"
            >
              <p class="eyebrow mb-2 hidden lg:block">{{ t("annAdmin.editor.preview") }}</p>
              <MarkdownView v-if="form.content.trim()" :source="form.content" />
              <p v-else class="flex h-40 items-center justify-center text-xs text-fg-subtle">
                {{ t("annAdmin.editor.emptyPreview") }}
              </p>
            </div>
          </div>
        </div>
      </div>
    </form>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="saving" @click="emit('update:open', false)">
        {{ t("common.cancel") }}
      </button>
      <button type="submit" form="announcement-form" class="btn btn-primary" :disabled="saving">
        <UiIcon v-if="saving" name="loader" :size="15" spin />
        {{ mode === "edit" ? t("annAdmin.editor.submitSave") : t("annAdmin.editor.submitCreate") }}
      </button>
    </template>
  </UiModal>
</template>
