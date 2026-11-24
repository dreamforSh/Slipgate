import { describe, expect, it } from "bun:test";
import type {
  AlertEvaluateResponse,
  AlertEventListResponse,
  AlertRule,
  AlertSilence,
} from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import type { MailMessage, SmtpConfig } from "../mail/smtp.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };
const INTERNAL_TOKEN = "alerts-internal-secret";

type StoreFactory = () => Promise<ControlStore>;

async function bootstrap() {
  const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
  const outbox: { cfg: SmtpConfig; msg: MailMessage }[] = [];
  const app = createBffApp({
    store: factory ? await factory() : undefined,
    jwtSecret: "alerts-test-jwt-secret-32-bytes-min",
    vaultSecret: "alerts-test-vault-secret-32-bytes",
    internalToken: INTERNAL_TOKEN,
    mailDelivery: async (cfg, msg) => {
      outbox.push({ cfg, msg });
    },
  });

  const call = async <T>(
    method: string,
    path: string,
    headers: Record<string, string> = JSON_HEADERS,
    body?: unknown,
  ) => {
    const res = await app.request(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed as T };
  };

  const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
    siteName: "Alerts Test",
    adminEmail: "admin@alerts.test",
    adminPassword: "AdminPassword123!",
    allowRegistration: true,
  });
  expect(init.status).toBe(201);
  const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };

  const reg = await call<{ accessToken: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
    email: "user@alerts.test",
    password: "UserPassword123!",
  });
  expect(reg.status).toBe(201);
  const user = { ...JSON_HEADERS, Authorization: `Bearer ${reg.body.accessToken}` };

  // Enable mail config so alert evaluation can send real notifications through mailDelivery hook.
  const cfg = await call("PATCH", "/api/v1/admin/email/config", admin, {
    enabled: true,
    host: "smtp.alerts.test",
    port: 587,
    security: "starttls",
    username: "mailer",
    password: "smtp-password",
    fromAddress: "noreply@alerts.test",
    fromName: "Alerts Bot",
  });
  expect(cfg.status).toBe(200);

  return { call, admin, user, outbox };
}

describe("Ops Alert Rules, Events, Silences & Email Notifications (Lane O2)", () => {
  it("evaluates rules, fires alert with email notification, respects cooldown, and auto-resolves", async () => {
    const { call, admin, user, outbox } = await bootstrap();

    expect((await call("GET", "/api/v1/admin/ops/alerts/rules", user)).status).toBe(403);

    const ruleRes = await call<{ item: AlertRule }>("POST", "/api/v1/admin/ops/alerts/rules", admin, {
      name: "High request error spike",
      description: "Triggers on 2+ open errors in 15m",
      metric: "request_errors_count",
      operator: "gte",
      threshold: 2,
      windowMinutes: 15,
      cooldownMinutes: 60,
      severity: "critical",
      notifyEmails: ["oncall@alerts.test"],
    });
    expect(ruleRes.status).toBe(201);
    const rule = ruleRes.body.item;

    // Below threshold initially -> evaluates cleanly without firing.
    const ev0 = await call<AlertEvaluateResponse>("POST", "/api/v1/admin/ops/alerts/evaluate", admin);
    expect(ev0.status).toBe(200);
    expect(ev0.body).toEqual({ evaluated: 1, fired: 0, resolved: 0, silenced: 0 });
    expect(outbox.length).toBe(0);

    // Ingest 2 request errors via internal endpoint.
    const internalHeaders = { ...JSON_HEADERS, "X-Slipgate-Internal-Token": INTERNAL_TOKEN };
    await call("POST", "/api/v1/internal/dataplane/request-errors", internalHeaders, {
      items: [
        { requestId: "req_a1", phase: "upstream_http", statusCode: 502, errorMessage: "bad gateway 1" },
        { requestId: "req_a2", phase: "upstream_http", statusCode: 503, errorMessage: "unavailable 2" },
      ],
    });

    const ev1 = await call<AlertEvaluateResponse>("POST", "/api/v1/admin/ops/alerts/evaluate", admin);
    expect(ev1.status).toBe(200);
    expect(ev1.body.fired).toBe(1);
    expect(outbox.length).toBe(1);
    expect(outbox[0]!.msg.to).toBe("oncall@alerts.test");
    expect(outbox[0]!.msg.subject).toContain("High request error spike");

    // Re-evaluating immediately does not double-fire or resend mail.
    const ev2 = await call<AlertEvaluateResponse>("POST", "/api/v1/admin/ops/alerts/evaluate", admin);
    expect(ev2.body.fired).toBe(0);
    expect(outbox.length).toBe(1);

    const events = await call<AlertEventListResponse>("GET", "/api/v1/admin/ops/alerts/events", admin);
    expect(events.status).toBe(200);
    expect(events.body.firingCount).toBe(1);
    expect(events.body.items[0]!.notified).toBe(true);

    // Ack the firing event.
    const acked = await call<{ item: { acknowledgedBy: string } }>(
      "POST",
      `/api/v1/admin/ops/alerts/events/${events.body.items[0]!.id}/ack`,
      admin,
    );
    expect(acked.status).toBe(200);
    expect(acked.body.item.acknowledgedBy).toBeTruthy();

    // Resolve open request errors so the condition clears, then re-evaluate -> auto-resolves!
    const errList = await call<{ items: { id: string }[] }>("GET", "/api/v1/admin/ops/request-errors", admin);
    for (const errItem of errList.body.items) {
      await call("POST", `/api/v1/admin/ops/request-errors/${errItem.id}/resolve`, admin, { resolved: true });
    }

    const ev3 = await call<AlertEvaluateResponse>("POST", "/api/v1/admin/ops/alerts/evaluate", admin);
    expect(ev3.body.resolved).toBe(1);
    const eventsAfter = await call<AlertEventListResponse>("GET", "/api/v1/admin/ops/alerts/events", admin);
    expect(eventsAfter.body.firingCount).toBe(0);
    expect(eventsAfter.body.items[0]!.status).toBe("resolved");
  });

  it("suppresses alert notifications during active silences", async () => {
    const { call, admin, outbox } = await bootstrap();

    const ruleRes = await call<{ item: AlertRule }>("POST", "/api/v1/admin/ops/alerts/rules", admin, {
      name: "Unhealthy account alert",
      metric: "account_unhealthy",
      operator: "gte",
      threshold: 1,
      cooldownMinutes: 0,
      severity: "warning",
      notifyEmails: ["ops@alerts.test"],
    });
    const ruleId = ruleRes.body.item.id;

    // Create paused upstream account (effectiveStatus !== 'active').
    const accRes = await call("POST", "/api/v1/admin/accounts", admin, {
      name: "Down Account",
      groupId: "grp_default",
      platform: "openai",
      authKind: "api_key",
      executionMode: "direct_api",
      credentialSecret: "sk-dummy-credential-1234",
      status: "paused",
      priority: 1,
    });
    expect(accRes.status).toBe(201);

    // Silence this rule for 1 hour.
    const endsAtIso = new Date(Date.now() + 3_600_000).toISOString();
    const silRes = await call<{ item: AlertSilence }>("POST", "/api/v1/admin/ops/alerts/silences", admin, {
      ruleId,
      reason: "Scheduled maintenance",
      endsAtIso,
    });
    expect(silRes.status).toBe(201);

    const evalRes = await call<AlertEvaluateResponse>("POST", "/api/v1/admin/ops/alerts/evaluate", admin);
    expect(evalRes.status).toBe(200);
    expect(evalRes.body.silenced).toBe(1);
    expect(evalRes.body.fired).toBe(0);
    expect(outbox.length).toBe(0);

    const events = await call<AlertEventListResponse>("GET", "/api/v1/admin/ops/alerts/events", admin);
    expect(events.body.items[0]!.status).toBe("silenced");
  });
});
