<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { UpstreamAccount } from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import { COOLDOWN_PRESETS_HOURS } from "./accountDisplay";

/**
 * One shared "more actions" menu for every row/card. Teleported and fixed-positioned so the
 * table's horizontal scroll container cannot clip it; flips above the trigger near the bottom.
 */
const props = defineProps<{
  open: boolean;
  account: UpstreamAccount | null;
  anchor: HTMLElement | null;
}>();
const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "test" | "stats" | "edit" | "duplicate" | "resume" | "delete", account: UpstreamAccount): void;
  (e: "cooldown", account: UpstreamAccount, hours: number): void;
}>();

const { t } = useI18n();
const panel = ref<HTMLElement | null>(null);
const pos = ref({ top: 0, left: 0 });
const armedDelete = ref(false);

const isVm = computed(() => props.account?.executionMode === "vm_slot");

/** A cooldown only matters for an account the scheduler could otherwise pick. */
const canCooldown = computed(() => {
  const status = props.account?.effectiveStatus;
  return status === "active" || status === "cooldown";
});

/** Resuming helps unless the account is off because its expiry lapsed (that needs a new date). */
const canResume = computed(() => {
  const acc = props.account;
  if (!acc || acc.effectiveStatus === "active") return false;
  return !(acc.effectiveStatus === "expired" && acc.status !== "expired");
});

function close() {
  emit("update:open", false);
}

function place() {
  if (!props.anchor || !panel.value) return;
  const gap = 4;
  const margin = 8;
  const a = props.anchor.getBoundingClientRect();
  const { width, height } = panel.value.getBoundingClientRect();
  const below = a.bottom + gap;
  const top = below + height + margin <= window.innerHeight ? below : Math.max(margin, a.top - gap - height);
  const left = Math.min(Math.max(margin, a.right - width), window.innerWidth - width - margin);
  pos.value = { top, left };
}

function onPointerDown(ev: PointerEvent) {
  const target = ev.target as Node;
  if (panel.value?.contains(target) || props.anchor?.contains(target)) return;
  close();
}
function onKeydown(ev: KeyboardEvent) {
  if (ev.key === "Escape") close();
}

function bind(on: boolean) {
  const method = on ? "addEventListener" : "removeEventListener";
  document[method]("pointerdown", onPointerDown as EventListener, true);
  document[method]("keydown", onKeydown as EventListener);
  window[method]("resize", close);
  // Any scroll (page or table) would detach the menu from its trigger.
  window[method]("scroll", close, true);
}

watch(
  () => [props.open, props.account?.id, props.anchor] as const,
  async ([open]) => {
    armedDelete.value = false;
    bind(false);
    if (!open) return;
    await nextTick();
    place();
    bind(true);
    panel.value?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  },
);

onBeforeUnmount(() => bind(false));

function pick(action: "test" | "stats" | "edit" | "duplicate" | "resume") {
  const acc = props.account;
  if (!acc) return;
  close();
  // Emit per action so the parent's typed handlers stay simple.
  switch (action) {
    case "test":
      emit("test", acc);
      break;
    case "stats":
      emit("stats", acc);
      break;
    case "edit":
      emit("edit", acc);
      break;
    case "duplicate":
      emit("duplicate", acc);
      break;
    case "resume":
      emit("resume", acc);
      break;
  }
}

function pickCooldown(hours: number) {
  const acc = props.account;
  if (!acc) return;
  close();
  emit("cooldown", acc, hours);
}

function onDelete() {
  const acc = props.account;
  if (!acc) return;
  if (!armedDelete.value) {
    armedDelete.value = true;
    return;
  }
  close();
  emit("delete", acc);
}

const cooldownLabel = (h: number) => t(`accounts.cooldown.h${h}`);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && account"
      ref="panel"
      role="menu"
      :aria-label="t('accounts.row.more')"
      class="menu-panel fixed z-[60] w-60 animate-scale-in"
      :style="{ top: `${pos.top}px`, left: `${pos.left}px` }"
    >
      <p class="truncate px-2.5 pb-1 pt-1.5 text-2xs font-medium text-fg-subtle">{{ account.name }}</p>
      <button
        type="button"
        role="menuitem"
        class="menu-item disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="isVm"
        :title="isVm ? t('accounts.row.vmTestDisabled') : undefined"
        @click="pick('test')"
      >
        <UiIcon name="play" :size="14" />
        {{ t("accounts.row.test") }}
      </button>
      <button type="button" role="menuitem" class="menu-item" @click="pick('stats')">
        <UiIcon name="chart" :size="14" />
        {{ t("accounts.row.stats") }}
      </button>
      <button type="button" role="menuitem" class="menu-item" @click="pick('edit')">
        <UiIcon name="pencil" :size="14" />
        {{ t("accounts.row.edit") }}
      </button>
      <button type="button" role="menuitem" class="menu-item" @click="pick('duplicate')">
        <UiIcon name="copy" :size="14" />
        {{ t("accounts.row.duplicate") }}
      </button>

      <div v-if="canCooldown || canResume" class="my-1 border-t border-line/70" />
      <template v-if="canCooldown">
        <p class="eyebrow px-2.5 pb-1.5 pt-1">{{ t("accounts.row.cooldown") }}</p>
        <div class="grid grid-cols-4 gap-1 px-1.5 pb-1.5">
          <button
            v-for="h in COOLDOWN_PRESETS_HOURS"
            :key="h"
            type="button"
            role="menuitem"
            class="btn btn-secondary btn-xs justify-center px-1"
            @click="pickCooldown(h)"
          >
            {{ cooldownLabel(h) }}
          </button>
        </div>
      </template>
      <button
        v-if="canResume"
        type="button"
        role="menuitem"
        class="menu-item"
        @click="pick('resume')"
      >
        <UiIcon name="refresh" :size="14" />
        {{ t("accounts.row.resume") }}
      </button>

      <div class="my-1 border-t border-line/70" />
      <button
        type="button"
        role="menuitem"
        class="menu-item"
        :class="armedDelete ? '!bg-danger !text-white' : 'hover:!bg-danger/10 hover:!text-danger'"
        @click="onDelete"
      >
        <UiIcon :name="armedDelete ? 'alert' : 'trash'" :size="14" />
        {{ armedDelete ? t("common.confirmDelete") : t("accounts.row.delete") }}
      </button>
    </div>
  </Teleport>
</template>
