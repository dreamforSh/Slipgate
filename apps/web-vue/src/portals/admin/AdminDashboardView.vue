<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type {
  ClashExitNode,
  ClashRuntimeStatus,
  GroupItem,
  Provider,
  RiskBanEvent,
  RoutePreviewResponse,
  StoredCompositeRoute,
  SystemUpdateStatus,
  UsageLogItem,
  VmSlotSummary,
} from "@slipgate/contracts";
import { RouterLink } from "vue-router";
import ConfirmButton from "../../components/ui/ConfirmButton.vue";
import EmptyState from "../../components/ui/EmptyState.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import StatCard from "../../components/ui/StatCard.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiBadge from "../../components/ui/UiBadge.vue";
import UiCard from "../../components/ui/UiCard.vue";
import UiIcon, { type IconName } from "../../components/ui/UiIcon.vue";
import UsageMeter from "../../components/ui/UsageMeter.vue";
import { useFeedbackToasts } from "../../composables/useFeedbackToasts";
import {
  HEALTH_LABEL,
  PLANE_LABEL,
  PROVIDER_OPTIONS,
  RUNTIME_PROFILE_TONE,
  SLOT_STATE_LABEL,
  formatDateTime,
  formatNumber,
  healthTone,
  shortHash,
} from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const auth = useAuthStore();

interface ArchitectureLayer {
  id: string;
  name: string;
  stack: string;
  schema: string;
  role: string;
}

interface ReadinessState {
  ready: boolean;
  degraded: boolean;
  planes: Record<string, string>;
}

const layers = ref<ArchitectureLayer[]>([]);
const groups = ref<GroupItem[]>([]);
const routes = ref<StoredCompositeRoute[]>([]);
const adminUsage = ref<UsageLogItem[]>([]);
const clashNodes = ref<ClashExitNode[]>([]);
const clashRuntime = ref<ClashRuntimeStatus | null>(null);
const vmSlots = ref<VmSlotSummary[]>([]);
const riskEvents = ref<RiskBanEvent[]>([]);
const readiness = ref<ReadinessState | null>(null);
const updateStatus = ref<SystemUpdateStatus | null>(null);
const updateBusy = ref(false);
const updateError = ref<string | null>(null);
const routeGroupId = ref("grp_default");
const routePublicModel = ref("");
const routeMatchType = ref<"exact" | "prefix">("exact");
const routeTargetPlatform = ref<Provider>("anthropic");
const routeUpstreamModel = ref("");
const routePriority = ref(50);
const previewModel = ref("claude-sonnet-4-5");
const previewResult = ref<RoutePreviewResponse | null>(null);
const previewError = ref<string | null>(null);
const loading = ref(false);
const routeFormOpen = ref(false);

useFeedbackToasts(updateError);

const planes = computed<{ key: string; label: string; stack: string; icon: IconName }[]>(() => [
  { key: "net", label: "L1 网络与隐匿层", stack: "Go · mihomo · uTLS", icon: "globe" },
  { key: "core", label: "L2 核心数据面", stack: "Zig · Arena · i128", icon: "cpu" },
  { key: "bff", label: "L3 业务中间件", stack: "Bun · Hono · Zod", icon: "layers" },
]);

const healthyNodes = computed(() => clashNodes.value.filter((n) => n.healthStatus === "healthy").length);
const readySlots = computed(() => vmSlots.value.filter((s) => s.state === "ready").length);
const activeSubagents = computed(() => vmSlots.value.reduce((sum, s) => sum + s.activeSubagents, 0));
const maxSubagents = computed(() => vmSlots.value.reduce((sum, s) => sum + s.maxSubagents, 0));

const groupNameById = computed(() => new Map(groups.value.map((g) => [g.id, g.name])));

async function loadOverview() {
  loading.value = true;
  try {
    const [archRes, grpRes, routeRes, usageRes, clashRes, vmRes, riskRes, readyRes, updRes] = await Promise.all([
      fetch("/api/v1/system/architecture"),
      auth.apiFetch("/api/v1/admin/groups"),
      auth.apiFetch("/api/v1/admin/routes"),
      auth.apiFetch("/api/v1/admin/usage?limit=15"),
      auth.apiFetch("/api/v1/admin/clash/nodes"),
      auth.apiFetch("/api/v1/admin/vms/slots"),
      auth.apiFetch("/api/v1/admin/risk/events"),
      fetch("/readyz"),
      auth.apiFetch("/api/v1/admin/system/update"),
    ]);
    if (archRes.ok) {
      const archData = (await archRes.json()) as { layers: ArchitectureLayer[] };
      layers.value = archData.layers;
    }
    if (grpRes.ok) {
      const grpData = (await grpRes.json()) as { groups: GroupItem[] };
      groups.value = grpData.groups;
      if (groups.value.length > 0 && !groups.value.some((g) => g.id === routeGroupId.value)) {
        routeGroupId.value = groups.value[0]!.id;
      }
    }
    if (routeRes.ok) {
      const routeData = (await routeRes.json()) as { routes: StoredCompositeRoute[] };
      routes.value = routeData.routes;
    }
    if (usageRes.ok) {
      const usageData = (await usageRes.json()) as { items: UsageLogItem[] };
      adminUsage.value = usageData.items;
    }
    if (clashRes.ok) {
      const clashData = (await clashRes.json()) as {
        nodes: ClashExitNode[];
        runtime?: ClashRuntimeStatus;
      };
      clashNodes.value = clashData.nodes;
      clashRuntime.value = clashData.runtime ?? null;
    }
    if (vmRes.ok) {
      const vmData = (await vmRes.json()) as { slots: VmSlotSummary[] };
      vmSlots.value = vmData.slots;
    }
    if (riskRes.ok) {
      const riskData = (await riskRes.json()) as { events: RiskBanEvent[] };
      riskEvents.value = riskData.events;
    }
    if (readyRes.ok || readyRes.status === 503) {
      readiness.value = (await readyRes.json()) as ReadinessState;
    }
    if (updRes.ok) {
      updateStatus.value = (await updRes.json()) as SystemUpdateStatus;
    }
  } catch {
    // Allow standalone preview when backend is offline.
  } finally {
    loading.value = false;
  }
}

async function triggerRepoSync(checkOnly: boolean) {
  updateBusy.value = true;
  updateError.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/system/update/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkOnly }),
    });
    const data = (await res.json()) as SystemUpdateStatus & {
      error?: string;
      message?: string;
      status?: SystemUpdateStatus;
    };
    if (!res.ok) {
      if (data.status) {
        updateStatus.value = data.status;
      }
      updateError.value = data.message ?? data.error ?? "仓库热更新请求失败";
      return;
    }
    updateStatus.value = data;
    if (!checkOnly) {
      window.setTimeout(() => {
        void loadOverview();
      }, 1200);
    }
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : "仓库同步失败";
  } finally {
    updateBusy.value = false;
  }
}

async function handleCreateRoute() {
  previewError.value = null;
  const res = await auth.apiFetch("/api/v1/admin/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      groupId: routeGroupId.value,
      publicModel: routePublicModel.value,
      matchType: routeMatchType.value,
      targetPlatform: routeTargetPlatform.value,
      upstreamModel: routeUpstreamModel.value,
      priority: routePriority.value,
    }),
  });
  if (!res.ok) {
    const err = (await res.json()) as { message?: string; error?: string };
    previewError.value = err.message ?? err.error ?? "创建合成路由规则失败";
    return;
  }
  routePublicModel.value = "";
  routeUpstreamModel.value = "";
  routeFormOpen.value = false;
  await loadOverview();
}

async function deleteRoute(routeId: string) {
  previewError.value = null;
  const res = await auth.apiFetch(`/api/v1/admin/routes/${routeId}`, { method: "DELETE" });
  if (!res.ok) {
    const err = (await res.json()) as { message?: string };
    previewError.value = err.message ?? "删除路由规则失败";
    return;
  }
  await loadOverview();
}

async function runRoutePreview() {
  previewError.value = null;
  previewResult.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/routes/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: routeGroupId.value,
        publicModel: previewModel.value,
        endpoint: "any",
      }),
    });
    const data = (await res.json()) as RoutePreviewResponse & { error?: string };
    if (!res.ok) {
      previewError.value = data.error ?? "路由未匹配（Fail-Closed）";
      return;
    }
    previewResult.value = data;
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : "请求失败";
  }
}

onMounted(() => {
  void loadOverview();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader title="系统看板" description="三平面健康状态、合成路由、出口与执行槽概览，以及全网实时结算流水。">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadOverview">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          刷新
        </button>
      </template>
    </PageHeader>

    <!-- Plane health -->
    <div class="grid gap-4 md:grid-cols-3">
      <div v-for="p in planes" :key="p.key" class="card flex items-center gap-3.5 p-4">
        <span
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-fg-muted ring-1 ring-inset ring-line"
        >
          <UiIcon :name="p.icon" :size="18" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-xs text-fg-subtle">{{ p.label }}</p>
          <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{{ p.stack }}</p>
        </div>
        <UiBadge
          :tone="healthTone(readiness?.planes[p.key] ?? 'unknown')"
          dot
          :pulse="readiness?.planes[p.key] === 'up'"
        >
          {{ PLANE_LABEL[readiness?.planes[p.key] ?? "unknown"] ?? readiness?.planes[p.key] }}
        </UiBadge>
      </div>
    </div>

    <!-- KPIs -->
    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard label="路由分组 / 合成规则" :value="`${groups.length} / ${routes.length}`" icon="route" tone="accent" />
      <StatCard
        label="健康出口节点"
        :value="`${healthyNodes} / ${clashNodes.length}`"
        icon="globe"
        tone="success"
        :hint="`活跃监听 ${clashRuntime?.activeListeners ?? clashNodes.length}`"
      />
      <StatCard
        label="就绪 VM 槽位"
        :value="`${readySlots} / ${vmSlots.length}`"
        icon="server"
        tone="info"
        :hint="`Subagents ${activeSubagents} / ${maxSubagents}`"
      />
      <StatCard
        label="风控封禁事件"
        :value="riskEvents.length"
        icon="shield-alert"
        :tone="riskEvents.length > 0 ? 'warning' : 'neutral'"
        hint="10m → 24h → 永久"
      />
    </div>

    <!-- Hot update -->
    <UiCard icon="branch" title="版本构建与仓库热更新" description="Dev 模式下保持 :8080 不断线地同步仓库并平滑重启子进程">
      <template #actions>
        <UiBadge :tone="updateStatus?.mode === 'dev' ? 'success' : 'neutral'" dot>
          {{ updateStatus?.mode === "dev" ? "DEV 自动热更新" : "RELEASE 生产锁定" }}
        </UiBadge>
        <UiBadge v-if="updateStatus?.updateAvailable" tone="accent">有可用更新</UiBadge>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="updateBusy" @click="triggerRepoSync(true)">
          <UiIcon name="search" :size="14" />
          检查更新
        </button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="updateBusy" @click="triggerRepoSync(false)">
          <UiIcon :name="updateBusy ? 'loader' : 'download'" :size="14" :spin="updateBusy" />
          立即热更新
        </button>
      </template>
      <dl class="kv grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <dt>仓库</dt>
          <dd :title="updateStatus?.repo">{{ updateStatus?.repo ?? "dreamforSh/Slipgate" }}</dd>
        </div>
        <div>
          <dt>分支 / 版本</dt>
          <dd>{{ updateStatus?.branch ?? "main" }} · {{ updateStatus?.version ?? "0.1.0" }}</dd>
        </div>
        <div>
          <dt>当前提交</dt>
          <dd>
            {{ shortHash(updateStatus?.activeCommit ?? "dev") }}
            <span v-if="updateStatus?.remoteCommit" class="text-accent">→ {{ shortHash(updateStatus.remoteCommit) }}</span>
          </dd>
        </div>
        <div>
          <dt>同步方式 / 状态</dt>
          <dd>{{ updateStatus?.resolvedStrategy ?? "release" }} · {{ updateStatus?.state ?? "idle" }}</dd>
        </div>
        <div>
          <dt>热重载次数</dt>
          <dd>{{ updateStatus?.reloadCount ?? 0 }}</dd>
        </div>
        <div>
          <dt>前端资源</dt>
          <dd>{{ updateStatus?.webUiOverridden ? "已热替换接管" : "内嵌版本" }}</dd>
        </div>
      </dl>
      <UiAlert v-if="updateError || updateStatus?.lastError" tone="danger" class="mt-4">
        <span class="font-mono text-xs">{{ updateError ?? updateStatus?.lastError }}</span>
      </UiAlert>
    </UiCard>

    <!-- Routing -->
    <div class="grid gap-6 xl:grid-cols-3">
      <UiCard
        class="xl:col-span-2"
        icon="route"
        title="合成路由规则"
        description="公开模型名 → 目标平台 / 上游模型，同步至 Zig DataPlane"
        flush
      >
        <template #actions>
          <button type="button" class="btn btn-sm" :class="routeFormOpen ? 'btn-secondary' : 'btn-primary'" @click="routeFormOpen = !routeFormOpen">
            <UiIcon :name="routeFormOpen ? 'x' : 'plus'" :size="14" />
            {{ routeFormOpen ? "收起" : "添加规则" }}
          </button>
        </template>

        <form
          v-if="routeFormOpen"
          class="grid animate-fade-in gap-3 border-b border-line bg-surface-2/40 p-5 sm:grid-cols-2 lg:grid-cols-3"
          @submit.prevent="handleCreateRoute"
        >
          <label class="block">
            <span class="label">分组</span>
            <select v-model="routeGroupId" class="select">
              <option v-if="groups.length === 0" value="grp_default">grp_default</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}（{{ g.id }}）</option>
            </select>
          </label>
          <label class="block">
            <span class="label">公开模型名 <span class="text-danger">*</span></span>
            <input v-model="routePublicModel" type="text" required placeholder="如 sonnet-fast" class="input font-mono" />
          </label>
          <label class="block">
            <span class="label">匹配方式</span>
            <select v-model="routeMatchType" class="select">
              <option value="exact">精确匹配（exact）</option>
              <option value="prefix">前缀匹配（prefix）</option>
            </select>
          </label>
          <label class="block">
            <span class="label">目标平台</span>
            <select v-model="routeTargetPlatform" class="select">
              <option v-for="p in PROVIDER_OPTIONS" :key="p.value" :value="p.value">{{ p.value }}</option>
            </select>
          </label>
          <label class="block">
            <span class="label">上游模型</span>
            <input v-model="routeUpstreamModel" type="text" placeholder="留空则透传" class="input font-mono" />
          </label>
          <div class="flex items-end gap-2">
            <label class="block w-24 shrink-0">
              <span class="label">优先级</span>
              <input v-model.number="routePriority" type="number" min="0" class="input font-mono" />
            </label>
            <button type="submit" class="btn btn-primary flex-1">保存规则</button>
          </div>
        </form>

        <EmptyState
          v-if="routes.length === 0"
          compact
          icon="route"
          title="暂无合成路由规则"
          description="未命中显式规则时将使用内置模型探测器解析。"
        />
        <div v-else class="table-wrap max-h-80 overflow-y-auto">
          <table class="data-table">
            <thead class="sticky top-0 z-10">
              <tr>
                <th>公开模型</th>
                <th>目标</th>
                <th>匹配 / 优先级</th>
                <th>分组</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in routes" :key="r.id">
                <td class="font-mono text-xs font-medium text-fg">{{ r.publicModel }}</td>
                <td class="font-mono text-xs text-fg-muted">
                  <span class="text-fg">{{ r.targetPlatform }}</span> / {{ r.upstreamModel || r.publicModel }}
                </td>
                <td>
                  <div class="flex items-center gap-1.5">
                    <UiBadge :tone="r.matchType === 'exact' ? 'accent' : 'info'">{{ r.matchType }}</UiBadge>
                    <span class="font-mono text-2xs text-fg-subtle">#{{ r.priority }}</span>
                  </div>
                </td>
                <td class="text-xs text-fg-muted">{{ groupNameById.get(r.groupId) ?? r.groupId }}</td>
                <td class="text-right">
                  <ConfirmButton icon-only @confirm="deleteRoute(r.id)" />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </UiCard>

      <UiCard icon="search" title="路由解析预览" description="模拟一次请求的模型解析结果">
        <form class="flex gap-2" @submit.prevent="runRoutePreview">
          <input
            v-model="previewModel"
            type="text"
            class="input font-mono"
            placeholder="公开模型名，如 claude-sonnet-4-5"
            aria-label="公开模型名"
          />
          <button type="submit" class="btn btn-primary">解析</button>
        </form>
        <p class="hint">使用分组：<span class="font-mono">{{ groupNameById.get(routeGroupId) ?? routeGroupId }}</span></p>

        <div v-if="previewResult" class="mt-4 animate-fade-in overflow-hidden rounded-lg border border-success/30">
          <div class="flex items-center gap-2 bg-success/[0.08] px-3.5 py-2 text-xs font-medium text-success">
            <UiIcon name="check-circle" :size="14" />
            已解析
          </div>
          <dl class="kv grid-cols-1 p-3.5">
            <div>
              <dt>目标平台</dt>
              <dd class="!text-sm">{{ previewResult.targetPlatform }}</dd>
            </div>
            <div>
              <dt>上游模型</dt>
              <dd class="!text-sm">{{ previewResult.upstreamModel }}</dd>
            </div>
            <div>
              <dt>解析来源</dt>
              <dd>{{ previewResult.resolutionSource }}</dd>
            </div>
          </dl>
        </div>
        <UiAlert v-if="previewError" tone="danger" class="mt-4">{{ previewError }}</UiAlert>
        <div
          v-if="!previewResult && !previewError"
          class="mt-4 rounded-lg border border-dashed border-line px-4 py-8 text-center text-xs text-fg-subtle"
        >
          输入模型名后点击「解析」
        </div>
      </UiCard>
    </div>

    <!-- Egress & VM -->
    <div class="grid gap-6 xl:grid-cols-2">
      <UiCard
        icon="globe"
        title="Clash 独立出口池"
        :description="`内核 ${clashRuntime?.mode ?? 'embedded'} · ${clashRuntime?.version || 'mihomo'}`"
        flush
      >
        <template #actions>
          <RouterLink to="/admin/clash" class="btn btn-ghost btn-sm">
            管理
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="clashNodes.length === 0" compact icon="globe" title="暂无出口节点" description="在 Clash 页面添加订阅后自动生成本地监听槽位。" />
        <ul v-else class="divide-y divide-line/70">
          <li v-for="node in clashNodes.slice(0, 6)" :key="node.nodeId" class="flex items-center gap-3 px-5 py-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-fg">{{ node.name }}</p>
              <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">
                :{{ node.listenerPort }} → {{ node.exitIp || "待探测" }} · {{ node.latencyMs }}ms
              </p>
            </div>
            <span class="font-mono text-2xs text-fg-subtle">{{ node.boundAccounts }}/{{ node.maxAccounts }}</span>
            <UiBadge :tone="healthTone(node.healthStatus)" dot>{{ HEALTH_LABEL[node.healthStatus] ?? node.healthStatus }}</UiBadge>
          </li>
        </ul>
      </UiCard>

      <UiCard icon="server" title="VM 拟真槽舰队" description="1 槽 1 出口 · 每槽最多 20 路 Subagent" flush>
        <template #actions>
          <RouterLink to="/admin/vms" class="btn btn-ghost btn-sm">
            管理
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="vmSlots.length === 0" compact icon="server" title="暂无 VM 槽位" description="在 VM 舰队页面为账号部署执行槽。" />
        <ul v-else class="divide-y divide-line/70">
          <li v-for="slot in vmSlots.slice(0, 6)" :key="slot.slotId" class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto]">
            <div class="min-w-0">
              <p class="flex items-center gap-1.5 truncate font-mono text-xs font-medium text-fg">
                {{ slot.slotId }}
                <UiBadge :tone="RUNTIME_PROFILE_TONE[slot.runtimeProfile] ?? 'neutral'">{{ slot.runtimeProfile }}</UiBadge>
              </p>
              <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">{{ slot.hypervisorKind }} · {{ slot.exitIp }}</p>
            </div>
            <UsageMeter class="hidden sm:block" label="5h" :bps="slot.window5hUsedBps" />
            <UsageMeter class="hidden sm:block" label="Subagents" :value="slot.activeSubagents" :max="slot.maxSubagents" />
            <UiBadge :tone="healthTone(slot.state)" dot>{{ SLOT_STATE_LABEL[slot.state] ?? slot.state }}</UiBadge>
          </li>
        </ul>
      </UiCard>
    </div>

    <!-- Risk + architecture -->
    <div class="grid gap-6 xl:grid-cols-2">
      <UiCard icon="shield-alert" title="进槽前风控拦截" description="阶梯封禁 10m → 24h → 永久，普通上游 400 自动豁免" flush>
        <EmptyState v-if="riskEvents.length === 0" compact icon="shield" title="无封禁记录" description="当前没有触发阶梯封禁的设备或会话。" />
        <ul v-else class="divide-y divide-line/70">
          <li v-for="ev in riskEvents" :key="ev.eventId" class="px-5 py-3">
            <div class="flex flex-wrap items-center gap-2">
              <UiBadge :tone="ev.strikeLevel >= 3 ? 'danger' : 'warning'">Strike {{ ev.strikeLevel }} · {{ ev.banDuration }}</UiBadge>
              <span class="text-xs text-fg-muted">{{ ev.subjectKind }}</span>
              <span class="ml-auto font-mono text-2xs text-fg-subtle">{{ formatDateTime(ev.createdAtIso) }}</span>
            </div>
            <p class="mt-1.5 font-mono text-xs text-fg">{{ ev.reason }}</p>
            <p class="mt-1 text-2xs text-fg-subtle">降级出站 {{ ev.downgradedCount }} · 普通 400 {{ ev.ordinaryUpstream400Count }}</p>
          </li>
        </ul>
      </UiCard>

      <UiCard icon="database" title="单写者分层架构" description="每个 PostgreSQL schema 只由一个平面写入">
        <EmptyState v-if="layers.length === 0" compact icon="database" title="架构信息不可用" />
        <ul v-else class="space-y-2.5">
          <li
            v-for="layer in layers"
            :key="layer.id"
            class="rounded-lg border border-line bg-surface-2/40 px-3.5 py-3"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-sm font-medium text-fg">
                <span class="font-mono text-accent">{{ layer.id }}</span>
                <span class="mx-1.5 text-fg-subtle">·</span>{{ layer.name }}
              </p>
              <span class="code-chip">schema: {{ layer.schema }}</span>
            </div>
            <p class="mt-1 font-mono text-2xs text-fg-subtle">{{ layer.stack }}</p>
            <p class="mt-1.5 text-xs leading-relaxed text-fg-muted">{{ layer.role }}</p>
          </li>
        </ul>
      </UiCard>
    </div>

    <!-- Global usage -->
    <UiCard icon="activity" title="全网实时结算流水" description="Go L1 ↔ Zig L2 每次请求的上游账号、转码与费用" flush>
      <template #actions>
        <span class="text-xs text-fg-subtle">最近 15 条</span>
      </template>
      <EmptyState v-if="adminUsage.length === 0" compact icon="activity" title="暂无实时请求流水" />
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>请求 / 用户</th>
              <th>模型</th>
              <th>上游账号</th>
              <th>协议转码</th>
              <th class="text-right">Tokens</th>
              <th class="text-right">费用</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in adminUsage" :key="u.id">
              <td>
                <p class="font-mono text-xs text-fg">{{ shortHash(u.requestId, 18) }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ u.userId }}</p>
              </td>
              <td>
                <p class="text-sm text-fg">{{ u.publicModel }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">→ {{ u.upstreamModel }}</p>
              </td>
              <td>
                <p class="text-xs text-fg-muted">{{ u.platform }}</p>
                <p class="mt-0.5 font-mono text-2xs text-fg-subtle">{{ u.accountId }}</p>
              </td>
              <td class="whitespace-nowrap font-mono text-xs text-fg-muted">{{ u.ingressCodec }} → {{ u.egressCodec }}</td>
              <td class="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                {{ formatNumber(u.inputTokens) }} / {{ formatNumber(u.outputTokens) }}
              </td>
              <td class="text-right font-mono text-xs font-medium tabular-nums text-fg">{{ u.formattedCostUsd }}</td>
              <td class="whitespace-nowrap">
                <UiBadge :tone="u.statusCode < 400 ? 'success' : 'danger'" mono>{{ u.statusCode }}</UiBadge>
                <span class="ml-1.5 font-mono text-2xs text-fg-subtle">{{ u.durationMs }}ms</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UiCard>
  </div>
</template>
