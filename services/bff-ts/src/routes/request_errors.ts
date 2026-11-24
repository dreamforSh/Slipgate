import type { Context, Hono } from "hono";
import {
  IngestRequestErrorItemSchema,
  IngestRequestErrorsBatchSchema,
  REQUEST_ERROR_DEFAULT_TIME_RANGE,
  REQUEST_ERROR_TIME_RANGE_MS,
  RequestErrorCleanupRequestSchema,
  RequestErrorQuerySchema,
  RequestErrorSummaryQuerySchema,
  ResolveRequestErrorRequestSchema,
  type IngestRequestErrorItem,
  type RequestErrorListResponse,
} from "@slipgate/contracts";
import type { z } from "zod";
import { redactAuditBody, redactLogContext, redactLogText } from "../insights.ts";
import { logger } from "../logging/logger.ts";
import type { AuthEnv } from "../middleware/auth.ts";
import type { JwtClaims } from "../security/crypto.ts";
import {
  hasRequestErrorCleanupConstraint,
  REQUEST_ERROR_BODY_MAX_CHARS,
  REQUEST_ERROR_MESSAGE_MAX_CHARS,
  type RequestErrorCleanupFilter,
  type RequestErrorFilter,
  type RequestErrorInsert,
} from "../store/request_errors_types.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

/**
 * Request & Upstream Error Center routes (Lane O1):
 *
 *   POST /api/v1/internal/dataplane/request-errors        slipgate-net async batch/single ingest
 *   GET  /api/v1/admin/ops/request-errors                 filtered error list
 *   GET  /api/v1/admin/ops/request-errors/summary         KPI & breakdown summary
 *   GET  /api/v1/admin/ops/request-errors/:id             detail view
 *   POST /api/v1/admin/ops/request-errors/:id/resolve     mark resolved / reopen
 *   POST /api/v1/admin/ops/request-errors/cleanup         delete matching/expired records
 */

type App = Hono<AuthEnv>;

const INGEST_MAX_BYTES = 8 * 1024 * 1024;

function adminClaims(c: Context<AuthEnv>): JwtClaims {
  const claims = c.get("authUser") as JwtClaims | undefined;
  if (!claims || claims.role !== "admin") {
    throw new StoreError("forbidden", "Administrator role required");
  }
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

function clampText(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function scrubBodyText(raw: string): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return clampText(redactAuditBody(trimmed), REQUEST_ERROR_BODY_MAX_CHARS);
    } catch {
      // Truncated JSON or plain HTML/text falls through to secret pattern scrubbing.
    }
  }
  return clampText(redactLogText(raw), REQUEST_ERROR_BODY_MAX_CHARS);
}

function toInsertRow(item: IngestRequestErrorItem): RequestErrorInsert {
  const cleanMeta = redactLogContext(item.metadata ?? {});
  return {
    requestId: item.requestId,
    clientRequestId: item.clientRequestId,
    userId: item.userId ?? null,
    apiKeyId: item.apiKeyId ?? null,
    accountId: item.accountId ?? null,
    groupId: item.groupId ?? null,
    platform: item.platform,
    model: item.model,
    upstreamModel: item.upstreamModel,
    phase: item.phase,
    kind: item.kind,
    statusCode: item.statusCode,
    upstreamStatus: item.upstreamStatus,
    errorType: item.errorType,
    errorCode: item.errorCode,
    errorMessage: clampText(redactLogText(item.errorMessage ?? ""), REQUEST_ERROR_MESSAGE_MAX_CHARS),
    upstreamBody: scrubBodyText(item.upstreamBody ?? ""),
    attempt: item.attempt,
    failoverUsed: item.failoverUsed,
    durationMs: item.durationMs,
    executionMode: item.executionMode,
    metadataJson: JSON.stringify(cleanMeta),
    createdAtIso: item.createdAtIso ?? new Date().toISOString(),
  };
}

function resolveWindow(timeRange: keyof typeof REQUEST_ERROR_TIME_RANGE_MS | undefined, sinceIso?: string, untilIso?: string) {
  const nowMs = Date.now();
  const untilMs = untilIso ? Date.parse(untilIso) : nowMs;
  const rangeKey = timeRange ?? REQUEST_ERROR_DEFAULT_TIME_RANGE;
  const sinceMs = sinceIso ? Date.parse(sinceIso) : untilMs - REQUEST_ERROR_TIME_RANGE_MS[rangeKey];
  return {
    sinceIso: new Date(sinceMs).toISOString(),
    untilIso: new Date(untilMs).toISOString(),
    explicitUntilIso: untilIso ? new Date(untilMs).toISOString() : undefined,
  };
}

export interface RequestErrorRouteOptions {
  verifyInternal: (c: Context) => boolean;
}

export function registerRequestErrorRoutes(app: App, store: ControlStore, opts: RequestErrorRouteOptions): void {
  app.post("/api/v1/internal/dataplane/request-errors", async (c) => {
    if (!opts.verifyInternal(c)) {
      return c.json({ error: "forbidden", message: "Invalid internal supervisor token" }, 403);
    }
    const length = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(length) && length > INGEST_MAX_BYTES) {
      return c.json({ error: "payload_too_large", message: `Ingest bodies are limited to ${INGEST_MAX_BYTES} bytes` }, 413);
    }
    const raw = await jsonBody(c);
    let items: IngestRequestErrorItem[];
    if (raw && typeof raw === "object" && !Array.isArray(raw) && Array.isArray((raw as { items?: unknown }).items)) {
      const parsed = IngestRequestErrorsBatchSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: "invalid_request", issues: parsed.error.issues.slice(0, 5) }, 400);
      }
      items = parsed.data.items;
    } else {
      const single = IngestRequestErrorItemSchema.safeParse(raw);
      if (!single.success) {
        return c.json({ error: "invalid_request", issues: single.error.issues.slice(0, 5) }, 400);
      }
      items = [single.data];
    }

    const accepted = await store.requestErrors.insertRequestErrors(items.map(toInsertRow));
    return c.json({ ok: true, accepted });
  });

  app.get("/api/v1/admin/ops/request-errors/summary", async (c) => {
    adminClaims(c);
    const parsed = RequestErrorSummaryQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const win = resolveWindow(parsed.data.timeRange, parsed.data.sinceIso, parsed.data.untilIso);
    const summary = await store.requestErrors.summarizeRequestErrors(win.sinceIso, win.explicitUntilIso);
    return c.json({ ...summary, untilIso: win.untilIso });
  });

  app.get("/api/v1/admin/ops/request-errors", async (c) => {
    adminClaims(c);
    const parsed = RequestErrorQuerySchema.safeParse(c.req.query());
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const { page, pageSize, timeRange, sinceIso, untilIso, statusCode, ...rest } = parsed.data;
    const win = resolveWindow(timeRange, sinceIso, untilIso);
    const filter: RequestErrorFilter = {
      ...rest,
      ...(statusCode ? { statusCode: Number(statusCode) } : {}),
      sinceIso: win.sinceIso,
      ...(win.explicitUntilIso ? { untilIso: win.explicitUntilIso } : {}),
    };
    const { items, total } = await store.requestErrors.listRequestErrors(filter, page, pageSize);
    const body: RequestErrorListResponse = {
      items,
      total,
      page,
      pageSize,
      sinceIso: win.sinceIso,
      untilIso: win.untilIso,
    };
    return c.json(body);
  });

  app.get("/api/v1/admin/ops/request-errors/:id", async (c) => {
    adminClaims(c);
    const item = await store.requestErrors.getRequestError(c.req.param("id"));
    if (!item) {
      throw new StoreError("not_found", "Request error record not found");
    }
    return c.json({ item });
  });

  app.post("/api/v1/admin/ops/request-errors/:id/resolve", async (c) => {
    const claims = adminClaims(c);
    const parsed = ResolveRequestErrorRequestSchema.safeParse(await jsonBody(c).catch(() => ({})));
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const item = await store.requestErrors.setRequestErrorResolved(c.req.param("id"), parsed.data.resolved, claims.sub);
    if (!item) {
      throw new StoreError("not_found", "Request error record not found");
    }
    return c.json({ item });
  });

  app.post("/api/v1/admin/ops/request-errors/cleanup", async (c) => {
    const claims = adminClaims(c);
    const parsed = RequestErrorCleanupRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) throw new StoreError("bad_request", issuesMessage(parsed.error.issues));
    const req = parsed.data;
    const beforeIso =
      req.beforeIso ?? (req.olderThanDays !== undefined ? new Date(Date.now() - req.olderThanDays * 86_400_000).toISOString() : undefined);
    const filter: RequestErrorCleanupFilter = {
      beforeIso,
      phase: req.phase,
      statusCode: req.statusCode,
      resolvedOnly: req.resolvedOnly,
    };
    if (!hasRequestErrorCleanupConstraint(filter)) {
      throw new StoreError("bad_request", "Cleanup requires at least one constraint");
    }
    const deleted = await store.requestErrors.cleanupRequestErrors(filter);
    logger.info("audit.request_errors_cleanup", `request errors cleaned up (${deleted} deleted)`, {
      operatorId: claims.sub,
      conditions: filter,
      deleted,
    });
    return c.json({ deleted });
  });
}
