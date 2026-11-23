import {
  LOGIN_AGREEMENT_MAX_CONTENT,
  LOGIN_AGREEMENT_MAX_DOCUMENTS,
  LOGIN_AGREEMENT_MAX_TITLE,
  normalizeLoginAgreementDocumentId,
  REGISTRATION_EMAIL_SUFFIX_MAX,
  type PortalSettings,
  type UpdatePortalSettingsRequest,
} from "@slipgate/contracts";
import type { FieldIssue } from "./emailForm";

/**
 * The sign-in guard fields of the portal settings (saved with them through PATCH
 * /api/v1/admin/settings): sign-up email policy, backend mode and the login agreement.
 */
export interface AgreementDocRow {
  /** Stable row identity for list transitions (never sent). */
  key: number;
  id: string;
  title: string;
  contentMd: string;
}

export interface GuardPortalForm {
  registrationEmailSuffixAllowlist: string[];
  registrationEmailDomainQuotaEnabled: boolean;
  backendModeEnabled: boolean;
  loginAgreementEnabled: boolean;
  loginAgreementMode: "modal" | "checkbox";
  loginAgreementUpdatedAt: string;
  loginAgreementDocuments: AgreementDocRow[];
}

export type GuardPortalKey = keyof GuardPortalForm;
export type GuardTab = "registration" | "security" | "agreement";

export const GUARD_TAB_FIELDS: Record<GuardTab, GuardPortalKey[]> = {
  registration: ["registrationEmailSuffixAllowlist", "registrationEmailDomainQuotaEnabled"],
  security: ["backendModeEnabled"],
  agreement: ["loginAgreementEnabled", "loginAgreementMode", "loginAgreementUpdatedAt", "loginAgreementDocuments"],
};
export const GUARD_PORTAL_FIELDS: GuardPortalKey[] = Object.values(GUARD_TAB_FIELDS).flat();

export const MAX_AGREEMENT_DOCUMENTS = LOGIN_AGREEMENT_MAX_DOCUMENTS;
export const MAX_AGREEMENT_TITLE = LOGIN_AGREEMENT_MAX_TITLE;
export const MAX_AGREEMENT_CONTENT = LOGIN_AGREEMENT_MAX_CONTENT;
export const MAX_EMAIL_SUFFIXES = REGISTRATION_EMAIL_SUFFIX_MAX;

let rowSeq = 0;
export function nextDocKey(): number {
  rowSeq += 1;
  return rowSeq;
}

export function emptyGuardPortalForm(): GuardPortalForm {
  return {
    registrationEmailSuffixAllowlist: [],
    registrationEmailDomainQuotaEnabled: false,
    backendModeEnabled: false,
    loginAgreementEnabled: false,
    loginAgreementMode: "modal",
    loginAgreementUpdatedAt: "",
    loginAgreementDocuments: [],
  };
}

/** Form from saved settings; row keys are reused by position so a save doesn't replay list animations. */
export function toGuardPortalForm(s: PortalSettings, prev: AgreementDocRow[] = []): GuardPortalForm {
  return {
    registrationEmailSuffixAllowlist: [...(s.registrationEmailSuffixAllowlist ?? [])],
    registrationEmailDomainQuotaEnabled: s.registrationEmailDomainQuotaEnabled ?? false,
    backendModeEnabled: s.backendModeEnabled ?? false,
    loginAgreementEnabled: s.loginAgreementEnabled ?? false,
    loginAgreementMode: s.loginAgreementMode === "checkbox" ? "checkbox" : "modal",
    loginAgreementUpdatedAt: s.loginAgreementUpdatedAt ?? "",
    loginAgreementDocuments: (s.loginAgreementDocuments ?? []).map((d, i) => ({
      key: prev[i]?.key ?? nextDocKey(),
      id: d.id,
      title: d.title,
      contentMd: d.contentMd,
    })),
  };
}

export function cloneGuardPortalForm(f: GuardPortalForm): GuardPortalForm {
  return {
    ...f,
    registrationEmailSuffixAllowlist: [...f.registrationEmailSuffixAllowlist],
    loginAgreementDocuments: f.loginAgreementDocuments.map((d) => ({ ...d })),
  };
}

function norm(f: GuardPortalForm, key: GuardPortalKey): string {
  if (key === "loginAgreementDocuments") {
    return JSON.stringify(f.loginAgreementDocuments.map((d) => [d.id.trim(), d.title.trim(), d.contentMd.trim()]));
  }
  if (key === "registrationEmailSuffixAllowlist") return JSON.stringify(f.registrationEmailSuffixAllowlist);
  return String(f[key]).trim();
}

export function guardPortalDirtyKeys(form: GuardPortalForm, base: GuardPortalForm): GuardPortalKey[] {
  return GUARD_PORTAL_FIELDS.filter((k) => norm(form, k) !== norm(base, k));
}

const issue = (key: string, params?: Record<string, unknown>): FieldIssue => ({ key, params });

/** Per-document problems (index-aligned with the list). */
export interface DocIssues {
  id?: FieldIssue;
  title?: FieldIssue;
  contentMd?: FieldIssue;
}

const DOC_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

/** The id a document will be saved under (the BFF derives a missing one from the title). */
export function effectiveDocId(d: Pick<AgreementDocRow, "id" | "title">): string {
  return normalizeLoginAgreementDocumentId(d.id) || normalizeLoginAgreementDocumentId(d.title);
}

export function validateDocs(docs: AgreementDocRow[]): DocIssues[] {
  const seen = new Map<string, number>();
  return docs.map((d, i) => {
    const out: DocIssues = {};
    const title = d.title.trim();
    if (!title) out.title = issue("settings.errors.required");
    else if (title.length > MAX_AGREEMENT_TITLE) out.title = issue("settings.errors.maxLength", { n: MAX_AGREEMENT_TITLE });
    const rawId = d.id.trim();
    if (rawId && !DOC_ID_RE.test(rawId)) out.id = issue("authGuards.settings.agreement.errors.id");
    const id = effectiveDocId(d);
    if (id) {
      if (seen.has(id)) out.id = issue("authGuards.settings.agreement.errors.duplicateId", { n: (seen.get(id) ?? 0) + 1 });
      else seen.set(id, i);
    }
    if (d.contentMd.length > MAX_AGREEMENT_CONTENT) out.contentMd = issue("settings.errors.maxLength", { n: MAX_AGREEMENT_CONTENT });
    return out;
  });
}

export function validateGuardPortalForm(f: GuardPortalForm): Partial<Record<GuardPortalKey, FieldIssue>> {
  const e: Partial<Record<GuardPortalKey, FieldIssue>> = {};
  if (f.registrationEmailSuffixAllowlist.length > MAX_EMAIL_SUFFIXES) {
    e.registrationEmailSuffixAllowlist = issue("authGuards.settings.emailPolicy.errors.tooMany", { n: MAX_EMAIL_SUFFIXES });
  }
  const date = f.loginAgreementUpdatedAt.trim();
  if (date && !DATE_RE.test(date)) e.loginAgreementUpdatedAt = issue("authGuards.settings.agreement.errors.date");
  const docs = f.loginAgreementDocuments;
  if (docs.length > MAX_AGREEMENT_DOCUMENTS) {
    e.loginAgreementDocuments = issue("authGuards.settings.agreement.errors.tooMany", { n: MAX_AGREEMENT_DOCUMENTS });
  } else if (validateDocs(docs).some((d) => d.id || d.title || d.contentMd)) {
    e.loginAgreementDocuments = issue("authGuards.settings.agreement.errors.documents");
  }
  if (f.loginAgreementEnabled && docs.length === 0) e.loginAgreementEnabled = issue("authGuards.settings.agreement.errors.noDocuments");
  return e;
}

export function buildGuardPortalPatch(f: GuardPortalForm, dirty: GuardPortalKey[]): UpdatePortalSettingsRequest {
  const patch: UpdatePortalSettingsRequest = {};
  for (const k of dirty) {
    switch (k) {
      case "registrationEmailSuffixAllowlist":
        patch.registrationEmailSuffixAllowlist = [...f.registrationEmailSuffixAllowlist];
        break;
      case "loginAgreementUpdatedAt":
        patch.loginAgreementUpdatedAt = f.loginAgreementUpdatedAt.trim();
        break;
      case "loginAgreementDocuments":
        patch.loginAgreementDocuments = f.loginAgreementDocuments.map((d) => ({
          id: d.id.trim(),
          title: d.title.trim(),
          contentMd: d.contentMd,
        }));
        break;
      default:
        Object.assign(patch, { [k]: f[k] });
    }
  }
  return patch;
}

/**
 * Field errors from a settings PATCH message (`loginAgreementDocuments.0.title: …`,
 * `registrationEmailSuffixAllowlist.3: Invalid email suffix: …`); keys keep the index path.
 */
export function parseGuardServerErrors(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of message.split("; ")) {
    const m = /^([A-Za-z]+)((?:\.\d+)?(?:\.[A-Za-z]+)?):\s*(.+)$/.exec(part.trim());
    if (!m || !(GUARD_PORTAL_FIELDS as string[]).includes(m[1]!)) continue;
    out[`${m[1]}${m[2] ?? ""}`] = m[3]!;
    out[m[1]!] ??= m[3]!;
  }
  return out;
}

export function guardTabOf(key: string): GuardTab | null {
  const field = key.split(".")[0] as GuardPortalKey;
  return (Object.keys(GUARD_TAB_FIELDS) as GuardTab[]).find((tab) => GUARD_TAB_FIELDS[tab].includes(field)) ?? null;
}

/** Today's date as YYYY-MM-DD in the admin's own time zone. */
export function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
