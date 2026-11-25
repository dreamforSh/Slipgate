<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { CliFingerprintReport, CliFingerprintTool } from "@slipgate/contracts";
import UiAlert from "../../ui/UiAlert.vue";
import UiBadge from "../../ui/UiBadge.vue";
import UiIcon from "../../ui/UiIcon.vue";
import UiModal from "../../ui/UiModal.vue";
import { formatDateTime, formatRelative } from "../../../lib/format";
import { useAuthStore } from "../../../stores/auth";
import { useToastStore } from "../../../stores/toast";

/**
 * The client versions / User-Agents slipgate-net impersonates. Versions follow upstream releases
 * hourly (never below the built-in pin, never across a major); an env override still wins.
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "update:open", value: boolean): void }>();

const { t } = useI18n();
const auth = useAuthStore();
const toast = useToastStore();

const report = ref<CliFingerprintReport | null>(null);
const loading = ref(false);
const syncing = ref(false);
const error = ref<string | null>(null);

async function call(method: "GET" | "POST") {
  const res = await auth.apiFetch(`/api/v1/admin/cli-fingerprint${method === "POST" ? "/sync" : ""}`, { method });
  const body = (await res.json().catch(() => ({}))) as CliFingerprintReport & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
  return body;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    report.value = await call("GET");
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function syncNow() {
  syncing.value = true;
  try {
    report.value = await call("POST");
    const updated = report.value.tools.filter((tool) => tool.source === "synced").length;
    toast.success(t("accounts.cli.synced", { n: updated }));
  } catch (err) {
    toast.error(t("accounts.cli.syncFailed", { message: err instanceof Error ? err.message : String(err) }));
  } finally {
    syncing.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void load();
  },
  { immediate: true },
);

const SOURCE_TONE: Record<CliFingerprintTool["source"], "success" | "accent" | "neutral"> = {
  synced: "success",
  env: "accent",
  builtin: "neutral",
};
</script>

<template>
  <UiModal :open="open" :title="t('accounts.cli.title')" width="xl" @update:open="emit('update:open', $event)">
    <template #icon>
      <span class="icon-chip icon-chip-accent h-8 w-8"><UiIcon name="fingerprint" :size="15" /></span>
    </template>

    <div class="space-y-3">
      <p class="text-xs text-fg-muted">{{ t("accounts.cli.hint") }}</p>
      <UiAlert v-if="error" tone="warning">{{ t("accounts.cli.unavailable", { message: error }) }}</UiAlert>
      <template v-else-if="report">
        <div class="flex flex-wrap items-center gap-2 text-2xs text-fg-subtle">
          <UiBadge :tone="report.syncEnabled ? 'success' : 'neutral'" dot>
            {{ report.syncEnabled ? t("accounts.cli.syncOn") : t("accounts.cli.syncOff") }}
          </UiBadge>
          <span v-if="report.lastSyncAtUnixMs" :title="formatDateTime(new Date(report.lastSyncAtUnixMs).toISOString())">
            {{ t("accounts.cli.lastSync", { time: formatRelative(new Date(report.lastSyncAtUnixMs).toISOString()) }) }}
          </span>
          <span v-else>{{ t("accounts.cli.neverSynced") }}</span>
        </div>
        <div class="overflow-x-auto rounded-lg border border-line">
          <table class="w-full min-w-[40rem] text-xs">
            <thead class="bg-surface-2/60 text-left text-2xs text-fg-subtle">
              <tr>
                <th class="px-3 py-2 font-medium">{{ t("accounts.cli.client") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("accounts.cli.effective") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("accounts.cli.builtin") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("accounts.cli.latest") }}</th>
                <th class="px-3 py-2 font-medium">User-Agent</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line/70">
              <tr v-for="tool in report.tools" :key="tool.key">
                <td class="whitespace-nowrap px-3 py-2 font-medium text-fg">{{ tool.name }}</td>
                <td class="whitespace-nowrap px-3 py-2">
                  <span class="font-mono text-fg">{{ tool.effective }}</span>
                  <UiBadge class="ml-1.5" :tone="SOURCE_TONE[tool.source]">{{ t(`accounts.cli.source.${tool.source}`) }}</UiBadge>
                </td>
                <td class="whitespace-nowrap px-3 py-2 font-mono text-fg-muted">{{ tool.builtin }}</td>
                <td class="whitespace-nowrap px-3 py-2">
                  <span v-if="!tool.syncable" class="text-fg-subtle">{{ t("accounts.cli.notSyncable") }}</span>
                  <span v-else-if="tool.error" class="text-danger" :title="tool.error">{{ t("accounts.cli.fetchError") }}</span>
                  <span v-else-if="tool.latest" class="font-mono" :class="tool.latest === tool.effective ? 'text-fg-muted' : 'text-warning'" :title="tool.latest === tool.effective ? undefined : t('accounts.cli.heldBack')">
                    {{ tool.latest }}
                  </span>
                  <span v-else class="text-fg-subtle">—</span>
                </td>
                <td class="max-w-[16rem] truncate px-3 py-2 font-mono text-2xs text-fg-subtle" :title="tool.userAgent">{{ tool.userAgent }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <p v-else-if="loading" class="text-xs text-fg-subtle">{{ t("common.loading") }}</p>
    </div>

    <template #footer>
      <button type="button" class="btn btn-secondary" @click="emit('update:open', false)">{{ t("common.close") }}</button>
      <button type="button" class="btn btn-primary" :disabled="syncing || !!error" @click="syncNow">
        <UiIcon :name="syncing ? 'loader' : 'refresh'" :size="14" :spin="syncing" />
        {{ t("accounts.cli.syncNow") }}
      </button>
    </template>
  </UiModal>
</template>
