import type {
  RequestErrorItem,
  RequestErrorPhase,
  RequestErrorResolvedFilter,
  RequestErrorStatusClass,
  RequestErrorSummary,
} from "@slipgate/contracts";

export const MEMORY_REQUEST_ERROR_LIMIT = 10_000;
export const REQUEST_ERROR_BODY_MAX_CHARS = 16 * 1024;
export const REQUEST_ERROR_MESSAGE_MAX_CHARS = 4096;

export interface RequestErrorInsert {
  requestId: string;
  clientRequestId: string;
  userId: string | null;
  apiKeyId: string | null;
  accountId: string | null;
  groupId: string | null;
  platform: string;
  model: string;
  upstreamModel: string;
  phase: RequestErrorPhase;
  kind: string;
  statusCode: number;
  upstreamStatus: number;
  errorType: string;
  errorCode: string;
  errorMessage: string;
  upstreamBody: string;
  attempt: number;
  failoverUsed: boolean;
  durationMs: number;
  executionMode: string;
  metadataJson: string;
  createdAtIso: string;
}

export interface RequestErrorFilter {
  phase?: RequestErrorPhase;
  statusCode?: number;
  statusClass?: RequestErrorStatusClass;
  accountId?: string;
  userId?: string;
  apiKeyId?: string;
  platform?: string;
  model?: string;
  requestId?: string;
  resolved?: RequestErrorResolvedFilter;
  q?: string;
  sinceIso?: string;
  untilIso?: string;
}

export interface RequestErrorCleanupFilter {
  beforeIso?: string;
  phase?: RequestErrorPhase;
  statusCode?: number;
  resolvedOnly?: boolean;
}

export function hasRequestErrorCleanupConstraint(f: RequestErrorCleanupFilter): boolean {
  return Boolean(f.beforeIso || f.phase || f.statusCode !== undefined || f.resolvedOnly);
}

export class RequestErrorCleanupConstraintError extends Error {
  constructor() {
    super("Cleanup requires at least one constraint");
    this.name = "RequestErrorCleanupConstraintError";
  }
}

export function parseRequestErrorMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

export interface RequestErrorStore {
  insertRequestErrors(rows: RequestErrorInsert[]): Promise<number>;
  listRequestErrors(
    filter: RequestErrorFilter,
    page: number,
    pageSize: number,
  ): Promise<{ items: RequestErrorItem[]; total: number }>;
  getRequestError(id: string): Promise<RequestErrorItem | null>;
  summarizeRequestErrors(sinceIso: string, untilIso?: string): Promise<RequestErrorSummary>;
  setRequestErrorResolved(id: string, resolved: boolean, operatorId: string): Promise<RequestErrorItem | null>;
  cleanupRequestErrors(filter: RequestErrorCleanupFilter): Promise<number>;
}
