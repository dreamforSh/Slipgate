<script setup lang="ts">
import { onMounted, ref } from "vue";
import type {
  AccountExitBinding,
  ClashExitNode,
  ClashOutboundTestResponse,
  ClashRuntimeStatus,
  ClashSubscription,
  ClientHelloPreset,
  TlsProfile,
  UpstreamAccount,
} from "@slipgate/contracts";
import { useAuthStore } from "../../stores/auth";

const auth = useAuthStore();

interface ClashOverviewPayload {
  runtime: ClashRuntimeStatus;
  subscriptions: ClashSubscription[];
  nodes: ClashExitNode[];
  bindings: AccountExitBinding[];
  profiles: TlsProfile[];
  policy: {
    maxAccountsPerExitIp: number;
    failClosed: boolean;
    dropGuardThreshold: number;
  };
}

const loading = ref(false);
const busyAction = ref(false);
const errorMessage = ref<string | null>(null);
const actionNotice = ref<string | null>(null);

const runtime = ref<ClashRuntimeStatus | null>(null);
const subscriptions = ref<ClashSubscription[]>([]);
const nodes = ref<ClashExitNode[]>([]);
const bindings = ref<AccountExitBinding[]>([]);
const profiles = ref<TlsProfile[]>([]);
const accounts = ref<UpstreamAccount[]>([]);

// Subscription form
const subName = ref("");
const subKind = ref<"url" | "inline">("url");
const subSource = ref("");
const subExclude = ref("剩余流量|到期时间|官网");

// Account <-> Exit binding form
const bindAccountId = ref("");
const bindNodeId = ref("");
const bindProfileId = ref("chrome-131");
const bindShadow = ref(false);

// Outbound test target & result
const testTargetUrl = ref("https://api.ipify.org?format=json");
const outboundResult = ref<ClashOutboundTestResponse | null>(null);

// Custom TLS Profile form
const tlsName = ref("");
const tlsPreset = ref<ClientHelloPreset>("chrome_auto");
const tlsAlpnRaw = ref("h2,http/1.1");
const tlsUA = ref("");
const tlsJA3 = ref("");

async function loadOverview() {
  loading.value = true;
  errorMessage.value = null;
  try {
    const [ovRes, accRes] = await Promise.all([
      auth.apiFetch("/api/v1/admin/clash/overview"),
      auth.apiFetch("/api/v1/admin/accounts"),
    ]);
    if (ovRes.ok) {
      const ov = (await ovRes.json()) as ClashOverviewPayload;
      runtime.value = ov.runtime;
      subscriptions.value = ov.subscriptions ?? [];
      nodes.value = ov.nodes ?? [];
      bindings.value = ov.bindings ?? [];
      profiles.value = ov.profiles ?? [];
      if (!bindNodeId.value && nodes.value.length > 0) {
        const firstHealthy = nodes.value.find((n) => n.healthStatus === "healthy") ?? nodes.value[0];
        if (firstHealthy) {
          bindNodeId.value = firstHealthy.nodeId;
        }
      }
    }
    if (accRes.ok) {
      const accBody = (await accRes.json()) as { accounts: UpstreamAccount[] };
      accounts.value = accBody.accounts ?? [];
      if (!bindAccountId.value && accounts.value.length > 0 && accounts.value[0]) {
        bindAccountId.value = accounts.value[0].id;
      }
    }
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "加载 Clash 出口池失败";
  } finally {
    loading.value = false;
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { message?: string; error?: string };
    return data.message ?? data.error ?? fallback;
  } catch {
    return fallback;
  }
}

async function createSubscription() {
  busyAction.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/clash/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: subName.value,
        sourceKind: subKind.value,
        sourceUrl: subSource.value,
        excludeRegex: subExclude.value,
        autoSync: true,
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "添加并同步订阅失败");
      return;
    }
    subName.value = "";
    subSource.value = "";
    actionNotice.value = "订阅已保存并完成 mihomo 配置下发";
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function syncSubscription(subId: string, force = false) {
  busyAction.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/subscriptions/${encodeURIComponent(subId)}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "同步订阅失败");
      return;
    }
    actionNotice.value = force ? "已完成强制同步并重载 mihomo" : "已完成订阅同步";
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function deleteSubscription(subId: string) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/subscriptions/${encodeURIComponent(subId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "删除订阅失败");
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function probeNodes(nodeIds: string[]) {
  busyAction.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/clash/nodes/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeIds, verifyExitIp: true }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "节点测速与 IP 核验失败");
      return;
    }
    actionNotice.value = "已完成延迟探测与独立出口 IP 核验";
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function confirmDrift(nodeId: string) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/nodes/${encodeURIComponent(nodeId)}/confirm-drift`, {
      method: "POST",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "确认漂移失败");
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function toggleNodeEnabled(node: ClashExitNode) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const nextEnabled = !(node.enabled ?? true);
    const res = await auth.apiFetch(`/api/v1/admin/clash/nodes/${encodeURIComponent(node.nodeId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: nextEnabled }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "切换节点状态失败");
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function bindAccount() {
  busyAction.value = true;
  errorMessage.value = null;
  actionNotice.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/clash/bindings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId: bindAccountId.value,
        nodeId: bindNodeId.value,
        utlsProfileId: bindProfileId.value || undefined,
        isShadowFollower: bindShadow.value,
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "绑定独立出口失败");
      return;
    }
    actionNotice.value = "已绑定账号独立出口与 uTLS 指纹模板";
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function unbindAccount(accountId: string) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/clash/bindings/${encodeURIComponent(accountId)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "解绑失败");
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function runOutboundTest(accountId: string, utlsProfileId?: string) {
  busyAction.value = true;
  errorMessage.value = null;
  outboundResult.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/clash/test-outbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        utlsProfileId: utlsProfileId || undefined,
        targetUrl: testTargetUrl.value || undefined,
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "uTLS 出站实测失败");
      return;
    }
    outboundResult.value = (await res.json()) as ClashOutboundTestResponse;
  } finally {
    busyAction.value = false;
  }
}

async function createTlsProfile() {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const alpns = tlsAlpnRaw.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const res = await auth.apiFetch("/api/v1/admin/tls-profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: tlsName.value,
        clientHelloPreset: tlsPreset.value,
        alpnProtocols: alpns.length > 0 ? alpns : ["h2", "http/1.1"],
        userAgentTemplate: tlsUA.value,
        ja3Fingerprint: tlsJA3.value,
      }),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "创建 uTLS 模板失败");
      return;
    }
    tlsName.value = "";
    tlsUA.value = "";
    tlsJA3.value = "";
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

async function deleteTlsProfile(id: string) {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const res = await auth.apiFetch(`/api/v1/admin/tls-profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, "删除 uTLS 模板失败");
      return;
    }
    await loadOverview();
  } finally {
    busyAction.value = false;
  }
}

onMounted(() => {
  void loadOverview();
});
</script>

<template>
  <div class="space-y-6">
    <!-- Embedded mihomo Runtime Header -->
    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="flex items-center gap-2">
            <h2 class="text-base font-semibold text-white">Clash (mihomo) 独立出口内核</h2>
            <span
              :class="
                runtime?.ready
                  ? 'border-emerald-500/30 bg-emerald-500/15 text-emerald-300'
                  : 'border-amber-500/30 bg-amber-500/15 text-amber-300'
              "
              class="rounded-full border px-2.5 py-0.5 text-xs font-medium"
            >
              {{ runtime?.ready ? "EMBEDDED READY" : runtime?.mode ?? "UNKNOWN" }}
            </span>
          </div>
          <p class="mt-1 font-mono text-xs text-slate-400">
            内核版本: {{ runtime?.version || "-" }} · 监听槽位: {{ runtime?.activeListeners ?? 0 }} ·
            活跃节点: {{ runtime?.activeProxies ?? 0 }} ·
            配置摘要: {{ runtime?.configHash ? runtime.configHash.slice(0, 12) : "-" }} ·
            策略: Fail-Closed (MATCH,REJECT · 1 号 1 IP)
          </p>
        </div>
        <div class="flex items-center gap-2">
          <button
            type="button"
            :disabled="busyAction"
            class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-medium text-slate-200 hover:border-sky-500 disabled:opacity-50"
            @click="loadOverview"
          >
            刷新状态
          </button>
          <button
            type="button"
            :disabled="busyAction || nodes.length === 0"
            class="rounded-lg bg-sky-500 px-3 py-2 text-xs font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-50"
            @click="probeNodes([])"
          >
            全部节点测速 + IP 核验
          </button>
        </div>
      </div>
      <p v-if="errorMessage" class="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
        {{ errorMessage }}
      </p>
      <p v-if="actionNotice" class="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300">
        {{ actionNotice }}
      </p>
    </section>

    <!-- Subscriptions -->
    <section class="grid gap-6 md:grid-cols-5">
      <form
        class="space-y-3 rounded-xl border border-slate-800 bg-slate-900 p-6 md:col-span-2"
        @submit.prevent="createSubscription"
      >
        <h3 class="text-sm font-semibold text-white">添加 Clash 订阅源</h3>
        <input
          v-model="subName"
          type="text"
          required
          placeholder="订阅名称（如 Tokyo-ISP）"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white focus:border-sky-500 focus:outline-none"
        />
        <select
          v-model="subKind"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
        >
          <option value="url">远程订阅 URL（Clash YAML / Base64 / URI）</option>
          <option value="inline">内联配置（直接粘贴 Clash YAML / 分享链接）</option>
        </select>
        <input
          v-if="subKind === 'url'"
          v-model="subSource"
          type="url"
          required
          placeholder="https://example.com/sub?token=..."
          class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white focus:border-sky-500 focus:outline-none"
        />
        <textarea
          v-else
          v-model="subSource"
          rows="4"
          required
          placeholder="proxies:&#10;  - name: Tokyo-01&#10;    type: socks5&#10;    server: 203.0.113.10&#10;    port: 1080"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white focus:border-sky-500 focus:outline-none"
        />
        <input
          v-model="subExclude"
          type="text"
          placeholder="过滤正则（如 剩余流量|到期时间|官网）"
          class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
        />
        <button
          type="submit"
          :disabled="busyAction"
          class="w-full rounded-lg bg-sky-500 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-50"
        >
          保存并下发至 mihomo
        </button>
      </form>

      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6 md:col-span-3">
        <h3 class="text-sm font-semibold text-white">已接入订阅（50% 骤降保护）</h3>
        <div class="mt-4 space-y-2.5">
          <p v-if="!loading && subscriptions.length === 0" class="text-xs text-slate-400">
            暂未添加 Clash 订阅，请在左侧添加远程订阅 URL 或粘贴节点配置。
          </p>
          <div
            v-for="sub in subscriptions"
            :key="sub.id"
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs"
          >
            <div>
              <p class="font-medium text-white">
                {{ sub.name }}
                <span class="ml-2 rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                  {{ sub.sourceKind }}
                </span>
              </p>
              <p class="mt-1 font-mono text-slate-400">
                状态: {{ sub.lastSyncStatus }} · 节点数: {{ sub.lastNodeCount }}
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded border border-slate-700 px-2.5 py-1 text-slate-200 hover:border-sky-500"
                @click="syncSubscription(sub.id, false)"
              >
                同步
              </button>
              <button
                type="button"
                class="rounded border border-amber-500/40 px-2.5 py-1 text-amber-300 hover:bg-amber-500/10"
                @click="syncSubscription(sub.id, true)"
              >
                强制同步
              </button>
              <button
                type="button"
                class="rounded border border-rose-500/40 px-2.5 py-1 text-rose-300 hover:bg-rose-500/10"
                @click="deleteSubscription(sub.id)"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Materialized Exit Nodes -->
    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-semibold text-white">独立本地 SOCKS5 监听池（{{ nodes.length }} 个槽位）</h3>
        <span class="font-mono text-xs text-slate-400">每槽独占 127.0.0.1:port + 随机凭证</span>
      </div>
      <div class="mt-4 overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="border-b border-slate-800 text-slate-400">
            <tr>
              <th class="py-2 pr-3">节点名称</th>
              <th class="py-2 pr-3">协议 / 上游</th>
              <th class="py-2 pr-3">本地监听</th>
              <th class="py-2 pr-3">真实出口 IP</th>
              <th class="py-2 pr-3">延迟 / 健康</th>
              <th class="py-2 pr-3">绑定占用</th>
              <th class="py-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800/70">
            <tr v-for="n in nodes" :key="n.nodeId" class="text-slate-200">
              <td class="py-2.5 pr-3 font-medium text-white">{{ n.name }}</td>
              <td class="py-2.5 pr-3 font-mono text-slate-400">
                {{ n.proxyType || "-" }} · {{ n.server || "-" }}:{{ n.serverPort || "-" }}
              </td>
              <td class="py-2.5 pr-3 font-mono text-sky-300">127.0.0.1:{{ n.listenerPort }}</td>
              <td class="py-2.5 pr-3 font-mono">
                {{ n.exitIp || "待探测" }}
                <span
                  v-if="n.driftUnconfirmed"
                  class="ml-1 rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] text-rose-300"
                >
                  IP漂移熔断
                </span>
              </td>
              <td class="py-2.5 pr-3 font-mono">
                {{ n.latencyMs }}ms ·
                <span :class="n.healthStatus === 'healthy' ? 'text-emerald-300' : 'text-amber-300'">
                  {{ n.healthStatus }}
                </span>
              </td>
              <td class="py-2.5 pr-3 font-mono">{{ n.boundAccounts }}/{{ n.maxAccounts }}</td>
              <td class="py-2.5 text-right">
                <div class="inline-flex gap-1.5">
                  <button
                    type="button"
                    class="rounded border border-slate-700 px-2 py-1 hover:border-sky-500"
                    @click="probeNodes([n.nodeId])"
                  >
                    探测
                  </button>
                  <button
                    v-if="n.driftUnconfirmed"
                    type="button"
                    class="rounded border border-amber-500/50 px-2 py-1 text-amber-300"
                    @click="confirmDrift(n.nodeId)"
                  >
                    确认漂移
                  </button>
                  <button
                    type="button"
                    class="rounded border border-slate-700 px-2 py-1"
                    @click="toggleNodeEnabled(n)"
                  >
                    {{ (n.enabled ?? true) ? "停用" : "启用" }}
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Bindings & Live uTLS Outbound Verification -->
    <section class="grid gap-6 md:grid-cols-2">
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h3 class="text-sm font-semibold text-white">账号 ↔ 独立出口 + uTLS 指纹绑定</h3>
        <form class="mt-4 space-y-3" @submit.prevent="bindAccount">
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="text-xs text-slate-400">账号 ID</label>
              <input
                v-model="bindAccountId"
                list="slipgate-account-ids"
                required
                placeholder="输入或选择账号 ID"
                class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
              />
              <datalist id="slipgate-account-ids">
                <option v-for="acc in accounts" :key="acc.id" :value="acc.id">
                  {{ acc.name }} ({{ acc.platform }})
                </option>
              </datalist>
            </div>
            <div>
              <label class="text-xs text-slate-400">Clash 出口槽位</label>
              <select
                v-model="bindNodeId"
                required
                class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              >
                <option v-for="n in nodes" :key="n.nodeId" :value="n.nodeId">
                  {{ n.name }} ({{ n.exitIp || "未探测" }} · {{ n.healthStatus }})
                </option>
              </select>
            </div>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="text-xs text-slate-400">uTLS ClientHello 指纹模板</label>
              <select
                v-model="bindProfileId"
                class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
              >
                <option v-for="p in profiles" :key="p.id" :value="p.id">
                  {{ p.name }} ({{ p.alpnProtocols.join(",") }})
                </option>
              </select>
            </div>
            <label class="mt-5 flex items-center gap-2 text-xs text-slate-300">
              <input v-model="bindShadow" type="checkbox" class="rounded border-slate-700 bg-slate-950" />
              影子跟随号（允许复用到同一 Exit IP）
            </label>
          </div>
          <button
            type="submit"
            :disabled="busyAction"
            class="w-full rounded-lg bg-emerald-500 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            绑定账号独立出口
          </button>
        </form>

        <div class="mt-5 space-y-2">
          <div class="flex items-center gap-2">
            <span class="text-xs text-slate-400">测试目标:</span>
            <input
              v-model="testTargetUrl"
              type="url"
              class="flex-1 rounded border border-slate-700 bg-slate-950 px-2.5 py-1 font-mono text-xs text-slate-200"
            />
          </div>
          <div
            v-for="b in bindings"
            :key="b.accountId"
            class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs"
          >
            <div>
              <p class="font-mono text-white">
                {{ b.accountId }} → {{ b.nodeId }}
              </p>
              <p class="font-mono text-slate-400">
                IP: {{ b.boundExitIp || "-" }} · uTLS: {{ b.utlsProfileId || "chrome-131" }}
                {{ b.isShadowFollower ? " · Shadow" : "" }}
              </p>
            </div>
            <div class="flex gap-1.5">
              <button
                type="button"
                class="rounded bg-sky-500/20 px-2.5 py-1 text-sky-300 hover:bg-sky-500/30"
                @click="runOutboundTest(b.accountId, b.utlsProfileId)"
              >
                实测 uTLS 出站
              </button>
              <button
                type="button"
                class="rounded border border-rose-500/40 px-2.5 py-1 text-rose-300"
                @click="unbindAccount(b.accountId)"
              >
                解绑
              </button>
            </div>
          </div>
        </div>

        <div
          v-if="outboundResult"
          class="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 font-mono text-xs text-emerald-200"
        >
          <p>
            HTTP {{ outboundResult.statusCode }} · {{ outboundResult.tlsVersion }} · ALPN={{ outboundResult.negotiatedAlpn || "http/1.1" }} ·
            Exit={{ outboundResult.exitIp }} ({{ outboundResult.latencyMs }}ms)
          </p>
          <p class="mt-1 truncate text-slate-300">{{ outboundResult.bodySnippet }}</p>
        </div>
      </div>

      <!-- uTLS Profiles -->
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h3 class="text-sm font-semibold text-white">uTLS ClientHello 指纹模板</h3>
        <form class="mt-4 space-y-3" @submit.prevent="createTlsProfile">
          <div class="grid gap-3 sm:grid-cols-2">
            <input
              v-model="tlsName"
              type="text"
              required
              placeholder="模板名称（如 Edge-Win11）"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            />
            <select
              v-model="tlsPreset"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
            >
              <option value="chrome_auto">chrome_auto</option>
              <option value="firefox_auto">firefox_auto</option>
              <option value="safari_auto">safari_auto</option>
              <option value="ios_auto">ios_auto</option>
              <option value="edge_auto">edge_auto</option>
              <option value="claude_cli">claude_cli</option>
            </select>
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <input
              v-model="tlsAlpnRaw"
              type="text"
              placeholder="ALPN（如 h2,http/1.1）"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
            />
            <input
              v-model="tlsJA3"
              type="text"
              placeholder="备注 JA3 摘要（可选）"
              class="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
            />
          </div>
          <input
            v-model="tlsUA"
            type="text"
            placeholder="User-Agent 模板（可选）"
            class="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
          />
          <button
            type="submit"
            :disabled="busyAction"
            class="w-full rounded-lg border border-sky-500/40 bg-sky-500/15 py-2 text-xs font-medium text-sky-300 hover:bg-sky-500/25"
          >
            新增自定义指纹模板
          </button>
        </form>

        <div class="mt-4 space-y-2">
          <div
            v-for="p in profiles"
            :key="p.id"
            class="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs"
          >
            <div>
              <p class="font-medium text-white">
                {{ p.name }}
                <span class="ml-1 font-mono text-slate-400">({{ p.id }})</span>
              </p>
              <p class="mt-0.5 font-mono text-slate-400">
                Preset: {{ p.clientHelloPreset }} · ALPN: {{ p.alpnProtocols.join(", ") }}
              </p>
            </div>
            <span
              v-if="p.builtIn"
              class="rounded bg-slate-800 px-2 py-0.5 text-[11px] text-slate-300"
            >
              内置
            </span>
            <button
              v-else
              type="button"
              class="rounded border border-rose-500/40 px-2 py-1 text-rose-300"
              @click="deleteTlsProfile(p.id)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
