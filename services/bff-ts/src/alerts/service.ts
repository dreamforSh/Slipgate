import type { AlertEvaluateResponse, AlertOperator, AlertRule } from "@slipgate/contracts";
import { logger } from "../logging/logger.ts";
import type { MailService } from "../routes/mail.ts";
import type { ControlStore } from "../store/types.ts";

export interface AlertServiceOptions {
  store: ControlStore;
  mail: () => MailService;
  deadLetterCount?: () => Promise<number>;
  intervalMs?: number;
}

const activeAlertServices = new Set<AlertService>();

export function stopAlertServices(): void {
  for (const svc of activeAlertServices) svc.stop();
}

function compareMetric(observed: number, op: AlertOperator, threshold: number): boolean {
  switch (op) {
    case "gt":
      return observed > threshold;
    case "gte":
      return observed >= threshold;
    case "lt":
      return observed < threshold;
    case "lte":
      return observed <= threshold;
  }
}

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatMetricSummary(rule: AlertRule, observed: number): string {
  switch (rule.metric) {
    case "error_rate":
      return `Error rate ${observed}% ${rule.operator} ${rule.threshold}% over last ${rule.windowMinutes}m`;
    case "latency_p95":
      return `Latency P95 ${observed}ms ${rule.operator} ${rule.threshold}ms over last ${rule.windowMinutes}m`;
    case "account_unhealthy":
      return `${observed} unhealthy account(s) ${rule.operator} ${rule.threshold}`;
    case "request_errors_count":
      return `${observed} open request error(s) ${rule.operator} ${rule.threshold} over last ${rule.windowMinutes}m`;
    case "dead_letter_count":
      return `${observed} queued settlement dead-letter(s) ${rule.operator} ${rule.threshold}`;
  }
}

export class AlertService {
  private readonly store: ControlStore;
  private readonly mail: () => MailService;
  private readonly deadLetterCount?: () => Promise<number>;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<AlertEvaluateResponse> | null = null;

  constructor(opts: AlertServiceOptions) {
    this.store = opts.store;
    this.mail = opts.mail;
    this.deadLetterCount = opts.deadLetterCount;
    this.intervalMs = opts.intervalMs ?? 60_000;
    activeAlertServices.add(this);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.evaluateNow().catch((err) => {
        logger.warn("alerts", "periodic alert evaluation failed", { error: err });
      });
    }, this.intervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    activeAlertServices.delete(this);
  }

  async evaluateNow(): Promise<AlertEvaluateResponse> {
    if (this.inflight) return this.inflight;
    this.inflight = this.runEvaluation().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async measureRule(rule: AlertRule, nowMs: number): Promise<number> {
    const windowMs = Math.max(1, rule.windowMinutes) * 60_000;
    const sinceMs = nowMs - windowMs;
    const sinceIso = new Date(sinceMs).toISOString();
    const scope = rule.scope ?? {};

    switch (rule.metric) {
      case "error_rate":
      case "latency_p95": {
        const bucketMs = Math.max(60_000, Math.floor(windowMs / 12));
        const usage = await this.store.ops.opsUsage({
          sinceMs,
          nowMs,
          bucketStartMs: sinceMs,
          bucketMs,
          bucketCount: 12,
        });
        const sums = scope.accountId
          ? usage.accounts.get(scope.accountId)
          : scope.model
            ? usage.models.get(scope.model)
            : usage.totals;
        if (!sums) return 0;
        if (rule.metric === "error_rate") {
          return sums.requests > 0 ? Number(((sums.errors / sums.requests) * 100).toFixed(2)) : 0;
        }
        return sums.durationP95;
      }
      case "account_unhealthy": {
        const accounts = await this.store.listAccounts({
          groupId: scope.groupId,
        });
        return accounts.filter((a) => {
          if (scope.platform && a.platform !== scope.platform) return false;
          if (scope.accountId && a.id !== scope.accountId) return false;
          return a.effectiveStatus !== "active";
        }).length;
      }
      case "request_errors_count": {
        if (scope.platform || scope.accountId || scope.model) {
          const { total } = await this.store.requestErrors.listRequestErrors(
            {
              sinceIso,
              resolved: "open",
              platform: scope.platform,
              accountId: scope.accountId,
              model: scope.model,
            },
            1,
            1,
          );
          return total;
        }
        const summary = await this.store.requestErrors.summarizeRequestErrors(sinceIso);
        return summary.openCount;
      }
      case "dead_letter_count": {
        return this.deadLetterCount ? await this.deadLetterCount() : 0;
      }
    }
  }

  private async notifyEmails(rule: AlertRule, observed: number, message: string, firedAtIso: string): Promise<{ notified: boolean; error: string }> {
    const recipients = rule.notifyEmails.map((e) => e.trim()).filter(Boolean);
    if (recipients.length === 0) return { notified: false, error: "" };

    const mail = this.mail();
    let ready = false;
    try {
      ready = await mail.ready();
    } catch (err) {
      return { notified: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!ready) {
      return { notified: false, error: "SMTP mail is not configured or enabled" };
    }

    const site = await mail.siteName().catch(() => "Slipgate");
    const subject = `[${site}] [${rule.severity.toUpperCase()}] Alert: ${rule.name}`;
    const html = `
      <div style="font-family:sans-serif;line-height:1.5;color:#111">
        <h2 style="margin:0 0 12px">${escapeHtml(subject)}</h2>
        <p style="margin:0 0 8px"><strong>Rule:</strong> ${escapeHtml(rule.name)}</p>
        <p style="margin:0 0 8px"><strong>Condition:</strong> ${escapeHtml(message)}</p>
        <p style="margin:0 0 8px"><strong>Observed:</strong> ${observed} (threshold ${rule.operator} ${rule.threshold})</p>
        <p style="margin:0 0 8px"><strong>Severity:</strong> ${escapeHtml(rule.severity)}</p>
        <p style="margin:0;color:#555;font-size:12px">Fired at ${escapeHtml(firedAtIso)}</p>
      </div>
    `.trim();
    const text = `${subject}\nRule: ${rule.name}\nCondition: ${message}\nObserved: ${observed} (${rule.operator} ${rule.threshold})\nSeverity: ${rule.severity}\nFired at: ${firedAtIso}`;

    const errs: string[] = [];
    let anySent = false;
    for (const to of recipients) {
      try {
        await mail.deliver({ to, subject, html, text });
        anySent = true;
      } catch (err) {
        errs.push(`${to}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      notified: anySent && errs.length === 0,
      error: errs.join("; ").slice(0, 500),
    };
  }

  private async runEvaluation(): Promise<AlertEvaluateResponse> {
    const rules = await this.store.alerts.listRules();
    const result: AlertEvaluateResponse = { evaluated: 0, fired: 0, resolved: 0, silenced: 0 };

    for (const rule of rules) {
      if (!rule.enabled) continue;
      result.evaluated++;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const observed = await this.measureRule(rule, nowMs);
      const breached = compareMetric(observed, rule.operator, rule.threshold);
      const openEvent = await this.store.alerts.findOpenEventForRule(rule.id);

      if (breached) {
        const message = formatMetricSummary(rule, observed);
        const silenced = await this.store.alerts.hasActiveSilence(rule.id, nowIso);
        if (silenced) {
          if (!openEvent) {
            await this.store.alerts.createEvent({
              ruleId: rule.id,
              ruleName: rule.name,
              metric: rule.metric,
              severity: rule.severity,
              status: "silenced",
              observedValue: observed,
              threshold: rule.threshold,
              message,
              details: { operator: rule.operator, windowMinutes: rule.windowMinutes, scope: rule.scope },
              notified: false,
              notifyError: "",
              firedAtIso: nowIso,
            });
          }
          result.silenced++;
          await this.store.alerts.markRuleEvaluated(rule.id, nowIso);
          continue;
        }

        const lastTrigMs = rule.lastTriggeredAtIso ? Date.parse(rule.lastTriggeredAtIso) : 0;
        const inCooldown = rule.cooldownMinutes > 0 && lastTrigMs > 0 && nowMs - lastTrigMs < rule.cooldownMinutes * 60_000;
        if (!openEvent && !inCooldown) {
          const mailRes = await this.notifyEmails(rule, observed, message, nowIso);
          await this.store.alerts.createEvent({
            ruleId: rule.id,
            ruleName: rule.name,
            metric: rule.metric,
            severity: rule.severity,
            status: "firing",
            observedValue: observed,
            threshold: rule.threshold,
            message,
            details: { operator: rule.operator, windowMinutes: rule.windowMinutes, scope: rule.scope },
            notified: mailRes.notified,
            notifyError: mailRes.error,
            firedAtIso: nowIso,
          });
          await this.store.alerts.markRuleEvaluated(rule.id, nowIso, nowIso);
          result.fired++;
          continue;
        }
        await this.store.alerts.markRuleEvaluated(rule.id, nowIso);
      } else {
        if (openEvent) {
          await this.store.alerts.resolveEvent(openEvent.id, nowIso);
          result.resolved++;
        }
        await this.store.alerts.markRuleEvaluated(rule.id, nowIso);
      }
    }

    return result;
  }
}
