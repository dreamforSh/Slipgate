import type { Context, Hono } from "hono";
import {
  RestartUpdateRequestSchema,
  RollbackUpdateRequestSchema,
  SystemReleasesResponseSchema,
  SystemUpdateStatusSchema,
  TriggerUpdateSyncRequestSchema,
  UpdateSystemConfigRequestSchema,
  type AdminStepUp,
  type DevSyncStrategy,
  type SystemUpdateChannel,
  type SystemUpdateMode,
  type SystemUpdateStatus,
} from "@slipgate/contracts";
import type { AuthEnv, SessionManager } from "../middleware/auth.ts";
import { totpStepUp } from "../security/step_up.ts";
import type { ControlStore } from "../store/types.ts";

export interface SystemUpdateRoutesDeps {
  store: ControlStore;
  sessions: SessionManager;
  vaultSecret: string;
  buildStandaloneSystemUpdateStatus: () => SystemUpdateStatus;
}

interface StandalonePolicy {
  channel: SystemUpdateChannel;
  autoSyncEnabled: boolean;
  intervalSeconds: number;
  autoRestartAfterUpdate: boolean;
  drainTimeoutSeconds: number;
  strategy: DevSyncStrategy;
}

/**
 * Whether update actions (apply, rollback, restart) and update-policy changes need the
 * administrator to re-confirm with a password or passkey (static admin API keys are refused).
 * Dev-mode deployments (SLIPGATE_MODE=dev) are developer sandboxes that auto-apply their own
 * channel, so they skip it; release deployments always ask.
 */
export function updateStepUpRequired(mode: SystemUpdateMode): boolean {
  return mode !== "dev";
}

function withStepUpPolicy(status: SystemUpdateStatus): SystemUpdateStatus {
  return { ...status, stepUpRequired: updateStepUpRequired(status.mode) };
}

async function readJsonBody(c: Context): Promise<{ ok: true; data: unknown } | { ok: false; response: Response }> {
  const rawText = await c.req.text();
  if (rawText.trim().length === 0) {
    return { ok: true, data: {} };
  }
  try {
    return { ok: true, data: JSON.parse(rawText) };
  } catch {
    return {
      ok: false,
      response: c.json({ error: "invalid_request", message: "Malformed JSON request body" }, 400),
    };
  }
}

function supervisorCredentials(): { url: string; token: string } | null {
  const url = process.env.SLIPGATE_NET_INTERNAL_URL?.trim();
  const token = process.env.SLIPGATE_INTERNAL_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

function forwardSupervisorErrorStatus(status: number): 400 | 409 | 502 {
  if (status === 400) return 400;
  if (status === 409) return 409;
  return 502;
}

function unreachableResponse(c: Context, err: unknown): Response {
  return c.json(
    {
      error: "net_supervisor_unreachable",
      message: err instanceof Error ? err.message : String(err),
    },
    502,
  );
}

type SupervisorStatusResult = { ok: true; status: SystemUpdateStatus } | { ok: false; response: Response };

async function fetchSupervisorStatus(
  c: Context,
  sup: { url: string; token: string },
): Promise<SupervisorStatusResult> {
  const res = await fetch(`${sup.url}/internal/supervisor/update`, {
    headers: { "X-Slipgate-Internal-Token": sup.token },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: false, response: c.json(payload, forwardSupervisorErrorStatus(res.status)) };
  }
  return { ok: true, status: SystemUpdateStatusSchema.parse(await res.json()) };
}

/**
 * Registers admin system update, release catalog, policy config, rollback, and restart endpoints
 * under /api/v1/admin/system/update*.
 */
export function registerSystemUpdateRoutes(app: Hono<AuthEnv>, deps: SystemUpdateRoutesDeps): void {
  const { store, sessions, vaultSecret, buildStandaloneSystemUpdateStatus } = deps;
  const initialStandalone = buildStandaloneSystemUpdateStatus();
  const standalonePolicy: StandalonePolicy = {
    channel: initialStandalone.channel,
    autoSyncEnabled: initialStandalone.autoSyncEnabled,
    intervalSeconds: initialStandalone.intervalSeconds,
    autoRestartAfterUpdate: initialStandalone.autoRestartAfterUpdate,
    drainTimeoutSeconds: initialStandalone.drainTimeoutSeconds,
    strategy: initialStandalone.strategy,
  };

  function currentStandaloneStatus(extra?: Partial<SystemUpdateStatus>): SystemUpdateStatus {
    const base = buildStandaloneSystemUpdateStatus();
    return withStepUpPolicy(
      SystemUpdateStatusSchema.parse({
        ...base,
        standalone: true,
        channel: standalonePolicy.channel,
        autoSyncEnabled: standalonePolicy.autoSyncEnabled,
        intervalSeconds: standalonePolicy.intervalSeconds,
        autoRestartAfterUpdate: standalonePolicy.autoRestartAfterUpdate,
        drainTimeoutSeconds: standalonePolicy.drainTimeoutSeconds,
        strategy: standalonePolicy.strategy,
        resolvedStrategy: standalonePolicy.strategy === "git" ? "git" : "release",
        githubTokenConfigured: Boolean(process.env.SLIPGATE_GITHUB_TOKEN || process.env.GITHUB_TOKEN),
        canRollback: false,
        components: [
          { name: "bff", status: "running", overridden: false, restartRequired: false, pid: process.pid },
          { name: "webui", status: "embedded", overridden: false, restartRequired: false, pid: 0 },
        ],
        ...extra,
      }),
    );
  }

  /** null when the action may proceed: dev mode, or a valid password / passkey confirmation. */
  async function confirmIfRequired(
    c: Context<AuthEnv>,
    mode: SystemUpdateMode,
    confirm: AdminStepUp | undefined,
  ): Promise<Response | null> {
    if (!updateStepUpRequired(mode)) return null;
    const claims = c.get("authUser");
    return totpStepUp(store, vaultSecret).confirmAdmin(c, sessions, claims.sub, confirm);
  }

  async function forwardMutation(
    c: Context<AuthEnv>,
    sup: { url: string; token: string },
    path: string,
    method: "POST" | "PUT",
    body: unknown,
    timeoutMs: number,
  ): Promise<Response> {
    const res = await fetch(`${sup.url}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Slipgate-Internal-Token": sup.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return c.json(payload, forwardSupervisorErrorStatus(res.status));
    }
    return c.json(withStepUpPolicy(SystemUpdateStatusSchema.parse(payload)));
  }

  app.get("/api/v1/admin/system/update", async (c) => {
    const sup = supervisorCredentials();
    if (!sup) {
      return c.json(currentStandaloneStatus());
    }
    try {
      const result = await fetchSupervisorStatus(c, sup);
      if (!result.ok) return result.response;
      return c.json(withStepUpPolicy(result.status));
    } catch (err) {
      return unreachableResponse(c, err);
    }
  });

  app.get("/api/v1/admin/system/update/releases", async (c) => {
    const sup = supervisorCredentials();
    if (!sup) {
      const base = currentStandaloneStatus();
      return c.json(
        SystemReleasesResponseSchema.parse({
          repo: base.repo,
          currentVersion: base.version,
          currentCommit: base.activeCommit,
          standalone: true,
          fetchedAtIso: new Date().toISOString(),
          releases: [],
        }),
      );
    }
    const refresh = c.req.query("refresh") === "1" || c.req.query("refresh") === "true";
    const qs = refresh ? "?refresh=1" : "";
    try {
      const res = await fetch(`${sup.url}/internal/supervisor/update/releases${qs}`, {
        headers: { "X-Slipgate-Internal-Token": sup.token },
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return c.json(payload, forwardSupervisorErrorStatus(res.status));
      }
      return c.json(SystemReleasesResponseSchema.parse(payload));
    } catch (err) {
      return unreachableResponse(c, err);
    }
  });

  app.post("/api/v1/admin/system/update/sync", async (c) => {
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;

    const parsed = TriggerUpdateSyncRequestSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }

    const sup = supervisorCredentials();
    if (!sup) {
      return c.json(currentStandaloneStatus({ lastCheckedAtIso: new Date().toISOString() }));
    }

    try {
      if (!parsed.data.checkOnly) {
        const current = await fetchSupervisorStatus(c, sup);
        if (!current.ok) return current.response;
        const denied = await confirmIfRequired(c, current.status.mode, parsed.data.confirm);
        if (denied) return denied;
      }

      // Never forward admin step-up credentials to the net supervisor.
      return await forwardMutation(
        c,
        sup,
        "/internal/supervisor/update/sync",
        "POST",
        {
          checkOnly: parsed.data.checkOnly,
          channel: parsed.data.channel,
          targetTag: parsed.data.targetTag,
          force: parsed.data.force,
          allowReleaseApply: !parsed.data.checkOnly,
        },
        180_000,
      );
    } catch (err) {
      return unreachableResponse(c, err);
    }
  });

  app.put("/api/v1/admin/system/update/config", async (c) => {
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;

    const parsed = UpdateSystemConfigRequestSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }

    // The policy decides what code this deployment runs (channel, strategy, automatic restarts),
    // so it is confirmed like the update actions themselves; confirm is never forwarded.
    const { confirm, ...policy } = parsed.data;
    const sup = supervisorCredentials();
    if (!sup) {
      const denied = await confirmIfRequired(c, currentStandaloneStatus().mode, confirm);
      if (denied) return denied;
      if (parsed.data.channel !== undefined) standalonePolicy.channel = parsed.data.channel;
      if (parsed.data.autoSyncEnabled !== undefined) standalonePolicy.autoSyncEnabled = parsed.data.autoSyncEnabled;
      if (parsed.data.intervalSeconds !== undefined) standalonePolicy.intervalSeconds = parsed.data.intervalSeconds;
      if (parsed.data.autoRestartAfterUpdate !== undefined) {
        standalonePolicy.autoRestartAfterUpdate = parsed.data.autoRestartAfterUpdate;
      }
      if (parsed.data.drainTimeoutSeconds !== undefined) {
        standalonePolicy.drainTimeoutSeconds = parsed.data.drainTimeoutSeconds;
      }
      if (parsed.data.strategy !== undefined) standalonePolicy.strategy = parsed.data.strategy;
      return c.json(currentStandaloneStatus());
    }

    try {
      const current = await fetchSupervisorStatus(c, sup);
      if (!current.ok) return current.response;
      const denied = await confirmIfRequired(c, current.status.mode, confirm);
      if (denied) return denied;

      return await forwardMutation(c, sup, "/internal/supervisor/update/config", "PUT", policy, 10_000);
    } catch (err) {
      return unreachableResponse(c, err);
    }
  });

  app.post("/api/v1/admin/system/update/rollback", async (c) => {
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;

    const parsed = RollbackUpdateRequestSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }

    const sup = supervisorCredentials();
    if (!sup) {
      const denied = await confirmIfRequired(c, currentStandaloneStatus().mode, parsed.data.confirm);
      if (denied) return denied;
      return c.json(
        {
          error: "rollback_unavailable_standalone",
          message: "Rollback requires the unified Slipgate supervisor runtime",
        },
        409,
      );
    }

    try {
      const current = await fetchSupervisorStatus(c, sup);
      if (!current.ok) return current.response;
      const denied = await confirmIfRequired(c, current.status.mode, parsed.data.confirm);
      if (denied) return denied;

      return await forwardMutation(
        c,
        sup,
        "/internal/supervisor/update/rollback",
        "POST",
        { releaseId: parsed.data.releaseId },
        60_000,
      );
    } catch (err) {
      return unreachableResponse(c, err);
    }
  });

  app.post("/api/v1/admin/system/update/restart", async (c) => {
    const bodyResult = await readJsonBody(c);
    if (!bodyResult.ok) return bodyResult.response;

    const parsed = RestartUpdateRequestSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues }, 400);
    }

    const sup = supervisorCredentials();
    if (!sup) {
      const denied = await confirmIfRequired(c, currentStandaloneStatus().mode, parsed.data.confirm);
      if (denied) return denied;
      return c.json(
        {
          error: "restart_unavailable_standalone",
          message: "Service restart requires the unified Slipgate supervisor runtime",
        },
        409,
      );
    }

    try {
      const current = await fetchSupervisorStatus(c, sup);
      if (!current.ok) return current.response;
      const denied = await confirmIfRequired(c, current.status.mode, parsed.data.confirm);
      if (denied) return denied;

      return await forwardMutation(c, sup, "/internal/supervisor/update/restart", "POST", {}, 15_000);
    } catch (err) {
      return unreachableResponse(c, err);
    }
  });
}
