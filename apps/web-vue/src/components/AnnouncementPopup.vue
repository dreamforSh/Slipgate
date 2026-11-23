<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { formatRelative } from "../lib/format";
import { useAnnouncementStore } from "../stores/announcements";
import MarkdownView from "./ui/MarkdownView.vue";
import UiIcon from "./ui/UiIcon.vue";
import UiModal from "./ui/UiModal.vue";

/** Shows unread pop-up announcements one at a time; dismissing marks each read. */
const { t } = useI18n();
const store = useAnnouncementStore();

const current = computed(() => store.popupQueue[0] ?? null);
const open = computed({
  get: () => current.value !== null,
  set: (v) => {
    if (!v && current.value) store.dismissPopup(current.value.id);
  },
});
const remaining = computed(() => Math.max(0, store.popupQueue.length - 1));
const tone = computed(() =>
  current.value?.level === "important"
    ? "icon-chip-danger"
    : current.value?.level === "warning"
      ? "icon-chip-warning"
      : current.value?.level === "success"
        ? "icon-chip-success"
        : "icon-chip-info",
);
</script>

<template>
  <UiModal v-model:open="open" width="lg" :title="current?.title ?? ''" persistent>
    <template #icon>
      <span class="icon-chip h-8 w-8" :class="tone">
        <UiIcon name="megaphone" :size="15" />
      </span>
    </template>
    <template v-if="current">
      <p class="mb-3 text-xs text-fg-subtle">{{ formatRelative(current.startsAtIso ?? current.createdAtIso) }}</p>
      <MarkdownView :source="current.content" />
    </template>
    <template #footer>
      <span v-if="remaining" class="mr-auto text-xs text-fg-subtle">{{ t("announcements.more", { n: remaining }) }}</span>
      <button type="button" class="btn btn-primary" @click="open = false">
        {{ remaining ? t("announcements.next") : t("announcements.gotIt") }}
      </button>
    </template>
  </UiModal>
</template>
