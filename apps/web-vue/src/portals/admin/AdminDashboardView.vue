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
import { useI18n } from "vue-i18n";
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
  PROVIDER_OPTIONS,
  RUNTIME_PROFILE_TONE,
  formatDateTime,
  formatNumber,
  healthLabel,
  healthTone,
  planeLabel,
  shortHash,
  slotStateLabel,
} from "../../lib/format";
import { useAuthStore } from "../../stores/auth";

const auth = useAuthStore();
const { t } = useI18n();

interface ReadinessState {
  ready: boolean;
  degraded: boolean;
  planes: Record<string, string>;
}

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

const planes = computed<{ key: string; label: string; icon: IconName }[]>(() => [
  { key: "net", label: t("dashboard.planes.net"), icon: "globe" },
  { key: "core", label: t("dashboard.planes.core"), icon: "cpu" },
  { key: "bff", label: t("dashboard.planes.bff"), icon: "layers" },
]);

const healthyNodes = computed(() => clashNodes.value.filter((n) => n.healthStatus === "healthy").length);
const readySlots = computed(() => vmSlots.value.filter((s) => s.state === "ready").length);
const activeSubagents = computed(() => vmSlots.value.reduce((sum, s) => sum + s.activeSubagents, 0));
const maxSubagents = computed(() => vmSlots.value.reduce((sum, s) => sum + s.maxSubagents, 0));

const groupNameById = computed(() => new Map(groups.value.map((g) => [g.id, g.name])));

async function loadOverview() {
  loading.value = true;
  try {
    const [grpRes, routeRes, usageRes, clashRes, vmRes, riskRes, readyRes, updRes] = await Promise.all([
      auth.apiFetch("/api/v1/admin/groups"),
      auth.apiFetch("/api/v1/admin/routes"),
      auth.apiFetch("/api/v1/admin/usage?limit=15"),
      auth.apiFetch("/api/v1/admin/clash/nodes"),
      auth.apiFetch("/api/v1/admin/vms/slots"),
      auth.apiFetch("/api/v1/admin/risk/events"),
      fetch("/readyz"),
      auth.apiFetch("/api/v1/admin/system/update"),
    ]);
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
      updateError.value = data.message ?? data.error ?? t("dashboard.update.failed");
      return;
    }
    updateStatus.value = data;
    if (!checkOnly) {
      window.setTimeout(() => {
        void loadOverview();
      }, 1200);
    }
  } catch (err) {
    updateError.value = err instanceof Error ? err.message : t("dashboard.update.syncFailed");
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
    previewError.value = err.message ?? err.error ?? t("dashboard.routes.createFailed");
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
    previewError.value = err.message ?? t("dashboard.routes.deleteFailed");
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
      previewError.value = data.error ?? t("dashboard.preview.notMatched");
      return;
    }
    previewResult.value = data;
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : t("common.requestFailed");
  }
}

onMounted(() => {
  void loadOverview();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('dashboard.title')">
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadOverview">
          <UiIcon name="refresh" :size="15" :spin="loading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </PageHeader>

    <!-- Plane health -->
    <div class="grid gap-4 md:grid-cols-3">
      <div v-for="p in planes" :key="p.key" class="card min-w-0 p-4">
        <div class="flex items-center justify-between gap-3">
          <span
            class="icon-chip h-9 w-9 rounded-xl"
            :class="readiness?.planes[p.key] === 'up' ? 'icon-chip-accent' : ''"
          >
            <UiIcon :name="p.icon" :size="18" />
          </span>
          <UiBadge
            :tone="healthTone(readiness?.planes[p.key] ?? 'unknown')"
            dot
            :pulse="readiness?.planes[p.key] === 'up'"
          >
            {{ planeLabel(readiness?.planes[p.key] ?? "unknown") }}
          </UiBadge>
        </div>
        <p class="mt-3 truncate text-sm font-medium text-fg">{{ p.label }}</p>
      </div>
    </div>

    <!-- KPIs -->
    <div class="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard
        :label="t('dashboard.stats.groupsRoutes')"
        :value="`${groups.length} / ${routes.length}`"
        icon="route"
        tone="accent"
      />
      <StatCard
        :label="t('dashboard.stats.healthyNodes')"
        :value="`${healthyNodes} / ${clashNodes.length}`"
        icon="globe"
        tone="success"
        :hint="t('dashboard.stats.listeners', { count: clashRuntime?.activeListeners ?? clashNodes.length })"
      />
      <StatCard
        :label="t('dashboard.stats.readySlots')"
        :value="`${readySlots} / ${vmSlots.length}`"
        icon="server"
        tone="info"
        :hint="t('dashboard.stats.concurrency', { active: activeSubagents, max: maxSubagents })"
      />
      <StatCard
        :label="t('dashboard.stats.riskBlocks')"
        :value="riskEvents.length"
        icon="shield-alert"
        :tone="riskEvents.length > 0 ? 'warning' : 'neutral'"
      />
    </div>

    <!-- Hot update -->
    <UiCard icon="branch" :title="t('dashboard.update.title')">
      <template #actions>
        <UiBadge :tone="updateStatus?.mode === 'dev' ? 'success' : 'neutral'" dot>
          {{ updateStatus?.mode === "dev" ? t("dashboard.update.devChannel") : t("dashboard.update.stable") }}
        </UiBadge>
        <UiBadge v-if="updateStatus?.updateAvailable" tone="accent">{{ t("dashboard.update.available") }}</UiBadge>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="updateBusy" @click="triggerRepoSync(true)">
          <UiIcon name="search" :size="14" />
          {{ t("dashboard.update.check") }}
        </button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="updateBusy" @click="triggerRepoSync(false)">
          <UiIcon :name="updateBusy ? 'loader' : 'download'" :size="14" :spin="updateBusy" />
          {{ t("dashboard.update.now") }}
        </button>
      </template>
      <dl class="kv grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <dt>{{ t("dashboard.update.repo") }}</dt>
          <dd :title="updateStatus?.repo">{{ updateStatus?.repo ?? "dreamforSh/Slipgate" }}</dd>
        </div>
        <div>
          <dt>{{ t("dashboard.update.branchVersion") }}</dt>
          <dd>{{ updateStatus?.branch ?? "main" }} · {{ updateStatus?.version ?? "0.1.0" }}</dd>
        </div>
        <div>
          <dt>{{ t("dashboard.update.commit") }}</dt>
          <dd>
            {{ shortHash(updateStatus?.activeCommit ?? "dev") }}
            <span v-if="updateStatus?.remoteCommit" class="text-accent">→ {{ shortHash(updateStatus.remoteCommit) }}</span>
          </dd>
        </div>
        <div>
          <dt>{{ t("dashboard.update.strategyState") }}</dt>
          <dd>{{ updateStatus?.resolvedStrategy ?? "release" }} · {{ updateStatus?.state ?? "idle" }}</dd>
        </div>
        <div>
          <dt>{{ t("dashboard.update.reloads") }}</dt>
          <dd>{{ updateStatus?.reloadCount ?? 0 }}</dd>
        </div>
        <div>
          <dt>{{ t("dashboard.update.console") }}</dt>
          <dd>{{ updateStatus?.webUiOverridden ? t("dashboard.update.consoleLive") : t("dashboard.update.consoleBuiltin") }}</dd>
        </div>
      </dl>
      <UiAlert v-if="updateError || updateStatus?.lastError" tone="danger" class="mt-4">
        <span class="font-mono text-xs">{{ updateError ?? updateStatus?.lastError }}</span>
      </UiAlert>
    </UiCard>

    <!-- Routing -->
    <div class="grid gap-6 xl:grid-cols-3">
      <UiCard class="xl:col-span-2" icon="route" :title="t('dashboard.routes.title')" flush>
        <template #actions>
          <button type="button" class="btn btn-sm" :class="routeFormOpen ? 'btn-secondary' : 'btn-primary'" @click="routeFormOpen = !routeFormOpen">
            <UiIcon :name="routeFormOpen ? 'x' : 'plus'" :size="14" />
            {{ routeFormOpen ? t("dashboard.routes.hideForm") : t("dashboard.routes.add") }}
          </button>
        </template>

        <form
          v-if="routeFormOpen"
          class="grid animate-fade-in gap-3 border-b border-line bg-surface-2/40 p-5 sm:grid-cols-2 lg:grid-cols-3"
          @submit.prevent="handleCreateRoute"
        >
          <label class="block">
            <span class="label">{{ t("dashboard.routes.group") }}</span>
            <select v-model="routeGroupId" class="select">
              <option v-if="groups.length === 0" value="grp_default">grp_default</option>
              <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }} ({{ g.id }})</option>
            </select>
          </label>
          <label class="block">
            <span class="label">{{ t("dashboard.routes.publicModel") }} <span class="text-danger">*</span></span>
            <input
              v-model="routePublicModel"
              type="text"
              required
              :placeholder="t('dashboard.routes.publicModelPlaceholder')"
              class="input font-mono"
            />
          </label>
          <label class="block">
            <span class="label">{{ t("dashboard.routes.matchType") }}</span>
            <select v-model="routeMatchType" class="select">
              <option value="exact">{{ t("dashboard.routes.matchExact") }}</option>
              <option value="prefix">{{ t("dashboard.routes.matchPrefix") }}</option>
            </select>
          </label>
          <label class="block">
            <span class="label">{{ t("dashboard.routes.targetPlatform") }}</span>
            <select v-model="routeTargetPlatform" class="select">
              <option v-for="p in PROVIDER_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
            </select>
          </label>
          <label class="block">
            <span class="label">{{ t("dashboard.routes.upstreamModel") }}</span>
            <input
              v-model="routeUpstreamModel"
              type="text"
              :placeholder="t('dashboard.routes.upstreamModelPlaceholder')"
              class="input font-mono"
            />
          </label>
          <div class="flex items-end gap-2">
            <label class="block w-24 shrink-0">
              <span class="label">{{ t("dashboard.routes.priority") }}</span>
              <input v-model.number="routePriority" type="number" min="0" class="input font-mono" />
            </label>
            <button type="submit" class="btn btn-primary flex-1">{{ t("common.save") }}</button>
          </div>
        </form>

        <EmptyState v-if="routes.length === 0" compact icon="route" :title="t('dashboard.routes.empty')" />
        <div v-else class="table-wrap max-h-80 overflow-y-auto">
          <table class="data-table">
            <thead class="sticky top-0 z-10">
              <tr>
                <th>{{ t("dashboard.routes.colPublicModel") }}</th>
                <th>{{ t("dashboard.routes.colTarget") }}</th>
                <th>{{ t("dashboard.routes.colMatch") }}</th>
                <th>{{ t("dashboard.routes.group") }}</th>
                <th class="text-right">{{ t("common.actions") }}</th>
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
                    <UiBadge :tone="r.matchType === 'exact' ? 'accent' : 'info'">
                      {{ t(`dashboard.routes.match.${r.matchType}`) }}
                    </UiBadge>
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

      <UiCard icon="search" :title="t('dashboard.preview.title')">
        <form class="flex gap-2" @submit.prevent="runRoutePreview">
          <input
            v-model="previewModel"
            type="text"
            class="input font-mono"
            :placeholder="t('dashboard.preview.modelPlaceholder')"
            :aria-label="t('dashboard.preview.modelLabel')"
          />
          <button type="submit" class="btn btn-primary">{{ t("dashboard.preview.run") }}</button>
        </form>

        <div v-if="previewResult" class="mt-4 animate-fade-in overflow-hidden rounded-lg border border-success/30">
          <div class="flex items-center gap-2 bg-success/[0.08] px-3.5 py-2 text-xs font-medium text-success">
            <UiIcon name="check-circle" :size="14" />
            {{ t("dashboard.preview.matched") }}
          </div>
          <dl class="kv grid-cols-1 p-3.5">
            <div>
              <dt>{{ t("dashboard.routes.targetPlatform") }}</dt>
              <dd class="!text-sm">{{ previewResult.targetPlatform }}</dd>
            </div>
            <div>
              <dt>{{ t("dashboard.routes.upstreamModel") }}</dt>
              <dd class="!text-sm">{{ previewResult.upstreamModel }}</dd>
            </div>
            <div>
              <dt>{{ t("dashboard.preview.source") }}</dt>
              <dd>{{ previewResult.resolutionSource }}</dd>
            </div>
          </dl>
        </div>
        <UiAlert v-if="previewError" tone="danger" class="mt-4">{{ previewError }}</UiAlert>
      </UiCard>
    </div>

    <!-- Egress & VM -->
    <div class="grid gap-6 xl:grid-cols-2">
      <UiCard icon="globe" :title="t('nav.clash')" flush>
        <template #actions>
          <RouterLink to="/admin/clash" class="btn btn-ghost btn-sm">
            {{ t("dashboard.clash.manage") }}
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="clashNodes.length === 0" compact icon="globe" :title="t('dashboard.clash.empty')" />
        <ul v-else class="divide-y divide-line/70">
          <li v-for="node in clashNodes.slice(0, 6)" :key="node.nodeId" class="flex items-center gap-3 px-5 py-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-fg">{{ node.name }}</p>
              <p class="mt-0.5 truncate font-mono text-2xs text-fg-subtle">
                :{{ node.listenerPort }} → {{ node.exitIp || t("dashboard.clash.notProbed") }} · {{ node.latencyMs }}ms
              </p>
            </div>
            <span class="font-mono text-2xs text-fg-subtle">{{ node.boundAccounts }}/{{ node.maxAccounts }}</span>
            <UiBadge :tone="healthTone(node.healthStatus)" dot>{{ healthLabel(node.healthStatus) }}</UiBadge>
          </li>
        </ul>
      </UiCard>

      <UiCard icon="server" :title="t('nav.vms')" flush>
        <template #actions>
          <RouterLink to="/admin/vms" class="btn btn-ghost btn-sm">
            {{ t("dashboard.clash.manage") }}
            <UiIcon name="chevron-right" :size="14" />
          </RouterLink>
        </template>
        <EmptyState v-if="vmSlots.length === 0" compact icon="server" :title="t('dashboard.vms.empty')" />
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
            <UsageMeter
              class="hidden sm:block"
              :label="t('dashboard.vms.concurrency')"
              :value="slot.activeSubagents"
              :max="slot.maxSubagents"
            />
            <UiBadge :tone="healthTone(slot.state)" dot>{{ slotStateLabel(slot.state) }}</UiBadge>
          </li>
        </ul>
      </UiCard>
    </div>

    <!-- Risk -->
    <UiCard icon="shield-alert" :title="t('dashboard.risk.title')" flush>
      <EmptyState v-if="riskEvents.length === 0" compact icon="shield" :title="t('dashboard.risk.empty')" />
      <ul v-else class="divide-y divide-line/70">
        <li v-for="ev in riskEvents" :key="ev.eventId" class="px-5 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <UiBadge :tone="ev.strikeLevel >= 3 ? 'danger' : 'warning'">
              {{ t("dashboard.risk.strike", { level: ev.strikeLevel, duration: ev.banDuration }) }}
            </UiBadge>
            <span class="text-xs text-fg-muted">{{ ev.subjectKind }}</span>
            <span class="ml-auto font-mono text-2xs text-fg-subtle">{{ formatDateTime(ev.createdAtIso) }}</span>
          </div>
          <p class="mt-1.5 font-mono text-xs text-fg">{{ ev.reason }}</p>
          <p class="mt-1 text-2xs text-fg-subtle">
            {{ t("dashboard.risk.counts", { downgraded: ev.downgradedCount, upstream400: ev.ordinaryUpstream400Count }) }}
          </p>
        </li>
      </ul>
    </UiCard>

    <!-- Global usage -->
    <UiCard icon="activity" :title="t('dashboard.usage.title')" flush>
      <EmptyState v-if="adminUsage.length === 0" compact icon="activity" :title="t('dashboard.usage.empty')" />
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ t("dashboard.usage.colRequest") }}</th>
              <th>{{ t("dashboard.usage.colModel") }}</th>
              <th>{{ t("dashboard.usage.colAccount") }}</th>
              <th>{{ t("dashboard.usage.colProtocol") }}</th>
              <th class="text-right">{{ t("dashboard.usage.colTokens") }}</th>
              <th class="text-right">{{ t("dashboard.usage.colCost") }}</th>
              <th>{{ t("common.status") }}</th>
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
