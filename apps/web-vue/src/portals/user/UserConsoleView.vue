<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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
  { method: "POST", path: "/mcp/", label: "Model Context Protocol" },
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
      errorMessage.value = data.message ?? "创建 API Key 失败";
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
    errorMessage.value = data.message ?? "更新密钥状态失败";
    return;
  }
  await loadData();
}

async function deleteKey(keyId: string) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/user/api-keys/${keyId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "删除密钥失败";
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
    <PageHeader title="密钥与配额" description="签发访问网关的 API Key，查看余额与每次调用的结算明细。">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadData">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          刷新
        </button>
        <button type="button" class="btn btn-primary" @click="createOpen = true">
          <UiIcon name="plus" :size="15" />
          签发 API Key
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard label="可用余额" :value="formattedAvailable" icon="wallet" tone="accent" hint="已扣除流式预冻结" />
      <StatCard label="账户总余额" :value="formattedBalance" icon="database" hint="nano-USD 定点精度" />
      <StatCard label="预冻结中" :value="formattedHeld" icon="clock" tone="warning" hint="进行中的流式请求" />
      <StatCard
        label="API Key"
        :value="`${enabledKeyCount} / ${apiKeys.length}`"
        icon="key"
        tone="success"
        hint="启用 / 全部"
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
          <p class="text-sm font-medium text-fg">新密钥已签发</p>
          <p class="mt-0.5 text-xs text-fg-muted">明文只显示这一次，关闭或刷新页面后将无法再次查看，请立即复制保存。</p>
          <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code class="min-w-0 flex-1 break-all rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-fg">
              {{ createdPlaintext }}
            </code>
            <div class="flex gap-2">
              <button type="button" class="btn btn-sm" :class="copied ? 'btn-success' : 'btn-primary'" @click="copySecret">
                <UiIcon :name="copied ? 'check' : 'copy'" :size="14" />
                {{ copied ? "已复制" : "复制" }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" @click="createdPlaintext = null">我已保存</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <UiCard title="API Key" description="密钥只在签发时展示明文，服务端仅保存 SHA-256 摘要" icon="key" flush>
      <EmptyState
        v-if="apiKeys.length === 0"
        icon="key"
        title="还没有 API Key"
        description="签发一个密钥，即可通过下方的统一端点调用网关。"
      >
        <button type="button" class="btn btn-primary btn-sm" @click="createOpen = true">
          <UiIcon name="plus" :size="14" />
          签发 API Key
        </button>
      </EmptyState>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>密钥前缀</th>
              <th>分组</th>
              <th class="text-right">RPM</th>
              <th class="text-right">并发</th>
              <th>状态</th>
              <th class="text-right">操作</th>
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
                  :label="item.enabled ? '已启用' : '已禁用'"
                  @update:model-value="toggleKey(item)"
                />
              </td>
              <td class="text-right">
                <ConfirmButton label="吊销" confirm-label="确认吊销" @confirm="deleteKey(item.id)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>

    <UiCard title="最近调用" description="DataPlane 每次请求的 Token 用量与 nano-USD 结算" icon="activity" flush>
      <template #actions>
        <span class="text-xs text-fg-subtle">最近 25 条</span>
      </template>
      <EmptyState
        v-if="usageLogs.length === 0"
        icon="activity"
        title="暂无调用记录"
        description="使用 sk-sg-* 密钥请求任一统一端点后，结算记录会实时出现在这里。"
      />
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>模型</th>
              <th>协议转码</th>
              <th class="text-right">Tokens 入 / 出</th>
              <th class="text-right">费用</th>
              <th class="text-right">TTFT / 总耗时</th>
              <th>状态</th>
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

    <UiCard title="接入端点" description="直连 DataPlane，不经过 BFF 中间件" icon="plug">
      <div class="flex flex-col gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2.5 sm:flex-row sm:items-center">
        <span class="text-xs text-fg-subtle">Base URL</span>
        <code class="min-w-0 flex-1 truncate font-mono text-sm text-fg">{{ gatewayOrigin }}</code>
        <CopyButton :text="gatewayOrigin" label="复制" />
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

    <UiDrawer v-model:open="createOpen" title="签发 API Key" description="明文只在签发成功后显示一次">
      <form id="create-key-form" class="space-y-4" @submit.prevent="handleCreateKey">
        <FormField label="密钥名称" required>
          <input v-model="keyName" type="text" required placeholder="例如 claude-code" class="input" />
        </FormField>
        <FormField label="路由分组" required hint="决定该密钥可访问的上游平台与计费倍率">
          <select v-model="selectedGroupId" required class="select">
            <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}（{{ g.platform }}）</option>
          </select>
        </FormField>
        <div class="grid grid-cols-2 gap-3">
          <FormField label="RPM 限制" hint="每分钟请求数">
            <input v-model.number="rpmLimit" type="number" min="1" class="input font-mono" />
          </FormField>
          <FormField label="并发槽" hint="同时进行的请求数">
            <input v-model.number="concurrencyLimit" type="number" min="1" class="input font-mono" />
          </FormField>
        </div>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="createOpen = false">取消</button>
        <button type="submit" form="create-key-form" class="btn btn-primary" :disabled="creating">
          <UiIcon v-if="creating" name="loader" :size="15" spin />
          签发
        </button>
      </template>
    </UiDrawer>
  </div>
</template>
