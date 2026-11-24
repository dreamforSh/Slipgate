import type {
  AlertEvent,
  AlertEventStatus,
  AlertMetric,
  AlertRule,
  AlertScope,
  AlertSeverity,
  AlertSilence,
  CreateAlertRuleRequest,
  CreateAlertSilenceRequest,
  UpdateAlertRuleRequest,
} from "@slipgate/contracts";

export interface AlertEventFilter {
  ruleId?: string;
  status?: AlertEventStatus;
  severity?: AlertSeverity;
}

export interface CreateAlertEventInput {
  ruleId: string;
  ruleName: string;
  metric: AlertMetric;
  severity: AlertSeverity;
  status: AlertEventStatus;
  observedValue: number;
  threshold: number;
  message: string;
  details: Record<string, unknown>;
  notified: boolean;
  notifyError: string;
  firedAtIso: string;
}

export function parseAlertScope(raw: unknown): AlertScope {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const obj = raw as Record<string, unknown>;
  const pick = (k: string) => (typeof obj[k] === "string" && obj[k].trim() ? obj[k].trim() : undefined);
  return {
    platform: pick("platform"),
    accountId: pick("accountId"),
    groupId: pick("groupId"),
    model: pick("model"),
  };
}

export function parseNotifyEmails(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.includes("@"));
}

export function parseAlertDetails(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

export interface AlertStore {
  listRules(): Promise<AlertRule[]>;
  getRule(id: string): Promise<AlertRule | null>;
  createRule(req: CreateAlertRuleRequest, createdBy: string): Promise<AlertRule>;
  updateRule(id: string, req: UpdateAlertRuleRequest): Promise<AlertRule | null>;
  deleteRule(id: string): Promise<boolean>;
  markRuleEvaluated(id: string, evaluatedAtIso: string, triggeredAtIso?: string): Promise<void>;

  listEvents(
    filter: AlertEventFilter,
    page: number,
    pageSize: number,
  ): Promise<{ items: AlertEvent[]; total: number; firingCount: number }>;
  findOpenEventForRule(ruleId: string): Promise<AlertEvent | null>;
  createEvent(input: CreateAlertEventInput): Promise<AlertEvent>;
  resolveEvent(id: string, resolvedAtIso: string): Promise<AlertEvent | null>;
  acknowledgeEvent(id: string, operatorId: string): Promise<AlertEvent | null>;

  listSilences(activeOnly?: boolean): Promise<AlertSilence[]>;
  createSilence(req: CreateAlertSilenceRequest, createdBy: string): Promise<AlertSilence>;
  deleteSilence(id: string): Promise<boolean>;
  hasActiveSilence(ruleId: string, nowIso: string): Promise<boolean>;
}
