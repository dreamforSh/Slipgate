<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type {
  AccountAuthKind,
  ExecutionMode,
  GroupItem,
  GroupPlatform,
  GroupSubscriptionType,
  Provider,
  UpstreamAccount,
} from "@slipgate/contracts";
import { useAuthStore } from "../../stores/auth";

const auth = useAuthStore();

const groups = ref<GroupItem[]>([]);
const accounts = ref<UpstreamAccount[]>([]);
const modeFilter = ref<"all" | ExecutionMode>("all");
const errorMessage = ref<string | null>(null);

// Group creation form
const groupName = ref("");
const groupPlatform = ref<GroupPlatform>("composite");
const groupSubType = ref<GroupSubscriptionType>("balance");
const groupMultiplier = ref(1);

// Account creation form
const accName = ref("");
const accGroupId = ref("");
const accPlatform = ref<Provider>("anthropic");
const accMode = ref<ExecutionMode>("stealth_http");
const accAuthKind = ref<AccountAuthKind>("oauth");
const accSecret = ref("");
const accMaxConc = ref(5);
const accPriority = ref(100);

const filteredAccounts = computed(() => {
  if (modeFilter.value === "all") return accounts.value;
  return accounts.value.filter((a) => a.executionMode === modeFilter.value);
});

async function refreshPool() {
  errorMessage.value = null;
  const [gRes, aRes] = await Promise.all([
    auth.apiFetch("/api/v1/admin/groups"),
    auth.apiFetch("/api/v1/admin/accounts"),
  ]);
  if (gRes.ok) {
    const data = (await gRes.json()) as { groups: GroupItem[] };
    groups.value = data.groups;
    if (!accGroupId.value && groups.value.length > 0) {
      accGroupId.value = groups.value[0]!.id;
    }
  }
  if (aRes.ok) {
    const data = (await aRes.json()) as { accounts: UpstreamAccount[] };
    accounts.value = data.accounts;
  }
}

async function handleCreateGroup() {
  errorMessage.value = null;
  const res = await auth.apiFetch("/api/v1/admin/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: groupName.value,
      platform: groupPlatform.value,
      subscriptionType: groupSubType.value,
      rateMultiplier: groupMultiplier.value,
    }),
  });
  const data = (await res.json()) as { message?: string };
  if (!res.ok) {
    errorMessage.value = data.message ?? "创建分组失败";
    return;
  }
  groupName.value = "";
  await refreshPool();
}

async function toggleGroup(group: GroupItem) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/groups/${group.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: !group.enabled }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "更新分组失败";
    return;
  }
  await refreshPool();
}

async function removeGroup(groupId: string) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/groups/${groupId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "删除分组失败";
    return;
  }
  await refreshPool();
}

async function handleCreateAccount() {
  errorMessage.value = null;
  const res = await auth.apiFetch("/api/v1/admin/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: accName.value,
      groupId: accGroupId.value,
      platform: accPlatform.value,
      executionMode: accMode.value,
      authKind: accAuthKind.value,
      credentialSecret: accSecret.value,
      maxConcurrency: accMaxConc.value,
      priority: accPriority.value,
    }),
  });
  const data = (await res.json()) as { message?: string };
  if (!res.ok) {
    errorMessage.value = data.message ?? "添加账号失败";
    return;
  }
  accName.value = "";
  accSecret.value = "";
  await refreshPool();
}

async function toggleAccountStatus(acc: UpstreamAccount) {
  errorMessage.value = null;
  const nextStatus = acc.status === "active" ? "paused" : "active";
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${acc.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: nextStatus }),
  });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "更新账号状态失败";
    return;
  }
  await refreshPool();
}

async function removeAccount(accountId: string) {
  errorMessage.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/accounts/${accountId}`, { method: "DELETE" });
  if (!res.ok) {
    const data = (await res.json()) as { message?: string };
    errorMessage.value = data.message ?? "删除账号失败";
    return;
  }
  await refreshPool();
}

onMounted(() => {
  void refreshPool();
});
</script>

<template>
  <div class="space-y-6">
    <p v-if="errorMessage" class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
      {{ errorMessage }}
    </p>

    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="text-base font-semibold text-white">路由分组管理</h2>
      <form class="mt-4 grid gap-3 sm:grid-cols-5" @submit.prevent="handleCreateGroup">
        <input
          v-model="groupName"
          type="text"
          required
          placeholder="分组名称"
          class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
        />
        <select v-model="groupPlatform" class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
          <option value="composite">composite (合成路由)</option>
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
          <option value="gemini">gemini</option>
          <option value="antigravity">antigravity</option>
          <option value="grok">grok</option>
        </select>
        <select v-model="groupSubType" class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
          <option value="balance">按量扣费 (balance)</option>
          <option value="subscription">订阅套餐 (subscription)</option>
        </select>
        <input
          v-model.number="groupMultiplier"
          type="number"
          step="0.1"
          min="0.01"
          class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
        />
        <button
          type="submit"
          class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400"
        >
          新增分组
        </button>
      </form>

      <div class="mt-4 grid gap-3 md:grid-cols-2">
        <div
          v-for="g in groups"
          :key="g.id"
          class="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm"
        >
          <div>
            <p class="font-medium text-white">
              {{ g.name }}
              <span class="ml-2 rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-sky-300">{{ g.platform }}</span>
            </p>
            <p class="mt-0.5 text-xs text-slate-400">
              倍率 {{ g.rateMultiplier }}x · {{ g.subscriptionType }} · 账号数 {{ g.accountCount }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded px-2.5 py-1 text-xs"
              :class="g.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-400'"
              @click="toggleGroup(g)"
            >
              {{ g.enabled ? "已启用" : "已禁用" }}
            </button>
            <button
              type="button"
              class="rounded bg-rose-500/15 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/25"
              @click="removeGroup(g.id)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-base font-semibold text-white">上游号池管理（AES-256-GCM 密文保管）</h2>
        <div class="flex gap-1 rounded-lg bg-slate-950 p-1 text-xs">
          <button
            v-for="mode in ['all', 'stealth_http', 'vm_slot', 'direct_api'] as const"
            :key="mode"
            type="button"
            class="rounded px-2.5 py-1"
            :class="modeFilter === mode ? 'bg-sky-500 text-slate-950 font-semibold' : 'text-slate-400'"
            @click="modeFilter = mode"
          >
            {{ mode }}
          </button>
        </div>
      </div>

      <form class="mt-4 grid gap-3 sm:grid-cols-4" @submit.prevent="handleCreateAccount">
        <input
          v-model="accName"
          type="text"
          required
          placeholder="账号别名（例如 claude-max-01）"
          class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
        />
        <select v-model="accGroupId" required class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
          <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
        </select>
        <select v-model="accPlatform" class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
          <option value="gemini">gemini</option>
          <option value="antigravity">antigravity</option>
          <option value="grok">grok</option>
          <option value="deepseek">deepseek</option>
        </select>
        <select v-model="accMode" class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
          <option value="stealth_http">stealth_http (uTLS + Clash)</option>
          <option value="vm_slot">vm_slot (KVM/VM 全拟真)</option>
          <option value="direct_api">direct_api (官方密钥直连)</option>
        </select>
        <select v-model="accAuthKind" class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
          <option value="oauth">oauth</option>
          <option value="setup_token">setup_token</option>
          <option value="api_key">api_key</option>
          <option value="vm_cli_seed">vm_cli_seed</option>
        </select>
        <input
          v-model="accSecret"
          type="password"
          required
          placeholder="凭据密文 / OAuth Token / API Key"
          class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white sm:col-span-2"
        />
        <button
          type="submit"
          class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-sky-400"
        >
          录入并加密入库
        </button>
      </form>

      <div class="mt-4 space-y-2">
        <div
          v-for="acc in filteredAccounts"
          :key="acc.id"
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm"
        >
          <div>
            <p class="font-medium text-white">
              {{ acc.name }}
              <span class="ml-2 rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-sky-300">{{ acc.platform }}</span>
              <span class="ml-1 rounded bg-indigo-500/20 px-2 py-0.5 font-mono text-xs text-indigo-300">{{ acc.executionMode }}</span>
            </p>
            <p class="mt-1 font-mono text-xs text-slate-400">
              分组 {{ acc.groupName }} · 凭据摘要 {{ acc.credentialPreview }} · 并发 {{ acc.maxConcurrency }} · 优先级 {{ acc.priority }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded px-2.5 py-1 text-xs"
              :class="acc.status === 'active' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-300'"
              @click="toggleAccountStatus(acc)"
            >
              {{ acc.status }}
            </button>
            <button
              type="button"
              class="rounded bg-rose-500/15 px-2.5 py-1 text-xs text-rose-300 hover:bg-rose-500/25"
              @click="removeAccount(acc.id)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
