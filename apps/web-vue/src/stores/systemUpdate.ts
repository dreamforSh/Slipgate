import { defineStore } from "pinia";
import { computed, ref } from "vue";
import type {
  AdminStepUp,
  SystemReleaseItem,
  SystemReleasesResponse,
  SystemUpdateChannel,
  SystemUpdateStatus,
  UpdateSystemConfigRequest,
} from "@slipgate/contracts";
import { apiJson, errorText } from "../lib/api";

const BUSY_STATES = new Set([
  "checking",
  "downloading",
  "applying",
  "reloading_planes",
  "rolling_back",
]);

export const useSystemUpdateStore = defineStore("systemUpdate", () => {
  const status = ref<SystemUpdateStatus | null>(null);
  const releases = ref<SystemReleaseItem[]>([]);
  const releasesMeta = ref<{ repo: string; fetchedAtIso: string | null; standalone: boolean }>({
    repo: "dreamforSh/Slipgate",
    fetchedAtIso: null,
    standalone: false,
  });

  const loading = ref(false);
  const releasesLoading = ref(false);
  const checking = ref(false);
  const applying = ref(false);
  const rollingBack = ref(false);
  const savingConfig = ref(false);
  const error = ref<string | null>(null);

  let pollTimer: number | undefined;
  let inFlightLoad: Promise<SystemUpdateStatus | null> | null = null;

  const isBusy = computed(
    () =>
      checking.value ||
      applying.value ||
      rollingBack.value ||
      (status.value !== null && BUSY_STATES.has(status.value.state)),
  );

  const updateAvailable = computed(() => Boolean(status.value?.updateAvailable));
  const needsEdgeRestart = computed(() => Boolean(status.value?.edgeBinaryStaged));
  const canRollback = computed(() => Boolean(status.value?.canRollback));
  const requiresStepUpForApply = computed(() => status.value?.mode !== "dev");

  function syncPolling() {
    const active = status.value !== null && BUSY_STATES.has(status.value.state);
    if (active && pollTimer === undefined) {
      pollTimer = window.setInterval(() => {
        void loadStatus(true);
      }, 1500);
    } else if (!active && !applying.value && !rollingBack.value && pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function stopPolling() {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  async function loadStatus(silent = false): Promise<SystemUpdateStatus | null> {
    if (inFlightLoad) return inFlightLoad;
    if (!silent) {
      loading.value = true;
      error.value = null;
    }
    inFlightLoad = (async () => {
      try {
        const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update");
        status.value = next;
        syncPolling();
        return next;
      } catch (err) {
        if (!silent) {
          error.value = errorText(err, "Failed to load system update status");
        }
        return null;
      } finally {
        loading.value = false;
        inFlightLoad = null;
      }
    })();
    return inFlightLoad;
  }

  async function loadReleases(refresh = false): Promise<SystemReleasesResponse | null> {
    releasesLoading.value = true;
    try {
      const qs = refresh ? "?refresh=1" : "";
      const data = await apiJson<SystemReleasesResponse>(`/api/v1/admin/system/update/releases${qs}`);
      releases.value = data.releases;
      releasesMeta.value = {
        repo: data.repo,
        fetchedAtIso: data.fetchedAtIso,
        standalone: data.standalone,
      };
      return data;
    } catch (err) {
      error.value = errorText(err, "Failed to load release catalog");
      return null;
    } finally {
      releasesLoading.value = false;
    }
  }

  async function checkForUpdates(channel?: SystemUpdateChannel): Promise<SystemUpdateStatus | null> {
    checking.value = true;
    error.value = null;
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/sync", {
        method: "POST",
        body: { checkOnly: true, channel },
      });
      status.value = next;
      return next;
    } catch (err) {
      error.value = errorText(err, "Failed to check for updates");
      void loadStatus(true);
      return null;
    } finally {
      checking.value = false;
      syncPolling();
    }
  }

  async function applyUpdate(opts: {
    channel?: SystemUpdateChannel;
    targetTag?: string;
    force?: boolean;
    confirm?: AdminStepUp;
  }): Promise<SystemUpdateStatus> {
    applying.value = true;
    error.value = null;
    // Start polling right away so download bytes & stage stepper update live while the request runs.
    if (pollTimer === undefined) {
      pollTimer = window.setInterval(() => {
        void loadStatus(true);
      }, 1500);
    }
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/sync", {
        method: "POST",
        body: {
          checkOnly: false,
          channel: opts.channel,
          targetTag: opts.targetTag,
          force: opts.force ?? false,
          confirm: opts.confirm,
        },
      });
      status.value = next;
      void loadReleases(true);
      return next;
    } catch (err) {
      error.value = errorText(err, "Failed to apply system update");
      void loadStatus(true);
      throw err;
    } finally {
      applying.value = false;
      syncPolling();
    }
  }

  async function rollback(opts: { releaseId?: string; confirm?: AdminStepUp }): Promise<SystemUpdateStatus> {
    rollingBack.value = true;
    error.value = null;
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/rollback", {
        method: "POST",
        body: {
          releaseId: opts.releaseId,
          confirm: opts.confirm,
        },
      });
      status.value = next;
      void loadReleases(true);
      return next;
    } catch (err) {
      error.value = errorText(err, "Failed to roll back release");
      void loadStatus(true);
      throw err;
    } finally {
      rollingBack.value = false;
      syncPolling();
    }
  }

  async function saveConfig(patch: UpdateSystemConfigRequest): Promise<SystemUpdateStatus | null> {
    savingConfig.value = true;
    error.value = null;
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/config", {
        method: "PUT",
        body: patch,
      });
      status.value = next;
      return next;
    } catch (err) {
      error.value = errorText(err, "Failed to update policy");
      throw err;
    } finally {
      savingConfig.value = false;
    }
  }

  return {
    status,
    releases,
    releasesMeta,
    loading,
    releasesLoading,
    checking,
    applying,
    rollingBack,
    savingConfig,
    error,
    isBusy,
    updateAvailable,
    needsEdgeRestart,
    canRollback,
    requiresStepUpForApply,
    loadStatus,
    loadReleases,
    checkForUpdates,
    applyUpdate,
    rollback,
    saveConfig,
    stopPolling,
  };
});
