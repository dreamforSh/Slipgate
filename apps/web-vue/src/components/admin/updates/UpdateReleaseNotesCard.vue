<script setup lang="ts">
import type { SystemUpdateStatus } from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { formatBytes, formatDateTime } from "../../../lib/format";
import EmptyState from "../../ui/EmptyState.vue";
import MarkdownView from "../../ui/MarkdownView.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiCard from "../../ui/UiCard.vue";
import UiIcon from "../../ui/UiIcon.vue";

defineProps<{
  status: SystemUpdateStatus | null;
}>();

const { t } = useI18n();
</script>

<template>
  <UiCard icon="file" :title="t('updates.notes.title')">
    <template #actions>
      <!-- Only a matched release asset is installed, and only after its SHA-256 checks out. -->
      <UiBadge v-if="status?.assetName" tone="success">
        <UiIcon name="badge-check" :size="12" />
        {{ t("updates.notes.verifiedSha") }}
      </UiBadge>
      <a
        v-if="status?.releaseUrl"
        :href="status.releaseUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="btn btn-ghost btn-xs"
      >
        {{ t("updates.notes.viewOnGithub") }}
        <UiIcon name="external-link" :size="12" />
      </a>
    </template>

    <div v-if="status?.releaseNotes || status?.releaseName || status?.remoteTag" class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface-2/60 px-3.5 py-2.5 text-xs">
        <div class="min-w-0">
          <p class="font-semibold text-fg">
            {{ status?.releaseName ?? status?.remoteTag ?? status?.remoteVersion }}
          </p>
          <p v-if="status?.publishedAtIso" class="mt-0.5 text-2xs text-fg-subtle">
            {{ t("updates.notes.publishedAt", { time: formatDateTime(status.publishedAtIso) }) }}
          </p>
        </div>
        <div v-if="status?.assetName" class="flex items-center gap-1.5 text-right">
          <UiIcon name="box" :size="13" class="text-fg-subtle" />
          <code class="font-mono text-2xs text-fg-muted">{{ status.assetName }}</code>
          <span v-if="status.assetSizeBytes" class="font-mono text-2xs text-fg-subtle">
            ({{ formatBytes(status.assetSizeBytes) }})
          </span>
        </div>
      </div>

      <MarkdownView
        v-if="status?.releaseNotes"
        :source="status.releaseNotes"
        class="max-h-[340px] overflow-y-auto pr-1"
      />
      <p v-else class="text-xs text-fg-muted">{{ t("updates.notes.empty") }}</p>
    </div>

    <EmptyState v-else compact icon="file" :title="t('updates.notes.empty')" />
  </UiCard>
</template>
