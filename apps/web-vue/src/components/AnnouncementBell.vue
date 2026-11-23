<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AnnouncementLevel, UserAnnouncementItem } from "@slipgate/contracts";
import { formatRelative } from "../lib/format";
import { markdownExcerpt } from "../lib/markdown";
import { useAnnouncementStore } from "../stores/announcements";
import MarkdownView from "./ui/MarkdownView.vue";
import UiIcon from "./ui/UiIcon.vue";
import UiModal from "./ui/UiModal.vue";
import type { IconName } from "./ui/icons";

const { t } = useI18n();
const store = useAnnouncementStore();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const detail = ref<UserAnnouncementItem | null>(null);
const detailOpen = computed({
  get: () => detail.value !== null,
  set: (v) => {
    if (!v) detail.value = null;
  },
});

interface LevelStyle {
  icon: IconName;
  chip: string;
  dot: string;
}

const LEVEL: Record<AnnouncementLevel, LevelStyle> = {
  info: { icon: "info", chip: "icon-chip-info", dot: "bg-info" },
  success: { icon: "check-circle", chip: "icon-chip-success", dot: "bg-success" },
  warning: { icon: "alert", chip: "icon-chip-warning", dot: "bg-warning" },
  important: { icon: "megaphone", chip: "icon-chip-danger", dot: "bg-danger" },
};

function toggle() {
  open.value = !open.value;
  if (open.value) void store.refresh(true);
}

function show(item: UserAnnouncementItem) {
  detail.value = item;
  open.value = false;
  if (!item.read) void store.markRead([item.id]);
}

function onPointerDown(ev: PointerEvent) {
  if (open.value && root.value && !root.value.contains(ev.target as Node)) open.value = false;
}
function onKey(ev: KeyboardEvent) {
  if (ev.key === "Escape") open.value = false;
}

onMounted(() => {
  document.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onPointerDown);
  document.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div ref="root" class="relative">
    <button
      type="button"
      class="btn btn-ghost btn-icon btn-sm relative"
      :aria-label="t('announcements.bell', { n: store.unreadCount })"
      :aria-expanded="open"
      aria-haspopup="dialog"
      @click="toggle"
    >
      <UiIcon name="bell" :size="17" :class="store.unreadCount ? 'bell-ring' : ''" />
      <Transition name="pop">
        <span
          v-if="store.unreadCount"
          class="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white ring-2 ring-surface"
        >
          {{ store.unreadCount > 9 ? "9+" : store.unreadCount }}
        </span>
      </Transition>
    </button>

    <Transition name="panel">
      <div
        v-if="open"
        class="menu-panel absolute right-0 top-full z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] origin-top-right p-0"
        role="dialog"
        :aria-label="t('announcements.title')"
      >
        <div class="flex items-center justify-between border-b border-line/70 px-4 py-3">
          <p class="text-sm font-semibold text-fg">{{ t("announcements.title") }}</p>
          <button
            v-if="store.unreadCount"
            type="button"
            class="text-xs font-medium text-accent transition-colors hover:text-accent-hover"
            @click="store.markRead('all')"
          >
            {{ t("announcements.markAllRead") }}
          </button>
        </div>
        <div class="max-h-[22rem] overflow-y-auto py-1">
          <p v-if="store.items.length === 0" class="px-4 py-10 text-center text-sm text-fg-subtle">
            <UiIcon name="inbox" :size="22" class="mx-auto mb-2 text-fg-subtle/70" />
            {{ t("announcements.empty") }}
          </p>
          <button
            v-for="(a, i) in store.items"
            :key="a.id"
            type="button"
            class="ann-row group"
            :style="{ animationDelay: `${Math.min(i, 8) * 25}ms` }"
            @click="show(a)"
          >
            <span class="icon-chip mt-0.5 h-8 w-8 shrink-0" :class="LEVEL[a.level].chip">
              <UiIcon :name="LEVEL[a.level].icon" :size="14" />
            </span>
            <span class="min-w-0 flex-1 text-left">
              <span class="flex items-center gap-1.5">
                <UiIcon v-if="a.pinned" name="arrow-up" :size="11" class="shrink-0 text-accent" />
                <span class="truncate text-sm font-medium" :class="a.read ? 'text-fg-muted' : 'text-fg'">{{ a.title }}</span>
              </span>
              <span class="mt-0.5 line-clamp-2 block text-xs text-fg-subtle">{{ markdownExcerpt(a.content, 90) }}</span>
              <span class="mt-1 block text-2xs text-fg-subtle/80">{{ formatRelative(a.startsAtIso ?? a.createdAtIso) }}</span>
            </span>
            <span v-if="!a.read" class="mt-2 h-2 w-2 shrink-0 rounded-full" :class="LEVEL[a.level].dot" />
          </button>
        </div>
      </div>
    </Transition>

    <UiModal v-model:open="detailOpen" width="lg" :title="detail?.title ?? ''">
      <template #icon>
        <span v-if="detail" class="icon-chip h-8 w-8" :class="LEVEL[detail.level].chip">
          <UiIcon :name="LEVEL[detail.level].icon" :size="15" />
        </span>
      </template>
      <p v-if="detail" class="mb-3 text-xs text-fg-subtle">{{ formatRelative(detail.startsAtIso ?? detail.createdAtIso) }}</p>
      <MarkdownView v-if="detail" :source="detail.content" />
    </UiModal>
  </div>
</template>

<style scoped>
.ann-row {
  @apply flex w-full items-start gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-surface-2/70;
  animation: row-in 220ms cubic-bezier(0.2, 0, 0, 1) both;
}
@keyframes row-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}
.bell-ring {
  transform-origin: 50% 2px;
  animation: ring 2.4s ease-in-out 0.4s 2;
}
@keyframes ring {
  0%,
  60%,
  100% {
    transform: rotate(0);
  }
  10%,
  30% {
    transform: rotate(14deg);
  }
  20%,
  40% {
    transform: rotate(-12deg);
  }
  50% {
    transform: rotate(4deg);
  }
}
.panel-enter-active {
  transition:
    opacity 160ms ease-out,
    transform 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.panel-leave-active {
  transition: opacity 100ms ease-in;
}
.panel-enter-from {
  opacity: 0;
  transform: translateY(-4px) scale(0.97);
}
.panel-leave-to {
  opacity: 0;
}
.pop-enter-active {
  transition: transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.pop-enter-from,
.pop-leave-to {
  transform: scale(0);
}
.pop-leave-active {
  transition: transform 120ms ease-in;
}
@media (prefers-reduced-motion: reduce) {
  .ann-row,
  .bell-ring {
    animation: none;
  }
}
</style>
