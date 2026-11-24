import type { Context, Hono } from "hono";
import {
  RestartUpdateRequestSchema,
  RollbackUpdateRequestSchema,
  SystemReleasesResponseSchema,
  SystemUpdateStatusSchema,
  TriggerUpdateSyncRequestSchema,
  UpdateSystemConfigRequestSchema,
  type DevSyncStrategy,
  type SystemUpdateChannel,
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
  strategy: DevSyncStrategy;
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

/**
 * Registers admin system update, release catalog, policy config, and rollback endpoints under /api/v1/admin/system/update*.
 */
export function registerSystemUpdateRoutes(app: Hono<AuthEnv>, deps: SystemUpdateRoutesDeps): void {
  const { store, sessions, vaultSecret, buildStandaloneSystemUpdateStatus } = deps;
  const initialStandalone = buildStandaloneSystemUpdateStatus();
  const standalonePolicy: StandalonePolicy = {
    channel: initialStandalone.channel,
    autoSyncEnabled: initialStandalone.autoSyncEnabled,
    intervalSeconds: initialStandalone.intervalSeconds,
    autoRestartAfterUpdate: initialStandalone.autoRestartAfterUpdate,
    strategy: initialStandalone.strategy,
  };

  function currentStandaloneStatus(extra?: Partial<SystemUpdateStatus>): SystemUpdateStatus {
    const base = buildStandaloneSystemUpdateStatus();
    return SystemUpdateStatusSchema.parse({
      ...base,
      standalone: true,
      channel: standalonePolicy.channel,
      autoSyncEnabled: standalonePolicy.autoSyncEnabled,
      intervalSeconds: standalonePolicy.intervalSeconds,
      autoRestartAfterUpdate: standalonePolicy.autoRestartAfterUpdate,
      strategy: standalonePolicy.strategy,
      resolvedStrategy: standalonePolicy.strategy === "git" ? "git" : "release",
      githubTokenConfigured: Boolean(process.env.SLIPGATE_GITHUB_TOKEN || process.env.GITHUB_TOKEN),
      canRollback: false,
      components: [
        { name: "bff", status: "running", overridden: false, restartRequired: false, pid: process.pid },
        { name: "webui", status: "embedded", overridden: false, restartRequired: false, pid: 0 },
      ],
      ...extra,
    });
  }

  app.get("/api/v1/admin/system/update", async (c) => {
    const sup = supervisorCredentials();
    if (!sup) {
      return c.json(currentStandaloneStatus());
    }
    try {
      const res = await fetch(`${sup.url}/internal/supervisor/update`, {
        headers: { "X-Slipgate-Internal-Token": sup.token },
        signal: AbortSignal.timeout(5000),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return c.json(payload, forwardSupervisorErrorStatus(res.status));
      }
      return c.json(SystemUpdateStatusSchema.parse(payload));
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
        const statusRes = await fetch(`${sup.url}/internal/supervisor/update`, {
          headers: { "X-Slipgate-Internal-Token": sup.token },
          signal: AbortSignal.timeout(5000),
        });
        if (!statusRes.ok) {
          const payload = (await statusRes.json().catch(() => ({}))) as Record<string, unknown>;
          return c.json(payload, forwardSupervisorErrorStatus(statusRes.status));
        }
        const statusJson = SystemUpdateStatusSchema.parse(await statusRes.json());
        if (statusJson.mode !== "dev") {
          const claims = c.get("authUser");
          const denied = await totpStepUp(store, vaultSecret).confirmAdmin(c, sessions, claims.sub, parsed.data.confirm);
          if (denied) return denied;
        }
      }

      // Never forward admin step-up credentials to the net supervisor.
      const forwardPayload = {
        checkOnly: parsed.data.checkOnly,
        channel: parsed.data.channel,
        targetTag: parsed.data.targetTag,
        force: parsed.data.force,
        allowReleaseApply: !parsed.data.checkOnly,
      };

      const res = await fetch(`${sup.url}/internal/supervisor/update/sync`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slipgate-Internal-Token": sup.token,
        },
        body: JSON.stringify(forwardPayload),
        signal: AbortSignal.timeout(180_000),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return c.json(payload, forwardSupervisorErrorStatus(res.status));
      }
      return c.json(SystemUpdateStatusSchema.parse(payload));
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

    const sup = supervisorCredentials();
    if (!sup) {
      if (parsed.data.channel !== undefined) standalonePolicy.channel = parsed.data.channel;
      if (parsed.data.autoSyncEnabled !== undefined) standalonePolicy.autoSyncEnabled = parsed.data.autoSyncEnabled;
      if (parsed.data.intervalSeconds !== undefined) standalonePolicy.intervalSeconds = parsed.data.intervalSeconds;
      if (parsed.data.autoRestartAfterUpdate !== undefined) {
        standalonePolicy.autoRestartAfterUpdate = parsed.data.autoRestartAfterUpdate;
      }
      if (parsed.data.strategy !== undefined) standalonePolicy.strategy = parsed.data.strategy;
      return c.json(currentStandaloneStatus());
    }

    try {
      const res = await fetch(`${sup.url}/internal/supervisor/update/config`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "X-Slipgate-Internal-Token": sup.token,
        },
        body: JSON.stringify(parsed.data),
        signal: AbortSignal.timeout(10_000),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return c.json(payload, forwardSupervisorErrorStatus(res.status));
      }
      return c.json(SystemUpdateStatusSchema.parse(payload));
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

    const claims = c.get("authUser");
    const denied = await totpStepUp(store, vaultSecret).confirmAdmin(c, sessions, claims.sub, parsed.data.confirm);
    if (denied) return denied;

    const sup = supervisorCredentials();
    if (!sup) {
      return c.json(
        {
          error: "rollback_unavailable_standalone",
          message: "Rollback requires the unified Slipgate supervisor runtime",
        },
        409,
      );
    }

    try {
      const res = await fetch(`${sup.url}/internal/supervisor/update/rollback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slipgate-Internal-Token": sup.token,
        },
        body: JSON.stringify({ releaseId: parsed.data.releaseId }),
        signal: AbortSignal.timeout(60_000),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return c.json(payload, forwardSupervisorErrorStatus(res.status));
      }
      return c.json(SystemUpdateStatusSchema.parse(payload));
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
      const claims = c.get("authUser");
      const denied = await totpStepUp(store, vaultSecret).confirmAdmin(c, sessions, claims.sub, parsed.data.confirm);
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
      const statusRes = await fetch(`${sup.url}/internal/supervisor/update`, {
        headers: { "X-Slipgate-Internal-Token": sup.token },
        signal: AbortSignal.timeout(5000),
      });
      if (!statusRes.ok) {
        const payload = (await statusRes.json().catch(() => ({}))) as Record<string, unknown>;
        return c.json(payload, forwardSupervisorErrorStatus(statusRes.status));
      }
      const statusJson = SystemUpdateStatusSchema.parse(await statusRes.json());
      if (statusJson.mode !== "dev") {
        const claims = c.get("authUser");
        const denied = await totpStepUp(store, vaultSecret).confirmAdmin(c, sessions, claims.sub, parsed.data.confirm);
        if (denied) return denied;
      }

      const res = await fetch(`${sup.url}/internal/supervisor/update/restart`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Slipgate-Internal-Token": sup.token,
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        return c.json(payload, forwardSupervisorErrorStatus(res.status));
      }
      return c.json(SystemUpdateStatusSchema.parse(payload));
    } catch (err) {
      return unreachableResponse(c, err);
    }
  });
}
