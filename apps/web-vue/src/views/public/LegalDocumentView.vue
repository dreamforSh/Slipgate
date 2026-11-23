<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute } from "vue-router";
import type { LegalDocumentResponse } from "@slipgate/contracts";
import PublicLayout from "../../components/PublicLayout.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import MarkdownView from "../../components/ui/MarkdownView.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import { ApiError, publicJson } from "../../lib/api";
import { useAuthStore } from "../../stores/auth";
import { usePortalStore } from "../../stores/portal";

/** Public agreement document (terms, privacy …) at /legal/:documentId, linked from sign-in. */
const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const portal = usePortalStore();

type State = { kind: "loading" } | { kind: "ready"; doc: LegalDocumentResponse } | { kind: "missing" } | { kind: "error"; message: string };

const state = ref<State>({ kind: "loading" });
let seq = 0;

const documentId = computed(() => {
  const raw = route.params.documentId;
  return (Array.isArray(raw) ? raw[0] : raw)?.toString().trim().toLowerCase() ?? "";
});

/** Every document of the agreement (for the "other documents" list). */
const siblings = computed(() => portal.settings?.loginAgreementDocuments ?? []);
const others = computed(() => siblings.value.filter((d) => d.id !== documentId.value));

const backTarget = computed(() => (auth.isAuthenticated ? { to: auth.isAdmin ? "/admin" : "/dashboard", key: "authGuards.legal.backConsole" } : { to: "/login", key: "authGuards.legal.backLogin" }));

function iconFor(id: string, title: string): IconName {
  const text = `${id} ${title}`.toLowerCase();
  if (/privacy|policy|cookie|隐私|政策/.test(text)) return "shield";
  if (/refund|billing|payment|退款|付费|支付/.test(text)) return "credit-card";
  return "file";
}

async function load() {
  const id = documentId.value;
  const mine = ++seq;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    state.value = { kind: "missing" };
    return;
  }
  state.value = { kind: "loading" };
  try {
    const doc = await publicJson<LegalDocumentResponse>(`/api/v1/public/legal/${encodeURIComponent(id)}`);
    if (mine !== seq) return;
    state.value = { kind: "ready", doc };
    document.title = `${doc.title} · ${portal.siteName}`;
  } catch (err) {
    if (mine !== seq) return;
    if (err instanceof ApiError && err.status === 404) state.value = { kind: "missing" };
    else state.value = { kind: "error", message: err instanceof ApiError ? t("authGuards.legal.loadFailedBody") : t("common.networkError") };
  }
}

onMounted(() => {
  void portal.load();
  void load();
});
watch(documentId, () => void load());

function print() {
  window.print();
}
</script>

<template>
  <PublicLayout>
    <div class="mx-auto w-full max-w-5xl px-4 pb-20 pt-8 sm:px-6 sm:pt-12">
      <Transition
        mode="out-in"
        enter-active-class="transition duration-200 ease-out motion-reduce:transition-none"
        leave-active-class="transition duration-100 ease-in motion-reduce:transition-none"
        enter-from-class="translate-y-1 opacity-0"
        leave-to-class="opacity-0"
      >
        <!-- Loading -->
        <div v-if="state.kind === 'loading'" key="loading" class="space-y-6" aria-busy="true" :aria-label="t('authGuards.legal.loading')">
          <div class="flex items-start gap-4">
            <div class="h-12 w-12 shrink-0 animate-pulse rounded-2xl bg-surface-2 motion-reduce:animate-none" />
            <div class="min-w-0 flex-1 space-y-2.5 pt-1">
              <div class="h-3 w-24 animate-pulse rounded bg-surface-2 motion-reduce:animate-none" />
              <div class="h-7 w-2/3 max-w-sm animate-pulse rounded-md bg-surface-2 motion-reduce:animate-none" />
              <div class="h-3 w-32 animate-pulse rounded bg-surface-2/70 motion-reduce:animate-none" />
            </div>
          </div>
          <div class="card space-y-3 p-6 sm:p-8">
            <div v-for="i in 7" :key="i" class="h-3 animate-pulse rounded bg-surface-2/80 motion-reduce:animate-none" :style="{ width: `${92 - ((i * 13) % 35)}%` }" />
          </div>
        </div>

        <!-- Not found -->
        <div v-else-if="state.kind === 'missing'" key="missing" class="card mx-auto max-w-xl">
          <div class="flex flex-col items-center px-6 py-12 text-center">
            <span class="relative inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-fg-subtle ring-1 ring-inset ring-line">
              <UiIcon name="file" :size="24" :stroke-width="1.6" />
            </span>
            <h1 class="mt-4 text-base font-semibold text-fg">{{ t("authGuards.legal.notFoundTitle") }}</h1>
            <p class="mt-1.5 max-w-sm text-sm leading-relaxed text-fg-muted">{{ t("authGuards.legal.notFoundBody") }}</p>
            <RouterLink :to="backTarget.to" class="btn btn-primary btn-sm mt-5">
              <UiIcon name="chevron-left" :size="14" />
              {{ t(backTarget.key) }}
            </RouterLink>
          </div>
          <div v-if="siblings.length" class="border-t border-line/70 px-5 py-4">
            <p class="eyebrow">{{ t("authGuards.legal.available") }}</p>
            <ul class="mt-2 space-y-1">
              <li v-for="d in siblings" :key="d.id">
                <RouterLink :to="{ name: 'legal-document', params: { documentId: d.id } }" class="menu-item">
                  <UiIcon :name="iconFor(d.id, d.title)" :size="15" />
                  <span class="min-w-0 flex-1 truncate">{{ d.title }}</span>
                  <UiIcon name="chevron-right" :size="14" class="text-fg-subtle" />
                </RouterLink>
              </li>
            </ul>
          </div>
        </div>

        <!-- Error -->
        <div v-else-if="state.kind === 'error'" key="error" class="mx-auto max-w-xl">
          <UiAlert tone="danger" :title="t('authGuards.legal.loadFailed')">
            {{ state.message }}
            <template #action>
              <button type="button" class="btn btn-secondary btn-sm shrink-0" @click="load">
                <UiIcon name="refresh" :size="14" />
                {{ t("authGuards.legal.retry") }}
              </button>
            </template>
          </UiAlert>
        </div>

        <!-- Document -->
        <div v-else :key="`doc-${state.doc.id}`" class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <article class="min-w-0">
            <header class="flex items-start gap-4">
              <span class="icon-chip icon-chip-accent h-12 w-12 rounded-2xl print:hidden">
                <UiIcon :name="iconFor(state.doc.id, state.doc.title)" :size="22" :stroke-width="1.7" />
              </span>
              <div class="min-w-0 flex-1">
                <p class="text-xs font-semibold uppercase tracking-[0.14em] text-accent">{{ t("authGuards.legal.eyebrow") }}</p>
                <h1 class="mt-1.5 break-words text-2xl font-bold tracking-tight text-fg sm:text-3xl">{{ state.doc.title }}</h1>
                <p v-if="state.doc.updatedAt" class="mt-2 flex items-center gap-1.5 text-xs text-fg-subtle">
                  <UiIcon name="calendar" :size="13" />
                  {{ t("authGuards.legal.updatedAt", { date: state.doc.updatedAt }) }}
                </p>
              </div>
            </header>

            <div class="card mt-6 p-5 sm:p-8">
              <MarkdownView v-if="state.doc.contentMd.trim()" :source="state.doc.contentMd" class="legal-body" />
              <EmptyState v-else compact icon="file" :title="t('authGuards.legal.empty')" />
            </div>
          </article>

          <aside class="min-w-0 space-y-4 print:hidden lg:sticky lg:top-24 lg:self-start">
            <div v-if="others.length" class="card p-2">
              <p class="eyebrow px-2.5 pb-1 pt-2">{{ t("authGuards.legal.otherDocuments") }}</p>
              <ul>
                <li v-for="d in others" :key="d.id">
                  <RouterLink :to="{ name: 'legal-document', params: { documentId: d.id } }" class="menu-item">
                    <UiIcon :name="iconFor(d.id, d.title)" :size="15" />
                    <span class="min-w-0 flex-1 truncate">{{ d.title }}</span>
                  </RouterLink>
                </li>
              </ul>
            </div>
            <div class="flex flex-wrap gap-2 lg:flex-col">
              <RouterLink :to="backTarget.to" class="btn btn-secondary btn-sm lg:w-full lg:justify-start">
                <UiIcon name="chevron-left" :size="14" />
                {{ t(backTarget.key) }}
              </RouterLink>
              <button type="button" class="btn btn-ghost btn-sm lg:w-full lg:justify-start" @click="print">
                <UiIcon name="download" :size="14" />
                {{ t("authGuards.legal.print") }}
              </button>
            </div>
          </aside>
        </div>
      </Transition>
    </div>
  </PublicLayout>
</template>

<style scoped>
.legal-body :deep(h2) {
  @apply mt-8 first:mt-0;
}
.legal-body :deep(h3) {
  @apply mt-6;
}
</style>
