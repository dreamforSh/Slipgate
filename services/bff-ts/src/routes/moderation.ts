import type { Context, Hono } from "hono";
import {
  AdminRiskUnbanRequestSchema,
  ModerationEventQuerySchema,
  ModerationTestRequestSchema,
  RecordModerationEventInputSchema,
  UpdateModerationSettingsRequestSchema,
  UpsertModerationRuleRequestSchema,
  type ModerationRule,
  type ModerationTestResponse,
} from "@slipgate/contracts";
import type { z } from "zod";
import { redactLogText } from "../insights.ts";
import type { AuthEnv } from "../middleware/auth.ts";
import { encryptSecret } from "../security/crypto.ts";
import { StoreError, type ControlStore } from "../store/types.ts";

/**
 * Prompt Moderation & Admin Risk Control routes (Lane O5):
 *
 *   POST   /api/v1/internal/dataplane/moderation-events
 *   GET    /api/v1/admin/moderation/settings
 *   PATCH  /api/v1/admin/moderation/settings
 *   GET    /api/v1/admin/moderation/rules
 *   POST   /api/v1/admin/moderation/rules
 *   PUT    /api/v1/admin/moderation/rules/:id
 *   DELETE /api/v1/admin/moderation/rules/:id
 *   POST   /api/v1/admin/moderation/test
 *   GET    /api/v1/admin/moderation/events
 *   POST   /api/v1/admin/risk/unban
 *   POST   /api/v1/admin/risk/clear-cache
 */

type App = Hono<AuthEnv>;

function requireAdmin(c: Context<AuthEnv>): void {
  const claims = c.get("authUser");
  if (!claims || claims.role !== "admin") {
    throw new StoreError("forbidden", "Administrator role required");
  }
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

export function sanitizeModerationExcerpt(raw: string): string {
  const clean = redactLogText(raw ?? "").trim();
  return clean.length > 256 ? `${clean.slice(0, 253)}...` : clean;
}

/**
 * Pure local rule evaluator shared by the admin dry-run endpoint and tests.
 * Keeps keyword splitting and scope filtering consistent with Go's moderation.go.
 */
export function evaluateModerationRules(
  text: string,
  rules: readonly ModerationRule[],
  platform?: string,
  groupId?: string,
): ModerationTestResponse {
  const normPlatform = (platform ?? "").trim().toLowerCase();
  const normGroup = (groupId ?? "").trim();
  const ordered = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority || a.createdAtIso.localeCompare(b.createdAtIso));

  for (const rule of ordered) {
    if (
      rule.scopePlatforms.length > 0 &&
      (!normPlatform || !rule.scopePlatforms.some((p) => p.trim().toLowerCase() === normPlatform))
    ) {
      continue;
    }
    if (
      rule.scopeGroupIds.length > 0 &&
      (!normGroup || !rule.scopeGroupIds.some((g) => g.trim() === normGroup))
    ) {
      continue;
    }

    if (rule.kind === "keyword") {
      const terms = rule.pattern
        .split(/[\r\n,]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      const haystack = rule.caseSensitive ? text : text.toLowerCase();
      for (const term of terms) {
        const needle = rule.caseSensitive ? term : term.toLowerCase();
        const idx = haystack.indexOf(needle);
        if (idx !== -1) {
          const excerptRaw = text.slice(Math.max(0, idx - 24), Math.min(text.length, idx + needle.length + 24));
          return {
            matched: true,
            action: rule.action,
            ruleId: rule.id,
            ruleName: rule.name,
            rejectMessage: rule.rejectMessage,
            matchedExcerpt: sanitizeModerationExcerpt(excerptRaw),
          };
        }
      }
    } else {
      try {
        const re = new RegExp(rule.pattern, rule.caseSensitive ? "" : "i");
        const m = re.exec(text);
        if (m) {
          const idx = m.index ?? 0;
          const excerptRaw = text.slice(Math.max(0, idx - 24), Math.min(text.length, idx + m[0].length + 24));
          return {
            matched: true,
            action: rule.action,
            ruleId: rule.id,
            ruleName: rule.name,
            rejectMessage: rule.rejectMessage,
            matchedExcerpt: sanitizeModerationExcerpt(excerptRaw),
          };
        }
      } catch {
        // Invalid regex cannot match.
      }
    }
  }

  return {
    matched: false,
    action: null,
    ruleId: null,
    ruleName: null,
    rejectMessage: null,
    matchedExcerpt: null,
  };
}

export interface ModerationRouteOptions {
  verifyInternal: (c: Context) => boolean;
  vaultSecret: string;
  syncDataPlane: () => Promise<unknown>;
  onRiskUnban: (subjectKey: string) => void;
  onRiskClearAll: () => void;
}

export function registerModerationRoutes(app: App, store: ControlStore, opts: ModerationRouteOptions): void {
  app.post("/api/v1/internal/dataplane/moderation-events", async (c) => {
    if (!opts.verifyInternal(c)) {
      return c.json({ error: "forbidden", message: "Invalid internal supervisor token" }, 403);
    }
    const parsed = RecordModerationEventInputSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", issues: parsed.error.issues.slice(0, 5) }, 400);
    }
    const item = await store.moderation.recordEvent({
      ...parsed.data,
      matchedExcerpt: sanitizeModerationExcerpt(parsed.data.matchedExcerpt ?? ""),
    });
    return c.json({ ok: true, item });
  });

  app.get("/api/v1/admin/moderation/settings", async (c) => {
    requireAdmin(c);
    const settings = await store.moderation.getSettings();
    return c.json(settings);
  });

  app.patch("/api/v1/admin/moderation/settings", async (c) => {
    requireAdmin(c);
    const parsed = UpdateModerationSettingsRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const settings = await store.moderation.updateSettings(parsed.data, (plain) =>
      encryptSecret(plain, opts.vaultSecret),
    );
    await opts.syncDataPlane();
    return c.json(settings);
  });

  app.get("/api/v1/admin/moderation/rules", async (c) => {
    requireAdmin(c);
    const items = await store.moderation.listRules();
    return c.json({ items });
  });

  app.post("/api/v1/admin/moderation/rules", async (c) => {
    requireAdmin(c);
    const parsed = UpsertModerationRuleRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const item = await store.moderation.createRule(parsed.data);
    await opts.syncDataPlane();
    return c.json({ item }, 201);
  });

  app.put("/api/v1/admin/moderation/rules/:id", async (c) => {
    requireAdmin(c);
    const parsed = UpsertModerationRuleRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const item = await store.moderation.updateRule(c.req.param("id"), parsed.data);
    await opts.syncDataPlane();
    return c.json({ item });
  });

  app.delete("/api/v1/admin/moderation/rules/:id", async (c) => {
    requireAdmin(c);
    const deleted = await store.moderation.deleteRule(c.req.param("id"));
    if (!deleted) {
      return c.json({ error: "not_found", message: "Moderation rule not found" }, 404);
    }
    await opts.syncDataPlane();
    return c.json({ ok: true });
  });

  app.post("/api/v1/admin/moderation/test", async (c) => {
    requireAdmin(c);
    const parsed = ModerationTestRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const rules = await store.moderation.listRules();
    const res = evaluateModerationRules(parsed.data.text, rules, parsed.data.platform, parsed.data.groupId);
    return c.json(res);
  });

  app.get("/api/v1/admin/moderation/events", async (c) => {
    requireAdmin(c);
    const parsed = ModerationEventQuerySchema.safeParse({
      limit: c.req.query("limit") || undefined,
      action: c.req.query("action") || undefined,
      source: c.req.query("source") || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const items = await store.moderation.listEvents(parsed.data);
    return c.json({ items });
  });

  app.post("/api/v1/admin/risk/unban", async (c) => {
    requireAdmin(c);
    const parsed = AdminRiskUnbanRequestSchema.safeParse(await jsonBody(c));
    if (!parsed.success) {
      return c.json({ error: "invalid_request", message: issuesMessage(parsed.error.issues) }, 400);
    }
    const unbanned = await store.unbanRiskSubject(parsed.data.subjectKind, parsed.data.subjectHash);
    opts.onRiskUnban(parsed.data.subjectHash);
    await opts.syncDataPlane();
    return c.json({ ok: true, unbanned });
  });

  app.post("/api/v1/admin/risk/clear-cache", async (c) => {
    requireAdmin(c);
    const result = await store.clearRiskBansAndRefusalCache();
    opts.onRiskClearAll();
    await opts.syncDataPlane();
    return c.json({ ok: true, ...result });
  });
}
