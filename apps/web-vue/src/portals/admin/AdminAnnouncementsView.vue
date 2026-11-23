<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AnnouncementItem, AnnouncementLevel, AnnouncementStatus } from "@slipgate/contracts";
import AnnouncementEditorModal from "../../components/admin/ops/AnnouncementEditorModal.vue";
import AnnouncementReadersDrawer from "../../components/admin/ops/AnnouncementReadersDrawer.vue";
import {
  describeTargeting,
  isBrokenTargeting,
  targetingSentence,
  useSubscriptionGroups,
} from "../../components/admin/ops/announcementTargeting";
import ListSkeleton from "../../components/admin/ops/ListSkeleton.vue";
import { isPast, STAGGER_CLASS, stagger, type AnnouncementEditorMode } from "../../components/admin/ops/opsUtil";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import MarkdownView from "../../components/ui/MarkdownView.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiModal from "../../components/ui/UiModal.vue";
import { useNow } from "../../composables/useNow";
import { apiJson, errorText } from "../../lib/api";
import { formatDateTime, formatNumber, formatRelative, type Tone } from "../../lib/format";
import { markdownExcerpt } from "../../lib/markdown";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const toast = useToastStore();
const now = useNow(60_000);

const items = ref<AnnouncementItem[]>([]);
const loading = ref(false);
const loaded = ref(false);
const loadError = ref<string | null>(null);
const busyIds = ref(new Set<string>());

async function load() {
  loading.value = true;
  try {
    items.value = (
      await apiJson<{ items: AnnouncementItem[] }>("/api/v1/admin/announcements", { fallbackError: t("annAdmin.errors.load") })
    ).items;
    loaded.value = true;
    loadError.value = null;
  } catch (err) {
    loadError.value = errorText(err, t("annAdmin.errors.load"));
    toast.error(loadError.value);
  } finally {
    loading.value = false;
  }
}

/* ---------------- Display helpers ---------------- */

const levelTone: Record<AnnouncementLevel, Tone> = {
  info: "info",
  success: "success",
  warning: "warning",
  important: "danger",
};
const levelStripe: Record<AnnouncementLevel, string> = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  important: "bg-danger",
};
const levelChip: Record<AnnouncementLevel, string> = {
  info: "icon-chip-info",
  success: "icon-chip-success",
  warning: "icon-chip-warning",
  important: "icon-chip-danger",
};
const statusTone: Record<AnnouncementStatus, Tone> = {
  draft: "neutral",
  published: "success",
  archived: "warning",
};

type Phase = "scheduled" | "live" | "ended";

function phaseOf(a: AnnouncementItem, nowMs: number): Phase | null {
  if (a.status !== "published") return null;
  if (a.startsAtIso && !isPast(a.startsAtIso, nowMs)) return "scheduled";
  if (a.endsAtIso && isPast(a.endsAtIso, nowMs)) return "ended";
  return "live";
}

const phaseTone: Record<Phase, Tone> = { scheduled: "info", live: "success", ended: "neutral" };

function windowText(a: AnnouncementItem): string {
  const start = a.startsAtIso ? formatDateTime(a.startsAtIso) : "";
  const end = a.endsAtIso ? formatDateTime(a.endsAtIso) : "";
  if (start && end) return t("annAdmin.window.range", { start, end });
  if (start) return t("annAdmin.window.from", { start });
  if (end) return t("annAdmin.window.until", { end });
  return t("annAdmin.window.always");
}

/* ---------------- Targeting ---------------- */

const subGroups = useSubscriptionGroups();

function groupName(id: string): string {
  return subGroups.byId.value.get(id)?.name ?? t("annAdmin.targeting.unknownGroup");
}

function targetingParts(a: AnnouncementItem): string[][] {
  return describeTargeting(a.targeting, groupName, t);
}

/** One-line rule ("(a 且 b) 或 c"), or null when the announcement is not targeted. */
function targetingText(a: AnnouncementItem): string | null {
  if (a.targeting.anyOf.length === 0) return null;
  if (isBrokenTargeting(a.targeting)) return t("annAdmin.targeting.brokenHint");
  return targetingSentence(targetingParts(a), t, true);
}

/* ---------------- Stats & filters ---------------- */

const liveCount = computed(() => items.value.filter((a) => phaseOf(a, now.value) === "live").length);
const draftCount = computed(() => items.value.filter((a) => a.status === "draft").length);
const readTotal = computed(() => items.value.reduce((sum, a) => sum + a.readCount, 0));

type Filter = "all" | AnnouncementStatus;
const filter = ref<Filter>("all");
const search = ref("");

const filterOptions = computed(() => {
  const count = (s: AnnouncementStatus) => items.value.filter((a) => a.status === s).length;
  return [
    { value: "all" as const, label: t("common.all"), count: items.value.length },
    { value: "published" as const, label: t("annAdmin.statuses.published"), count: count("published") },
    { value: "draft" as const, label: t("annAdmin.statuses.draft"), count: count("draft") },
    { value: "archived" as const, label: t("annAdmin.statuses.archived"), count: count("archived") },
  ];
});

const visible = computed(() => {
  const q = search.value.trim().toLowerCase();
  return items.value
    .filter((a) => {
      if (filter.value !== "all" && a.status !== filter.value) return false;
      if (q && !a.title.toLowerCase().includes(q) && !a.content.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAtIso.localeCompare(a.createdAtIso));
});

function resetFilters() {
  filter.value = "all";
  search.value = "";
}

/* ---------------- Actions ---------------- */

const editorOpen = ref(false);
const editorMode = ref<AnnouncementEditorMode>("create");
const editorItem = ref<AnnouncementItem | null>(null);
const previewItem = ref<AnnouncementItem | null>(null);
const previewOpen = ref(false);
const readersItem = ref<AnnouncementItem | null>(null);
const readersOpen = ref(false);

function openEditor(mode: AnnouncementEditorMode, item: AnnouncementItem | null = null) {
  editorMode.value = mode;
  editorItem.value = item;
  editorOpen.value = true;
}

function openPreview(a: AnnouncementItem) {
  previewItem.value = a;
  previewOpen.value = true;
}

async function editFromPreview(a: AnnouncementItem) {
  previewOpen.value = false;
  // Let the preview release the body scroll lock before the editor takes it.
  await nextTick();
  openEditor("edit", a);
}

function openReaders(a: AnnouncementItem) {
  readersItem.value = a;
  readersOpen.value = true;
}

function onSaved(item: AnnouncementItem, created: boolean) {
  if (created) items.value = [item, ...items.value];
  else items.value = items.value.map((a) => (a.id === item.id ? item : a));
  toast.success(created ? t("annAdmin.notice.created") : t("annAdmin.notice.saved"));
}

async function remove(a: AnnouncementItem) {
  const next = new Set(busyIds.value);
  next.add(a.id);
  busyIds.value = next;
  try {
    await apiJson(`/api/v1/admin/announcements/${encodeURIComponent(a.id)}`, {
      method: "DELETE",
      fallbackError: t("annAdmin.errors.delete"),
    });
    items.value = items.value.filter((x) => x.id !== a.id);
    toast.success(t("annAdmin.notice.deleted"));
  } catch (err) {
    toast.error(errorText(err, t("annAdmin.errors.delete")));
  } finally {
    const after = new Set(busyIds.value);
    after.delete(a.id);
    busyIds.value = after;
  }
}

onMounted(() => {
  void load();
  // Names for targeting summaries; a failure only leaves "stale group" placeholders.
  void subGroups.load(true);
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.announcements')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="load">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          <span class="hidden sm:inline">{{ t("common.refresh") }}</span>
        </button>
        <button type="button" class="btn btn-primary" @click="openEditor('create')">
          <UiIcon name="plus" :size="15" />
          {{ t("annAdmin.actions.create") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard :label="t('annAdmin.stats.total')" :value="formatNumber(items.length)" icon="megaphone" tone="accent" />
      <StatCard :label="t('annAdmin.stats.live')" :value="formatNumber(liveCount)" icon="activity" tone="success" />
      <StatCard :label="t('annAdmin.stats.drafts')" :value="formatNumber(draftCount)" icon="pencil" />
      <StatCard :label="t('annAdmin.stats.reads')" :value="formatNumber(readTotal)" icon="eye" tone="info" />
    </div>

    <UiCard icon="megaphone" :title="t('annAdmin.list.title')" flush>
      <template #actions>
        <div class="scrollbar-hide max-w-full overflow-x-auto">
          <SegmentedControl v-model="filter" :options="filterOptions" />
        </div>
      </template>

      <div class="flex flex-wrap items-center gap-2 border-b border-line/70 px-5 py-3">
        <label class="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <span class="sr-only">{{ t("common.search") }}</span>
          <UiIcon
            name="search"
            :size="14"
            class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-subtle"
          />
          <input v-model="search" type="search" class="input input-sm pl-8" :placeholder="t('annAdmin.list.searchPlaceholder')" />
        </label>
      </div>

      <ListSkeleton v-if="!loaded && loading" :rows="3" />
      <EmptyState v-else-if="!loaded && loadError" icon="alert" :title="t('annAdmin.errors.load')">
        <p class="w-full max-w-xs text-xs text-fg-subtle">{{ loadError }}</p>
        <button type="button" class="btn btn-secondary btn-sm" @click="load">
          <UiIcon name="refresh" :size="14" />
          {{ t("annAdmin.list.retry") }}
        </button>
      </EmptyState>
      <EmptyState v-else-if="items.length === 0" icon="megaphone" :title="t('annAdmin.list.empty')">
        <p class="w-full max-w-xs text-xs text-fg-subtle">{{ t("annAdmin.list.emptyHint") }}</p>
        <button type="button" class="btn btn-primary btn-sm" @click="openEditor('create')">
          <UiIcon name="plus" :size="14" />
          {{ t("annAdmin.actions.create") }}
        </button>
      </EmptyState>
      <EmptyState v-else-if="visible.length === 0" icon="search" :title="t('annAdmin.list.noMatch')">
        <button type="button" class="btn btn-secondary btn-sm" @click="resetFilters">
          <UiIcon name="x" :size="14" />
          {{ t("annAdmin.list.clearFilters") }}
        </button>
      </EmptyState>
      <div v-else class="space-y-3 p-3 sm:p-4">
        <article
          v-for="(a, i) in visible"
          :key="a.id"
          class="card relative overflow-hidden hover:border-line-strong/80 hover:shadow-card-hover"
          :class="[STAGGER_CLASS, a.status === 'archived' ? 'opacity-75' : '']"
          :style="stagger(i, 40, 8)"
        >
          <span class="absolute inset-y-0 left-0 w-1" :class="levelStripe[a.level]" aria-hidden="true" />
          <div class="flex flex-col gap-3 p-4 pl-5 sm:flex-row sm:items-start">
            <span class="icon-chip hidden h-9 w-9 sm:inline-flex" :class="levelChip[a.level]">
              <UiIcon name="megaphone" :size="16" />
            </span>

            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <h3 class="min-w-0 max-w-full truncate text-sm font-semibold text-fg" :title="a.title">{{ a.title }}</h3>
                <UiBadge v-if="a.pinned" tone="accent">
                  <UiIcon name="arrow-up" :size="10" class="-ml-0.5 mr-0.5 inline -translate-y-px" />
                  {{ t("annAdmin.chips.pinned") }}
                </UiBadge>
                <UiBadge v-if="a.popup" tone="violet">
                  <UiIcon name="bell" :size="10" class="-ml-0.5 mr-0.5 inline -translate-y-px" />
                  {{ t("annAdmin.chips.popup") }}
                </UiBadge>
              </div>
              <p class="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-fg-muted">
                {{ markdownExcerpt(a.content, 180) || t("annAdmin.list.noContent") }}
              </p>

              <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-fg-subtle">
                <UiBadge :tone="levelTone[a.level]">{{ t(`annAdmin.levels.${a.level}`) }}</UiBadge>
                <UiBadge :tone="statusTone[a.status]" dot>{{ t(`annAdmin.statuses.${a.status}`) }}</UiBadge>
                <span class="inline-flex items-center gap-1">
                  <UiIcon name="users" :size="12" />
                  {{ t(`annAdmin.audiences.${a.audience}`) }}
                </span>
                <UiBadge
                  v-if="a.targeting.anyOf.length > 0"
                  :tone="isBrokenTargeting(a.targeting) ? 'warning' : 'violet'"
                  :title="targetingText(a) ?? undefined"
                >
                  <UiIcon
                    :name="isBrokenTargeting(a.targeting) ? 'alert' : 'filter'"
                    :size="10"
                    class="-ml-0.5 mr-0.5 inline -translate-y-px"
                  />
                  {{ isBrokenTargeting(a.targeting) ? t("annAdmin.targeting.broken") : t("annAdmin.targeting.chip") }}
                </UiBadge>
                <span class="inline-flex items-center gap-1">
                  <UiIcon name="calendar" :size="12" />
                  {{ windowText(a) }}
                  <UiBadge
                    v-if="phaseOf(a, now)"
                    :tone="phaseTone[phaseOf(a, now)!]"
                    :pulse="phaseOf(a, now) === 'live'"
                    :dot="phaseOf(a, now) === 'live'"
                    class="ml-1"
                  >
                    {{ t(`annAdmin.window.${phaseOf(a, now)}`) }}
                  </UiBadge>
                </span>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-surface-2 hover:text-fg"
                  :title="t('annAdmin.actions.readers')"
                  @click="openReaders(a)"
                >
                  <UiIcon name="eye" :size="12" />
                  {{ t("annAdmin.reads", { n: formatNumber(a.readCount) }) }}
                </button>
                <span :title="formatDateTime(a.updatedAtIso)">
                  {{ t("annAdmin.list.updated", { time: formatRelative(a.updatedAtIso, now) }) }}
                </span>
              </div>
            </div>

            <div class="-mb-1 flex shrink-0 items-center justify-end gap-0.5 border-t border-line/60 pt-2 sm:border-0 sm:pt-0">
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-xs"
                :title="t('annAdmin.actions.preview')"
                :aria-label="t('annAdmin.actions.preview')"
                @click="openPreview(a)"
              >
                <UiIcon name="eye" :size="13" />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-xs"
                :title="t('annAdmin.actions.readers')"
                :aria-label="t('annAdmin.actions.readers')"
                @click="openReaders(a)"
              >
                <UiIcon name="users" :size="13" />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-xs"
                :title="t('annAdmin.actions.edit')"
                :aria-label="t('annAdmin.actions.edit')"
                @click="openEditor('edit', a)"
              >
                <UiIcon name="pencil" :size="13" />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-icon btn-xs"
                :title="t('annAdmin.actions.duplicate')"
                :aria-label="t('annAdmin.actions.duplicate')"
                @click="openEditor('duplicate', a)"
              >
                <UiIcon name="copy" :size="13" />
              </button>
              <ConfirmButton icon-only :disabled="busyIds.has(a.id)" @confirm="remove(a)" />
            </div>
          </div>
        </article>
      </div>
    </UiCard>

    <AnnouncementEditorModal v-model:open="editorOpen" :mode="editorMode" :item="editorItem" @saved="onSaved" />
    <AnnouncementReadersDrawer v-model:open="readersOpen" :item="readersItem" />

    <UiModal v-model:open="previewOpen" width="lg" :title="previewItem?.title ?? t('annAdmin.preview.title')">
      <template #icon>
        <span class="icon-chip h-8 w-8" :class="previewItem ? levelChip[previewItem.level] : 'icon-chip-info'">
          <UiIcon name="megaphone" :size="15" />
        </span>
      </template>
      <template v-if="previewItem">
        <div class="mb-4 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
          <UiBadge :tone="levelTone[previewItem.level]">{{ t(`annAdmin.levels.${previewItem.level}`) }}</UiBadge>
          <UiBadge :tone="statusTone[previewItem.status]" dot>{{ t(`annAdmin.statuses.${previewItem.status}`) }}</UiBadge>
          <span class="inline-flex items-center gap-1">
            <UiIcon name="users" :size="12" />
            {{ t(`annAdmin.audiences.${previewItem.audience}`) }}
          </span>
          <span class="inline-flex items-center gap-1">
            <UiIcon name="calendar" :size="12" />
            {{ windowText(previewItem) }}
          </span>
        </div>
        <div
          v-if="targetingText(previewItem)"
          class="mb-4 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs"
          :class="isBrokenTargeting(previewItem.targeting) ? 'border-warning/30 bg-warning/[0.07]' : 'border-violet/20 bg-violet/[0.05]'"
        >
          <UiIcon
            :name="isBrokenTargeting(previewItem.targeting) ? 'alert' : 'filter'"
            :size="13"
            class="mt-px shrink-0"
            :class="isBrokenTargeting(previewItem.targeting) ? 'text-warning' : 'text-violet'"
          />
          <p class="min-w-0 break-words text-fg-muted">
            <span class="font-medium text-fg">{{ t("annAdmin.targeting.title") }}</span>
            <span aria-hidden="true"> · </span>
            {{ targetingText(previewItem) }}
          </p>
        </div>
        <MarkdownView v-if="previewItem.content.trim()" :source="previewItem.content" />
        <p v-else class="text-sm text-fg-subtle">{{ t("annAdmin.list.noContent") }}</p>
      </template>
      <template #footer>
        <button
          v-if="previewItem"
          type="button"
          class="btn btn-secondary"
          @click="editFromPreview(previewItem)"
        >
          <UiIcon name="pencil" :size="14" />
          {{ t("annAdmin.actions.edit") }}
        </button>
        <button type="button" class="btn btn-primary" @click="previewOpen = false">{{ t("common.close") }}</button>
      </template>
    </UiModal>
  </div>
</template>
