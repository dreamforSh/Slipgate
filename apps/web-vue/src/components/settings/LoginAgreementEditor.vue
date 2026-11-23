<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import ConfirmButton from "../ui/ConfirmButton.vue";
import EmptyState from "../ui/EmptyState.vue";
import MarkdownView from "../ui/MarkdownView.vue";
import SegmentedControl from "../ui/SegmentedControl.vue";
import UiAlert from "../ui/UiAlert.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon, { type IconName } from "../ui/UiIcon.vue";
import SettingField from "./SettingField.vue";
import SettingSwitchRow from "./SettingSwitchRow.vue";
import {
  effectiveDocId,
  MAX_AGREEMENT_CONTENT,
  MAX_AGREEMENT_DOCUMENTS,
  MAX_AGREEMENT_TITLE,
  nextDocKey,
  todayIso,
  type AgreementDocRow,
  type GuardPortalForm,
  type GuardPortalKey,
} from "./authGuardsForm";

/**
 * Settings → Agreement: the terms / privacy documents visitors accept before signing in or up
 * (dialog or checkbox), their "last updated" date and the Markdown documents served at
 * /legal/:id. Any change to the date or a document asks every visitor to agree again.
 */
const form = defineModel<GuardPortalForm>({ required: true });
const props = defineProps<{
  saved: GuardPortalForm | null;
  dirtyKeys: GuardPortalKey[];
  errors: Record<string, string>;
  docErrors: { id?: string; title?: string; contentMd?: string }[];
}>();

const { t } = useI18n();

const errorClass = "!border-danger/60 focus:!ring-danger/20";
const isDirty = (k: GuardPortalKey) => props.dirtyKeys.includes(k);

const docs = computed(() => form.value.loginAgreementDocuments);

/* ---------------- Mode & date ---------------- */

const modes = computed<{ value: "modal" | "checkbox"; icon: IconName; title: string; desc: string }[]>(() => [
  { value: "modal", icon: "layers", title: t("authGuards.settings.agreement.modeModal"), desc: t("authGuards.settings.agreement.modeModalHelp") },
  { value: "checkbox", icon: "check-circle", title: t("authGuards.settings.agreement.modeCheckbox"), desc: t("authGuards.settings.agreement.modeCheckboxHelp") },
]);

/** Saving will invalidate consent already given (the revision changes). */
const reconsent = computed(
  () => Boolean(props.saved?.loginAgreementEnabled) && (isDirty("loginAgreementUpdatedAt") || isDirty("loginAgreementDocuments")),
);

/* ---------------- Documents ---------------- */

/** Rows whose editor is open (new rows open, the first one opens by default). */
const expanded = ref(new Set<number>(docs.value[0] ? [docs.value[0].key] : []));
const previewing = ref(new Set<number>());

function toggle(set: Set<number>, key: number) {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function setPreview(key: number, on: boolean) {
  if (on !== previewing.value.has(key)) previewing.value = toggle(previewing.value, key);
}

const TEMPLATES = computed(() => ({
  terms: { id: "terms", title: t("authGuards.settings.agreement.templates.termsTitle"), contentMd: t("authGuards.settings.agreement.templates.termsBody") },
  privacy: { id: "privacy", title: t("authGuards.settings.agreement.templates.privacyTitle"), contentMd: t("authGuards.settings.agreement.templates.privacyBody") },
  blank: { id: "", title: "", contentMd: "" },
}));

function add(kind: "terms" | "privacy" | "blank") {
  if (docs.value.length >= MAX_AGREEMENT_DOCUMENTS) return;
  const tpl = TEMPLATES.value[kind];
  const taken = new Set(docs.value.map((d) => effectiveDocId(d)));
  const row: AgreementDocRow = { key: nextDocKey(), id: tpl.id && taken.has(tpl.id) ? "" : tpl.id, title: tpl.title, contentMd: tpl.contentMd };
  form.value.loginAgreementDocuments = [...docs.value, row];
  expanded.value = new Set([...expanded.value, row.key]);
}

function remove(index: number) {
  const row = docs.value[index];
  form.value.loginAgreementDocuments = docs.value.filter((_, i) => i !== index);
  if (row) {
    const next = new Set(expanded.value);
    next.delete(row.key);
    expanded.value = next;
  }
}

function move(index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= docs.value.length) return;
  const next = [...docs.value];
  [next[index], next[target]] = [next[target]!, next[index]!];
  form.value.loginAgreementDocuments = next;
}

/** The URL a document will have (from the typed id, else the title). */
function slugOf(d: AgreementDocRow): string {
  return effectiveDocId(d);
}

/** Saved documents can be opened at their public address. */
function savedId(d: AgreementDocRow): string | null {
  const id = slugOf(d);
  return props.saved?.loginAgreementDocuments.some((s) => s.id === id) ? id : null;
}

const docsError = computed(() => props.errors.loginAgreementDocuments ?? null);
const enabledError = computed(() => props.errors.loginAgreementEnabled ?? null);

const stagger = (i: number) => ({ animationDelay: `${Math.min(i, 5) * 60}ms`, animationFillMode: "both" });
</script>

<template>
  <div class="space-y-6">
    <!-- Gate settings -->
    <UiCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(0)" icon="shield" :title="t('authGuards.settings.agreement.title')">
      <template #actions>
        <UiBadge :tone="saved?.loginAgreementEnabled ? 'success' : 'neutral'" dot>
          {{ saved?.loginAgreementEnabled ? t("authGuards.settings.agreement.statusOn") : t("authGuards.settings.agreement.statusOff") }}
        </UiBadge>
      </template>

      <div class="grid gap-6 lg:grid-cols-2">
        <div class="min-w-0">
          <SettingSwitchRow
            v-model="form.loginAgreementEnabled"
            icon="shield"
            tone="accent"
            :title="t('authGuards.settings.agreement.enabled')"
            :description="t('authGuards.settings.agreement.enabledHelp')"
            :dirty="isDirty('loginAgreementEnabled')"
          >
            <p v-if="enabledError" class="mt-1.5 flex animate-fade-in items-center gap-1 text-2xs text-danger" role="alert">
              <UiIcon name="alert" :size="11" />
              {{ enabledError }}
            </p>
          </SettingSwitchRow>

          <SettingField
            class="mt-5"
            input-id="set-agreement-date"
            :label="t('authGuards.settings.agreement.updatedAt')"
            :hint="t('authGuards.settings.agreement.updatedAtHelp')"
            :dirty="isDirty('loginAgreementUpdatedAt')"
            :error="errors.loginAgreementUpdatedAt ?? null"
          >
            <div class="flex gap-2">
              <input
                id="set-agreement-date"
                v-model="form.loginAgreementUpdatedAt"
                type="date"
                class="input min-w-0 flex-1 font-mono"
                :class="errors.loginAgreementUpdatedAt ? errorClass : ''"
              />
              <button type="button" class="btn btn-secondary shrink-0" @click="form.loginAgreementUpdatedAt = todayIso()">
                <UiIcon name="calendar" :size="14" />
                {{ t("authGuards.settings.agreement.today") }}
              </button>
              <button
                v-if="form.loginAgreementUpdatedAt"
                type="button"
                class="btn btn-ghost btn-icon shrink-0"
                :aria-label="t('authGuards.settings.agreement.clearDate')"
                :title="t('authGuards.settings.agreement.clearDate')"
                @click="form.loginAgreementUpdatedAt = ''"
              >
                <UiIcon name="x" :size="14" />
              </button>
            </div>
          </SettingField>
        </div>

        <div class="min-w-0">
          <p class="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-fg-muted">
            {{ t("authGuards.settings.agreement.mode") }}
            <span v-if="isDirty('loginAgreementMode')" class="inline-block h-1.5 w-1.5 rounded-full bg-accent" :title="t('settings.modified')" />
          </p>
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2" role="radiogroup" :aria-label="t('authGuards.settings.agreement.mode')">
            <button
              v-for="m in modes"
              :key="m.value"
              type="button"
              role="radio"
              :aria-checked="form.loginAgreementMode === m.value"
              class="flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border p-3 text-left transition-[border-color,background-color] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              :class="
                form.loginAgreementMode === m.value
                  ? 'border-accent/50 bg-accent/[0.06]'
                  : 'border-line bg-surface hover:border-line-strong hover:bg-surface-2/50 dark:bg-surface-2/30'
              "
              @click="form.loginAgreementMode = m.value"
            >
              <span class="icon-chip mt-0.5 h-8 w-8" :class="form.loginAgreementMode === m.value ? 'icon-chip-accent' : ''">
                <UiIcon :name="m.icon" :size="15" />
              </span>
              <span class="min-w-0">
                <span class="block text-sm font-medium text-fg">{{ m.title }}</span>
                <span class="mt-0.5 block text-2xs leading-relaxed text-fg-subtle">{{ m.desc }}</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      <Transition
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <UiAlert v-if="reconsent" tone="info" class="mt-5">{{ t("authGuards.settings.agreement.reconsent") }}</UiAlert>
      </Transition>
    </UiCard>

    <!-- Documents -->
    <UiCard class="animate-slide-up motion-reduce:animate-none" :style="stagger(1)" icon="file" :title="t('authGuards.settings.agreement.documents')">
      <template #actions>
        <span v-if="isDirty('loginAgreementDocuments')" class="inline-block h-1.5 w-1.5 rounded-full bg-accent" :title="t('settings.modified')" />
        <span class="text-xs tabular-nums text-fg-subtle">{{ docs.length }}/{{ MAX_AGREEMENT_DOCUMENTS }}</span>
        <button v-if="docs.length" type="button" class="btn btn-secondary btn-sm" :disabled="docs.length >= MAX_AGREEMENT_DOCUMENTS" @click="add('blank')">
          <UiIcon name="plus" :size="14" />
          {{ t("authGuards.settings.agreement.add") }}
        </button>
      </template>

      <p class="mb-4 text-xs leading-relaxed text-fg-subtle">{{ t("authGuards.settings.agreement.documentsHelp") }}</p>

      <div v-if="!docs.length" class="rounded-xl border border-dashed border-line">
        <EmptyState compact icon="file" :title="t('authGuards.settings.agreement.empty')">
          <button type="button" class="btn btn-secondary btn-sm" @click="add('terms')">
            <UiIcon name="file" :size="14" />
            {{ t("authGuards.settings.agreement.templates.terms") }}
          </button>
          <button type="button" class="btn btn-secondary btn-sm" @click="add('privacy')">
            <UiIcon name="shield" :size="14" />
            {{ t("authGuards.settings.agreement.templates.privacy") }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="add('blank')">
            <UiIcon name="plus" :size="14" />
            {{ t("authGuards.settings.agreement.templates.blank") }}
          </button>
        </EmptyState>
      </div>

      <TransitionGroup
        v-else
        tag="ol"
        class="relative space-y-3"
        move-class="transition-transform duration-200 ease-out motion-reduce:transition-none"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-150 ease-in motion-reduce:transition-none"
        enter-from-class="-translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <li
          v-for="(d, i) in docs"
          :key="d.key"
          class="rounded-xl border bg-surface transition-colors dark:bg-surface-2/30"
          :class="docErrors[i]?.title || docErrors[i]?.id || docErrors[i]?.contentMd ? 'border-danger/40' : 'border-line'"
        >
          <!-- Row header -->
          <div class="flex items-center gap-2 px-3 py-2.5 sm:px-4">
            <button
              type="button"
              class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              :aria-expanded="expanded.has(d.key)"
              :aria-controls="`agreement-doc-${d.key}`"
              @click="expanded = toggle(expanded, d.key)"
            >
              <UiIcon
                name="chevron-right"
                :size="15"
                class="shrink-0 text-fg-subtle transition-transform duration-200 motion-reduce:transition-none"
                :class="expanded.has(d.key) ? 'rotate-90' : ''"
              />
              <span class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-surface-2 font-mono text-2xs tabular-nums text-fg-subtle">{{ i + 1 }}</span>
              <span class="min-w-0 flex-1">
                <span class="block truncate text-sm font-medium" :class="d.title.trim() ? 'text-fg' : 'italic text-fg-subtle'">
                  {{ d.title.trim() || t("authGuards.settings.agreement.untitled") }}
                </span>
                <span class="block truncate font-mono text-2xs text-fg-subtle">/legal/{{ slugOf(d) || "…" }}</span>
              </span>
              <UiIcon v-if="docErrors[i]?.title || docErrors[i]?.id || docErrors[i]?.contentMd" name="alert" :size="14" class="shrink-0 text-danger" />
              <UiBadge v-else-if="!d.contentMd.trim()" tone="warning" class="hidden sm:inline-flex">{{ t("authGuards.settings.agreement.noContent") }}</UiBadge>
            </button>
            <div class="flex shrink-0 items-center gap-0.5">
              <a
                v-if="savedId(d)"
                :href="`/legal/${savedId(d)}`"
                target="_blank"
                rel="noopener"
                class="btn btn-ghost btn-icon btn-xs"
                :aria-label="t('authGuards.settings.agreement.open')"
                :title="t('authGuards.settings.agreement.open')"
              >
                <UiIcon name="external-link" :size="13" />
              </a>
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-xs"
                :disabled="i === 0"
                :aria-label="t('authGuards.settings.agreement.moveUp')"
                :title="t('authGuards.settings.agreement.moveUp')"
                @click="move(i, -1)"
              >
                <UiIcon name="arrow-up" :size="13" />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-xs"
                :disabled="i === docs.length - 1"
                :aria-label="t('authGuards.settings.agreement.moveDown')"
                :title="t('authGuards.settings.agreement.moveDown')"
                @click="move(i, 1)"
              >
                <UiIcon name="arrow-down" :size="13" />
              </button>
              <ConfirmButton icon-only :label="t('authGuards.settings.agreement.remove')" @confirm="remove(i)" />
            </div>
          </div>

          <!-- Row editor -->
          <div v-if="expanded.has(d.key)" :id="`agreement-doc-${d.key}`" class="space-y-4 border-t border-line/70 px-3 py-4 sm:px-4">
            <div class="grid gap-4 sm:grid-cols-2">
              <SettingField
                :input-id="`agreement-title-${d.key}`"
                :label="t('authGuards.settings.agreement.docTitle')"
                required
                :error="docErrors[i]?.title ?? null"
              >
                <template #aside>
                  <span class="text-2xs tabular-nums text-fg-subtle">{{ d.title.length }}/{{ MAX_AGREEMENT_TITLE }}</span>
                </template>
                <input
                  :id="`agreement-title-${d.key}`"
                  v-model="d.title"
                  type="text"
                  :maxlength="MAX_AGREEMENT_TITLE"
                  class="input"
                  :class="docErrors[i]?.title ? errorClass : ''"
                  :placeholder="t('authGuards.settings.agreement.docTitlePlaceholder')"
                />
              </SettingField>
              <SettingField
                :input-id="`agreement-id-${d.key}`"
                :label="t('authGuards.settings.agreement.docId')"
                :hint="t('authGuards.settings.agreement.docIdHelp')"
                :error="docErrors[i]?.id ?? null"
              >
                <div class="relative">
                  <span class="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-xs text-fg-subtle">/legal/</span>
                  <input
                    :id="`agreement-id-${d.key}`"
                    v-model="d.id"
                    type="text"
                    maxlength="64"
                    spellcheck="false"
                    autocapitalize="off"
                    class="input pl-16 font-mono"
                    :class="docErrors[i]?.id ? errorClass : ''"
                    :placeholder="slugOf({ ...d, id: '' }) || 'terms'"
                  />
                </div>
              </SettingField>
            </div>

            <div>
              <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <label :for="`agreement-body-${d.key}`" class="text-xs font-medium text-fg-muted">{{ t("authGuards.settings.agreement.content") }}</label>
                <div class="flex items-center gap-2">
                  <span class="text-2xs tabular-nums" :class="d.contentMd.length > MAX_AGREEMENT_CONTENT ? 'text-danger' : 'text-fg-subtle'">
                    {{ d.contentMd.length.toLocaleString() }} / {{ MAX_AGREEMENT_CONTENT.toLocaleString() }}
                  </span>
                  <SegmentedControl
                    :model-value="previewing.has(d.key) ? 'preview' : 'edit'"
                    :options="[
                      { value: 'edit', label: t('authGuards.settings.agreement.edit') },
                      { value: 'preview', label: t('authGuards.settings.agreement.preview') },
                    ]"
                    @update:model-value="setPreview(d.key, $event === 'preview')"
                  />
                </div>
              </div>
              <Transition
                mode="out-in"
                enter-active-class="transition-opacity duration-150 ease-out motion-reduce:transition-none"
                leave-active-class="transition-opacity duration-100 ease-in motion-reduce:transition-none"
                enter-from-class="opacity-0"
                leave-to-class="opacity-0"
              >
                <div
                  v-if="previewing.has(d.key)"
                  key="preview"
                  class="h-[22rem] overflow-y-auto rounded-lg border border-line bg-bg/60 p-4"
                >
                  <MarkdownView v-if="d.contentMd.trim()" :source="d.contentMd" />
                  <EmptyState v-else compact icon="file" :title="t('authGuards.settings.agreement.noContent')" />
                </div>
                <textarea
                  v-else
                  :id="`agreement-body-${d.key}`"
                  key="edit"
                  v-model="d.contentMd"
                  rows="14"
                  spellcheck="false"
                  class="textarea h-[22rem] resize-y font-mono text-xs"
                  :class="docErrors[i]?.contentMd ? errorClass : ''"
                  :placeholder="t('authGuards.settings.agreement.contentPlaceholder')"
                />
              </Transition>
              <p v-if="docErrors[i]?.contentMd" class="mt-1 text-xs text-danger" role="alert">{{ docErrors[i]?.contentMd }}</p>
              <p v-else class="hint">{{ t("authGuards.settings.agreement.contentHelp") }}</p>
            </div>
          </div>
        </li>
      </TransitionGroup>

      <p v-if="docsError && docs.length" class="mt-3 flex items-center gap-1.5 text-xs text-danger" role="alert">
        <UiIcon name="alert" :size="12" />
        {{ docsError }}
      </p>

      <div v-if="docs.length && docs.length < MAX_AGREEMENT_DOCUMENTS" class="mt-3 flex flex-wrap gap-2">
        <button type="button" class="btn btn-ghost btn-sm" @click="add('terms')">
          <UiIcon name="plus" :size="13" />
          {{ t("authGuards.settings.agreement.templates.terms") }}
        </button>
        <button type="button" class="btn btn-ghost btn-sm" @click="add('privacy')">
          <UiIcon name="plus" :size="13" />
          {{ t("authGuards.settings.agreement.templates.privacy") }}
        </button>
      </div>
    </UiCard>
  </div>
</template>
