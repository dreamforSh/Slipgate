import type {
  AlertEvent,
  AlertRule,
  AlertSilence,
  CreateAlertRuleRequest,
  CreateAlertSilenceRequest,
  UpdateAlertRuleRequest,
} from "@slipgate/contracts";
import { clampPage } from "./ops_shared.ts";
import type { AlertEventFilter, AlertStore, CreateAlertEventInput } from "./alerts_types.ts";

export class MemoryAlertStore implements AlertStore {
  private readonly rules = new Map<string, AlertRule>();
  private readonly events: AlertEvent[] = [];
  private readonly silences = new Map<string, AlertSilence>();

  async listRules(): Promise<AlertRule[]> {
    return [...this.rules.values()]
      .map((r) => ({ ...r, scope: { ...r.scope }, notifyEmails: [...r.notifyEmails] }))
      .sort((a, b) => Date.parse(b.createdAtIso) - Date.parse(a.createdAtIso) || a.id.localeCompare(b.id));
  }

  async getRule(id: string): Promise<AlertRule | null> {
    const r = this.rules.get(id);
    return r ? { ...r, scope: { ...r.scope }, notifyEmails: [...r.notifyEmails] } : null;
  }

  async createRule(req: CreateAlertRuleRequest, createdBy: string): Promise<AlertRule> {
    const id = `alr_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const rule: AlertRule = {
      id,
      name: req.name,
      description: req.description,
      enabled: req.enabled,
      metric: req.metric,
      operator: req.operator,
      threshold: req.threshold,
      windowMinutes: req.windowMinutes,
      cooldownMinutes: req.cooldownMinutes,
      severity: req.severity,
      scope: { ...req.scope },
      notifyEmails: [...req.notifyEmails],
      createdBy,
      lastEvaluatedAtIso: null,
      lastTriggeredAtIso: null,
      createdAtIso: now,
      updatedAtIso: now,
    };
    this.rules.set(id, rule);
    return { ...rule, scope: { ...rule.scope }, notifyEmails: [...rule.notifyEmails] };
  }

  async updateRule(id: string, req: UpdateAlertRuleRequest): Promise<AlertRule | null> {
    const existing = this.rules.get(id);
    if (!existing) return null;
    const updated: AlertRule = {
      ...existing,
      name: req.name ?? existing.name,
      description: req.description ?? existing.description,
      enabled: req.enabled ?? existing.enabled,
      metric: req.metric ?? existing.metric,
      operator: req.operator ?? existing.operator,
      threshold: req.threshold ?? existing.threshold,
      windowMinutes: req.windowMinutes ?? existing.windowMinutes,
      cooldownMinutes: req.cooldownMinutes ?? existing.cooldownMinutes,
      severity: req.severity ?? existing.severity,
      scope: req.scope ? { ...req.scope } : { ...existing.scope },
      notifyEmails: req.notifyEmails ? [...req.notifyEmails] : [...existing.notifyEmails],
      updatedAtIso: new Date().toISOString(),
    };
    this.rules.set(id, updated);
    return { ...updated, scope: { ...updated.scope }, notifyEmails: [...updated.notifyEmails] };
  }

  async deleteRule(id: string): Promise<boolean> {
    const deleted = this.rules.delete(id);
    if (deleted) {
      for (let i = this.events.length - 1; i >= 0; i--) {
        if (this.events[i]!.ruleId === id) this.events.splice(i, 1);
      }
      for (const [sid, s] of this.silences) {
        if (s.ruleId === id) this.silences.delete(sid);
      }
    }
    return deleted;
  }

  async markRuleEvaluated(id: string, evaluatedAtIso: string, triggeredAtIso?: string): Promise<void> {
    const rule = this.rules.get(id);
    if (!rule) return;
    rule.lastEvaluatedAtIso = evaluatedAtIso;
    if (triggeredAtIso) rule.lastTriggeredAtIso = triggeredAtIso;
    rule.updatedAtIso = evaluatedAtIso;
  }

  async listEvents(
    filter: AlertEventFilter,
    page: number,
    pageSize: number,
  ): Promise<{ items: AlertEvent[]; total: number; firingCount: number }> {
    const firingCount = this.events.filter((e) => e.status === "firing").length;
    const hits = this.events.filter((e) => {
      if (filter.ruleId && e.ruleId !== filter.ruleId) return false;
      if (filter.status && e.status !== filter.status) return false;
      if (filter.severity && e.severity !== filter.severity) return false;
      return true;
    });
    hits.sort((a, b) => Date.parse(b.firedAtIso) - Date.parse(a.firedAtIso) || b.id.localeCompare(a.id));
    const { offset, limit } = clampPage(page, pageSize);
    return {
      items: hits.slice(offset, offset + limit).map((e) => ({ ...e, details: { ...e.details } })),
      total: hits.length,
      firingCount,
    };
  }

  async findOpenEventForRule(ruleId: string): Promise<AlertEvent | null> {
    const matches = this.events
      .filter((e) => e.ruleId === ruleId && (e.status === "firing" || e.status === "silenced"))
      .sort((a, b) => Date.parse(b.firedAtIso) - Date.parse(a.firedAtIso));
    const top = matches[0];
    return top ? { ...top, details: { ...top.details } } : null;
  }

  async createEvent(input: CreateAlertEventInput): Promise<AlertEvent> {
    const id = `ale_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const ev: AlertEvent = {
      id,
      ruleId: input.ruleId,
      ruleName: input.ruleName,
      metric: input.metric,
      severity: input.severity,
      status: input.status,
      observedValue: input.observedValue,
      threshold: input.threshold,
      message: input.message,
      details: { ...input.details },
      notified: input.notified,
      notifyError: input.notifyError,
      firedAtIso: input.firedAtIso,
      resolvedAtIso: null,
      acknowledgedBy: "",
      acknowledgedAtIso: null,
    };
    this.events.push(ev);
    if (this.events.length > 5_000) this.events.splice(0, this.events.length - 5_000);
    return { ...ev, details: { ...ev.details } };
  }

  async resolveEvent(id: string, resolvedAtIso: string): Promise<AlertEvent | null> {
    const ev = this.events.find((e) => e.id === id);
    if (!ev) return null;
    ev.status = "resolved";
    ev.resolvedAtIso = ev.resolvedAtIso ?? resolvedAtIso;
    return { ...ev, details: { ...ev.details } };
  }

  async acknowledgeEvent(id: string, operatorId: string): Promise<AlertEvent | null> {
    const ev = this.events.find((e) => e.id === id);
    if (!ev) return null;
    ev.acknowledgedBy = operatorId;
    ev.acknowledgedAtIso = new Date().toISOString();
    return { ...ev, details: { ...ev.details } };
  }

  async listSilences(activeOnly = false): Promise<AlertSilence[]> {
    const nowMs = Date.now();
    return [...this.silences.values()]
      .filter((s) => !activeOnly || Date.parse(s.endsAtIso) > nowMs)
      .map((s) => ({
        ...s,
        ruleName: s.ruleId ? (this.rules.get(s.ruleId)?.name ?? "") : "",
      }))
      .sort((a, b) => Date.parse(b.endsAtIso) - Date.parse(a.endsAtIso));
  }

  async createSilence(req: CreateAlertSilenceRequest, createdBy: string): Promise<AlertSilence> {
    const id = `als_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = new Date().toISOString();
    const silence: AlertSilence = {
      id,
      ruleId: req.ruleId,
      ruleName: req.ruleId ? (this.rules.get(req.ruleId)?.name ?? "") : "",
      reason: req.reason,
      startsAtIso: req.startsAtIso ?? now,
      endsAtIso: req.endsAtIso,
      createdBy,
      createdAtIso: now,
    };
    this.silences.set(id, silence);
    return { ...silence };
  }

  async deleteSilence(id: string): Promise<boolean> {
    return this.silences.delete(id);
  }

  async hasActiveSilence(ruleId: string, nowIso: string): Promise<boolean> {
    const nowMs = Date.parse(nowIso);
    for (const s of this.silences.values()) {
      const startMs = Date.parse(s.startsAtIso);
      const endMs = Date.parse(s.endsAtIso);
      if (startMs <= nowMs && endMs > nowMs && (s.ruleId === null || s.ruleId === ruleId)) {
        return true;
      }
    }
    return false;
  }
}
