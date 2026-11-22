<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import FormField from "../../components/ui/FormField.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import SegmentedControl from "../../components/ui/SegmentedControl.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiDrawer from "../../components/ui/UiDrawer.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiSwitch from "../../components/ui/UiSwitch.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import { HEALTH_LABEL, healthTone, shortHash } from "../../lib/format";
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

type TabKey = "nodes" | "subscriptions" | "bindings" | "profiles";

const loading = ref(false);
const busyAction = ref(false);
const errorMessage = ref<string | null>(null);
const actionNotice = ref<string | null>(null);
const activeTab = ref<TabKey>("nodes");
const subDrawerOpen = ref(false);
const tlsDrawerOpen = ref(false);

useFeedbackToasts(errorMessage, actionNotice);

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

// Custom TLS Profile form (supports wire-level linksyncx parameters & PUT updates)
const editingProfileId = ref<string | null>(null);
const tlsName = ref("");
const tlsPreset = ref<ClientHelloPreset>("claude_bun_21");
const tlsAlpnRaw = ref("h2,http/1.1");
const tlsUA = ref("");
const tlsJA3 = ref("");
const tlsOsHint = ref("");
const tlsEnableGrease = ref(false);
const tlsCiphersRaw = ref("");
const tlsCurvesRaw = ref("");
const tlsKeySharesRaw = ref("");
const tlsExtensionsRaw = ref("");

const healthyCount = computed(() => nodes.value.filter((n) => n.healthStatus === "healthy").length);
const driftCount = computed(() => nodes.value.filter((n) => n.driftUnconfirmed).length);
const accountNameById = computed(() => new Map(accounts.value.map((a) => [a.id, a.name])));
const nodeNameById = computed(() => new Map(nodes.value.map((n) => [n.nodeId, n.name])));

const tabs = computed(() => [
  { key: "nodes" as const, label: "出口节点", count: nodes.value.length, icon: "radar" as const },
  { key: "subscriptions" as const, label: "订阅源", count: subscriptions.value.length, icon: "download" as const },
  { key: "bindings" as const, label: "账号绑定", count: bindings.value.length, icon: "link" as const },
  { key: "profiles" as const, label: "uTLS 模板", count: profiles.value.length, icon: "fingerprint" as const },
]);

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
    const data = (await res.json()) as {
      message?: string;
      error?: string;
      reason?: string;
      field?: string;
      group?: number;
    };
    const base = data.message ?? data.error ?? fallback;
    if (data.reason) {
      const fieldInfo = data.field ? ` (${data.field})` : "";
      return `[${data.reason}]${fieldInfo}: ${base}`;
    }
    return base;
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
    subDrawerOpen.value = false;
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

function parseUint16Csv(raw: string): number[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((token) => (token.startsWith("0x") || token.startsWith("0X") ? parseInt(token, 16) : parseInt(token, 10)))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 65535);
}

function fillClaudeBunWirePreset() {
  tlsPreset.value = "custom_wire";
  tlsOsHint.value = "linux";
  tlsEnableGrease.value = false;
  tlsAlpnRaw.value = "h2,http/1.1";
  tlsUA.value = "claude-cli/2.1.280 (external, cli)";
  tlsCurvesRaw.value = "4588,29,23,24";
  tlsKeySharesRaw.value = "4588,29";
  tlsExtensionsRaw.value = "0,23,65281,10,11,35,16,5,13,18,51,45,43";
}

function resetTlsForm() {
  editingProfileId.value = null;
  tlsName.value = "";
  tlsPreset.value = "claude_bun_21";
  tlsAlpnRaw.value = "h2,http/1.1";
  tlsUA.value = "";
  tlsJA3.value = "";
  tlsOsHint.value = "";
  tlsEnableGrease.value = false;
  tlsCiphersRaw.value = "";
  tlsCurvesRaw.value = "";
  tlsKeySharesRaw.value = "";
  tlsExtensionsRaw.value = "";
}

function openCreateTlsProfile() {
  resetTlsForm();
  tlsDrawerOpen.value = true;
}

function startEditTlsProfile(p: TlsProfile) {
  editingProfileId.value = p.id;
  tlsName.value = p.name;
  tlsPreset.value = p.clientHelloPreset as ClientHelloPreset;
  tlsAlpnRaw.value = (p.alpnProtocols ?? ["h2", "http/1.1"]).join(",");
  tlsUA.value = p.userAgentTemplate ?? "";
  tlsJA3.value = p.ja3Fingerprint ?? "";
  tlsOsHint.value = p.osHint ?? "";
  tlsEnableGrease.value = Boolean(p.enableGrease);
  tlsCiphersRaw.value = (p.cipherSuites ?? []).join(",");
  tlsCurvesRaw.value = (p.curves ?? []).join(",");
  tlsKeySharesRaw.value = (p.keyShareGroups ?? []).join(",");
  tlsExtensionsRaw.value = (p.extensions ?? []).join(",");
  tlsDrawerOpen.value = true;
}

async function saveTlsProfile() {
  busyAction.value = true;
  errorMessage.value = null;
  try {
    const alpns = tlsAlpnRaw.value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const body = {
      name: tlsName.value,
      clientHelloPreset: tlsPreset.value,
      alpnProtocols: alpns.length > 0 ? alpns : ["h2", "http/1.1"],
      userAgentTemplate: tlsUA.value,
      ja3Fingerprint: tlsJA3.value,
      osHint: tlsOsHint.value.trim(),
      enableGrease: tlsEnableGrease.value,
      cipherSuites: parseUint16Csv(tlsCiphersRaw.value),
      curves: parseUint16Csv(tlsCurvesRaw.value),
      keyShareGroups: parseUint16Csv(tlsKeySharesRaw.value),
      extensions: parseUint16Csv(tlsExtensionsRaw.value),
    };
    const isEdit = Boolean(editingProfileId.value);
    const url = isEdit
      ? `/api/v1/admin/tls-profiles/${encodeURIComponent(editingProfileId.value!)}`
      : "/api/v1/admin/tls-profiles";
    const res = await auth.apiFetch(url, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      errorMessage.value = await readError(res, isEdit ? "更新 uTLS 模板失败" : "创建 uTLS 模板失败");
      return;
    }
    resetTlsForm();
    tlsDrawerOpen.value = false;
    actionNotice.value = isEdit ? "uTLS 模板已更新" : "uTLS 模板已创建";
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
    <PageHeader
      title="Clash 出口与 uTLS"
      description="内嵌 mihomo 为每个账号提供独占的本地 SOCKS5 监听与出口 IP，策略 Fail-Closed（MATCH,REJECT · 1 号 1 IP）。"
    >
      <template #meta>
        <UiBadge :tone="runtime?.ready ? 'success' : 'warning'" dot :pulse="runtime?.ready">
          {{ runtime?.ready ? "内核就绪" : runtime?.mode ?? "状态未知" }}
        </UiBadge>
        <span class="code-chip">mihomo {{ runtime?.version || "-" }}</span>
        <span class="code-chip">config {{ shortHash(runtime?.configHash) }}</span>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading || busyAction" @click="loadOverview">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          刷新
        </button>
        <button type="button" class="btn btn-primary" :disabled="busyAction || nodes.length === 0" @click="probeNodes([])">
          <UiIcon :name="busyAction ? 'loader' : 'radar'" :size="15" :spin="busyAction" />
          全部测速 + IP 核验
        </button>
      </template>
    </PageHeader>

    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard label="监听槽位" :value="runtime?.activeListeners ?? 0" icon="plug" tone="accent" hint="每槽独占 127.0.0.1:port" />
      <StatCard label="健康节点" :value="`${healthyCount} / ${nodes.length}`" icon="radar" tone="success" />
      <StatCard
        label="出口 IP 漂移待确认"
        :value="driftCount"
        icon="alert"
        :tone="driftCount > 0 ? 'danger' : 'neutral'"
        hint="未确认前对应槽位熔断"
      />
      <StatCard label="账号绑定" :value="bindings.length" icon="link" tone="info" :hint="`活跃代理 ${runtime?.activeProxies ?? 0}`" />
    </div>

    <div class="card">
      <UiTabs v-model="activeTab" :tabs="tabs" class="px-3" />

      <!-- Nodes -->
      <div v-if="activeTab === 'nodes'">
        <EmptyState
          v-if="nodes.length === 0"
          icon="radar"
          title="还没有出口节点"
          description="添加 Clash 订阅后，mihomo 会为每个节点生成独立的本地监听槽位。"
        >
          <button type="button" class="btn btn-primary btn-sm" @click="activeTab = 'subscriptions'; subDrawerOpen = true">
            <UiIcon name="plus" :size="14" />
            添加订阅
          </button>
        </EmptyState>
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>节点</th>
                <th>协议 / 上游</th>
                <th>本地监听</th>
                <th>出口 IP</th>
                <th>延迟 / 健康</th>
                <th>绑定</th>
                <th>启用</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="n in nodes" :key="n.nodeId" :class="(n.enabled ?? true) ? '' : 'opacity-60'">
                <td class="max-w-[14rem]">
                  <p class="truncate font-medium text-fg">{{ n.name }}</p>
                  <p v-if="n.lastError" class="mt-0.5 truncate text-2xs text-danger" :title="n.lastError">{{ n.lastError }}</p>
                </td>
                <td class="whitespace-nowrap font-mono text-xs text-fg-muted">
                  {{ n.proxyType || "-" }} · {{ n.server || "-" }}:{{ n.serverPort || "-" }}
                </td>
                <td><span class="code-chip">127.0.0.1:{{ n.listenerPort }}</span></td>
                <td class="whitespace-nowrap">
                  <span class="font-mono text-xs" :class="n.exitIp ? 'text-fg' : 'text-fg-subtle'">{{ n.exitIp || "待探测" }}</span>
                  <UiBadge v-if="n.driftUnconfirmed" tone="danger" class="ml-1.5">漂移熔断</UiBadge>
                </td>
                <td class="whitespace-nowrap">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-xs tabular-nums text-fg-muted">{{ n.latencyMs }}ms</span>
                    <UiBadge :tone="healthTone(n.healthStatus)" dot>{{ HEALTH_LABEL[n.healthStatus] ?? n.healthStatus }}</UiBadge>
                  </div>
                </td>
                <td class="font-mono text-xs tabular-nums">{{ n.boundAccounts }}/{{ n.maxAccounts }}</td>
                <td>
                  <UiSwitch
                    :model-value="n.enabled ?? true"
                    :disabled="busyAction"
                    :label="(n.enabled ?? true) ? '停用节点' : '启用节点'"
                    hide-label
                    @update:model-value="toggleNodeEnabled(n)"
                  />
                </td>
                <td class="text-right">
                  <div class="inline-flex gap-1">
                    <button
                      v-if="n.driftUnconfirmed"
                      type="button"
                      class="btn btn-xs bg-warning/10 text-warning hover:bg-warning/20"
                      :disabled="busyAction"
                      @click="confirmDrift(n.nodeId)"
                    >
                      确认漂移
                    </button>
                    <button type="button" class="btn btn-ghost btn-xs" :disabled="busyAction" @click="probeNodes([n.nodeId])">
                      <UiIcon name="radar" :size="13" />
                      探测
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Subscriptions -->
      <div v-else-if="activeTab === 'subscriptions'">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <p class="text-xs text-fg-subtle">同步时节点数骤降超过 50% 会被拦截（骤降保护），可用「强制同步」覆盖。</p>
          <button type="button" class="btn btn-primary btn-sm" @click="subDrawerOpen = true">
            <UiIcon name="plus" :size="14" />
            添加订阅
          </button>
        </div>
        <EmptyState
          v-if="!loading && subscriptions.length === 0"
          icon="download"
          title="暂未接入订阅"
          description="支持远程订阅 URL（Clash YAML / Base64 / URI）或直接粘贴节点配置。"
        />
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>来源</th>
                <th>同步状态</th>
                <th class="text-right">节点数</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="sub in subscriptions" :key="sub.id">
                <td class="font-medium text-fg">{{ sub.name }}</td>
                <td><UiBadge mono>{{ sub.sourceKind }}</UiBadge></td>
                <td>
                  <UiBadge :tone="healthTone(sub.lastSyncStatus)" dot>{{ sub.lastSyncStatus }}</UiBadge>
                </td>
                <td class="text-right font-mono text-xs tabular-nums">{{ sub.lastNodeCount }}</td>
                <td class="text-right">
                  <div class="inline-flex gap-1">
                    <button type="button" class="btn btn-ghost btn-xs" :disabled="busyAction" @click="syncSubscription(sub.id, false)">
                      <UiIcon name="refresh" :size="13" />
                      同步
                    </button>
                    <button
                      type="button"
                      class="btn btn-xs text-warning hover:bg-warning/10"
                      :disabled="busyAction"
                      @click="syncSubscription(sub.id, true)"
                    >
                      强制同步
                    </button>
                    <ConfirmButton icon-only :disabled="busyAction" @confirm="deleteSubscription(sub.id)" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Bindings -->
      <div v-else-if="activeTab === 'bindings'" class="grid gap-0 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <form class="space-y-4 border-b border-line p-5 lg:border-b-0 lg:border-r" @submit.prevent="bindAccount">
          <div>
            <h3 class="text-sm font-semibold text-fg">绑定独立出口</h3>
            <p class="mt-0.5 text-xs text-fg-subtle">为账号指定出口槽位与 uTLS ClientHello 模板</p>
          </div>
          <FormField label="账号 ID" required>
            <input
              v-model="bindAccountId"
              list="slipgate-account-ids"
              required
              placeholder="输入或选择账号 ID"
              class="input font-mono text-xs"
            />
            <datalist id="slipgate-account-ids">
              <option v-for="acc in accounts" :key="acc.id" :value="acc.id">{{ acc.name }} ({{ acc.platform }})</option>
            </datalist>
          </FormField>
          <FormField label="出口槽位" required>
            <select v-model="bindNodeId" required class="select">
              <option v-for="n in nodes" :key="n.nodeId" :value="n.nodeId">
                {{ n.name }}（{{ n.exitIp || "未探测" }} · {{ HEALTH_LABEL[n.healthStatus] ?? n.healthStatus }}）
              </option>
            </select>
          </FormField>
          <FormField label="uTLS 指纹模板">
            <select v-model="bindProfileId" class="select">
              <option v-for="p in profiles" :key="p.id" :value="p.id">{{ p.name }}（{{ p.alpnProtocols.join(",") }}）</option>
            </select>
          </FormField>
          <label class="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5">
            <input v-model="bindShadow" type="checkbox" class="checkbox mt-0.5" />
            <span>
              <span class="block text-sm text-fg">影子跟随号</span>
              <span class="block text-xs text-fg-subtle">允许与主号复用同一出口 IP</span>
            </span>
          </label>
          <button type="submit" :disabled="busyAction" class="btn btn-primary w-full">
            <UiIcon name="link" :size="14" />
            绑定出口
          </button>
        </form>

        <div class="min-w-0">
          <div class="flex flex-col gap-2 border-b border-line px-5 py-3 sm:flex-row sm:items-center">
            <span class="shrink-0 text-xs text-fg-subtle">出站实测目标</span>
            <input v-model="testTargetUrl" type="url" class="input input-sm font-mono" aria-label="出站实测目标 URL" />
          </div>

          <div
            v-if="outboundResult"
            class="m-5 mb-0 animate-fade-in overflow-hidden rounded-lg border border-success/30"
          >
            <div class="flex flex-wrap items-center gap-2 bg-success/[0.08] px-3.5 py-2 text-xs">
              <UiIcon name="check-circle" :size="14" class="text-success" />
              <span class="font-medium text-success">出站成功</span>
              <UiBadge tone="success" mono>HTTP {{ outboundResult.statusCode }}</UiBadge>
              <UiBadge mono>{{ outboundResult.tlsVersion }}</UiBadge>
              <UiBadge mono>ALPN {{ outboundResult.negotiatedAlpn || "http/1.1" }}</UiBadge>
              <span class="ml-auto font-mono text-fg-muted">{{ outboundResult.exitIp }} · {{ outboundResult.latencyMs }}ms</span>
            </div>
            <pre class="max-h-28 overflow-auto whitespace-pre-wrap break-all bg-surface-2/50 px-3.5 py-2.5 font-mono text-2xs text-fg-muted">{{ outboundResult.bodySnippet }}</pre>
          </div>

          <EmptyState v-if="bindings.length === 0" compact icon="link" title="暂无绑定" description="在左侧为账号绑定出口槽位。" />
          <div v-else class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>账号</th>
                  <th>出口槽位</th>
                  <th>出口 IP</th>
                  <th>uTLS</th>
                  <th class="text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in bindings" :key="b.accountId">
                  <td class="max-w-[12rem]">
                    <p class="truncate text-sm text-fg">{{ accountNameById.get(b.accountId) ?? b.accountId }}</p>
                    <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{{ b.accountId }}</p>
                  </td>
                  <td class="max-w-[10rem] truncate text-xs text-fg-muted">{{ nodeNameById.get(b.nodeId) ?? b.nodeId }}</td>
                  <td class="whitespace-nowrap font-mono text-xs">
                    {{ b.boundExitIp || "-" }}
                    <UiBadge v-if="b.isShadowFollower" tone="violet" class="ml-1">Shadow</UiBadge>
                  </td>
                  <td><span class="code-chip">{{ b.utlsProfileId || "chrome-131" }}</span></td>
                  <td class="text-right">
                    <div class="inline-flex gap-1">
                      <button
                        type="button"
                        class="btn btn-ghost btn-xs"
                        :disabled="busyAction"
                        @click="runOutboundTest(b.accountId, b.utlsProfileId)"
                      >
                        <UiIcon name="zap" :size="13" />
                        实测
                      </button>
                      <ConfirmButton label="解绑" confirm-label="确认解绑" icon="unlink" icon-only :disabled="busyAction" @confirm="unbindAccount(b.accountId)" />
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- TLS profiles -->
      <div v-else>
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <p class="text-xs text-fg-subtle">内置模板只读；自定义模板支持线级参数（Curves / KeyShare / Extensions）。</p>
          <button type="button" class="btn btn-primary btn-sm" @click="openCreateTlsProfile">
            <UiIcon name="plus" :size="14" />
            新建模板
          </button>
        </div>
        <EmptyState v-if="profiles.length === 0" icon="fingerprint" title="暂无 uTLS 模板" />
        <div v-else class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>模板</th>
                <th>Preset</th>
                <th>ALPN</th>
                <th>KeyShare</th>
                <th>类型</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in profiles" :key="p.id">
                <td>
                  <p class="flex items-center gap-1.5 font-medium text-fg">
                    {{ p.name }}
                    <UiBadge v-if="p.enableGrease" tone="success">GREASE</UiBadge>
                  </p>
                  <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ p.id }}</p>
                </td>
                <td><span class="code-chip">{{ p.clientHelloPreset }}</span></td>
                <td class="font-mono text-xs text-fg-muted">{{ p.alpnProtocols.join(", ") }}</td>
                <td class="font-mono text-xs text-fg-muted">
                  {{ p.keyShareGroups && p.keyShareGroups.length > 0 ? p.keyShareGroups.join(",") : "-" }}
                </td>
                <td>
                  <UiBadge :tone="p.builtIn ? 'neutral' : 'accent'">{{ p.builtIn ? "内置" : "自定义" }}</UiBadge>
                </td>
                <td class="text-right">
                  <div v-if="!p.builtIn" class="inline-flex gap-1">
                    <button type="button" class="btn btn-ghost btn-xs" @click="startEditTlsProfile(p)">
                      <UiIcon name="pencil" :size="13" />
                      编辑
                    </button>
                    <ConfirmButton icon-only :disabled="busyAction" @confirm="deleteTlsProfile(p.id)" />
                  </div>
                  <span v-else class="text-2xs text-fg-subtle">只读</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Add subscription drawer -->
    <UiDrawer v-model:open="subDrawerOpen" title="添加 Clash 订阅源" description="保存后立即解析并下发至内嵌 mihomo">
      <form id="create-sub-form" class="space-y-4" @submit.prevent="createSubscription">
        <FormField label="订阅名称" required>
          <input v-model="subName" type="text" required placeholder="如 Tokyo-ISP" class="input" />
        </FormField>
        <div>
          <span class="label">来源类型</span>
          <SegmentedControl
            v-model="subKind"
            block
            size="md"
            :options="[
              { value: 'url', label: '远程订阅 URL' },
              { value: 'inline', label: '内联配置' },
            ]"
          />
        </div>
        <FormField v-if="subKind === 'url'" label="订阅地址" required hint="支持 Clash YAML / Base64 / URI 列表">
          <input
            v-model="subSource"
            type="url"
            required
            placeholder="https://example.com/sub?token=..."
            class="input font-mono text-xs"
          />
        </FormField>
        <FormField v-else label="节点配置" required hint="直接粘贴 Clash YAML 或分享链接">
          <textarea
            v-model="subSource"
            rows="8"
            required
            spellcheck="false"
            placeholder="proxies:&#10;  - name: Tokyo-01&#10;    type: socks5&#10;    server: 203.0.113.10&#10;    port: 1080"
            class="textarea font-mono text-xs"
          />
        </FormField>
        <FormField label="过滤正则" hint="名称匹配该正则的节点会被丢弃">
          <input v-model="subExclude" type="text" placeholder="剩余流量|到期时间|官网" class="input font-mono text-xs" />
        </FormField>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="subDrawerOpen = false">取消</button>
        <button type="submit" form="create-sub-form" :disabled="busyAction" class="btn btn-primary">
          <UiIcon v-if="busyAction" name="loader" :size="14" spin />
          保存并下发
        </button>
      </template>
    </UiDrawer>

    <!-- TLS profile drawer -->
    <UiDrawer
      v-model:open="tlsDrawerOpen"
      :title="editingProfileId ? '编辑 uTLS 模板' : '新建 uTLS 模板'"
      :description="editingProfileId ? `正在编辑 ${editingProfileId}` : 'ClientHello 线级指纹参数'"
      width="lg"
      @close="resetTlsForm"
    >
      <form id="tls-profile-form" class="space-y-5" @submit.prevent="saveTlsProfile">
        <div class="flex items-center justify-between gap-3 rounded-lg border border-dashed border-line px-3.5 py-2.5">
          <p class="text-xs text-fg-subtle">一键填入 Claude Bun（PQ X25519MLKEM768）线级参数</p>
          <button type="button" class="btn btn-secondary btn-xs" @click="fillClaudeBunWirePreset">
            <UiIcon name="sparkles" :size="13" />
            填充
          </button>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <FormField label="模板名称" required>
            <input v-model="tlsName" type="text" required placeholder="如 Claude-PQ-Linux" class="input" />
          </FormField>
          <FormField label="ClientHello Preset">
            <select v-model="tlsPreset" class="select">
              <option value="auto">auto（Rendezvous Sticky）</option>
              <option value="custom_wire">custom_wire</option>
              <option value="claude_bun_21">claude_bun_21（PQ X25519MLKEM768）</option>
              <option value="codex_rustls">codex_rustls（Rust reqwest/rustls）</option>
              <option value="antigravity_ide">antigravity_ide（Electron PQ + ALPS）</option>
              <option value="chrome_auto">chrome_auto</option>
              <option value="firefox_auto">firefox_auto</option>
              <option value="safari_auto">safari_auto</option>
              <option value="ios_auto">ios_auto</option>
              <option value="edge_auto">edge_auto</option>
              <option value="randomized">randomized</option>
              <option value="claude_cli">claude_cli</option>
            </select>
          </FormField>
          <FormField label="ALPN" hint="逗号分隔">
            <input v-model="tlsAlpnRaw" type="text" placeholder="h2,http/1.1" class="input font-mono text-xs" />
          </FormField>
          <FormField label="OS Hint">
            <select v-model="tlsOsHint" class="select">
              <option value="">任意</option>
              <option value="linux">linux</option>
              <option value="darwin">darwin（macOS）</option>
              <option value="windows">windows</option>
              <option value="ios">ios</option>
            </select>
          </FormField>
        </div>

        <div class="flex items-center justify-between rounded-lg border border-line bg-surface-2/40 px-3.5 py-2.5">
          <span class="text-sm text-fg">启用 GREASE</span>
          <UiSwitch v-model="tlsEnableGrease" label="启用 GREASE" tone="accent" hide-label />
        </div>

        <div class="space-y-4 border-t border-line pt-5">
          <p class="text-2xs font-medium uppercase tracking-wider text-fg-subtle">线级参数（十进制或 0x 十六进制）</p>
          <div class="grid gap-4 sm:grid-cols-2">
            <FormField label="Curves">
              <input v-model="tlsCurvesRaw" type="text" placeholder="4588,29,23,24" class="input font-mono text-xs" />
            </FormField>
            <FormField label="KeyShare" hint="必须属于 Curves">
              <input v-model="tlsKeySharesRaw" type="text" placeholder="4588,29" class="input font-mono text-xs" />
            </FormField>
            <FormField label="Extensions" hint="需包含 10 与 51，可含 0xfe0d">
              <input v-model="tlsExtensionsRaw" type="text" class="input font-mono text-xs" />
            </FormField>
            <FormField label="CipherSuites" hint="留空继承 BoringSSL 默认">
              <input v-model="tlsCiphersRaw" type="text" class="input font-mono text-xs" />
            </FormField>
          </div>
        </div>

        <div class="space-y-4 border-t border-line pt-5">
          <p class="text-2xs font-medium uppercase tracking-wider text-fg-subtle">可选</p>
          <FormField label="User-Agent 模板">
            <input v-model="tlsUA" type="text" class="input font-mono text-xs" />
          </FormField>
          <FormField label="JA3 摘要备注">
            <input v-model="tlsJA3" type="text" class="input font-mono text-xs" />
          </FormField>
        </div>
      </form>
      <template #footer>
        <button type="button" class="btn btn-secondary" @click="tlsDrawerOpen = false">取消</button>
        <button type="submit" form="tls-profile-form" :disabled="busyAction" class="btn btn-primary">
          {{ editingProfileId ? "保存更新" : "创建模板" }}
        </button>
      </template>
    </UiDrawer>
  </div>
</template>
