<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AdminUserItem } from "@slipgate/contracts";
import UiIcon from "../../ui/UiIcon.vue";
import { displayName } from "./userDisplay";

/**
 * Shared "more actions" menu for user rows. Teleported and fixed-positioned so the table's
 * horizontal scroller cannot clip it; flips above the trigger near the viewport bottom.
 */
const props = defineProps<{
  user: AdminUserItem | null;
  anchor: HTMLElement | null;
  isSelf: boolean;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{
  (
    e: "ledger" | "api-keys" | "usage" | "toggle-status" | "delete" | "reset-totp" | "limits" | "rates" | "replace-group",
    user: AdminUserItem,
  ): void;
}>();

const { t } = useI18n();
const panel = ref<HTMLElement | null>(null);
const pos = ref({ top: 0, left: 0 });
const armedDelete = ref(false);
const armedTotp = ref(false);

function close() {
  open.value = false;
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
  window[method]("scroll", close, true);
}

watch(
  () => [open.value, props.user?.id, props.anchor] as const,
  async ([isOpen]) => {
    armedDelete.value = false;
    armedTotp.value = false;
    bind(false);
    if (!isOpen) return;
    await nextTick();
    place();
    bind(true);
    panel.value?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  },
);

onBeforeUnmount(() => bind(false));

function pick(action: "ledger" | "api-keys" | "usage" | "toggle-status" | "limits" | "rates" | "replace-group") {
  const u = props.user;
  if (!u) return;
  close();
  switch (action) {
    case "limits":
      emit("limits", u);
      break;
    case "rates":
      emit("rates", u);
      break;
    case "replace-group":
      emit("replace-group", u);
      break;
    case "ledger":
      emit("ledger", u);
      break;
    case "api-keys":
      emit("api-keys", u);
      break;
    case "usage":
      emit("usage", u);
      break;
    case "toggle-status":
      emit("toggle-status", u);
      break;
  }
}

function onDelete() {
  const u = props.user;
  if (!u || props.isSelf) return;
  if (!armedDelete.value) {
    armedDelete.value = true;
    return;
  }
  close();
  emit("delete", u);
}

/** Two-step like delete: the first click arms, the second resets the user's 2FA. */
function onResetTotp() {
  const u = props.user;
  if (!u || !u.totpEnabled) return;
  if (!armedTotp.value) {
    armedTotp.value = true;
    return;
  }
  close();
  emit("reset-totp", u);
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && user"
      ref="panel"
      role="menu"
      :aria-label="t('adminUsers.actions.more')"
      class="menu-panel fixed z-[60] w-56 animate-scale-in"
      :style="{ top: `${pos.top}px`, left: `${pos.left}px` }"
    >
      <p class="truncate px-2.5 pb-1 pt-1.5 text-2xs font-medium text-fg-subtle">{{ displayName(user) }}</p>
      <button type="button" role="menuitem" class="menu-item" @click="pick('limits')">
        <UiIcon name="gauge" :size="14" />
        {{ t("userLimits.menu.limits") }}
      </button>
      <button type="button" role="menuitem" class="menu-item" @click="pick('rates')">
        <UiIcon name="percent" :size="14" />
        {{ t("userLimits.menu.rates") }}
      </button>
      <button type="button" role="menuitem" class="menu-item" @click="pick('ledger')">
        <UiIcon name="scroll" :size="14" />
        {{ t("adminUsers.actions.ledger") }}
      </button>
      <button type="button" role="menuitem" class="menu-item" @click="pick('api-keys')">
        <UiIcon name="key" :size="14" />
        {{ t("adminUsers.actions.apiKeys") }}
        <span class="ml-auto font-mono text-2xs tabular-nums text-fg-subtle">{{ user.apiKeyCount }}</span>
      </button>
      <button type="button" role="menuitem" class="menu-item" @click="pick('replace-group')">
        <UiIcon name="migrate" :size="14" />
        {{ t("userLimits.menu.replaceGroup") }}
      </button>
      <button type="button" role="menuitem" class="menu-item" @click="pick('usage')">
        <UiIcon name="chart" :size="14" />
        {{ t("adminUsers.actions.viewUsage") }}
      </button>

      <div class="my-1 border-t border-line/70" />
      <button
        type="button"
        role="menuitem"
        class="menu-item disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="isSelf"
        :title="isSelf ? t('adminUsers.actions.selfLocked') : undefined"
        @click="pick('toggle-status')"
      >
        <UiIcon :name="user.status === 'active' ? 'pause' : 'play'" :size="14" />
        {{ user.status === "active" ? t("adminUsers.actions.suspend") : t("adminUsers.actions.activate") }}
      </button>
      <button
        v-if="user.totpEnabled"
        type="button"
        role="menuitem"
        class="menu-item"
        :class="armedTotp ? '!bg-warning/15 !text-warning' : 'hover:!bg-warning/10 hover:!text-warning'"
        :title="t('adminUsers.actions.resetTotpHint')"
        @click="onResetTotp"
      >
        <UiIcon :name="armedTotp ? 'alert' : 'shield-alert'" :size="14" />
        {{ armedTotp ? t("adminUsers.actions.resetTotpConfirm") : t("adminUsers.actions.resetTotp") }}
      </button>
      <button
        type="button"
        role="menuitem"
        class="menu-item disabled:cursor-not-allowed disabled:opacity-50"
        :class="armedDelete ? '!bg-danger !text-white dark:!text-bg' : 'hover:!bg-danger/10 hover:!text-danger'"
        :disabled="isSelf"
        :title="isSelf ? t('adminUsers.actions.deleteSelf') : undefined"
        @click="onDelete"
      >
        <UiIcon :name="armedDelete ? 'alert' : 'trash'" :size="14" />
        {{ armedDelete ? t("common.confirmDelete") : t("adminUsers.actions.delete") }}
      </button>
    </div>
  </Teleport>
</template>
