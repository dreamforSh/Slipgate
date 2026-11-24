import type {
  DataPlaneSyncModeration,
  ModerationEvent,
  ModerationEventQuery,
  ModerationRule,
  ModerationSettings,
  RecordModerationEventInput,
  UpdateModerationSettingsRequest,
  UpsertModerationRuleRequest,
} from "@slipgate/contracts";
import {
  bytesToHexLower,
  DEFAULT_MODERATION_SETTINGS_BASE,
  type ModerationStore,
} from "./moderation_types.ts";
import { StoreError } from "./types.ts";

export class MemoryModerationStore implements ModerationStore {
  private settings: ModerationSettings = {
    ...DEFAULT_MODERATION_SETTINGS_BASE,
    updatedAtIso: new Date().toISOString(),
  };
  private externalApiKeyEnc: Uint8Array | null = null;
  private readonly rules = new Map<string, ModerationRule>();
  private readonly events: ModerationEvent[] = [];

  async getSettings(): Promise<ModerationSettings> {
    return { ...this.settings };
  }

  async updateSettings(
    req: UpdateModerationSettingsRequest,
    encryptKey: (plain: string) => Promise<Uint8Array>,
  ): Promise<ModerationSettings> {
    if (req.externalApiKey !== undefined) {
      if (req.externalApiKey === "") {
        this.externalApiKeyEnc = null;
      } else {
        this.externalApiKeyEnc = await encryptKey(req.externalApiKey);
      }
    }
    this.settings = {
      enabled: req.enabled ?? this.settings.enabled,
      externalEnabled: req.externalEnabled ?? this.settings.externalEnabled,
      externalEndpoint: req.externalEndpoint ?? this.settings.externalEndpoint,
      externalApiKeySet: Boolean(this.externalApiKeyEnc && this.externalApiKeyEnc.length > 0),
      externalModel: req.externalModel ?? this.settings.externalModel,
      externalTimeoutMs: req.externalTimeoutMs ?? this.settings.externalTimeoutMs,
      externalFailOpen: req.externalFailOpen ?? this.settings.externalFailOpen,
      updatedAtIso: new Date().toISOString(),
    };
    return { ...this.settings };
  }

  async listRules(): Promise<ModerationRule[]> {
    return Array.from(this.rules.values())
      .sort((a, b) => a.priority - b.priority || a.createdAtIso.localeCompare(b.createdAtIso))
      .map((r) => ({ ...r, scopePlatforms: [...r.scopePlatforms], scopeGroupIds: [...r.scopeGroupIds] }));
  }

  async createRule(req: UpsertModerationRuleRequest): Promise<ModerationRule> {
    const nowIso = new Date().toISOString();
    const rule: ModerationRule = {
      id: `mod_${crypto.randomUUID()}`,
      name: req.name,
      enabled: req.enabled,
      kind: req.kind,
      pattern: req.pattern,
      caseSensitive: req.caseSensitive,
      action: req.action,
      scopePlatforms: [...req.scopePlatforms],
      scopeGroupIds: [...req.scopeGroupIds],
      rejectMessage: req.rejectMessage,
      priority: req.priority,
      createdAtIso: nowIso,
      updatedAtIso: nowIso,
    };
    this.rules.set(rule.id, rule);
    return { ...rule, scopePlatforms: [...rule.scopePlatforms], scopeGroupIds: [...rule.scopeGroupIds] };
  }

  async updateRule(id: string, req: UpsertModerationRuleRequest): Promise<ModerationRule> {
    const prev = this.rules.get(id);
    if (!prev) {
      throw new StoreError("not_found", `Moderation rule ${id} not found`);
    }
    const updated: ModerationRule = {
      ...prev,
      name: req.name,
      enabled: req.enabled,
      kind: req.kind,
      pattern: req.pattern,
      caseSensitive: req.caseSensitive,
      action: req.action,
      scopePlatforms: [...req.scopePlatforms],
      scopeGroupIds: [...req.scopeGroupIds],
      rejectMessage: req.rejectMessage,
      priority: req.priority,
      updatedAtIso: new Date().toISOString(),
    };
    this.rules.set(id, updated);
    return { ...updated, scopePlatforms: [...updated.scopePlatforms], scopeGroupIds: [...updated.scopeGroupIds] };
  }

  async deleteRule(id: string): Promise<boolean> {
    return this.rules.delete(id);
  }

  async recordEvent(ev: RecordModerationEventInput): Promise<ModerationEvent> {
    const item: ModerationEvent = {
      id: `mev_${crypto.randomUUID()}`,
      requestId: ev.requestId ?? "",
      userId: ev.userId ?? null,
      apiKeyId: ev.apiKeyId ?? null,
      groupId: ev.groupId ?? null,
      platform: ev.platform ?? "",
      publicModel: ev.publicModel ?? "",
      ruleId: ev.ruleId ?? null,
      ruleName: ev.ruleName ?? "",
      source: ev.source,
      action: ev.action,
      matchedExcerpt: ev.matchedExcerpt ?? "",
      createdAtIso: new Date().toISOString(),
    };
    this.events.unshift(item);
    if (this.events.length > 500) {
      this.events.length = 500;
    }
    return { ...item };
  }

  async listEvents(query: ModerationEventQuery): Promise<ModerationEvent[]> {
    const capped = Math.max(1, Math.min(200, query.limit ?? 50));
    return this.events
      .filter((e) => (!query.action || e.action === query.action) && (!query.source || e.source === query.source))
      .slice(0, capped)
      .map((e) => ({ ...e }));
  }

  async exportDataPlaneModeration(): Promise<DataPlaneSyncModeration> {
    const rules = (await this.listRules()).filter((r) => r.enabled);
    return {
      enabled: this.settings.enabled,
      externalEnabled: this.settings.externalEnabled,
      externalEndpoint: this.settings.externalEndpoint,
      externalApiKeyEncHex: bytesToHexLower(this.externalApiKeyEnc),
      externalModel: this.settings.externalModel,
      externalTimeoutMs: this.settings.externalTimeoutMs,
      externalFailOpen: this.settings.externalFailOpen,
      rules,
    };
  }
}
