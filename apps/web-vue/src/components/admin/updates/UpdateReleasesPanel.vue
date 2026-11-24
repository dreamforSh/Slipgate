<script setup lang="ts">
import { computed, ref } from "vue";
import type { SystemReleaseItem } from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { formatBytes, formatDateTime, shortHash } from "../../../lib/format";
import EmptyState from "../../ui/EmptyState.vue";
import MarkdownView from "../../ui/MarkdownView.vue";
import SegmentedControl from "../../ui/SegmentedControl.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";

const props = defineProps<{
  releases: SystemReleaseItem[];
  loading: boolean;
  busy: boolean;
  standalone: boolean;
}>();

const emit = defineEmits<{
  (e: "refresh"): void;
  (e: "install", release: SystemReleaseItem): void;
}>();

const { t } = useI18n();

const channelFilter = ref<"all" | "stable" | "dev">("all");
const expandedTags = ref<Record<string, boolean>>({});

const filterOptions = computed(() => [
  { value: "all" as const, label: t("updates.releases.filterAll") },
  { value: "stable" as const, label: t("updates.releases.filterStable") },
  { value: "dev" as const, label: t("updates.releases.filterDev") },
]);

const filteredReleases = computed(() => {
  if (channelFilter.value === "all") return props.releases;
  return props.releases.filter((r) => r.channel === channelFilter.value);
});

function toggleNotes(tag: string) {
  expandedTags.value = {
    ...expandedTags.value,
    [tag]: !expandedTags.value[tag],
  };
}
</script>

<template>
  <UiCard icon="box" :title="t('updates.tabs.releases')">
    <template #actions>
      <SegmentedControl v-model="channelFilter" :options="filterOptions" size="sm" />
      <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="emit('refresh')">
        <UiIcon :name="loading ? 'loader' : 'refresh'" :size="14" :spin="loading" />
        {{ t("updates.releases.refresh") }}
      </button>
    </template>

    <div v-if="loading && releases.length === 0" class="py-10 text-center text-xs text-fg-muted">
      {{ t("common.loading") }}
    </div>

    <EmptyState
      v-else-if="filteredReleases.length === 0"
      compact
      icon="box"
      :title="t('updates.releases.empty')"
      :description="t('updates.releases.emptyHint')"
    />

    <ul v-else class="space-y-3">
      <li
        v-for="rel in filteredReleases"
        :key="rel.tag"
        class="rounded-xl border border-line bg-surface-2/40 p-4 transition-colors hover:border-line-strong"
      >
        <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div class="min-w-0 space-y-1.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-fg">{{ rel.name }}</span>
              <code class="rounded bg-surface px-1.5 py-0.5 font-mono text-2xs text-fg-muted ring-1 ring-inset ring-line">
                {{ rel.tag }}
              </code>
              <UiBadge v-if="rel.current" tone="success" dot>
                {{ t("updates.releases.currentBadge") }}
              </UiBadge>
              <UiBadge :tone="rel.channel === 'dev' ? 'warning' : 'accent'">
                {{ rel.prerelease ? t("updates.releases.prereleaseBadge") : t(`updates.channels.${rel.channel === "dev" ? "shortDev" : "shortStable"}`) }}
              </UiBadge>
              <UiBadge v-if="!rel.installable" tone="danger">
                {{ t("updates.releases.noAssetBadge") }}
              </UiBadge>
            </div>

            <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-fg-subtle">
              <span v-if="rel.publishedAtIso">{{ formatDateTime(rel.publishedAtIso) }}</span>
              <span v-if="rel.commit" class="font-mono">{{ shortHash(rel.commit, 10) }}</span>
              <span v-if="rel.assetName" class="font-mono">
                {{ rel.assetName }}
                <template v-if="rel.assetSizeBytes">({{ formatBytes(rel.assetSizeBytes) }})</template>
              </span>
            </div>
          </div>

          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <a
              v-if="rel.htmlUrl"
              :href="rel.htmlUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-ghost btn-xs"
              :title="t('updates.notes.viewOnGithub')"
            >
              <UiIcon name="external-link" :size="13" />
            </a>
            <button
              v-if="rel.body"
              type="button"
              class="btn btn-secondary btn-xs"
              @click="toggleNotes(rel.tag)"
            >
              <UiIcon
                name="chevron-down"
                :size="13"
                class="transition-transform duration-150"
                :class="expandedTags[rel.tag] ? 'rotate-180' : ''"
              />
              {{ expandedTags[rel.tag] ? t("updates.releases.hideNotes") : t("updates.releases.viewNotes") }}
            </button>
            <button
              type="button"
              class="btn btn-xs"
              :class="rel.current ? 'btn-secondary' : 'btn-primary'"
              :disabled="busy || standalone || !rel.installable"
              @click="emit('install', rel)"
            >
              <UiIcon name="download" :size="13" />
              {{ rel.current ? t("updates.releases.reinstall") : t("updates.releases.install") }}
            </button>
          </div>
        </div>

        <div
          v-if="expandedTags[rel.tag] && rel.body"
          class="mt-3 border-t border-line/70 pt-3"
        >
          <MarkdownView :source="rel.body" />
        </div>
      </li>
    </ul>
  </UiCard>
</template>
