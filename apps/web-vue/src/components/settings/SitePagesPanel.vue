<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { SitePage } from "@slipgate/contracts";
import FormField from "../ui/FormField.vue";
import MarkdownView from "../ui/MarkdownView.vue";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiModal from "../ui/UiModal.vue";
import { apiJson, errorText } from "../../lib/api";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const toast = useToastStore();

const pages = ref<SitePage[]>([]);
const loading = ref(false);
const errorMessage = ref<string | null>(null);
const confirmDeleteId = ref<string | null>(null);
const deletingId = ref<string | null>(null);

const modalOpen = ref(false);
const editingId = ref<string | null>(null);
const bodyTab = ref<"edit" | "preview">("edit");
const saving = ref(false);

const form = reactive({
  slug: "",
  title: "",
  summary: "",
  body: "",
  published: true,
  showInNav: false,
  sortOrder: 0,
});

async function load() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await apiJson<{ items: SitePage[] }>("/api/v1/admin/pages", {
      fallbackError: t("settings.public.sitePages.loadError"),
    });
    pages.value = res.items;
  } catch (err) {
    errorMessage.value = errorText(err, t("settings.public.sitePages.loadError"));
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  editingId.value = null;
  bodyTab.value = "edit";
  Object.assign(form, {
    slug: "",
    title: "",
    summary: "",
    body: "",
    published: true,
    showInNav: true,
    sortOrder: 0,
  });
  modalOpen.value = true;
}

function openEdit(page: SitePage) {
  editingId.value = page.id;
  bodyTab.value = "edit";
  Object.assign(form, {
    slug: page.slug,
    title: page.title,
    summary: page.summary,
    body: page.body,
    published: page.published,
    showInNav: page.showInNav,
    sortOrder: page.sortOrder,
  });
  modalOpen.value = true;
}

async function submit() {
  if (saving.value) return;
  saving.value = true;
  try {
    const payload = {
      slug: form.slug.trim().toLowerCase(),
      title: form.title.trim(),
      summary: form.summary.trim(),
      body: form.body,
      published: form.published,
      showInNav: form.showInNav,
      sortOrder: Number.isFinite(Number(form.sortOrder)) ? Math.trunc(Number(form.sortOrder)) : 0,
    };
    if (editingId.value) {
      await apiJson<{ page: SitePage }>(`/api/v1/admin/pages/${encodeURIComponent(editingId.value)}`, {
        method: "PATCH",
        body: payload,
      });
    } else {
      await apiJson<{ page: SitePage }>("/api/v1/admin/pages", {
        method: "POST",
        body: payload,
      });
    }
    toast.success(t("settings.public.sitePages.saved"));
    modalOpen.value = false;
    await load();
  } catch (err) {
    toast.error(errorText(err, t("settings.public.sitePages.saveError")));
  } finally {
    saving.value = false;
  }
}

async function removePage(id: string) {
  if (confirmDeleteId.value !== id) {
    confirmDeleteId.value = id;
    return;
  }
  deletingId.value = id;
  try {
    await apiJson(`/api/v1/admin/pages/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast.success(t("common.deleted"));
    confirmDeleteId.value = null;
    await load();
  } catch (err) {
    toast.error(errorText(err, t("settings.public.sitePages.deleteError")));
  } finally {
    deletingId.value = null;
  }
}

onMounted(() => void load());
</script>

<template>
  <UiCard icon="book-open" :title="t('settings.public.sitePages.title')">
    <template #actions>
      <button type="button" class="btn btn-secondary btn-sm" @click="openCreate">
        <UiIcon name="plus" :size="14" />
        {{ t("settings.public.sitePages.add") }}
      </button>
    </template>

    <p class="mb-4 text-xs text-fg-subtle">{{ t("settings.public.sitePages.help") }}</p>

    <p v-if="errorMessage" class="mb-3 text-xs text-danger">{{ errorMessage }}</p>
    <p v-else-if="loading && pages.length === 0" class="py-4 text-center text-xs text-fg-subtle">
      {{ t("common.loading") }}
    </p>
    <p v-else-if="pages.length === 0" class="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-fg-subtle">
      {{ t("settings.public.sitePages.empty") }}
    </p>

    <div v-else class="divide-y divide-line/70">
      <div v-for="p in pages" :key="p.id" class="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-fg">{{ p.title }}</span>
            <UiBadge :tone="p.published ? 'success' : 'neutral'">
              {{ p.published ? t("settings.public.sitePages.published") : t("settings.public.sitePages.draft") }}
            </UiBadge>
            <UiBadge v-if="p.showInNav" tone="accent">
              {{ t("settings.public.sitePages.inNav") }}
            </UiBadge>
          </div>
          <div class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-subtle">
            <a
              v-if="p.published"
              :href="`/p/${p.slug}`"
              target="_blank"
              rel="noopener"
              class="inline-flex items-center gap-1 font-mono text-accent hover:underline"
            >
              /p/{{ p.slug }}
              <UiIcon name="external-link" :size="11" />
            </a>
            <span v-else class="font-mono">/p/{{ p.slug }}</span>
            <span v-if="p.summary" class="truncate">{{ p.summary }}</span>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <button type="button" class="btn btn-secondary btn-sm" @click="openEdit(p)">
            <UiIcon name="pencil" :size="13" />
            {{ t("common.edit") }}
          </button>
          <button
            type="button"
            class="btn btn-sm"
            :class="confirmDeleteId === p.id ? 'btn-danger' : 'btn-secondary'"
            :disabled="deletingId === p.id"
            @click="removePage(p.id)"
          >
            <UiIcon name="trash" :size="13" />
            {{ confirmDeleteId === p.id ? t("common.confirmDelete") : t("common.delete") }}
          </button>
        </div>
      </div>
    </div>

    <UiModal
      v-model:open="modalOpen"
      width="lg"
      :title="editingId ? t('settings.public.sitePages.editTitle') : t('settings.public.sitePages.createTitle')"
    >
      <form class="space-y-4" @submit.prevent="submit">
        <div class="grid gap-4 sm:grid-cols-2">
          <FormField :label="t('settings.public.sitePages.fields.title')" required>
            <input v-model="form.title" type="text" required maxlength="120" class="input" />
          </FormField>
          <FormField :label="t('settings.public.sitePages.fields.slug')" :hint="t('settings.public.sitePages.fields.slugHint')" required>
            <input
              v-model="form.slug"
              type="text"
              required
              maxlength="64"
              pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
              placeholder="about"
              class="input font-mono"
            />
          </FormField>
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <FormField :label="t('settings.public.sitePages.fields.summary')" class="sm:col-span-2">
            <input v-model="form.summary" type="text" maxlength="300" class="input" />
          </FormField>
          <FormField :label="t('settings.public.sitePages.fields.sortOrder')">
            <input v-model.number="form.sortOrder" type="number" class="input font-mono" />
          </FormField>
        </div>

        <div class="flex flex-wrap gap-5 rounded-lg border border-line/70 bg-surface-2/40 px-3.5 py-2.5 text-sm">
          <label class="inline-flex cursor-pointer items-center gap-2">
            <input v-model="form.published" type="checkbox" class="rounded border-line text-accent" />
            <span>{{ t("settings.public.sitePages.fields.published") }}</span>
          </label>
          <label class="inline-flex cursor-pointer items-center gap-2">
            <input v-model="form.showInNav" type="checkbox" class="rounded border-line text-accent" />
            <span>{{ t("settings.public.sitePages.fields.showInNav") }}</span>
          </label>
        </div>

        <div>
          <div class="mb-2 flex items-center justify-between gap-2">
            <span class="label mb-0">{{ t("settings.public.sitePages.fields.body") }}</span>
            <div class="inline-flex rounded-lg border border-line bg-surface-2/60 p-0.5 text-xs">
              <button
                type="button"
                class="cursor-pointer rounded-md px-2.5 py-1 font-medium transition-colors"
                :class="bodyTab === 'edit' ? 'bg-surface text-fg shadow-xs' : 'text-fg-subtle hover:text-fg'"
                @click="bodyTab = 'edit'"
              >
                {{ t("settings.public.markdown") }}
              </button>
              <button
                type="button"
                class="cursor-pointer rounded-md px-2.5 py-1 font-medium transition-colors"
                :class="bodyTab === 'preview' ? 'bg-surface text-fg shadow-xs' : 'text-fg-subtle hover:text-fg'"
                @click="bodyTab = 'preview'"
              >
                {{ t("settings.public.preview") }}
              </button>
            </div>
          </div>
          <textarea
            v-if="bodyTab === 'edit'"
            v-model="form.body"
            rows="10"
            class="input font-mono text-xs leading-relaxed"
          />
          <div v-else class="min-h-[12rem] rounded-lg border border-line bg-surface-2/30 p-4">
            <MarkdownView :source="form.body" />
          </div>
        </div>

        <div class="flex justify-end gap-2 border-t border-line/70 pt-3">
          <button type="button" class="btn btn-secondary" @click="modalOpen = false">{{ t("common.cancel") }}</button>
          <button type="submit" class="btn btn-primary" :disabled="saving">
            <UiIcon :name="saving ? 'loader' : 'check'" :size="14" :spin="saving" />
            {{ saving ? t("common.saving") : t("common.save") }}
          </button>
        </div>
      </form>
    </UiModal>
  </UiCard>
</template>
