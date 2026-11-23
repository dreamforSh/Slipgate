<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { RedeemCodeItem } from "@slipgate/contracts";
import CopyButton from "../../ui/CopyButton.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { saveBlob } from "../../../lib/api";
import { formatDateTime, formatUsd } from "../../../lib/format";
import { useToastStore } from "../../../stores/toast";
import { STAGGER_CLASS, stagger } from "./opsUtil";

/** Shows a freshly generated batch so the admin can copy or download every code at once. */
const props = defineProps<{ open: boolean; items: RedeemCodeItem[] }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void; (e: "view-batch", batchId: string): void }>();

const { t } = useI18n();
const toast = useToastStore();

const first = computed(() => props.items[0] ?? null);
const allText = computed(() => props.items.map((i) => i.code).join("\n"));

const valueText = computed(() => {
  const item = first.value;
  if (!item) return "";
  if (item.kind === "balance") return formatUsd(item.amountNanoUsd);
  if (item.kind === "subscription") {
    return t("redeem.value.subscription", {
      days: item.validityDays ?? 0,
      group: item.groupName ?? t("redeem.value.unknownGroup"),
    });
  }
  return t("redeem.value.invitation");
});

async function copyAll() {
  try {
    await navigator.clipboard.writeText(allText.value);
    toast.success(t("redeem.admin.result.copiedAll", { n: props.items.length }));
  } catch {
    toast.error(t("redeem.admin.errors.copy"));
  }
}

function download() {
  const batch = first.value?.batchId || "codes";
  saveBlob(new Blob([`${allText.value}\n`], { type: "text/plain;charset=utf-8" }), `redeem-${batch}.txt`);
}

function viewBatch() {
  if (first.value) emit("view-batch", first.value.batchId);
  emit("update:open", false);
}
</script>

<template>
  <UiModal
    :open="open"
    width="lg"
    :title="t('redeem.admin.result.title', { n: items.length })"
    @update:open="emit('update:open', $event)"
  >
    <template #icon>
      <span class="icon-chip icon-chip-success h-8 w-8">
        <UiIcon name="check-circle" :size="15" />
      </span>
    </template>

    <div v-if="first" class="space-y-4">
      <div class="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <UiBadge tone="accent">{{ t(`redeem.kinds.${first.kind}`) }}</UiBadge>
        <span class="font-semibold text-fg">{{ valueText }}</span>
        <span class="text-fg-subtle">·</span>
        <span>{{ t("redeem.admin.result.batch") }}</span>
        <span class="code-chip">{{ first.batchId }}</span>
        <template v-if="first.expiresAtIso">
          <span class="text-fg-subtle">·</span>
          <span class="inline-flex items-center gap-1">
            <UiIcon name="clock" :size="12" />
            {{ formatDateTime(first.expiresAtIso) }}
          </span>
        </template>
      </div>

      <ul
        class="grid max-h-[45vh] grid-cols-1 gap-1.5 overflow-y-auto rounded-xl border border-line bg-surface-2/40 p-2 sm:grid-cols-2"
        :aria-label="t('redeem.admin.table.code')"
      >
        <li
          v-for="(item, i) in items"
          :key="item.code"
          class="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-surface px-2.5 py-1.5 ring-1 ring-inset ring-line/70"
          :class="STAGGER_CLASS"
          :style="stagger(i, 14, 30)"
        >
          <span class="truncate font-mono text-xs tracking-wide text-fg">{{ item.code }}</span>
          <CopyButton :text="item.code" />
        </li>
      </ul>

      <p class="flex items-center gap-1.5 text-xs text-fg-subtle">
        <UiIcon name="info" :size="13" />
        {{ t("redeem.admin.result.hint") }}
      </p>
    </div>

    <template #footer>
      <button
        type="button"
        class="btn btn-ghost mr-auto"
        :title="t('redeem.admin.result.viewBatch')"
        :aria-label="t('redeem.admin.result.viewBatch')"
        @click="viewBatch"
      >
        <UiIcon name="filter" :size="14" />
        <span class="hidden sm:inline">{{ t("redeem.admin.result.viewBatch") }}</span>
      </button>
      <button type="button" class="btn btn-secondary" @click="download">
        <UiIcon name="download" :size="15" />
        {{ t("redeem.admin.result.download") }}
      </button>
      <button type="button" class="btn btn-primary" @click="copyAll">
        <UiIcon name="copy" :size="15" />
        {{ t("redeem.admin.result.copyAll") }}
      </button>
    </template>
  </UiModal>
</template>
