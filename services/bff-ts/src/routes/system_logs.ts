import type { Context, Hono, MiddlewareHandler } from "hono";
import {
  SYSTEM_LOG_DEFAULT_TIME_RANGE,
  SYSTEM_LOG_TIME_RANGE_MS,
  SystemLogCleanupRequestSchema,
  SystemLogIngestRequestSchema,
  SystemLogQuerySchema,
  UpdateRuntimeLogConfigRequestSchema,
  type SystemLogCleanupRequest,
  type SystemLogListResponse,
} from "@slipgate/contracts";
import type { z } from "zod";
import type { JwtClaims } from "../security/crypto.ts";
import type { AuthEnv } from "../middleware/auth.ts";
import { clientAddress } from "../security/client_ip.ts";
import { currentRequestLog, logger, runWithRequestLog, setDefaultLogDestination, type RequestLogContext } from "../logging/logger.ts";
import { SystemLogService, type SystemLogServiceOptions } from "../logging/service.ts";
import { hasSystemLogConstraint, type SystemLogFilter } from "../store/system_logs_types.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

/**
 * Persisted system logs (admin → Ops → System logs; Linksyncx ops_system_log_handler.go):
 *
 *   GET  /api/v1/admin/ops/system-logs            list (filters, time window, pagination, afterId tail)
 *   POST /api/v1/admin/ops/system-logs/cleanup    delete by filter (at least one), audited
 *   GET  /api/v1/admin/ops/system-logs/health     sink + forwarder health
 *   GET  /api/v1/admin/ops/runtime/logging        runtime log config
 *   PUT  /api/v1/admin/ops/runtime/logging        partial update, applied at once
 *   POST /api/v1/admin/ops/runtime/logging/reset  back to the environment baseline
 *   POST /api/v1/internal/system-logs             slipgate-net ingest (internal token)
 *
 * plus the request middleware every route runs under: X-Request-Id, the logging context, access
 * entries (when persisted) and a record of every 5xx.
 */

type App = Hono<AuthEnv>;

const services = new WeakMap<object, SystemLogService>();

/** The system-log service of an app made by createBffApp (tests flush its sink through this). */
export function systemLogServiceOf(app: object): SystemLogService | undefined {
  return services.get(app);
}

const REQUEST_ID = /^[A-Za-z0-9._:@\-]{1,128}$/;

function sanitizeRequestId(raw: string | undefined): string {
  const v = (raw ?? "").trim();
  return REQUEST_ID.test(v) ? v : "";
}

function newRequestId(): string {
  return `req_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/** Paths whose access entries would only record the log viewer and health checks polling. */
function skipAccessLog(path: string): boolean {
  return (
    path === "/api/v1/health" ||
    path === "/api/v1/internal/system-logs" ||
    path === "/api/v1/internal/dataplane/snapshot" ||
    path.startsWith("/api/v1/admin/ops/system-logs")
  );
}

function requestLogMiddleware(service: SystemLogService): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const requestId = sanitizeRequestId(c.req.header("x-request-id")) || newRequestId();
    const method = c.req.method;
    const path = c.req.path;
    const ctx: RequestLogContext = {
      requestId,
      clientRequestId: sanitizeRequestId(c.req.header("x-client-request-id")),
      method,
      path,
      userId: () => (c.get("authUser") as JwtClaims | undefined)?.sub ?? null,
      destination: service,
      errorLogged: false,
    };
    c.header("X-Request-Id", requestId);
    const started = performance.now();
    await runWithRequestLog(ctx, () => next());
    const status = c.res.status;
    const latencyMs = Math.round(performance.now() - started);
    runWithRequestLog(ctx, () => {
      if (status >= 500 && !ctx.errorLogged) {
        logger.log(status === 500 ? "error" : "warn", "http", `${method} ${path} responded ${status}`, { status, latencyMs });
      }
      if (service.runtimeConfig().persistAccessLogs && !skipAccessLog(path)) {
        logger.info("http.access", `${method} ${path} ${status}`, { status, latencyMs, clientIp: clientAddress(c) });
      }
    });
    try {
      if (!c.res.headers.has("X-Request-Id")) c.res.headers.set("X-Request-Id", requestId);
    } catch {
      // Immutable headers (a passed-through upstream response): the id is still in the logs.
    }
  };
}

/** app.onError hook for unexpected failures (StoreErrors are client errors and are not logged). */
export function logRouteError(c: Context, err: unknown): void {
  try {
    if (err instanceof StoreError) return;
    const ctx = currentRequestLog();
    if (ctx) ctx.errorLogged = true;
    const message = err instanceof Error ? err.message : String(err);
    logger.error("http", `${c.req.method} ${c.req.path} failed: ${message}`, { status: 500, error: err });
  } catch {
    // Never let logging change the error response.
  }
}

/**
 * Creates the app's system-log service and installs the request middleware. Call before any
 * route is registered; `start` (the server) also starts the retention / config refresh timers and
 * makes this app the destination of entries written outside a request.
 */
export function mountSystemLogging(app: App, store: ControlStore, start: boolean, options?: SystemLogServiceOptions): SystemLogService {
  const service = new SystemLogService(store.systemLogs, options);
  services.set(app, service);
  app.use("*", requestLogMiddleware(service));
  void service.ensureLoaded().catch(() => undefined);
  if (start) {
    service.start();
    setDefaultLogDestination(service);
  }
  return service;
}

function adminClaims(c: Context<AuthEnv>): JwtClaims {
  // requireAdmin runs first for /api/v1/admin/*; checked again so a misordered mount fails closed.
  const claims = c.get("authUser") as JwtClaims | undefined;
  if (!claims) throw new StoreError("forbidden", "Administrator role required");
  if (claims.role !== "admin") throw new StoreError("forbidden", "Administrator role required");
  return claims;
}

function issuesMessage(issues: z.ZodIssue[]): string {
  return (
    issues
      .slice(0, 3)
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ") || "Invalid request"
  );
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
}

function filterOf(f: SystemLogCleanupRequest): SystemLogFilter {
  const out: SystemLogFilter = {};
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== "") (out as Record<string, unknown>)[k] = v;
  return out;
}

/** 8 MB: 500 entries of a few KB each with headroom; larger bodies are refused unread. */
const INGEST_MAX_BYTES = 8 * 1024 * 1024;

export interface SystemLogRouteOptions {
  verifyInternal: (c: Context) => boolean;
}

/** Registers the admin routes (after the admin guard) and the internal ingest route. */
export function registerSystemLogRoutes(app: App, store: ControlStore, service: SystemLogService, opts: SystemLogRouteOptions): void {
  app.get("/api/v1/admin/ops/system-logs", async (c) => {
    adminClaims(c);
    const parsed = SystemLogQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const { page, pageSize, timeRange, sinceIso, untilIso, ...rest } = parsed.data;
    const nowMs = Date.now();
    const untilMs = untilIso ? Date.parse(untilIso) : nowMs;
    const sinceMs = sinceIso ? Date.parse(sinceIso) : untilMs - SYSTEM_LOG_TIME_RANGE_MS[timeRange ?? SYSTEM_LOG_DEFAULT_TIME_RANGE];
    const filter: SystemLogFilter = {
      ...filterOf(rest as SystemLogCleanupRequest),
      sinceIso: new Date(sinceMs).toISOString(),
      // Without an explicit end nothing newer is cut off (entries written while the page loads).
      ...(untilIso ? { untilIso: new Date(untilMs).toISOString() } : {}),
    };
    const { items, total } = await store.systemLogs.listSystemLogs(filter, page, pageSize);
    const body: SystemLogListResponse = {
      items,
      total,
      page,
      pageSize,
      sinceIso: new Date(sinceMs).toISOString(),
      untilIso: new Date(untilMs).toISOString(),
    };
    return c.json(body);
  });

  app.post("/api/v1/admin/ops/system-logs/cleanup", async (c) => {
    const claims = adminClaims(c);
    const parsed = SystemLogCleanupRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const req = parsed.data;
    if (req.sinceIso && req.untilIso && Date.parse(req.sinceIso) > Date.parse(req.untilIso)) {
      return c.json({ error: "cleanup_invalid_range", message: "sinceIso must not be after untilIso" }, 400);
    }
    const filter = filterOf(req);
    if (!hasSystemLogConstraint(filter)) {
      return c.json({ error: "cleanup_filter_required", message: "Cleanup requires at least one filter condition" }, 400);
    }
    const deleted = await store.systemLogs.deleteSystemLogs(filter);
    try {
      await store.systemLogs.recordSystemLogCleanup({ operatorId: claims.sub, conditions: { ...filter }, deletedRows: deleted });
    } catch (err) {
      // The rows are gone either way; a lost audit row must not fail the cleanup.
      logger.warn("system-log", "system log cleanup audit failed", { error: err });
    }
    logger.info("audit.system_log_cleanup", `system logs cleaned up (${deleted} deleted)`, {
      operatorId: claims.sub,
      conditions: filter,
      deleted,
    });
    return c.json({ deleted });
  });

  app.get("/api/v1/admin/ops/system-logs/health", (c) => {
    adminClaims(c);
    return c.json(service.health());
  });

  app.get("/api/v1/admin/ops/runtime/logging", async (c) => {
    adminClaims(c);
    return c.json(await service.ensureLoaded());
  });

  app.put("/api/v1/admin/ops/runtime/logging", async (c) => {
    const claims = adminClaims(c);
    const parsed = UpdateRuntimeLogConfigRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    return c.json(await service.update(parsed.data, claims.sub));
  });

  app.post("/api/v1/admin/ops/runtime/logging/reset", async (c) => {
    const claims = adminClaims(c);
    return c.json(await service.reset(claims.sub));
  });

  app.post("/api/v1/internal/system-logs", async (c) => {
    if (!opts.verifyInternal(c)) {
      return c.json({ error: "forbidden", message: "Invalid internal supervisor token" }, 403);
    }
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > INGEST_MAX_BYTES) {
      return c.json({ error: "payload_too_large", message: `Ingest bodies are limited to ${INGEST_MAX_BYTES} bytes` }, 413);
    }
    const parsed = SystemLogIngestRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) return c.json({ error: "invalid_request", issues: parsed.error.issues.slice(0, 5) }, 400);
    // Filter with the saved level even right after a restart; a store hiccup keeps the current one.
    await service.ensureLoaded().catch(() => undefined);
    const outcome = service.ingest(parsed.data);
    return c.json({ ...outcome, config: service.runtimeConfig() });
  });
}
