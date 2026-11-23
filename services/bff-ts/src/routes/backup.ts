import type { Hono } from "hono";
import {
  auditRetentionShortens,
  CONFIG_BACKUP_TYPE,
  ConfigImportRequestSchema,
  CreateCompositeRouteRequestSchema,
  CreateGroupRequestSchema,
  CreatePromoCodeRequestSchema,
  formatNanoUsd,
  normalizePortalSettings,
  UpsertAnnouncementRequestSchema,
  type ConfigBackupFile,
  type ConfigBackupSection,
  type ConfigImportResult,
} from "@slipgate/contracts";
import type { AuthEnv } from "../middleware/auth.ts";
import { StoreError, type ControlStore } from "../store/types.ts";
import { remapTargetingGroups } from "./announcements.ts";

/** Export/merge-import of hand-made configuration; never includes secrets or user data. */
export function registerBackupRoutes(app: Hono<AuthEnv>, store: ControlStore, onChanged: () => Promise<void>) {
  app.get("/api/v1/admin/backup/export", async (c) => {
    const [settings, groups, routes, plans, promos, announcements, pricing, autoTest, plugins] = await Promise.all([
      store.ops.getSettings(),
      store.listGroups(false),
      store.listCompositeRoutes(),
      store.payments.listPlans(true),
      store.ops.listPromoCodes(),
      store.ops.listAnnouncements(),
      store.ops.getBlob("model_pricing"),
      store.ops.getBlob("account_autotest"),
      store.ops.getBlob("plugins"),
    ]);
    const file: ConfigBackupFile = {
      type: CONFIG_BACKUP_TYPE,
      version: 1,
      exportedAtIso: new Date().toISOString(),
      portalSettings: settings as unknown as Record<string, unknown>,
      groups: groups.map(({ accountCount: _a, activeAccountCount: _b, apiKeyCount: _c, ...g }) => g),
      compositeRoutes: routes.map((r) => ({ ...r })),
      paymentPlans: plans.map((p) => ({ ...p })),
      promoCodes: promos.map(({ usedCount: _u, ...p }) => p),
      announcements: announcements.map(({ readCount: _r, ...a }) => a),
      pricingRules: Array.isArray(pricing?.rules) ? (pricing.rules as Record<string, unknown>[]) : [],
      autoTest: autoTest ?? null,
      disabledPlugins: Array.isArray(plugins?.disabled) ? (plugins.disabled as string[]) : [],
    };
    const stamp = new Date().toISOString().slice(0, 10);
    return c.body(JSON.stringify(file, null, 2), 200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="slipgate-config-${stamp}.json"`,
      "Cache-Control": "no-store",
    });
  });

  app.post("/api/v1/admin/backup/import", async (c) => {
    const parsed = ConfigImportRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new StoreError("bad_request", "Not a Slipgate configuration backup");
    const { file } = parsed.data;
    const want = new Set<ConfigBackupSection>(
      parsed.data.sections ?? [
        "portalSettings",
        "groups",
        "compositeRoutes",
        "paymentPlans",
        "promoCodes",
        "announcements",
        "pricingRules",
        "autoTest",
        "plugins",
      ],
    );
    const result: ConfigImportResult = { created: {}, skipped: {}, updated: [], errors: [] };
    const bump = (bucket: "created" | "skipped", key: string) => (result[bucket][key] = (result[bucket][key] ?? 0) + 1);
    const fail = (what: string, err: unknown) => result.errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);

    if (want.has("portalSettings") && file.portalSettings) {
      const imported = normalizePortalSettings(file.portalSettings);
      // A shorter audit retention deletes history: that needs a fresh two-factor code on the
      // retention endpoint, so an import never shortens it (keeping entries longer is fine).
      // A backup made before the setting existed leaves it as it is.
      const current = (await store.ops.getSettings()).auditLogRetentionDays;
      if (!("auditLogRetentionDays" in file.portalSettings)) {
        imported.auditLogRetentionDays = current;
      } else if (auditRetentionShortens(current, imported.auditLogRetentionDays)) {
        result.errors.push(
          `portalSettings.auditLogRetentionDays: kept the current ${current === 0 ? "keep-forever" : `${current}-day`} retention; ` +
            "shorten it on the audit log page (needs a two-factor code)",
        );
        imported.auditLogRetentionDays = current;
      }
      await store.ops.saveSettings(imported);
      result.updated.push("portalSettings");
    }

    // Groups are matched by name; old ids are mapped so routes and plans follow them.
    const groupIdMap = new Map<string, string>();
    const existingGroups = await store.listGroups(false);
    for (const g of existingGroups) groupIdMap.set(g.id, g.id);
    if (want.has("groups")) {
      const byName = new Map(existingGroups.map((g) => [g.name.toLowerCase(), g.id]));
      for (const raw of file.groups) {
        const name = String(raw.name ?? "");
        const known = byName.get(name.toLowerCase());
        if (known) {
          groupIdMap.set(String(raw.id), known);
          bump("skipped", "groups");
          continue;
        }
        const req = CreateGroupRequestSchema.safeParse({
          ...raw,
          dailyLimitUsd: formatNanoUsd(BigInt(String(raw.dailyLimitNanoUsd ?? "0"))),
          weeklyLimitUsd: formatNanoUsd(BigInt(String(raw.weeklyLimitNanoUsd ?? "0"))),
          monthlyLimitUsd: formatNanoUsd(BigInt(String(raw.monthlyLimitNanoUsd ?? "0"))),
        });
        if (!req.success) {
          fail(`group ${name}`, req.error.issues[0]?.message);
          continue;
        }
        try {
          const created = await store.createGroup(req.data);
          groupIdMap.set(String(raw.id), created.id);
          bump("created", "groups");
        } catch (err) {
          fail(`group ${name}`, err);
        }
      }
    }

    if (want.has("compositeRoutes")) {
      const existing = await store.listCompositeRoutes();
      const keyOf = (r: { groupId: string; publicModel: string; endpoint: string; matchType: string }) =>
        `${r.groupId}\u0000${r.publicModel}\u0000${r.endpoint}\u0000${r.matchType}`;
      const seen = new Set(existing.map(keyOf));
      for (const raw of file.compositeRoutes) {
        const groupId = groupIdMap.get(String(raw.groupId));
        if (!groupId) {
          bump("skipped", "compositeRoutes");
          continue;
        }
        const req = CreateCompositeRouteRequestSchema.safeParse({ ...raw, groupId });
        if (!req.success || seen.has(keyOf(req.data))) {
          bump("skipped", "compositeRoutes");
          continue;
        }
        try {
          await store.createCompositeRoute(req.data);
          seen.add(keyOf(req.data));
          bump("created", "compositeRoutes");
        } catch (err) {
          fail(`route ${String(raw.publicModel)}`, err);
        }
      }
    }

    if (want.has("paymentPlans")) {
      const names = new Set((await store.payments.listPlans(true)).map((p) => p.name.toLowerCase()));
      for (const raw of file.paymentPlans) {
        const name = String(raw.name ?? "");
        if (!name || names.has(name.toLowerCase())) {
          bump("skipped", "paymentPlans");
          continue;
        }
        const kind = raw.kind === "subscription" ? "subscription" : "recharge";
        const groupId = raw.groupId ? (groupIdMap.get(String(raw.groupId)) ?? null) : null;
        if (kind === "subscription" && !groupId) {
          bump("skipped", "paymentPlans");
          continue;
        }
        try {
          await store.payments.createPlan({
            name,
            description: String(raw.description ?? ""),
            kind,
            priceMinor: Math.max(1, Math.trunc(Number(raw.priceMinor) || 0)),
            currency: raw.currency === "USD" ? "USD" : "CNY",
            creditNano: BigInt(String(raw.creditNanoUsd ?? "0")),
            groupId,
            validityDays: kind === "subscription" ? Math.max(1, Math.trunc(Number(raw.validityDays) || 30)) : null,
            badge: String(raw.badge ?? ""),
            enabled: raw.enabled !== false,
            sortOrder: Math.trunc(Number(raw.sortOrder) || 0),
          });
          names.add(name.toLowerCase());
          bump("created", "paymentPlans");
        } catch (err) {
          fail(`plan ${name}`, err);
        }
      }
    }

    if (want.has("promoCodes")) {
      const codes = new Set((await store.ops.listPromoCodes()).map((p) => p.code));
      for (const raw of file.promoCodes) {
        const code = String(raw.code ?? "");
        if (!code || codes.has(code)) {
          bump("skipped", "promoCodes");
          continue;
        }
        const bonus = BigInt(String(raw.bonusNanoUsd ?? "0"));
        const req = CreatePromoCodeRequestSchema.safeParse({ ...raw, bonusUsd: formatNanoUsd(bonus) });
        if (!req.success) {
          fail(`promo ${code}`, req.error.issues[0]?.message);
          continue;
        }
        try {
          await store.ops.createPromoCode(code, req.data, bonus);
          codes.add(code);
          bump("created", "promoCodes");
        } catch (err) {
          fail(`promo ${code}`, err);
        }
      }
    }

    if (want.has("announcements")) {
      const titles = new Set((await store.ops.listAnnouncements()).map((a) => a.title));
      for (const raw of file.announcements) {
        let req = UpsertAnnouncementRequestSchema.safeParse(raw);
        let ruleDropped = false;
        if (!req.success && req.error.issues.every((i) => i.path[0] === "targeting")) {
          // Only the rule is unreadable (an export writes such a rule fail-closed, matching
          // nobody): keep the announcement as a hidden draft without it rather than losing it.
          req = UpsertAnnouncementRequestSchema.safeParse({ ...raw, targeting: null, status: "draft" });
          ruleDropped = req.success;
        }
        if (!req.success || titles.has(req.data.title)) {
          bump("skipped", "announcements");
          continue;
        }
        // Targeting names subscription groups by id: follow the groups this import mapped.
        await store.ops.createAnnouncement(remapTargetingGroups(req.data, groupIdMap), c.get("authUser").sub);
        titles.add(req.data.title);
        bump("created", "announcements");
        if (ruleDropped) {
          result.errors.push(`announcement ${req.data.title}: its targeting rule could not be read; imported as a draft without one`);
        }
      }
    }

    if (want.has("pricingRules") && file.pricingRules.length) {
      const blob = await store.ops.getBlob("model_pricing");
      const current = Array.isArray(blob?.rules) ? (blob.rules as Record<string, unknown>[]) : [];
      const patterns = new Set(current.map((r) => String(r.pattern)));
      for (const raw of file.pricingRules) {
        if (patterns.has(String(raw.pattern))) {
          bump("skipped", "pricingRules");
          continue;
        }
        current.push({ ...raw, id: `price_${crypto.randomUUID()}` });
        patterns.add(String(raw.pattern));
        bump("created", "pricingRules");
      }
      await store.ops.setBlob("model_pricing", { rules: current });
    }

    if (want.has("autoTest") && file.autoTest) {
      await store.ops.setBlob("account_autotest", file.autoTest);
      result.updated.push("autoTest");
    }

    if (want.has("plugins")) {
      const blob = (await store.ops.getBlob("plugins")) ?? {};
      await store.ops.setBlob("plugins", { ...blob, disabled: file.disabledPlugins });
      result.updated.push("plugins");
    }

    await onChanged();
    return c.json(result);
  });
}
