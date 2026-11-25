<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  AdminStepUp,
  SystemReleaseItem,
  SystemUpdateChannel,
  SystemUpdateHistoryEntry,
  SystemUpdateStatus,
  UpdateSystemConfigRequest,
} from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import UpdateActionDialog, { type UpdateActionSummary } from "../../components/admin/updates/UpdateActionDialog.vue";
import UpdateComponentsGrid from "../../components/admin/updates/UpdateComponentsGrid.vue";
import UpdateConfigCard from "../../components/admin/updates/UpdateConfigCard.vue";
import UpdateHeroCard from "../../components/admin/updates/UpdateHeroCard.vue";
import UpdateHistoryPanel from "../../components/admin/updates/UpdateHistoryPanel.vue";
import UpdateReleaseNotesCard from "../../components/admin/updates/UpdateReleaseNotesCard.vue";
import UpdateReleasesPanel from "../../components/admin/updates/UpdateReleasesPanel.vue";
import PageHeader from "../../components/ui/PageHeader.vue";
import UiAlert from "../../components/ui/UiAlert.vue";
import UiIcon from "../../components/ui/UiIcon.vue";
import UiTabs from "../../components/ui/UiTabs.vue";
import { errorText } from "../../lib/api";
import { frontendBuildChanged, stashFlash, takeFlash, type FlashMessage } from "../../lib/appBuild";
import { formatDurationMs, shortHash } from "../../lib/format";
import { useSystemUpdateStore, type RestartEvent } from "../../stores/systemUpdate";
import { useToastStore } from "../../stores/toast";

/**
 * Server states only a request that already passed the password / code check can cause (release
 * deployments never apply or restart on their own): seeing one, the dialog can close and let a
 * long download continue with its progress on the page.
 */
const EXECUTING_STATES = new Set(["downloading", "applying", "reloading_planes", "restarting", "rolling_back"]);

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const store = useSystemUpdateStore();
const toast = useToastStore();

type TabKey = "releases" | "history" | "policy";
const initialTab = route.query.tab === "history" || route.query.tab === "policy" ? route.query.tab : "releases";
const activeTab = ref<TabKey>(initialTab);

const tabs = computed(() => [
  { key: "releases" as TabKey, label: t("updates.tabs.releases"), icon: "box" as const, count: store.releases.length },
  {
    key: "history" as TabKey,
    label: t("updates.tabs.history"),
    icon: "clock" as const,
    count: store.status?.history?.length ?? 0,
  },
  { key: "policy" as TabKey, label: t("updates.tabs.policy"), icon: "sliders" as const },
]);

watch(activeTab, (value) => {
  const query = { ...route.query };
  if (value === "releases") delete query.tab;
  else query.tab = value;
  void router.replace({ query });
});

// ---- Action confirmation -------------------------------------------------------------------

type PendingAction =
  | { kind: "apply"; channel?: SystemUpdateChannel; targetTag?: string; force?: boolean; label?: string }
  | { kind: "rollback"; releaseId?: string; label: string }
  | { kind: "restart" }
  | { kind: "policy"; patch: UpdateSystemConfigRequest };

const dialogOpen = ref(false);
const pendingAction = ref<PendingAction | null>(null);

function openAction(action: PendingAction) {
  pendingAction.value = action;
  dialogOpen.value = true;
}

function channelName(channel: SystemUpdateChannel | undefined): string {
  return channel === "dev" ? t("updates.channels.shortDev") : t("updates.channels.shortStable");
}

const dialogTitle = computed(() => {
  const act = pendingAction.value;
  if (!act) return "";
  if (act.kind === "rollback") return t("updates.confirm.rollbackTitle", { target: act.label });
  if (act.kind === "restart") return t("updates.confirm.restartTitle");
  if (act.kind === "policy") return t("updates.confirm.policyTitle");
  if (act.force) return t("updates.confirm.reinstallTitle", { target: act.label ?? "" });
  return t("updates.confirm.applyTitle");
});

const dialogConfirmLabel = computed(() => {
  const act = pendingAction.value;
  if (act?.kind === "rollback") return t("updates.confirm.rollbackConfirm");
  if (act?.kind === "restart") return t("updates.confirm.restartConfirm");
  if (act?.kind === "policy") return t("updates.confirm.policyConfirm");
  return t("updates.confirm.applyConfirm");
});

const dialogSummary = computed<UpdateActionSummary | null>(() => {
  const act = pendingAction.value;
  const st = store.status;
  if (!act || !st) return null;
  const current = `${st.version} (${shortHash(st.activeCommit, 8)})`;
  const drain = st.drainTimeoutSeconds || 30;
  const restartEffect = t("updates.confirm.effectRestart", { seconds: drain });
  const caution = t("updates.confirm.cautionDrain", { seconds: drain });

  if (act.kind === "policy") return policySummary(st, act.patch);

  if (act.kind === "restart") {
    const rows: UpdateActionSummary["rows"] = [{ label: t("updates.confirm.currentVersion"), value: current }];
    if (st.edgeBinaryStaged && st.edgeBinaryPath) {
      // The last path segments identify the staged bundle; the full path is on the component card.
      const tail = st.edgeBinaryPath.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
      rows.push({ label: t("updates.confirm.stagedEdge"), value: tail, accent: true });
    }
    return {
      icon: "zap",
      rows,
      effects: [restartEffect, t("updates.confirm.effectHealth")],
      caution,
    };
  }

  const effects =
    act.kind === "apply" ? [t("updates.confirm.effectDownload")] : [t("updates.confirm.effectRollbackBundle")];
  effects.push(st.autoRestartAfterUpdate ? restartEffect : t("updates.confirm.effectReloadOnly"));
  if (st.autoRestartAfterUpdate) effects.push(t("updates.confirm.effectAutoRollback"));

  const target =
    act.kind === "rollback"
      ? act.label
      : (act.label ?? st.remoteVersion ?? st.remoteTag ?? shortHash(st.remoteCommit, 9));
  const rows: UpdateActionSummary["rows"] = [
    { label: t("updates.confirm.currentVersion"), value: current },
    { label: t("updates.confirm.targetVersion"), value: target, accent: true },
  ];
  if (act.kind === "apply") rows.push({ label: t("updates.confirm.channel"), value: channelName(act.channel ?? st.channel) });
  return {
    icon: act.kind === "rollback" ? "rotate-ccw" : "download",
    rows,
    effects,
    caution: st.autoRestartAfterUpdate ? caution : undefined,
  };
});

/** The policy fields a save changes, as "before → after" rows. */
function policySummary(st: SystemUpdateStatus, patch: UpdateSystemConfigRequest): UpdateActionSummary {
  const onOff = (on: boolean) => (on ? t("common.enabled") : t("common.disabled"));
  const seconds = (n: number) => t("updates.policy.drainPreset", { seconds: n });
  const rows: UpdateActionSummary["rows"] = [];
  const add = (label: string, before: string, after: string) => {
    if (before !== after) rows.push({ label, value: `${before} → ${after}`, accent: true });
  };
  if (patch.channel !== undefined) add(t("updates.confirm.channel"), channelName(st.channel), channelName(patch.channel));
  if (patch.strategy !== undefined) {
    add(t("updates.policy.strategyLabel"), t(`updates.strategies.${st.strategy}`), t(`updates.strategies.${patch.strategy}`));
  }
  if (patch.autoSyncEnabled !== undefined) {
    add(t("updates.confirm.autoSyncRow"), onOff(st.autoSyncEnabled), onOff(patch.autoSyncEnabled));
  }
  if (patch.intervalSeconds !== undefined) {
    add(t("updates.confirm.intervalRow"), seconds(st.intervalSeconds), seconds(patch.intervalSeconds));
  }
  if (patch.autoRestartAfterUpdate !== undefined) {
    add(t("updates.confirm.autoRestartRow"), onOff(st.autoRestartAfterUpdate), onOff(patch.autoRestartAfterUpdate));
  }
  if (patch.drainTimeoutSeconds !== undefined) {
    add(t("updates.policy.drainLabel"), seconds(st.drainTimeoutSeconds), seconds(patch.drainTimeoutSeconds));
  }
  return { icon: "sliders", rows, effects: [t("updates.confirm.policyEffect")] };
}

function reportFailure(err: unknown) {
  toast.error(errorText(err, t("common.requestFailed")));
}

function startAction(act: PendingAction, confirm: AdminStepUp | undefined): Promise<SystemUpdateStatus | null> {
  if (act.kind === "policy") return store.saveConfig({ ...act.patch, confirm });
  if (act.kind === "apply") {
    return store.applyUpdate({ channel: act.channel, targetTag: act.targetTag, force: act.force, confirm });
  }
  if (act.kind === "rollback") return store.rollback({ releaseId: act.releaseId, confirm });
  return store.restart({ confirm });
}

function onAccepted(act: PendingAction, next: SystemUpdateStatus | null, before: SystemUpdateStatus | null) {
  if (act.kind === "policy") {
    onPolicySaved(act.patch, before);
    return;
  }
  // A restart that follows is reported by the restart banner and announced when it completes.
  if (next === null || next.restartScheduled || next.state === "restarting") {
    toast.info(t("updates.toast.restarting"));
    return;
  }
  if (act.kind === "rollback") toast.success(t("updates.toast.rolledBack", { version: next.version }));
  else if (act.kind === "apply") toast.success(t("updates.toast.applied", { version: next.version }));
}

/**
 * Runs the confirmed action. Without a password to check (dev mode) the dialog closes at once.
 * Otherwise it stays until the server answers or visibly starts working (only a request that
 * passed the password / code check gets that far), so a refusal always lands on its field, even
 * on a slow link; a long download then continues with its progress on the page.
 */
async function submitAction(confirm: AdminStepUp | undefined) {
  const act = pendingAction.value;
  if (!act) return;
  const before = store.status;
  const request = startAction(act, confirm);
  const later = () => void request.then((next) => onAccepted(act, next, before)).catch(reportFailure);
  if (!store.requiresStepUp) {
    later();
    return;
  }
  let stopWatch = () => {};
  const started = new Promise<"started">((resolve) => {
    stopWatch = watch(
      () => store.status?.state,
      (state) => {
        if (state && EXECUTING_STATES.has(state)) resolve("started");
      },
    );
  });
  const first = await Promise.race([
    request.then(
      (next) => ({ next }),
      (err: unknown) => ({ err }),
    ),
    started,
  ]).finally(() => stopWatch());
  if (first === "started") {
    later();
    return;
  }
  if ("err" in first) throw first.err;
  onAccepted(act, first.next, before);
}

function requestApply(opts: { channel?: SystemUpdateChannel; targetTag?: string; force?: boolean; label?: string } = {}) {
  openAction({ kind: "apply", ...opts });
}

function requestInstallRelease(rel: SystemReleaseItem) {
  requestApply({ channel: rel.channel, targetTag: rel.tag, force: rel.current, label: rel.tag });
}

function requestRollbackLatest() {
  const prev = store.status?.previousRelease;
  openAction({ kind: "rollback", releaseId: prev?.id, label: prev?.tag ?? prev?.version ?? "-" });
}

function requestRestoreHistory(entry: SystemUpdateHistoryEntry) {
  openAction({ kind: "rollback", releaseId: entry.id, label: entry.tag ?? entry.toVersion });
}

function requestRestart() {
  openAction({ kind: "restart" });
}

// ---- Restart announcements -----------------------------------------------------------------

/** The build this tab's console belongs to, for when the served entry script cannot be compared. */
const loadedBuild = ref<{ version: string; commit: string } | null>(null);

function showFlash(flash: FlashMessage) {
  if (flash.tone === "warning") toast.warning(flash.message);
  else if (flash.tone === "info") toast.info(flash.message);
  else toast.success(flash.message);
}

async function announceRestart(ev: RestartEvent) {
  const result = ev.result;
  if (result.kind === "timeout") {
    toast.warning(t("updates.toast.restartTimeout"));
    return;
  }
  if (result.kind === "error") {
    toast.error(result.message);
    return;
  }
  if (result.kind === "signed_out") {
    // Sessions did not survive the restart (memory store): sign in again on the new process.
    stashFlash({ tone: "info", message: t("updates.toast.restartedSignedOut") });
    window.location.reload();
    return;
  }

  const next = result.status;
  const report = next.lastRestart && next.lastRestart.id !== ev.previous.lastRestartId ? next.lastRestart : null;
  let flash: FlashMessage;
  if (report?.outcome === "rolled_back") {
    flash = { tone: "warning", message: t("updates.toast.restartRolledBack", { version: next.version }) };
  } else if (report?.outcome === "degraded") {
    flash = { tone: "warning", message: t("updates.toast.restartDegraded", { message: report.message ?? "" }) };
  } else {
    const key = ev.external ? "updates.toast.restartedExternal" : "updates.toast.restarted";
    const duration = report ? formatDurationMs(report.durationMs) : "—";
    flash = { tone: "success", message: t(key, { version: next.version, duration }) };
  }

  const changed = await frontendBuildChanged();
  const built = loadedBuild.value;
  const newConsole =
    changed === true || (changed === null && built !== null && (built.version !== next.version || built.commit !== next.activeCommit));
  if (newConsole && !ev.external) {
    stashFlash({ ...flash, message: `${flash.message} ${t("updates.toast.consoleReloaded")}` });
    window.setTimeout(() => window.location.reload(), 400);
    return;
  }
  // A restart this admin did not ask for must not reload under their hands (unsaved edits):
  // offer the reload instead.
  if (newConsole) consoleUpdateReady.value = true;
  showFlash(flash);
}

const consoleUpdateReady = ref(false);

function reloadConsole() {
  window.location.reload();
}

watch(
  () => store.restartEvent,
  (ev) => {
    if (ev) void announceRestart(ev);
  },
);

// ---- Misc ----------------------------------------------------------------------------------

async function refreshAll() {
  await Promise.all([store.loadStatus(), store.loadReleases(true)]);
}

async function handleCheck() {
  const next = await store.checkForUpdates();
  if (!next) return;
  if (next.updateAvailable) {
    toast.info(t("updates.toast.checkedNew", { version: next.remoteVersion ?? next.remoteTag ?? next.remoteCommit ?? "" }));
  } else {
    toast.success(t("updates.toast.upToDate"));
  }
  void store.loadReleases(true);
}

function onPolicySaved(patch: UpdateSystemConfigRequest, before: SystemUpdateStatus | null) {
  toast.success(t("updates.policy.saved"));
  // Only a different channel or strategy changes what "latest" means; skip the GitHub round trip otherwise.
  if (before && (patch.channel !== before.channel || patch.strategy !== before.strategy)) {
    void store.checkForUpdates().then(() => store.loadReleases(true));
  }
}

async function handleSaveConfig(patch: UpdateSystemConfigRequest) {
  // Release deployments confirm a policy change like the update actions themselves.
  if (store.requiresStepUp) {
    openAction({ kind: "policy", patch });
    return;
  }
  const before = store.status;
  try {
    await store.saveConfig(patch);
  } catch (err) {
    reportFailure(err);
    return;
  }
  onPolicySaved(patch, before);
}

onMounted(async () => {
  const flash = takeFlash();
  if (flash) showFlash(flash);
  store.startWatching();
  void store.loadReleases(false);
  const first = await store.loadStatus();
  if (first) loadedBuild.value = { version: first.version, commit: first.activeCommit };
});

onBeforeUnmount(() => {
  store.stopWatching();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('updates.title')">
      <template #meta>
        <span class="hidden text-sm text-fg-subtle lg:inline">{{ t("updates.subtitle") }}</span>
      </template>
      <template #actions>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="store.loading || store.releasesLoading || store.restarting"
          @click="refreshAll"
        >
          <UiIcon name="refresh" :size="15" :spin="store.loading || store.releasesLoading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </PageHeader>

    <UiAlert v-if="store.status?.standalone" tone="info">
      {{ t("updates.standaloneBanner") }}
    </UiAlert>

    <UiAlert v-if="consoleUpdateReady" tone="info">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <span class="text-xs">{{ t("updates.consoleUpdateReady") }}</span>
        <button type="button" class="btn btn-primary btn-sm" @click="reloadConsole">
          <UiIcon name="refresh" :size="14" />
          {{ t("updates.reloadConsole") }}
        </button>
      </div>
    </UiAlert>

    <UpdateHeroCard
      :status="store.status"
      :checking="store.checking"
      :applying="store.applying"
      :rolling-back="store.rollingBack"
      :restarting="store.restarting"
      :restart-stage="store.restartStage"
      :restart-started-at="store.restartStartedAt"
      :step-up-required="store.requiresStepUp"
      :busy="store.isBusy"
      :error="store.error"
      @check="handleCheck"
      @apply="requestApply()"
      @rollback="requestRollbackLatest"
      @restart="requestRestart"
      @dismiss-error="store.clearError()"
    />

    <div class="grid gap-6 lg:grid-cols-12">
      <UpdateReleaseNotesCard :status="store.status" class="lg:col-span-7" />
      <UpdateComponentsGrid :status="store.status" class="lg:col-span-5" />
    </div>

    <div>
      <UiTabs v-model="activeTab" :tabs="tabs" />
      <div class="pt-5">
        <UpdateReleasesPanel
          v-show="activeTab === 'releases'"
          :releases="store.releases"
          :loading="store.releasesLoading"
          :error="store.releasesError"
          :fetched-at-iso="store.releasesMeta.fetchedAtIso"
          :busy="store.isBusy"
          :standalone="Boolean(store.status?.standalone)"
          :step-up-required="store.requiresStepUp"
          @refresh="store.loadReleases(true)"
          @install="requestInstallRelease"
        />
        <UpdateHistoryPanel
          v-show="activeTab === 'history'"
          :history="store.status?.history ?? []"
          :busy="store.isBusy"
          :standalone="Boolean(store.status?.standalone)"
          :step-up-required="store.requiresStepUp"
          @restore="requestRestoreHistory"
        />
        <UpdateConfigCard
          v-show="activeTab === 'policy'"
          :status="store.status"
          :saving="store.savingConfig"
          :step-up-required="store.requiresStepUp"
          @save="handleSaveConfig"
        />
      </div>
    </div>

    <UpdateActionDialog
      v-model:open="dialogOpen"
      :title="dialogTitle"
      :confirm-label="dialogConfirmLabel"
      :summary="dialogSummary"
      :require-step-up="store.requiresStepUp"
      :submit="submitAction"
    />
  </div>
</template>
