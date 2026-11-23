import type { EmailConfig, SmtpSecurityMode, UpdateEmailConfigRequest } from "@slipgate/contracts";

/** Editable SMTP settings. The stored password is never sent back, only whether one exists. */
export interface EmailForm {
  enabled: boolean;
  host: string;
  port: number | string;
  security: SmtpSecurityMode;
  username: string;
  /** Newly typed password; empty keeps the stored one. */
  password: string;
  /** Remove the stored password on save. */
  clearPassword: boolean;
  fromAddress: string;
  fromName: string;
  allowInsecureTls: boolean;
}

/** Dirty/validation keys (`password` covers both a new value and an explicit clear). */
export type EmailFieldKey =
  | "enabled"
  | "host"
  | "port"
  | "security"
  | "username"
  | "password"
  | "fromAddress"
  | "fromName"
  | "allowInsecureTls";

export const EMAIL_FIELDS: EmailFieldKey[] = [
  "enabled",
  "host",
  "port",
  "security",
  "username",
  "password",
  "fromAddress",
  "fromName",
  "allowInsecureTls",
];

export const SECURITY_MODES: SmtpSecurityMode[] = ["tls", "starttls", "none"];

export const DEFAULT_PORTS: Record<SmtpSecurityMode, number> = { tls: 465, starttls: 587, none: 25 };

/** Same shape check the BFF applies to `fromAddress`. */
const FROM_RE = /^[^\s@]+@[^\s@]+$/;

/** Stricter check for addresses people type to receive mail. */
export const MAILBOX_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailStatus = "ready" | "disabled" | "incomplete";

/** Mirrors the BFF: mail goes out only when enabled with a host and a from address. */
export function emailStatus(c: EmailConfig): EmailStatus {
  if (!c.enabled) return "disabled";
  return c.host.trim() && c.fromAddress.trim() ? "ready" : "incomplete";
}

export function toEmailForm(c: EmailConfig): EmailForm {
  return {
    enabled: c.enabled,
    host: c.host,
    port: c.port,
    security: c.security,
    username: c.username,
    password: "",
    clearPassword: false,
    fromAddress: c.fromAddress,
    fromName: c.fromName,
    allowInsecureTls: c.allowInsecureTls,
  };
}

function norm(f: EmailForm, key: EmailFieldKey): string {
  if (key === "password") return f.clearPassword ? "\u0000clear" : f.password;
  if (key === "port") return f.port === "" ? "" : String(Number(f.port));
  return String(f[key]);
}

export function emailDirtyKeys(form: EmailForm, base: EmailForm): EmailFieldKey[] {
  return EMAIL_FIELDS.filter((k) => norm(form, k) !== norm(base, k));
}

/** An i18n key (plus params) describing why a field is invalid; the view translates it. */
export interface FieldIssue {
  key: string;
  params?: Record<string, unknown>;
}

const issue = (key: string, params?: Record<string, unknown>): FieldIssue => ({ key, params });

export function validateEmailForm(f: EmailForm): Partial<Record<EmailFieldKey, FieldIssue>> {
  const e: Partial<Record<EmailFieldKey, FieldIssue>> = {};
  const host = f.host.trim();
  if (f.enabled && !host) e.host = issue("settings.errors.required");
  // Catch pasted URLs and "host:port" (IPv6 literals still pass).
  else if (/[\s/]/.test(host) || /^[^:]+:\d*$/.test(host)) e.host = issue("settings.email.errors.host");
  else if (host.length > 255) e.host = issue("settings.errors.maxLength", { n: 255 });

  if (f.port === "") e.port = issue("settings.errors.required");
  else {
    const n = Number(f.port);
    if (!Number.isInteger(n)) e.port = issue("settings.errors.integer");
    else if (n < 1 || n > 65535) e.port = issue("settings.errors.range", { min: 1, max: 65535 });
  }

  if (f.username.trim().length > 255) e.username = issue("settings.errors.maxLength", { n: 255 });
  if (f.password.length > 512) e.password = issue("settings.errors.maxLength", { n: 512 });

  const from = f.fromAddress.trim();
  if (f.enabled && !from) e.fromAddress = issue("settings.errors.required");
  else if (from && !FROM_RE.test(from)) e.fromAddress = issue("settings.email.errors.email");
  else if (from.length > 255) e.fromAddress = issue("settings.errors.maxLength", { n: 255 });

  if (f.fromName.trim().length > 64) e.fromName = issue("settings.errors.maxLength", { n: 64 });
  return e;
}

/** PATCH body with only the changed fields (password: "" clears, a value replaces, absent keeps). */
export function buildEmailPatch(f: EmailForm, dirty: EmailFieldKey[]): UpdateEmailConfigRequest {
  const patch: UpdateEmailConfigRequest = {};
  for (const k of dirty) {
    switch (k) {
      case "port":
        patch.port = Number(f.port);
        break;
      case "password":
        patch.password = f.clearPassword ? "" : f.password;
        break;
      case "host":
      case "username":
      case "fromAddress":
      case "fromName":
        patch[k] = f[k].trim();
        break;
      default:
        Object.assign(patch, { [k]: f[k] });
    }
  }
  return patch;
}

/** Field errors from a Zod message such as `fromAddress: Expected an email address`. */
export function parseEmailServerErrors(message: string): Partial<Record<EmailFieldKey, string>> {
  const out: Partial<Record<EmailFieldKey, string>> = {};
  for (const part of message.split("; ")) {
    const m = /^([A-Za-z]+):\s*(.+)$/.exec(part.trim());
    if (m && (EMAIL_FIELDS as string[]).includes(m[1]!)) out[m[1] as EmailFieldKey] = m[2]!;
  }
  return out;
}
