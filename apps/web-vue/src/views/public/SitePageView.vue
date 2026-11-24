<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import type { SitePage } from "@slipgate/contracts";
import MarkdownView from "../../components/ui/MarkdownView.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import { ApiError, errorText, publicJson } from "../../lib/api";
import { formatDateShort } from "../../lib/format";

const { t } = useI18n();
const route = useRoute();

const slug = computed(() => String(route.params.slug ?? "").trim().toLowerCase());
const page = ref<SitePage | null>(null);
const loading = ref(false);
const notFound = ref(false);
const errorMessage = ref<string | null>(null);

let reqSeq = 0;

async function load() {
  const s = slug.value;
  if (!s) {
    notFound.value = true;
    page.value = null;
    return;
  }
  const seq = ++reqSeq;
  loading.value = true;
  notFound.value = false;
  errorMessage.value = null;
  try {
    const res = await publicJson<{ page: SitePage }>(`/api/v1/public/pages/${encodeURIComponent(s)}`);
    if (seq !== reqSeq) return;
    page.value = res.page;
    document.title = res.page.title;
  } catch (err) {
    if (seq !== reqSeq) return;
    page.value = null;
    if (err instanceof ApiError && err.status === 404) {
      notFound.value = true;
    } else {
      errorMessage.value = errorText(err, t("settings.public.sitePages.loadError"));
    }
  } finally {
    if (seq === reqSeq) loading.value = false;
  }
}

watch(slug, () => void load(), { immediate: true });
</script>

<template>
  <div class="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
    <div v-if="loading" class="space-y-4">
      <div class="h-8 w-56 animate-pulse rounded-lg bg-surface-2" />
      <div class="h-4 w-96 max-w-full animate-pulse rounded-lg bg-surface-2" />
      <UiCard>
        <div class="space-y-3 py-4">
          <div class="h-4 w-full animate-pulse rounded bg-surface-2" />
          <div class="h-4 w-5/6 animate-pulse rounded bg-surface-2" />
          <div class="h-4 w-3/4 animate-pulse rounded bg-surface-2" />
        </div>
      </UiCard>
    </div>

    <UiCard v-else-if="notFound" class="py-8 text-center">
      <div class="mx-auto flex max-w-md flex-col items-center gap-3">
        <span class="icon-chip h-11 w-11 rounded-xl bg-surface-2 text-fg-subtle">
          <UiIcon name="file" :size="20" />
        </span>
        <h1 class="text-lg font-semibold text-fg">{{ t("settings.public.sitePages.notFoundTitle") }}</h1>
        <p class="text-sm text-fg-subtle">{{ t("settings.public.sitePages.notFoundHint") }}</p>
        <RouterLink to="/home" class="btn btn-secondary mt-2">
          <UiIcon name="home" :size="15" />
          {{ t("publicNav.home") }}
        </RouterLink>
      </div>
    </UiCard>

    <UiCard v-else-if="errorMessage" class="py-8 text-center">
      <p class="text-sm text-danger">{{ errorMessage }}</p>
      <button type="button" class="btn btn-secondary mt-3" @click="load">
        <UiIcon name="refresh" :size="14" />
        {{ t("common.refresh") }}
      </button>
    </UiCard>

    <article v-else-if="page" class="space-y-6">
      <header class="space-y-2 border-b border-line/70 pb-5">
        <h1 class="text-2xl font-bold tracking-tight text-fg sm:text-3xl">{{ page.title }}</h1>
        <p v-if="page.summary" class="text-sm leading-relaxed text-fg-muted">{{ page.summary }}</p>
        <p class="text-xs text-fg-subtle">
          {{ t("common.updatedAt") }}: {{ formatDateShort(page.updatedAtIso) }}
        </p>
      </header>
      <UiCard>
        <MarkdownView :source="page.body" />
      </UiCard>
    </article>
  </div>
</template>
