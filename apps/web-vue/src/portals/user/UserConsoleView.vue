<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  formatNanoUsd,
  type ApiKeyItem,
  type CreatedApiKeyResponse,
  type GroupItem,
  type UsageLogItem,
} from "@slipgate/contracts";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import CopyButton from "../../components/ui/CopyButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiDrawer from "../../components/ui/UiDrawer.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { formatDateTime, formatNumber } from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const { t } = useI18n();
const auth = useAuthStore();

const groups = ref<GroupItem[]>([]);
const apiKeys = ref<ApiKeyItem[]>([]);
const usageLogs = ref<UsageLogItem[]>([]);
const keyName = ref("");
const selectedGroupId = ref("");
const rpmLimit = ref(60);
const concurrencyLimit = ref(5);
const createdPlaintext = ref<string | null>(null);
const copied = ref(false);
const errorMessage = ref<string | null>(null);
const loading = ref(false);
const createOpen = ref(false);
const creating = ref(false);

useFeedbackToasts(errorMessage);

const formattedBalance = computed(() =>
  formatNanoUsd(BigInt(auth.wallet?.balanceNanoUsd ?? "0")),
);
const formattedAvailable = computed(() => auth.wallet?.formattedAvailableUsd ?? "$0.00");
const formattedHeld = computed(() => formatNanoUsd(BigInt(auth.wallet?.heldNanoUsd ?? "0")));
const enabledKeyCount = computed(() => apiKeys.value.filter((k) => k.enabled).length);

const gatewayOrigin = computed(() => window.location.origin);

const endpoints = [
  { method: "POST", path: "/v1/chat/completions", label: "OpenAI Chat Completions" },
  { method: "POST", path: "/v1/responses", label: "OpenAI Responses / WebSocket" },
  { method: "POST", path: "/v1/messages", label: "Anthropic Messages" },
  { method: "POST", path: "/v1beta/models/:model:generateContent", label: "Google Gemini" },
  { method: "POST", path: "/mcp/", label: "MCP" },
];

async function loadData() {
  errorMessage.value = null;
  loading.value = true;
  try {
    await auth.hydrateSession();
    const [gRes, kRes, uRes] = await Promise.all([
      auth.apiFetch("/api/v1/user/groups"),
      auth.apiFetch("/api/v1/user/api-keys"),
      auth.apiFetch("/api/v1/user/usage?limit=25"),
    ]);
    if (gRes.ok) {
      const data = (await gRes.json()) as { groups: GroupItem[] };
      groups.value = data.groups;
      if (!selectedGroupId.value && groups.value.length > 0) {
        selectedGroupId.value = groups.value[0]!.id;
      }
    }
    if (kRes.ok) {
      const data = (await kRes.json()) as { items: ApiKeyItem[] };
      apiKeys.value = data.items;
    }
    if (uRes.ok) {
      const data = (await uRes.json()) as { items: UsageLogItem[] };
      usageLogs.value = data.items;
    }
  } finally {
    loading.value = false;
  }
}

async function handleCreateKey() {
  errorMessage.value = null;
  createdPlaintext.value = null;
  copied.value = false;
  creating.value = true;
  try {
    const res = await auth.apiFetch("/api/v1/user/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: keyName.value,
        groupId: selectedGroupId.value,
        rpmLimit: rpmLimit.value,
        concurrencyLimit: concurrencyLimit.value,
      }),
    });
    const data = (await res.json()) as CreatedApiKeyResponse & { message?: string };
    if (!res.ok) {
      errorMessage.value = data.message ?? t("user.errors.create");
      return;
    }
    createdPlaintext.value = data.plaintextKey;
    keyName.value = "";
    createOpen.value = false;
    await loadData();
  } finally {
    creating.value = false;
  }
}

async function toggleKey(item: ApiKeyItem) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/user/api-keys/${item.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: !item.enabled }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? t("user.errors.toggle");
    return;
  }
  await loadData();
}

async function deleteKey(keyId: string) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/user/api-keys/${keyId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? t("user.errors.delete");
    return;
  }
  await loadData();
}

async function copySecret() {
  if (!createdPlaintext.value) return;
  try {
    await navigator.clipboard.writeText(createdPlaintext.value);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

onMounted(() => {
  void loadData();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('nav.keys')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadData">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
        <button type="button" class="btn btn-primary" @click="createOpen = true">
          <UiIcon name="plus" :size="15" />
          {{ t("user.createKey") }}
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard :label="t('user.stats.available')" :value="formattedAvailable" icon="wallet" tone="accent" />
      <StatCard :label="t('user.stats.balance')" :value="formattedBalance" icon="database" />
      <StatCard :label="t('user.stats.held')" :value="formattedHeld" icon="clock" tone="warning" />
      <StatCard
        :label="t('user.stats.enabledKeys')"
        :value="enabledKeyCount"
        icon="key"
        tone="success"
        :hint="t('user.stats.totalKeys', { count: apiKeys.length })"
      />
    </div>

    <!-- One-time plaintext reveal -->
    <div
      v-if="createdPlaintext"
      class="animate-slide-up rounded-xl border border-success/30 bg-success/[0.06] p-4"
      role="status"
    >
      <div class="flex items-start gap-3">
        <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success/15 text-success">
          <UiIcon name="check-circle" :size="16" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium text-fg">{{ t("user.reveal.title") }}</p>
          <p class="mt-0.5 text-xs text-fg-muted">{{ t("user.reveal.notice") }}</p>
          <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code class="min-w-0 flex-1 break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-fg">
              {{ createdPlaintext }}
            </code>
            <div class="flex gap-2">
              <button type="button" class="btn btn-sm" :class="copied ? 'btn-success' : 'btn-primary'" @click="copySecret">
                <UiIcon :name="copied ? 'check' : 'copy'" :size="14" />
                {{ copied ? t("common.copied") : t("common.copy") }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" @click="createdPlaintext = null">{{ t("user.reveal.saved") }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <UiCard :title="t('user.keys.title')" icon="key" flush>
      <EmptyState v-if="apiKeys.length === 0" icon="key" :title="t('user.keys.empty')">
        <button type="button" class="btn btn-primary btn-sm" @click="createOpen = true">
          <UiIcon name="plus" :size="14" />
          {{ t("user.createKey") }}
        </button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("common.name") }}</th>
              <th>{{ t("user.keys.key") }}</th>
              <th>{{ t("user.keys.group") }}</th>
              <th class="text-right">{{ t("user.keys.rpm") }}</th>
              <th class="text-right">{{ t("user.keys.concurrency") }}</th>
              <th>{{ t("common.status") }}</th>
              <th class="text-right">{{ t("common.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in apiKeys" :key="item.id">
              <td class="font-medium text-fg">{{ item.name }}</td>
              <td><span class="code-chip">{{ item.keyPrefix }}</span></td>
              <td class="text-fg-muted">{{ item.groupName }}</td>
              <td class="text-right font-mono text-xs tabular-nums">{{ item.rpmLimit }}</td>
              <td class="text-right font-mono text-xs tabular-nums">{{ item.concurrencyLimit }}</td>
              <td>
                <UiSwitch
                  :model-value="item.enabled"
                  :label="item.enabled ? t('common.enabled') : t('common.disabled')"
                  @update:model-value="toggleKey(item)"
                />
              </td>
              <td class="text-right">
                <ConfirmButton @confirm="deleteKey(item.id)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard :title="t('user.usage.title')" icon="activity" flush>
      <template #actions>
        <UiBadge>{{ t("user.usage.recent", { count: 25 }) }}</UiBadge>
      </template>
      <EmptyState v-if="usageLogs.length === 0" icon="activity" :title="t('user.usage.empty')" />
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("user.usage.time") }}</th>
              <th>{{ t("user.usage.model") }}</th>
              <th>{{ t("user.usage.protocol") }}</th>
              <th class="text-right">{{ t("user.usage.tokens") }}</th>
              <th class="text-right">{{ t("user.usage.cost") }}</th>
              <th class="text-right">{{ t("user.usage.latency") }}</th>
              <th>{{ t("common.status") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="log in usageLogs" :key="log.id">
              <td class="whitespace-nowrap font-mono text-xs text-fg-subtle">{{ formatDateTime(log.createdAtIso) }}</td>
              <td>
                <p class="font-medium text-fg">{{ log.publicModel }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">→ {{ log.upstreamModel }}</p>
              </td>
              <td class="whitespace-nowrap font-mono text-xs text-fg-muted">{{ log.ingressCodec }} → {{ log.egressCodec }}</td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                {{ formatNumber(log.inputTokens) }} / {{ formatNumber(log.outputTokens) }}
              </td>
              <td class="text-right font-mono text-xs font-medium tabular-nums text-fg">{{ log.formattedCostUsd }}</td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums text-fg-muted">
                {{ log.ttftMs }} / {{ log.durationMs }} ms
              </td>
              <td>
                <UiBadge :tone="log.statusCode < 400 ? 'success' : 'danger'" mono>{{ log.statusCode }}</UiBadge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard :title="t('user.endpoints.title')" icon="plug">
      <div class="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 sm:flex-row sm:items-center">
        <span class="text-xs text-fg-subtle">Base URL</span>
        <code class="min-w-0 flex-1 truncate font-mono text-sm text-fg">{{ gatewayOrigin }}</code>
        <CopyButton :text="gatewayOrigin" :label="t('common.copy')" />
      </div>
      <ul class="mt-3 divide-y divide-line/70">
        <li v-for="ep in endpoints" :key="ep.path" class="flex items-center gap-3 py-2.5">
          <UiBadge tone="accent" mono>{{ ep.method }}</UiBadge>
          <code class="min-w-0 flex-1 truncate font-mono text-xs text-fg">{{ ep.path }}</code>
          <span class="hidden text-xs text-fg-subtle sm:inline">{{ ep.label }}</span>
          <CopyButton :text="`${gatewayOrigin}${ep.path}`" />
        </li>
      </ul>
    </UiCard>

    <UiDrawer v-model:open="createOpen" :title="t('user.createKey')">
      <form id="create-key-form" class="space-y-4" @submit.prevent="handleCreateKey">
        <FormField :label="t('user.form.name')" required>
          <input v-model="keyName" type="text" required :placeholder="t('user.form.namePlaceholder')" class="input" />
        </FormField>
        <FormField :label="t('user.form.group')" required>
          <select v-model="selectedGroupId" required class="select">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }} · {{ g.platform }}</option>
          </select>
        </FormField>
        <div class="grid grid-cols-2 gap-3">
          <FormField :label="t('user.form.rpm')">
            <input v-model.number="rpmLimit" type="number" min="1" class="input font-mono" />
          </FormField>
          <FormField :label="t('user.form.concurrency')">
            <input v-model.number="concurrencyLimit" type="number" min="1" class="input font-mono" />
          </FormField>
        </div>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="createOpen = false">{{ t("common.cancel") }}</button>
        <button type="submit" form="create-key-form" class="btn btn-primary" :disabled="creating">
          <UiIcon v-if="creating" name="loader" :size="15" spin />
          {{ t("user.form.submit") }}
        </button>
      </template>
    </UiDrawer>
  </div>
</template>
