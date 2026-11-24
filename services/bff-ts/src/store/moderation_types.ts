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

export interface ModerationStore {
  getSettings(): Promise<ModerationSettings>;
  updateSettings(
    req: UpdateModerationSettingsRequest,
    encryptKey: (plain: string) => Promise<Uint8Array>,
  ): Promise<ModerationSettings>;
  listRules(): Promise<ModerationRule[]>;
  createRule(req: UpsertModerationRuleRequest): Promise<ModerationRule>;
  updateRule(id: string, req: UpsertModerationRuleRequest): Promise<ModerationRule>;
  deleteRule(id: string): Promise<boolean>;
  recordEvent(ev: RecordModerationEventInput): Promise<ModerationEvent>;
  listEvents(query: ModerationEventQuery): Promise<ModerationEvent[]>;
  exportDataPlaneModeration(): Promise<DataPlaneSyncModeration>;
}

export function bytesToHexLower(bytes: Uint8Array | Buffer | null | undefined): string {
  if (!bytes || bytes.length === 0) return "";
  return Buffer.from(bytes).toString("hex");
}

export const DEFAULT_MODERATION_SETTINGS_BASE: Omit<ModerationSettings, "updatedAtIso"> = {
  enabled: false,
  externalEnabled: false,
  externalEndpoint: "",
  externalApiKeySet: false,
  externalModel: "omni-moderation-latest",
  externalTimeoutMs: 3000,
  externalFailOpen: true,
};
