<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  AdminStepUp,
  SystemReleaseItem,
  SystemUpdateChannel,
  SystemUpdateHistoryEntry,
  UpdateSystemConfigRequest,
} from "@slipgate/contracts";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import AdminStepUpModal from "../../components/admin/AdminStepUpModal.vue";
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
import { useSystemUpdateStore } from "../../stores/systemUpdate";
import { useToastStore } from "../../stores/toast";

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

type PendingAction =
  | { kind: "apply"; channel?: SystemUpdateChannel; targetTag?: string; force?: boolean; label?: string }
  | { kind: "rollback"; releaseId?: string; label: string }
  | { kind: "restart" };

const stepUpOpen = ref(false);
const pendingAction = ref<PendingAction | null>(null);

const stepUpTitle = computed(() => {
  const act = pendingAction.value;
  if (!act) return t("updates.stepUp.applyTitle");
  if (act.kind === "rollback") {
    return t("updates.stepUp.rollbackTitle", { target: act.label });
  }
  if (act.kind === "restart") {
    return t("updates.stepUp.restartTitle");
  }
  return t("updates.stepUp.applyTitle");
});

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

function handlePostMutationFeedback(
  next: { version: string; bootId?: string; state: string; restartScheduled?: boolean },
  beforeBootId: string,
  defaultMsg: string,
) {
  if (store.restartTimedOut || next.state === "restarting" || next.restartScheduled) {
    toast.warning(t("updates.toast.restartTimeout"));
    return;
  }
  if (beforeBootId && next.bootId && next.bootId !== beforeBootId) {
    toast.success(t("updates.toast.restarted", { version: next.version }));
    window.setTimeout(() => window.location.reload(), 1000);
    return;
  }
  toast.success(defaultMsg);
}

async function runApply(opts: { channel?: SystemUpdateChannel; targetTag?: string; force?: boolean; confirm?: AdminStepUp }) {
  const beforeBootId = store.status?.bootId ?? "";
  const next = await store.applyUpdate(opts);
  handlePostMutationFeedback(next, beforeBootId, t("updates.toast.applied", { version: next.version }));
}

async function runRollback(opts: { releaseId?: string; confirm?: AdminStepUp }) {
  const beforeBootId = store.status?.bootId ?? "";
  const next = await store.rollback(opts);
  handlePostMutationFeedback(next, beforeBootId, t("updates.toast.rolledBack", { version: next.version }));
}

async function runRestartEdge(opts: { confirm?: AdminStepUp } = {}) {
  const beforeBootId = store.status?.bootId ?? "";
  const next = await store.restartEdge(opts);
  if (store.restartTimedOut || next.state === "restarting" || next.restartScheduled) {
    toast.warning(t("updates.toast.restartTimeout"));
    return;
  }
  if (!beforeBootId || !next.bootId || next.bootId !== beforeBootId) {
    toast.success(t("updates.toast.restarted", { version: next.version }));
    window.setTimeout(() => window.location.reload(), 1000);
  }
}

function requestApply(opts: { channel?: SystemUpdateChannel; targetTag?: string; force?: boolean; label?: string } = {}) {
  if (store.requiresStepUpForApply) {
    pendingAction.value = { kind: "apply", ...opts };
    stepUpOpen.value = true;
    return;
  }
  void runApply(opts).catch((err) => {
    toast.error(errorText(err, t("common.requestFailed")));
  });
}

function requestInstallRelease(rel: SystemReleaseItem) {
  requestApply({
    channel: rel.channel,
    targetTag: rel.tag,
    force: rel.current,
    label: rel.tag,
  });
}

function requestRollbackLatest() {
  const prev = store.status?.previousRelease;
  const label = prev?.tag ?? prev?.version ?? "-";
  pendingAction.value = {
    kind: "rollback",
    releaseId: prev?.id,
    label,
  };
  stepUpOpen.value = true;
}

function requestRestoreHistory(entry: SystemUpdateHistoryEntry) {
  pendingAction.value = {
    kind: "rollback",
    releaseId: entry.id,
    label: entry.tag ?? entry.toVersion,
  };
  stepUpOpen.value = true;
}

function requestRestartEdge() {
  if (store.requiresStepUpForApply) {
    pendingAction.value = { kind: "restart" };
    stepUpOpen.value = true;
    return;
  }
  void runRestartEdge().catch((err) => {
    toast.error(errorText(err, t("common.requestFailed")));
  });
}

async function executeStepUpAction(confirm: AdminStepUp) {
  const act = pendingAction.value;
  if (!act) return;
  if (act.kind === "apply") {
    await runApply({
      channel: act.channel,
      targetTag: act.targetTag,
      force: act.force,
      confirm,
    });
  } else if (act.kind === "restart") {
    await runRestartEdge({ confirm });
  } else {
    await runRollback({
      releaseId: act.releaseId,
      confirm,
    });
  }
  pendingAction.value = null;
}

async function handleSaveConfig(patch: UpdateSystemConfigRequest) {
  try {
    await store.saveConfig(patch);
    toast.success(t("updates.policy.saved"));
    await store.checkForUpdates();
  } catch (err) {
    toast.error(errorText(err, t("common.requestFailed")));
  }
}

onMounted(() => {
  void store.loadStatus();
  void store.loadReleases(false);
});

onBeforeUnmount(() => {
  store.stopPolling();
});
</script>

<template>
  <div class="space-y-6">
    <PageHeader :title="t('updates.title')">
      <template #meta>
        <span class="hidden text-sm text-fg-subtle lg:inline">{{ t("updates.subtitle") }}</span>
      </template>
      <template #actions>
        <button type="button" class="btn btn-secondary" :disabled="store.loading || store.releasesLoading" @click="refreshAll">
          <UiIcon name="refresh" :size="15" :spin="store.loading || store.releasesLoading" />
          {{ t("common.refresh") }}
        </button>
      </template>
    </PageHeader>

    <UiAlert v-if="store.status?.standalone" tone="info">
      {{ t("updates.standaloneBanner") }}
    </UiAlert>

    <UpdateHeroCard
      :status="store.status"
      :checking="store.checking"
      :applying="store.applying"
      :rolling-back="store.rollingBack"
      :restarting="store.restarting"
      :busy="store.isBusy"
      :error="store.error"
      @check="handleCheck"
      @apply="requestApply()"
      @rollback="requestRollbackLatest"
      @restart="requestRestartEdge"
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
          :busy="store.isBusy"
          :standalone="Boolean(store.status?.standalone)"
          @refresh="store.loadReleases(true)"
          @install="requestInstallRelease"
        />
        <UpdateHistoryPanel
          v-show="activeTab === 'history'"
          :history="store.status?.history ?? []"
          :busy="store.isBusy"
          :standalone="Boolean(store.status?.standalone)"
          @restore="requestRestoreHistory"
        />
        <UpdateConfigCard
          v-show="activeTab === 'policy'"
          :status="store.status"
          :saving="store.savingConfig"
          @save="handleSaveConfig"
        />
      </div>
    </div>

    <AdminStepUpModal v-model:open="stepUpOpen" :title="stepUpTitle" :action="executeStepUpAction" />
  </div>
</template>
