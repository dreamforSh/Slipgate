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
import { ApiError, apiJson, errorText } from "../lib/api";

const BUSY_STATES = new Set([
  "checking",
  "downloading",
  "applying",
  "reloading_planes",
  "restarting",
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
  const restarting = ref(false);
  const restartTimedOut = ref(false);
  /** Where a full-service restart is, as seen from the console: reported by the old process, then inferred. */
  const restartStage = ref<"scheduled" | "draining" | "stopping" | "starting" | null>(null);
  const savingConfig = ref(false);
  const error = ref<string | null>(null);

  let pollTimer: number | undefined;
  let inFlightLoad: Promise<SystemUpdateStatus | null> | null = null;

  const isBusy = computed(
    () =>
      checking.value ||
      applying.value ||
      rollingBack.value ||
      restarting.value ||
      (status.value !== null && BUSY_STATES.has(status.value.state)),
  );

  const updateAvailable = computed(() => Boolean(status.value?.updateAvailable));
  const needsEdgeRestart = computed(() => Boolean(status.value?.edgeBinaryStaged));
  const canRollback = computed(() => Boolean(status.value?.canRollback));
  // Dev-mode deployments skip the password / passkey re-confirmation for every update action;
  // the BFF decides (stepUpRequired), with the mode as a fallback for older backends.
  const requiresStepUp = computed(() => status.value?.stepUpRequired ?? status.value?.mode !== "dev");

  function syncPolling() {
    const active = status.value !== null && BUSY_STATES.has(status.value.state);
    if (active && !restarting.value && pollTimer === undefined) {
      pollTimer = window.setInterval(() => {
        void loadStatus(true);
      }, 1500);
    } else if ((!active || restarting.value) && !applying.value && !rollingBack.value && pollTimer !== undefined) {
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

  async function waitForRestartRecovery(prevBootId: string): Promise<SystemUpdateStatus | null> {
    restarting.value = true;
    restartTimedOut.value = false;
    restartStage.value = status.value?.restartProgress?.phase ?? "scheduled";
    stopPolling();
    error.value = null;

    const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    await sleep(1000);

    // The old process may spend the whole drain window finishing requests before it re-execs,
    // then the new one waits for its planes before it serves.
    const drainSeconds = status.value?.drainTimeoutSeconds ?? 30;
    const deadline = Date.now() + Math.max(90, drainSeconds + 90) * 1000;
    while (Date.now() < deadline) {
      try {
        const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update");
        if ((!prevBootId || next.bootId !== prevBootId) && next.state !== "restarting" && !next.restartScheduled) {
          status.value = next;
          restarting.value = false;
          restartStage.value = null;
          syncPolling();
          void loadReleases(true);
          return next;
        }
        status.value = next;
        if (next.bootId === prevBootId && next.restartProgress) {
          restartStage.value = next.restartProgress.phase;
        } else if (next.bootId !== prevBootId) {
          // A new process that is itself restarting (an automatic rollback) is still starting up.
          restartStage.value = "starting";
        }
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
          restarting.value = false;
          restartStage.value = null;
          error.value = err.message;
          syncPolling();
          throw err;
        }
        // Transient network reset / 502 / 503 while Slipgate drains and re-execs is expected.
        if (restartStage.value === "stopping" || restartStage.value === "draining") {
          restartStage.value = "starting";
        }
      }
      await sleep(1500);
    }

    restarting.value = false;
    restartStage.value = null;
    restartTimedOut.value = true;
    error.value = "Timed out waiting for Slipgate service reconnect; refresh manually to verify.";
    syncPolling();
    return null;
  }

  async function applyUpdate(opts: {
    channel?: SystemUpdateChannel;
    targetTag?: string;
    force?: boolean;
    confirm?: AdminStepUp;
  }): Promise<SystemUpdateStatus> {
    const prevBootId = status.value?.bootId ?? "";
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
      if (next.restartScheduled || next.state === "restarting") {
        applying.value = false;
        const recovered = await waitForRestartRecovery(prevBootId);
        return recovered ?? next;
      }
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
    const prevBootId = status.value?.bootId ?? "";
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
      if (next.restartScheduled || next.state === "restarting") {
        rollingBack.value = false;
        const recovered = await waitForRestartRecovery(prevBootId);
        return recovered ?? next;
      }
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

  async function restartEdge(opts: { confirm?: AdminStepUp } = {}): Promise<SystemUpdateStatus> {
    const prevBootId = status.value?.bootId ?? "";
    restarting.value = true;
    restartTimedOut.value = false;
    error.value = null;
    try {
      const next = await apiJson<SystemUpdateStatus>("/api/v1/admin/system/update/restart", {
        method: "POST",
        body: { confirm: opts.confirm },
      });
      status.value = next;
      const recovered = await waitForRestartRecovery(prevBootId);
      return recovered ?? next;
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        restarting.value = false;
        error.value = errorText(err, "Failed to restart Slipgate service");
        throw err;
      }
      const recovered = await waitForRestartRecovery(prevBootId);
      if (recovered) {
        return recovered;
      }
      throw err;
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
    restarting,
    restartTimedOut,
    restartStage,
    savingConfig,
    error,
    isBusy,
    updateAvailable,
    needsEdgeRestart,
    canRollback,
    requiresStepUp,
    loadStatus,
    loadReleases,
    checkForUpdates,
    applyUpdate,
    rollback,
    restartEdge,
    waitForRestartRecovery,
    saveConfig,
    stopPolling,
  };
});
