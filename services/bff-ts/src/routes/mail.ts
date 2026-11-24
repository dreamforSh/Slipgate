import type { Context, Hono } from "hono";
import type { z } from "zod";
import {
  configuredPublicBaseUrl,
  DEFAULT_EMAIL_CONFIG,
  EmailConfigSchema,
  ForgotPasswordRequestSchema,
  ResetPasswordRequestSchema,
  SendEmailCodeRequestSchema,
  TestEmailRequestSchema,
  UpdateEmailConfigRequestSchema,
  type EmailConfig,
} from "@slipgate/contracts";
import { WindowLimiter } from "../insights.ts";
import { sendMail, type MailMessage, type SmtpConfig } from "../mail/smtp.ts";
import type { AuthEnv, SessionManager } from "../middleware/auth.ts";
import { clientIp } from "../security/client_ip.ts";
import { decryptSecret, encryptSecret, hashPassword } from "../security/crypto.ts";
import { StoreError, type ControlStore } from "../store/types.ts";
import { BACKEND_MODE_REFUSAL, refusalResponse, type AuthGuards } from "../auth_guards.ts";

export interface MailRouteContext {
  store: ControlStore;
  vaultSecret: string;
  /** Ends the sessions a password reset invalidates (and clears the account's sign-in lockout). */
  sessions: SessionManager;
  /** Test hook: replaces SMTP delivery. */
  deliver?: (cfg: SmtpConfig, msg: MailMessage) => Promise<unknown>;
  /** Captcha, sign-up email policy and backend mode (auth_guards.ts). */
  guards?: AuthGuards;
}

const BLOB_KEY = "email_config";
const CODE_TTL_MS = 10 * 60_000;
const RESET_TTL_MS = 30 * 60_000;
const RESEND_COOLDOWN_MS = 60_000;
/** Reset mails per address per window, whoever asks (keeps a victim's inbox from being flooded). */
const RESET_MAILS_PER_ADDRESS = 3;
const RESET_ADDRESS_WINDOW_MS = 30 * 60_000;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => Number.parseInt(x, 16)));

async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

/** Codes and reset tokens are stored only as salted digests. */
export async function digestEmailCode(email: string, code: string): Promise<string> {
  return sha256Hex(`slipgate-email-code:${email.toLowerCase()}:${code}`);
}

function bad(issues: z.ZodIssue[]): never {
  throw new StoreError("bad_request", issues.slice(0, 3).map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "));
}

async function body<T extends z.ZodTypeAny>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new StoreError("bad_request", "Malformed JSON request body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) bad(parsed.error.issues);
  return parsed.data;
}

function isZh(c: Context): boolean {
  return (c.req.header("accept-language") ?? "").toLowerCase().startsWith("zh");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** One branded, table-based (mail-client safe) card. */
export function renderEmail(site: string, title: string, lines: string[], action?: { label: string; url: string }, code?: string): string {
  const paragraphs = lines.map((l) => `<p style="margin:0 0 12px;color:#334155;font-size:14px;line-height:22px">${escapeHtml(l)}</p>`).join("");
  const codeBlock = code
    ? `<div style="margin:18px 0;padding:14px 0;border-radius:10px;background:#f1f5f9;text-align:center;font:600 28px/1 ui-monospace,Menlo,Consolas,monospace;letter-spacing:8px;color:#0f172a">${escapeHtml(code)}</div>`
    : "";
  const button = action
    ? `<a href="${escapeHtml(action.url)}" style="display:inline-block;margin:8px 0 16px;padding:11px 22px;border-radius:10px;background:#0f766e;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px">${escapeHtml(action.label)}</a><p style="margin:0;color:#94a3b8;font-size:12px;word-break:break-all">${escapeHtml(action.url)}</p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:-apple-system,Segoe UI,Roboto,'PingFang SC','Microsoft YaHei',sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px">
<tr><td style="padding:22px 28px;border-bottom:1px solid #e2e8f0;font-weight:700;font-size:16px;color:#0f766e">${escapeHtml(site)}</td></tr>
<tr><td style="padding:24px 28px"><h1 style="margin:0 0 16px;font-size:18px;color:#0f172a">${escapeHtml(title)}</h1>${paragraphs}${codeBlock}${button}</td></tr>
</table></td></tr></table></body></html>`;
}

export function registerMailRoutes(app: Hono<AuthEnv>, ctx: MailRouteContext): MailService {
  const { store, vaultSecret, sessions } = ctx;
  const ipLimiter = new WindowLimiter(10, 10 * 60_000);
  const resetAddressLimiter = new WindowLimiter(RESET_MAILS_PER_ADDRESS, RESET_ADDRESS_WINDOW_MS);

  async function load(): Promise<{ config: EmailConfig; password: string }> {
    const blob = (await store.ops.getBlob(BLOB_KEY)) ?? {};
    let password = "";
    if (typeof blob.passwordEnc === "string" && blob.passwordEnc) {
      try {
        password = await decryptSecret(fromHex(blob.passwordEnc), vaultSecret);
      } catch {
        password = "";
      }
    }
    const parsed = EmailConfigSchema.safeParse({ ...DEFAULT_EMAIL_CONFIG, ...blob, passwordSet: Boolean(password) });
    return { config: parsed.success ? parsed.data : DEFAULT_EMAIL_CONFIG, password };
  }

  async function ready(): Promise<boolean> {
    const { config } = await load();
    return config.enabled && Boolean(config.host && config.fromAddress);
  }

  async function deliver(msg: MailMessage) {
    const { config, password } = await load();
    if (!config.enabled || !config.host || !config.fromAddress) throw new StoreError("bad_request", "Outgoing mail is not configured");
    const smtp: SmtpConfig = {
      host: config.host,
      port: config.port,
      security: config.security,
      username: config.username,
      password,
      fromAddress: config.fromAddress,
      fromName: config.fromName,
      allowInsecureTls: config.allowInsecureTls,
    };
    return ctx.deliver ? ctx.deliver(smtp, msg) : sendMail(smtp, msg);
  }

  async function siteName() {
    return (await store.ops.getSettings()).siteName || "Slipgate";
  }

  /** Where reset links point: the configured public URL only, never the request's Host headers. */
  async function publicBaseUrl(): Promise<string | null> {
    return configuredPublicBaseUrl(await store.ops.getSettings());
  }

  /* ---------------- Admin ---------------- */

  app.get("/api/v1/admin/email/config", async (c) => c.json((await load()).config));

  app.patch("/api/v1/admin/email/config", async (c) => {
    const req = await body(c, UpdateEmailConfigRequestSchema);
    const blob = { ...((await store.ops.getBlob(BLOB_KEY)) ?? {}) };
    const { password, ...rest } = req;
    Object.assign(blob, rest);
    if (password !== undefined) blob.passwordEnc = password ? toHex(await encryptSecret(password, vaultSecret)) : "";
    delete blob.passwordSet;
    await store.ops.setBlob(BLOB_KEY, blob);
    return c.json((await load()).config);
  });

  app.post("/api/v1/admin/email/test", async (c) => {
    const { to } = await body(c, TestEmailRequestSchema);
    const site = await siteName();
    const zh = isZh(c);
    try {
      await deliver({
        to,
        subject: zh ? `${site} 测试邮件` : `${site} test email`,
        html: renderEmail(site, zh ? "邮件配置可用" : "Email delivery works", [
          zh ? "这是一封测试邮件，说明 SMTP 配置正确。" : "This test message confirms your SMTP settings are correct.",
        ]),
      });
    } catch (err) {
      if (err instanceof StoreError) throw err;
      return c.json({ error: "smtp_failed", message: err instanceof Error ? err.message : String(err) }, 502);
    }
    return c.json({ sent: true });
  });

  /* ---------------- Public ---------------- */

  app.post("/api/v1/auth/email-code", async (c) => {
    const req = await body(c, SendEmailCodeRequestSchema);
    if (!ipLimiter.allow(`code:${clientIp(c)}`)) throw new StoreError("forbidden", "Too many requests, try again later");
    if (!(await ready())) throw new StoreError("bad_request", "Outgoing mail is not configured");
    // Backend mode, sign-up closed, captcha, then the sign-up email policy: no code for an address that can't register.
    const refused = ctx.guards ? await ctx.guards.emailCodePreflight(c, req) : null;
    if (refused) return refused;
    const last = await store.ops.lastEmailCodeAt(req.email, req.purpose);
    if (last && Date.now() - Date.parse(last) < RESEND_COOLDOWN_MS) {
      throw new StoreError("conflict", "A code was just sent; wait a minute before asking again");
    }
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
    await store.ops.saveEmailCode(req.email, req.purpose, await digestEmailCode(req.email, code), new Date(Date.now() + CODE_TTL_MS).toISOString());
    const site = await siteName();
    const zh = isZh(c);
    try {
      await deliver({
        to: req.email,
        subject: zh ? `${site} 验证码：${code}` : `${site} verification code: ${code}`,
        html: renderEmail(
          site,
          zh ? "验证你的邮箱" : "Verify your email",
          [zh ? "请在注册页面输入以下验证码，10 分钟内有效。" : "Enter this code on the sign-up page. It expires in 10 minutes."],
          undefined,
          code,
        ),
      });
    } catch (err) {
      return c.json({ error: "smtp_failed", message: err instanceof Error ? err.message : String(err) }, 502);
    }
    return c.json({ sent: true, cooldownSeconds: RESEND_COOLDOWN_MS / 1000 });
  });

  app.post("/api/v1/auth/forgot-password", async (c) => {
    const { email, captcha } = await body(c, ForgotPasswordRequestSchema);
    if (!ipLimiter.allow(`forgot:${clientIp(c)}`)) throw new StoreError("forbidden", "Too many requests, try again later");
    if (!(await ready())) throw new StoreError("bad_request", "Password reset by email is not available");
    // Links are built from the configured public URL only; without one there is nowhere safe to point.
    const base = await publicBaseUrl();
    if (!base) {
      throw new StoreError("bad_request", "Password reset by email is not available: the site's public URL (API base URL) is not set");
    }
    const gate = ctx.guards ? await ctx.guards.captcha(c, "forgotPassword", captcha) : null;
    if (gate && !gate.ok) return gate.response;
    // Backend mode: only administrators get reset mail (the answer stays the same for everyone).
    const adminOnly = ctx.guards ? await ctx.guards.backendMode() : false;
    const user = await store.findUserByEmail(email);
    // Same answer whether or not the address exists (and when the per-address cap is reached), so
    // the endpoint can't enumerate users and can't be used to flood one inbox from many addresses.
    if (user && user.status === "active" && (!adminOnly || user.role === "admin") && resetAddressLimiter.allow(user.email.toLowerCase())) {
      const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
      await store.ops.savePasswordReset(user.id, await sha256Hex(token), new Date(Date.now() + RESET_TTL_MS).toISOString());
      const site = await siteName();
      const zh = isZh(c);
      const link = `${base}/reset-password?token=${token}`;
      try {
        await deliver({
          to: user.email,
          subject: zh ? `${site} 重置密码` : `Reset your ${site} password`,
          html: renderEmail(
            site,
            zh ? "重置密码" : "Reset your password",
            [
              zh ? "我们收到了重置该账号密码的请求。点击下方按钮设置新密码，链接 30 分钟内有效。" : "We received a request to reset your password. Use the button below within 30 minutes.",
              zh ? "如果不是你本人操作，请忽略这封邮件。" : "If this wasn't you, you can ignore this email.",
            ],
            { label: zh ? "设置新密码" : "Set a new password", url: link },
          ),
        });
      } catch (err) {
        console.warn(`[slipgate-bff] password reset mail failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    return c.json({ accepted: true });
  });

  app.post("/api/v1/auth/reset-password", async (c) => {
    const req = await body(c, ResetPasswordRequestSchema);
    if (!ipLimiter.allow(`reset:${clientIp(c)}`)) throw new StoreError("forbidden", "Too many requests, try again later");
    const userId = await store.ops.consumePasswordReset(await sha256Hex(req.token));
    if (!userId) throw new StoreError("bad_request", "This reset link is invalid or has expired");
    // Backend mode: a link mailed before the switch only still works for an administrator.
    if (ctx.guards && (await ctx.guards.backendMode()) && (await store.getUserById(userId))?.role !== "admin") {
      return refusalResponse(c, BACKEND_MODE_REFUSAL);
    }
    // Bumps the token version: every session (a stolen one included) ends with the old password.
    await store.ops.setPasswordHash(userId, await hashPassword(req.password));
    sessions.invalidate(userId);
    // The mailbox owner proved control of the account: lift every sign-in limit on it.
    const user = await store.getUserById(userId);
    if (user) sessions.attempts.clearSignIn(user.email);
    return c.json({ reset: true });
  });

  return {
    ready,
    deliver: async (msg: MailMessage): Promise<void> => {
      await deliver(msg);
    },
    siteName,
  };
}

export interface MailService {
  ready(): Promise<boolean>;
  deliver(msg: MailMessage): Promise<void>;
  siteName(): Promise<string>;
}
