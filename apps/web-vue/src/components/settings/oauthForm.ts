import type { OAuthProviderConfig, OAuthProviderId, UpdateOAuthProviderRequest } from "@slipgate/contracts";
import type { FieldIssue } from "./emailForm";

/** Editable sign-in provider. The stored client secret is never sent back, only whether one exists. */
export interface OAuthProviderForm {
  id: OAuthProviderId;
  enabled: boolean;
  displayName: string;
  clientId: string;
  /** Newly typed secret; empty keeps the stored one. */
  clientSecret: string;
  /** Remove the stored secret on save. */
  clearSecret: boolean;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scopes: string;
  idField: string;
  emailField: string;
  nameField: string;
  allowSignup: boolean;
}

/** Dirty/validation keys (`clientSecret` covers both a new value and an explicit clear). */
export type OAuthFieldKey = Exclude<keyof OAuthProviderForm, "id" | "clearSecret">;

export const OAUTH_FIELDS: OAuthFieldKey[] = [
  "enabled",
  "displayName",
  "clientId",
  "clientSecret",
  "authorizeUrl",
  "tokenUrl",
  "userinfoUrl",
  "scopes",
  "idField",
  "emailField",
  "nameField",
  "allowSignup",
];

/** Fields behind the "Advanced" disclosure. */
export const OAUTH_ADVANCED_FIELDS: OAuthFieldKey[] = [
  "authorizeUrl",
  "tokenUrl",
  "userinfoUrl",
  "scopes",
  "idField",
  "emailField",
  "nameField",
];

export const OAUTH_ENDPOINTS = ["authorizeUrl", "tokenUrl", "userinfoUrl"] as const;

/** Names the BFF falls back to when the display name is left empty. */
export const OAUTH_DEFAULT_NAMES: Record<OAuthProviderId, string> = {
  github: "GitHub",
  google: "Google",
  linuxdo: "LINUX DO",
  wechat: "WeChat",
  dingtalk: "DingTalk",
  oidc: "SSO",
};

/** Where the admin registers an OAuth app (the generic OIDC provider has no fixed console). */
export const OAUTH_CONSOLE_URLS: Partial<Record<OAuthProviderId, string>> = {
  github: "https://github.com/settings/developers",
  google: "https://console.cloud.google.com/apis/credentials",
  linuxdo: "https://connect.linux.do",
  wechat: "https://open.weixin.qq.com",
  dingtalk: "https://open-dev.dingtalk.com",
};

export const OAUTH_LIMITS: Record<Exclude<OAuthFieldKey, "enabled" | "allowSignup">, number> = {
  displayName: 40,
  clientId: 256,
  clientSecret: 512,
  authorizeUrl: 512,
  tokenUrl: 512,
  userinfoUrl: 512,
  scopes: 256,
  idField: 64,
  emailField: 64,
  nameField: 64,
};

const HTTP_RE = /^https?:\/\//i;
/** Dotted path into the userinfo JSON, e.g. `sub` or `data.user.id`. */
const PATH_RE = /^[^\s.]+(\.[^\s.]+)*$/;

export function toOAuthForm(c: OAuthProviderConfig): OAuthProviderForm {
  return {
    id: c.id,
    enabled: c.enabled,
    displayName: c.displayName,
    clientId: c.clientId,
    clientSecret: "",
    clearSecret: false,
    authorizeUrl: c.authorizeUrl,
    tokenUrl: c.tokenUrl,
    userinfoUrl: c.userinfoUrl,
    scopes: c.scopes,
    idField: c.idField,
    emailField: c.emailField,
    nameField: c.nameField,
    allowSignup: c.allowSignup,
  };
}

function norm(f: OAuthProviderForm, key: OAuthFieldKey): string {
  // Whitespace-only input is not a new secret (and must never be sent as "" = clear).
  if (key === "clientSecret") return f.clearSecret ? "\u0000clear" : f.clientSecret.trim();
  const v = f[key];
  return typeof v === "string" ? v.trim() : String(v);
}

export function oauthDirtyKeys(form: OAuthProviderForm, base: OAuthProviderForm): OAuthFieldKey[] {
  return OAUTH_FIELDS.filter((k) => norm(form, k) !== norm(base, k));
}

/** Whether a usable client secret will exist after saving this form. */
export function secretAfterSave(f: OAuthProviderForm, saved: OAuthProviderConfig): boolean {
  if (f.clearSecret) return false;
  return Boolean(f.clientSecret.trim()) || saved.clientSecretSet;
}

/**
 * What an enabled provider still lacks before the BFF lists it on the sign-in page
 * (client id, secret and all three endpoints; the subject field is needed to identify users).
 */
export function oauthMissing(f: OAuthProviderForm, saved: OAuthProviderConfig): OAuthFieldKey[] {
  const out: OAuthFieldKey[] = [];
  if (!f.clientId.trim()) out.push("clientId");
  if (!secretAfterSave(f, saved)) out.push("clientSecret");
  for (const k of OAUTH_ENDPOINTS) if (!f[k].trim()) out.push(k);
  if (!f.idField.trim()) out.push("idField");
  return out;
}

export type OAuthStatus = "active" | "incomplete" | "disabled";

/** Mirrors the BFF's `usable()` check on the saved configuration. */
export function oauthStatus(c: OAuthProviderConfig): OAuthStatus {
  if (!c.enabled) return "disabled";
  const complete = c.clientId && c.clientSecretSet && c.authorizeUrl && c.tokenUrl && c.userinfoUrl && c.idField;
  return complete ? "active" : "incomplete";
}

const issue = (key: string, params?: Record<string, unknown>): FieldIssue => ({ key, params });

/** Format checks only; missing pieces on an enabled provider are reported as a warning instead. */
export function validateOAuthForm(f: OAuthProviderForm): Partial<Record<OAuthFieldKey, FieldIssue>> {
  const e: Partial<Record<OAuthFieldKey, FieldIssue>> = {};
  for (const [k, max] of Object.entries(OAUTH_LIMITS) as [keyof typeof OAUTH_LIMITS, number][]) {
    const v = k === "clientSecret" ? f.clientSecret.trim() : f[k].trim();
    if (v.length > max) e[k] = issue("settings.errors.maxLength", { n: max });
  }
  for (const k of OAUTH_ENDPOINTS) {
    const v = f[k].trim();
    if (!e[k] && v && !HTTP_RE.test(v)) e[k] = issue("settings.oauth.errors.url");
  }
  for (const k of ["idField", "emailField", "nameField"] as const) {
    const v = f[k].trim();
    if (!e[k] && v && !PATH_RE.test(v)) e[k] = issue("settings.oauth.errors.path");
  }
  return e;
}

/** PATCH body with only the changed fields (clientSecret: "" clears, a value replaces, absent keeps). */
export function buildOAuthPatch(f: OAuthProviderForm, dirty: OAuthFieldKey[]): UpdateOAuthProviderRequest {
  const patch: UpdateOAuthProviderRequest = {};
  for (const k of dirty) {
    switch (k) {
      case "enabled":
      case "allowSignup":
        patch[k] = f[k];
        break;
      case "clientSecret":
        patch.clientSecret = f.clearSecret ? "" : f.clientSecret.trim();
        break;
      default:
        patch[k] = f[k].trim();
    }
  }
  return patch;
}

/** Field errors from a Zod message such as `tokenUrl: Must be an http(s) URL`. */
export function parseOAuthServerErrors(message: string): Partial<Record<OAuthFieldKey, string>> {
  const out: Partial<Record<OAuthFieldKey, string>> = {};
  for (const part of message.split("; ")) {
    const m = /^([A-Za-z]+):\s*(.+)$/.exec(part.trim());
    if (m && (OAUTH_FIELDS as string[]).includes(m[1]!)) out[m[1] as OAuthFieldKey] = m[2]!;
  }
  return out;
}

/** Same base the BFF builds redirect URIs from: the API base URL when absolute, else this site. */
export function oauthCallbackUrl(apiBaseUrl: string, origin: string, id: OAuthProviderId): string {
  const base = apiBaseUrl.trim();
  const root = HTTP_RE.test(base) ? base.replace(/\/+$/, "") : origin;
  return `${root}/api/v1/auth/oauth/${id}/callback`;
}
