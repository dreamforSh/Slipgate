<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AdminApiKeyItem, CreateAdminApiKeyResponse } from "@slipgate/contracts";
import UiBadge from "../ui/UiBadge.vue";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";
import { apiJson, errorText } from "../../lib/api";
import { formatDateShort, formatRelative } from "../../lib/format";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const toast = useToastStore();

const items = ref<AdminApiKeyItem[]>([]);
const loading = ref(false);
const creating = ref(false);
const revokingId = ref<string | null>(null);
const errorMessage = ref<string | null>(null);
const createdToken = ref<string | null>(null);

const form = reactive({
  name: "",
  expiresInDays: "" as string | number,
});

function isExpired(item: AdminApiKeyItem): boolean {
  return Boolean(item.expiresAtIso && Date.parse(item.expiresAtIso) <= Date.now());
}

async function load() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await apiJson<{ items: AdminApiKeyItem[] }>("/api/v1/admin/api-keys", {
      fallbackError: t("settings.security.adminKeys.loadError"),
    });
    items.value = res.items;
  } catch (err) {
    errorMessage.value = errorText(err, t("settings.security.adminKeys.loadError"));
  } finally {
    loading.value = false;
  }
}

async function createKey() {
  const name = form.name.trim();
  if (!name || creating.value) return;
  creating.value = true;
  try {
    const daysNum = Number(form.expiresInDays);
    const expiresInDays = Number.isInteger(daysNum) && daysNum > 0 ? daysNum : null;
    const res = await apiJson<CreateAdminApiKeyResponse>("/api/v1/admin/api-keys", {
      method: "POST",
      body: { name, ...(expiresInDays ? { expiresInDays } : {}) },
      fallbackError: t("settings.security.adminKeys.createError"),
    });
    createdToken.value = res.token;
    form.name = "";
    form.expiresInDays = "";
    toast.success(t("settings.security.adminKeys.created"));
    await load();
  } catch (err) {
    toast.error(errorText(err, t("settings.security.adminKeys.createError")));
  } finally {
    creating.value = false;
  }
}

async function copyToken() {
  if (!createdToken.value) return;
  try {
    await navigator.clipboard.writeText(createdToken.value);
    toast.success(t("common.copied"));
  } catch {
    // User can copy manually from the input box.
  }
}

async function revoke(id: string) {
  revokingId.value = id;
  try {
    await apiJson(`/api/v1/admin/api-keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
      fallbackError: t("settings.security.adminKeys.revokeError"),
    });
    toast.success(t("settings.security.adminKeys.revokedToast"));
    await load();
  } catch (err) {
    toast.error(errorText(err, t("settings.security.adminKeys.revokeError")));
  } finally {
    revokingId.value = null;
  }
}

onMounted(() => void load());
</script>

<template>
  <UiCard icon="key" :title="t('settings.security.adminKeys.title')">
    <p class="mb-4 text-xs text-fg-subtle">{{ t("settings.security.adminKeys.help") }}</p>

    <div
      v-if="createdToken"
      class="mb-4 rounded-xl border border-warning/40 bg-warning/10 p-3.5 text-xs"
      role="status"
    >
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="font-semibold text-fg">{{ t("settings.security.adminKeys.tokenOnce") }}</span>
        <button type="button" class="text-fg-subtle hover:text-fg" @click="createdToken = null">
          <UiIcon name="x" :size="14" />
        </button>
      </div>
      <div class="flex flex-col gap-2 sm:flex-row">
        <input :value="createdToken" type="text" readonly class="input flex-1 font-mono text-xs" />
        <button type="button" class="btn btn-secondary btn-sm shrink-0" @click="copyToken">
          <UiIcon name="copy" :size="13" />
          {{ t("common.copy") }}
        </button>
      </div>
    </div>

    <form class="mb-5 flex flex-col gap-2 sm:flex-row" @submit.prevent="createKey">
      <input
        v-model="form.name"
        type="text"
        required
        maxlength="80"
        class="input flex-1"
        :placeholder="t('settings.security.adminKeys.namePlaceholder')"
      />
      <input
        v-model="form.expiresInDays"
        type="number"
        min="1"
        max="3650"
        class="input w-full font-mono sm:w-44"
        :placeholder="t('settings.security.adminKeys.expiryPlaceholder')"
      />
      <button type="submit" class="btn btn-primary shrink-0" :disabled="!form.name.trim() || creating">
        <UiIcon :name="creating ? 'loader' : 'plus'" :size="14" :spin="creating" />
        {{ t("settings.security.adminKeys.create") }}
      </button>
    </form>

    <p v-if="errorMessage" class="mb-3 text-xs text-danger">{{ errorMessage }}</p>
    <p v-else-if="loading && items.length === 0" class="py-4 text-center text-xs text-fg-subtle">
      {{ t("common.loading") }}
    </p>
    <p v-else-if="items.length === 0" class="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-fg-subtle">
      {{ t("settings.security.adminKeys.empty") }}
    </p>

    <div v-else class="divide-y divide-line/70">
      <div v-for="k in items" :key="k.id" class="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-fg">{{ k.name }}</span>
            <code class="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-2xs text-fg-muted">{{ k.keyPrefix }}…</code>
            <UiBadge v-if="k.revokedAtIso" tone="neutral">{{ t("settings.security.adminKeys.status.revoked") }}</UiBadge>
            <UiBadge v-else-if="isExpired(k)" tone="warning">{{ t("settings.security.adminKeys.status.expired") }}</UiBadge>
            <UiBadge v-else tone="success">{{ t("settings.security.adminKeys.status.active") }}</UiBadge>
          </div>
          <p class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-fg-subtle">
            <span>{{ t("common.createdAt") }}: {{ formatDateShort(k.createdAtIso) }}</span>
            <span v-if="k.lastUsedAtIso">{{ t("settings.security.adminKeys.lastUsed", { time: formatRelative(k.lastUsedAtIso) }) }}</span>
            <span v-if="k.expiresAtIso">{{ t("settings.security.adminKeys.expires", { date: formatDateShort(k.expiresAtIso) }) }}</span>
          </p>
        </div>
        <button
          v-if="!k.revokedAtIso"
          type="button"
          class="btn btn-secondary btn-sm text-danger hover:bg-danger/10"
          :disabled="revokingId === k.id"
          @click="revoke(k.id)"
        >
          {{ t("settings.security.adminKeys.revoke") }}
        </button>
      </div>
    </div>
  </UiCard>
</template>
