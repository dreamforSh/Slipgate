<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiKeyItem, GroupItem } from "@slipgate/contracts";
import { formatDateTime, formatRelative } from "../../lib/format";
import ConfirmButton from "../ui/ConfirmButton.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiSwitch from "../ui/UiSwitch.vue";
import KeyFlags from "./KeyFlags.vue";
import KeyGroupSwitcher from "./KeyGroupSwitcher.vue";
import KeyUsageCell from "./KeyUsageCell.vue";
import { isExpired } from "./keyLimits";

/** Card layout of one key for narrow screens (the table takes over from `lg`). */
const props = defineProps<{
  item: ApiKeyItem;
  groups: GroupItem[];
  selected: boolean;
  busy: boolean;
  now: number;
}>();
const emit = defineEmits<{
  (e: "select" | "toggle" | "edit" | "use" | "delete"): void;
  (e: "group", groupId: string): void;
}>();

const { t } = useI18n();
const expired = computed(() => isExpired(props.item, props.now));
</script>

<template>
  <article
    class="rounded-xl border p-4 transition-colors duration-200"
    :class="selected ? 'border-accent/40 bg-accent/[0.04]' : 'border-line/80 bg-surface dark:bg-surface/60'"
  >
    <header class="flex items-start gap-3">
      <input
        type="checkbox"
        class="checkbox mt-1"
        :checked="selected"
        :aria-label="t('user.keys.select', { name: item.name })"
        @change="emit('select')"
      />
      <div class="min-w-0 flex-1">
        <button type="button" class="block max-w-full truncate text-left font-medium text-fg hover:text-accent" @click="emit('edit')">
          {{ item.name }}
        </button>
        <div class="mt-1 flex flex-wrap items-center gap-1.5">
          <span class="code-chip">{{ item.keyPrefix }}</span>
          <KeyFlags :item="item" :now="now" />
        </div>
      </div>
      <UiSwitch
        :model-value="item.enabled"
        :disabled="busy"
        :label="item.enabled ? t('common.enabled') : t('common.disabled')"
        hide-label
        @update:model-value="emit('toggle')"
      />
    </header>

    <div class="mt-3">
      <KeyGroupSwitcher :item="item" :groups="groups" :busy="busy" @change="(id) => emit('group', id)" />
    </div>

    <div class="mt-3">
      <KeyUsageCell :item="item" />
    </div>

    <dl class="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
      <dt class="text-fg-subtle">{{ t("user.keys.expiry") }}</dt>
      <dd class="truncate text-right" :class="expired ? 'text-danger' : 'text-fg-muted'" :title="formatDateTime(item.expiresAtIso)">
        {{ item.expiresAtIso ? (expired ? t("user.keys.expired") : t("user.keys.expiresIn", { time: formatRelative(item.expiresAtIso, now) })) : t("user.keys.noExpiry") }}
      </dd>
      <dt class="text-fg-subtle">{{ t("user.keys.lastUsed") }}</dt>
      <dd class="truncate text-right text-fg-muted" :title="formatDateTime(item.lastUsedAtIso)">
        {{ item.lastUsedAtIso ? formatRelative(item.lastUsedAtIso, now) : t("user.keys.neverUsed") }}
      </dd>
      <dt class="text-fg-subtle">{{ t("user.keys.limits") }}</dt>
      <dd class="text-right font-mono tabular-nums text-fg-muted">
        {{ t("user.keys.limitsValue", { rpm: item.rpmLimit, concurrency: item.concurrencyLimit }) }}
      </dd>
    </dl>

    <footer class="mt-3 flex items-center justify-end gap-1 border-t border-line/70 pt-3">
      <button type="button" class="btn btn-ghost btn-xs" @click="emit('use')">
        <UiIcon name="terminal" :size="13" />
        {{ t("user.useKey.action") }}
      </button>
      <button type="button" class="btn btn-ghost btn-xs" @click="emit('edit')">
        <UiIcon name="pencil" :size="13" />
        {{ t("common.edit") }}
      </button>
      <ConfirmButton :disabled="busy" @confirm="emit('delete')" />
    </footer>
  </article>
</template>
