<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { PasskeyItem } from "@slipgate/contracts";
import UiCard from "../ui/UiCard.vue";
import UiIcon from "../ui/UiIcon.vue";
import UiBadge from "../ui/UiBadge.vue";
import { apiJson, errorText } from "../../lib/api";
import { formatDateShort, formatRelative } from "../../lib/format";
import {
  createPasskeyCredential,
  isWebAuthnSupported,
  type ServerCreationOptions,
} from "../../lib/webauthn";
import { useToastStore } from "../../stores/toast";

const { t } = useI18n();
const toast = useToastStore();

const supported = isWebAuthnSupported();
const items = ref<PasskeyItem[]>([]);
const loading = ref(false);
const registering = ref(false);
const deviceName = ref("");
const editingId = ref<string | null>(null);
const editName = ref("");
const deletingId = ref<string | null>(null);

async function load() {
  loading.value = true;
  try {
    const res = await apiJson<{ items: PasskeyItem[] }>("/api/v1/user/passkeys");
    items.value = res.items ?? [];
  } catch (err) {
    toast.error(errorText(err, t("profile.passkeys.loadFailed")));
  } finally {
    loading.value = false;
  }
}

async function addPasskey() {
  if (!supported || registering.value) return;
  registering.value = true;
  const label = deviceName.value.trim() || "Passkey";
  try {
    const opts = await apiJson<{ challengeToken: string; options: ServerCreationOptions }>(
      "/api/v1/user/passkeys/register/options",
      {
        method: "POST",
        body: { deviceName: label },
      },
    );
    const verifyPayload = await createPasskeyCredential(opts.options, label, opts.challengeToken);
    const created = await apiJson<{ item: PasskeyItem }>("/api/v1/user/passkeys/register/verify", {
      method: "POST",
      body: verifyPayload,
    });
    items.value = [created.item, ...items.value];
    deviceName.value = "";
    toast.success(t("profile.passkeys.added"));
  } catch (err) {
    toast.error(errorText(err, t("profile.passkeys.addFailed")));
  } finally {
    registering.value = false;
  }
}

function startRename(item: PasskeyItem) {
  editingId.value = item.id;
  editName.value = item.deviceName;
}

async function saveRename(item: PasskeyItem) {
  const next = editName.value.trim();
  if (!next) return;
  try {
    const res = await apiJson<{ item: PasskeyItem }>(`/api/v1/user/passkeys/${encodeURIComponent(item.id)}`, {
      method: "PATCH",
      body: { deviceName: next },
    });
    items.value = items.value.map((x) => (x.id === item.id ? res.item : x));
    editingId.value = null;
    toast.success(t("profile.passkeys.renamed"));
  } catch (err) {
    toast.error(errorText(err, t("profile.passkeys.renameFailed")));
  }
}

async function removePasskey(item: PasskeyItem) {
  if (deletingId.value) return;
  deletingId.value = item.id;
  try {
    await apiJson(`/api/v1/user/passkeys/${encodeURIComponent(item.id)}`, { method: "DELETE" });
    items.value = items.value.filter((x) => x.id !== item.id);
    toast.success(t("profile.passkeys.removed"));
  } catch (err) {
    toast.error(errorText(err, t("profile.passkeys.removeFailed")));
  } finally {
    deletingId.value = null;
  }
}

onMounted(load);
</script>

<template>
  <UiCard icon="fingerprint" :title="t('profile.passkeys.title')">
    <div class="space-y-4">
      <p class="text-sm text-fg-subtle">{{ t("profile.passkeys.desc") }}</p>

      <div v-if="supported" class="flex flex-col gap-2 sm:flex-row">
        <input
          v-model="deviceName"
          type="text"
          maxlength="64"
          class="input sm:flex-1"
          :placeholder="t('profile.passkeys.devicePlaceholder')"
        />
        <button type="button" class="btn btn-primary shrink-0" :disabled="registering" @click="addPasskey">
          <UiIcon :name="registering ? 'loader' : 'plus'" :size="15" :spin="registering" />
          {{ registering ? t("common.submitting") : t("profile.passkeys.add") }}
        </button>
      </div>
      <p v-else class="rounded-lg border border-line/70 bg-surface-2 px-3 py-2 text-xs text-fg-subtle">
        {{ t("profile.passkeys.unsupported") }}
      </p>

      <div v-if="loading" class="flex items-center gap-2 py-2 text-xs text-fg-subtle">
        <UiIcon name="loader" :size="14" spin />
        {{ t("common.loading") }}
      </div>

      <p v-else-if="items.length === 0" class="text-xs text-fg-subtle">
        {{ t("profile.passkeys.empty") }}
      </p>

      <ul v-else class="divide-y divide-line/70 rounded-xl border border-line/70">
        <li v-for="pk in items" :key="pk.id" class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div class="min-w-0 flex-1">
            <div v-if="editingId === pk.id" class="flex items-center gap-2">
              <input v-model="editName" type="text" maxlength="64" class="input h-8 max-w-xs text-sm" @keyup.enter="saveRename(pk)" />
              <button type="button" class="btn btn-primary h-8 px-2.5 text-xs" @click="saveRename(pk)">
                {{ t("common.save") }}
              </button>
              <button type="button" class="btn btn-ghost h-8 px-2 text-xs" @click="editingId = null">
                {{ t("common.cancel") }}
              </button>
            </div>
            <template v-else>
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium text-fg">{{ pk.deviceName }}</span>
                <UiBadge v-if="pk.backedUp" tone="info">{{ t("profile.passkeys.synced") }}</UiBadge>
              </div>
              <p class="mt-0.5 text-xs text-fg-subtle">
                {{ t("profile.passkeys.addedOn", { date: formatDateShort(pk.createdAtIso) }) }}
                <template v-if="pk.lastUsedAtIso"> · {{ t("profile.passkeys.lastUsed", { time: formatRelative(pk.lastUsedAtIso) }) }}</template>
              </p>
            </template>
          </div>
          <div v-if="editingId !== pk.id" class="flex items-center gap-1.5">
            <button type="button" class="btn btn-ghost h-8 px-2 text-xs" :title="t('profile.passkeys.rename')" @click="startRename(pk)">
              <UiIcon name="pencil" :size="14" />
            </button>
            <button
              type="button"
              class="btn btn-ghost h-8 px-2 text-xs text-danger hover:bg-danger/10"
              :disabled="deletingId === pk.id"
              :title="t('profile.passkeys.remove')"
              @click="removePasskey(pk)"
            >
              <UiIcon :name="deletingId === pk.id ? 'loader' : 'trash'" :size="14" :spin="deletingId === pk.id" />
            </button>
          </div>
        </li>
      </ul>
    </div>
  </UiCard>
</template>
