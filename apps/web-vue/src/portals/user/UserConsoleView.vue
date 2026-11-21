<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  formatNanoUsd,
  type ApiKeyItem,
  type CreatedApiKeyResponse,
  type GroupItem,
} from "@slipgate/contracts";
import { useAuthStore } from "../../stores/auth";

const auth = useAuthStore();

const groups = ref<GroupItem[]>([]);
const apiKeys = ref<ApiKeyItem[]>([]);
const keyName = ref("");
const selectedGroupId = ref("");
const rpmLimit = ref(60);
const concurrencyLimit = ref(5);
const createdPlaintext = ref<string | null>(null);
const copied = ref(false);
const errorMessage = ref<string | null>(null);

const formattedBalance = computed(() =>
  formatNanoUsd(BigInt(auth.wallet?.balanceNanoUsd ?? "0")),
);
const formattedAvailable = computed(() => auth.wallet?.formattedAvailableUsd ?? "$0.00");

async function loadData() {
  errorMessage.value = null;
  await auth.hydrateSession();
  const [gRes, kRes] = await Promise.all([
    auth.apiFetch("/api/v1/user/groups"),
    auth.apiFetch("/api/v1/user/api-keys"),
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
}

async function handleCreateKey() {
  errorMessage.value = null;
  createdPlaintext.value = null;
  copied.value = false;
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
  await loadData();
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
    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="text-base font-semibold text-white">用户配额账本（nano-USD 定点精度）</h2>
      <div class="mt-4 grid gap-4 sm:grid-cols-2">
        <div class="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
          <p class="text-xs text-slate-400">总余额</p>
          <p class="mt-1 font-mono text-2xl font-bold text-white">{{ formattedBalance }}</p>
        </div>
        <div class="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
          <p class="text-xs text-slate-400">当前可用（扣除流式预冻结）</p>
          <p class="mt-1 font-mono text-2xl font-bold text-sky-400">{{ formattedAvailable }}</p>
        </div>
      </div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="text-base font-semibold text-white">API Key 密钥管理（仅创建时明文展示一次）</h2>

      <p v-if="errorMessage" class="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
        {{ errorMessage }}
      </p>

      <div
        v-if="createdPlaintext"
        class="mt-4 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm"
      >
        <p class="font-medium text-emerald-300">新密钥已签发，请立即复制保存（刷新后无法再次查看明文）：</p>
        <div class="mt-2 flex items-center gap-2">
          <code class="flex-1 break-all rounded bg-slate-950 px-3 py-2 font-mono text-xs text-white">
            {{ createdPlaintext }}
          </code>
          <button
            type="button"
            class="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400"
            @click="copySecret"
          >
            {{ copied ? "已复制" : "复制" }}
          </button>
        </div>
      </div>

      <form class="mt-4 grid gap-3 sm:grid-cols-5" @submit.prevent="handleCreateKey">
        <input
          v-model="keyName"
          type="text"
          required
          placeholder="密钥名称（如 claude-code）"
          class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
        />
        <select v-model="selectedGroupId" required class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }} ({{ g.platform }})</option>
        </select>
        <input
          v-model.number="rpmLimit"
          type="number"
          min="1"
          placeholder="RPM"
          class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
        />
        <input
          v-model.number="concurrencyLimit"
          type="number"
          min="1"
          placeholder="并发槽"
          class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
        />
        <button
          type="submit"
          class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400"
        >
          签发 API Key
        </button>
      </form>

      <div class="mt-4 space-y-2">
        <div
          v-for="item in apiKeys"
          :key="item.id"
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm"
        >
          <div>
            <p class="font-medium text-white">
              {{ item.name }}
              <code class="ml-2 rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-sky-300">{{ item.keyPrefix }}</code>
            </p>
            <p class="mt-1 font-mono text-xs text-slate-400">
              分组 {{ item.groupName }} · RPM {{ item.rpmLimit }} · 并发 {{ item.concurrencyLimit }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded px-2.5 py-1 text-xs"
              :class="item.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'"
              @click="toggleKey(item)"
            >
              {{ item.enabled ? "已启用" : "已禁用" }}
            </button>
            <button
              type="button"
              class="rounded bg-rose-500/15 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/25"
              @click="deleteKey(item.id)"
            >
              吊销
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="text-base font-semibold text-white">统一网关接入端点（直走 DataPlane，不经过 BFF）</h2>
      <ul class="mt-3 space-y-2 font-mono text-sm text-slate-300">
        <li>POST /v1/chat/completions · OpenAI Chat Completions</li>
        <li>POST /v1/responses · OpenAI Stateful Responses / WebSocket</li>
        <li>POST /v1/messages · Anthropic Messages</li>
        <li>POST /v1beta/models/:model:generateContent · Google Gemini</li>
        <li>POST /mcp/ · Model Context Protocol</li>
      </ul>
    </section>
  </div>
</template>
