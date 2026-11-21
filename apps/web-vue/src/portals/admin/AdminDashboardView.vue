<script setup lang="ts">
import { onMounted, ref } from "vue";
import type {
  ClashExitNode,
  RiskBanEvent,
  RoutePreviewResponse,
  VmSlotSummary,
} from "@slipgate/contracts";
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
const clashNodes = ref<ClashExitNode[]>([]);
const vmSlots = ref<VmSlotSummary[]>([]);
const riskEvents = ref<RiskBanEvent[]>([]);
const readiness = ref<ReadinessState | null>(null);
const previewModel = ref("claude-sonnet-4-5");
const previewResult = ref<RoutePreviewResponse | null>(null);
const previewError = ref<string | null>(null);

async function loadOverview() {
  try {
    const [archRes, clashRes, vmRes, riskRes, readyRes] = await Promise.all([
      fetch("/api/v1/system/architecture"),
      auth.apiFetch("/api/v1/admin/clash/nodes"),
      auth.apiFetch("/api/v1/admin/vms/slots"),
      auth.apiFetch("/api/v1/admin/risk/events"),
      fetch("/readyz"),
    ]);
    if (archRes.ok) {
      const archData = (await archRes.json()) as { layers: ArchitectureLayer[] };
      layers.value = archData.layers;
    }
    if (clashRes.ok) {
      const clashData = (await clashRes.json()) as { nodes: ClashExitNode[] };
      clashNodes.value = clashData.nodes;
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
  } catch {
    // Allow standalone preview when backend is offline.
  }
}

async function runRoutePreview() {
  previewError.value = null;
  previewResult.value = null;
  try {
    const res = await auth.apiFetch("/api/v1/admin/routes/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        groupId: "grp-default",
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
    <section class="grid gap-4 sm:grid-cols-3">
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <p class="text-xs uppercase tracking-wider text-slate-400">L1 网络与隐匿层 (Go)</p>
        <p class="mt-2 text-lg font-semibold text-sky-400">
          {{ readiness?.planes.net ?? "unknown" }}
        </p>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <p class="text-xs uppercase tracking-wider text-slate-400">L2 核心数据面 (Zig)</p>
        <p class="mt-2 text-lg font-semibold text-emerald-400">
          {{ readiness?.planes.core ?? "unknown" }}
        </p>
      </div>
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <p class="text-xs uppercase tracking-wider text-slate-400">L3 业务中间件 (Bun TS)</p>
        <p class="mt-2 text-lg font-semibold text-amber-400">
          {{ readiness?.planes.bff ?? "unknown" }}
        </p>
      </div>
    </section>

    <section class="rounded-xl border border-slate-800 bg-slate-900 p-6">
      <h2 class="text-base font-semibold text-white">四层单写者架构视图</h2>
      <div class="mt-4 grid gap-3 md:grid-cols-2">
        <div
          v-for="layer in layers"
          :key="layer.id"
          class="rounded-lg border border-slate-800 bg-slate-950/60 p-4"
        >
          <div class="flex items-center justify-between">
            <span class="font-mono text-sm font-semibold text-sky-400">{{ layer.id }} · {{ layer.name }}</span>
            <span class="rounded bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300">
              schema: {{ layer.schema }}
            </span>
          </div>
          <p class="mt-1 text-xs text-slate-400">{{ layer.stack }}</p>
          <p class="mt-2 text-sm text-slate-200">{{ layer.role }}</p>
        </div>
      </div>
    </section>

    <section class="grid gap-6 md:grid-cols-2">
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h2 class="text-base font-semibold text-white">Clash 独立出口池（1 号 1 IP）</h2>
        <div class="mt-4 space-y-3">
          <div
            v-for="node in clashNodes"
            :key="node.nodeId"
            class="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm"
          >
            <div>
              <p class="font-medium text-white">{{ node.name }}</p>
              <p class="font-mono text-xs text-slate-400">
                127.0.0.1:{{ node.listenerPort }} → {{ node.exitIp }} ({{ node.latencyMs }}ms)
              </p>
            </div>
            <span class="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
              {{ node.boundAccounts }}/{{ node.maxAccounts }} · {{ node.healthStatus }}
            </span>
          </div>
        </div>
      </div>

      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h2 class="text-base font-semibold text-white">合成路由实时预览</h2>
        <div class="mt-4 flex gap-2">
          <input
            v-model="previewModel"
            type="text"
            class="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-white focus:border-sky-500 focus:outline-none"
            placeholder="输入公开模型名，例如 claude-sonnet-4-5"
          />
          <button
            type="button"
            class="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 transition hover:bg-sky-400"
            @click="runRoutePreview"
          >
            解析
          </button>
        </div>
        <div v-if="previewResult" class="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm">
          <p>目标平台：<code class="font-mono text-emerald-300">{{ previewResult.targetPlatform }}</code></p>
          <p class="mt-1">上游模型：<code class="font-mono text-emerald-300">{{ previewResult.upstreamModel }}</code></p>
          <p class="mt-1 text-xs text-slate-300">来源：{{ previewResult.resolutionSource }}</p>
        </div>
        <p v-if="previewError" class="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
          {{ previewError }}
        </p>
      </div>
    </section>

    <section class="grid gap-6 md:grid-cols-2">
      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h2 class="text-base font-semibold text-white">VM 完全拟真槽舰队（1 槽 1 出口 · 20 路 Subagent）</h2>
        <div class="mt-4 space-y-3">
          <div
            v-for="slot in vmSlots"
            :key="slot.slotId"
            class="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm"
          >
            <div class="flex items-center justify-between">
              <span class="font-mono font-semibold text-sky-400">
                {{ slot.slotId }} · {{ slot.hypervisorKind }}
              </span>
              <span class="rounded-full bg-sky-500/15 px-2.5 py-0.5 text-xs text-sky-300">
                {{ slot.activeSubagents }}/{{ slot.maxSubagents }} Subagents · {{ slot.state }}
              </span>
            </div>
            <p class="mt-1 font-mono text-xs text-slate-400">
              出口 {{ slot.exitIp }} · 5h {{ (slot.window5hUsedBps / 100).toFixed(1) }}% · 7d {{ (slot.window7dUsedBps / 100).toFixed(1) }}%
            </p>
            <p class="mt-1 font-mono text-xs text-slate-500">
              machine-id: {{ slot.persona.guestMachineId }} · MAC: {{ slot.persona.macAddress }}
            </p>
            <p class="mt-1 text-xs text-slate-300">
              注入策略: {{ slot.cleanseMode }} · 遥测: {{ slot.telemetryMode }} · 内存: {{ slot.memoryMiB }} MiB
            </p>
          </div>
        </div>
      </div>

      <div class="rounded-xl border border-slate-800 bg-slate-900 p-6">
        <h2 class="text-base font-semibold text-white">进槽前风控拦截（阶梯封禁 10m → 24h → 永久）</h2>
        <div class="mt-4 space-y-3">
          <div
            v-for="ev in riskEvents"
            :key="ev.eventId"
            class="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm"
          >
            <div class="flex items-center justify-between">
              <span class="font-mono text-xs text-amber-300">
                {{ ev.subjectKind }} · Strike {{ ev.strikeLevel }} ({{ ev.banDuration }})
              </span>
              <span class="text-xs text-slate-400">
                降级出站 {{ ev.downgradedCount }} · 普通 400 {{ ev.ordinaryUpstream400Count }}
              </span>
            </div>
            <p class="mt-1 font-mono text-xs text-slate-200">{{ ev.reason }}</p>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
