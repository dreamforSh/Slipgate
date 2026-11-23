import { describe, expect, it } from "bun:test";
import type { EmailConfig, PublicSettings } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { buildMime, sendMail, type MailMessage, type SmtpConfig } from "../mail/smtp.ts";
import type { ControlStore } from "../store/types.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

/** Fake SMTP relay recording the dialogue and the DATA payload. */
function fakeSmtpServer() {
  const transcript: string[] = [];
  let data = "";
  const server = Bun.listen<{ buf: string; inData: boolean }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { buf: "", inData: false };
        s.write("220 fake.smtp ESMTP\r\n");
      },
      data(s, chunk) {
        s.data.buf += new TextDecoder().decode(chunk);
        let idx: number;
        while ((idx = s.data.buf.indexOf("\r\n")) >= 0) {
          const line = s.data.buf.slice(0, idx);
          s.data.buf = s.data.buf.slice(idx + 2);
          if (s.data.inData) {
            if (line === ".") {
              s.data.inData = false;
              s.write("250 2.0.0 queued as TEST\r\n");
            } else {
              data += `${line}\r\n`;
            }
            continue;
          }
          transcript.push(line);
          const verb = line.split(" ")[0]!.toUpperCase();
          if (verb === "EHLO") s.write("250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
          else if (verb === "AUTH") s.write("235 2.7.0 ok\r\n");
          else if (verb === "MAIL" || verb === "RCPT") s.write("250 ok\r\n");
          else if (verb === "DATA") {
            s.data.inData = true;
            s.write("354 go ahead\r\n");
          } else if (verb === "QUIT") {
            s.write("221 bye\r\n");
            s.end();
          } else s.write("502 unknown\r\n");
        }
      },
    },
  });
  return { server, transcript, data: () => data };
}

describe("SMTP client", () => {
  it("authenticates, sends a UTF-8 multipart message with dot-stuffing and quits", async () => {
    const fake = fakeSmtpServer();
    try {
      const reply = await sendMail(
        {
          host: "127.0.0.1",
          port: fake.server.port,
          security: "none",
          username: "mailer",
          password: "pa55",
          fromAddress: "noreply@example.com",
          fromName: "斯利普网关",
        },
        { to: "user@example.com", subject: "验证码 123456", html: "<p>你好</p>\n.leading dot" },
      );
      expect(reply).toContain("queued");
      expect(fake.transcript).toContain("MAIL FROM:<noreply@example.com>");
      expect(fake.transcript).toContain("RCPT TO:<user@example.com>");
      const auth = fake.transcript.find((l) => l.startsWith("AUTH PLAIN "))!;
      expect(Buffer.from(auth.slice(11), "base64").toString()).toBe("\u0000mailer\u0000pa55");
      const mime = fake.data();
      expect(mime).toContain("Subject: =?UTF-8?B?");
      expect(mime).toContain("multipart/alternative");
    } finally {
      fake.server.stop(true);
    }
  });

  it("refuses header injection", () => {
    expect(() => buildMime({ fromAddress: "a@b.c", fromName: "" }, { to: "x@y.z\r\nBcc: evil@z.z", subject: "s", html: "h" })).toThrow();
  });
});

type StoreFactory = () => Promise<ControlStore>;

describe("email verification and password reset", () => {
  it("gates sign-up on a mailed code and resets passwords through a one-time link", async () => {
    const factory = (globalThis as { __slipgateTestStoreFactory?: StoreFactory }).__slipgateTestStoreFactory;
    const outbox: { cfg: SmtpConfig; msg: MailMessage }[] = [];
    const app = createBffApp({
      store: factory ? await factory() : undefined,
      jwtSecret: "mail-test-jwt-secret-32-bytes-minimum",
      vaultSecret: "mail-test-vault-secret-32-bytes-minimum",
      mailDelivery: async (cfg, msg) => {
        outbox.push({ cfg, msg });
      },
    });
    const call = async <T>(method: string, path: string, headers: Record<string, string> = JSON_HEADERS, body?: unknown) => {
      const res = await app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
    };
    const init = await call<{ accessToken: string }>("POST", "/api/v1/setup/initialize", JSON_HEADERS, {
      siteName: "Mail Test",
      adminEmail: "admin@mail.test",
      adminPassword: "AdminPassword123!",
      allowRegistration: true,
    });
    const admin = { ...JSON_HEADERS, Authorization: `Bearer ${init.body.accessToken}` };
    await call("PATCH", "/api/v1/admin/settings", admin, { emailVerificationRequired: true });

    // Without working mail the requirement is not enforced (and not advertised).
    expect((await call<PublicSettings>("GET", "/api/v1/public/settings")).body.emailVerificationRequired).toBe(false);

    const cfg = await call<EmailConfig>("PATCH", "/api/v1/admin/email/config", admin, {
      enabled: true,
      host: "smtp.example.com",
      port: 587,
      security: "starttls",
      username: "mailer",
      password: "smtp-secret",
      fromAddress: "noreply@example.com",
      fromName: "Mail Test",
    });
    expect(cfg.body.passwordSet).toBe(true);
    expect(JSON.stringify(cfg.body)).not.toContain("smtp-secret");
    // Reset links point at the configured public URL only (never the request's Host headers).
    expect((await call<PublicSettings>("GET", "/api/v1/public/settings")).body.passwordResetEnabled).toBe(false);
    await call("PATCH", "/api/v1/admin/settings", admin, { apiBaseUrl: "https://mail.example.test" });
    const pub = await call<PublicSettings>("GET", "/api/v1/public/settings");
    expect(pub.body.emailVerificationRequired).toBe(true);
    expect(pub.body.passwordResetEnabled).toBe(true);

    expect((await call("POST", "/api/v1/admin/email/test", admin, { to: "ops@mail.test" })).status).toBe(200);
    expect(outbox.at(-1)!.cfg.password).toBe("smtp-secret");

    const register = (code?: string) =>
      call<{ accessToken?: string; error?: string }>("POST", "/api/v1/auth/register", JSON_HEADERS, {
        email: "new@mail.test",
        password: "UserPassword123!",
        emailCode: code,
      });
    expect((await register()).body.error).toBe("email_code_invalid");
    expect((await call("POST", "/api/v1/auth/email-code", JSON_HEADERS, { email: "new@mail.test" })).status).toBe(200);
    expect((await call("POST", "/api/v1/auth/email-code", JSON_HEADERS, { email: "new@mail.test" })).status).toBe(409);
    const codeMail = outbox.at(-1)!.msg;
    const code = /(\d{6})/.exec(codeMail.subject)![1]!;
    expect((await register("000000" === code ? "111111" : "000000")).status).toBe(400);
    const ok = await register(code);
    expect(ok.status).toBe(201);
    expect((await register(code)).status).not.toBe(201);

    // Unknown addresses get the same answer and no mail.
    const before = outbox.length;
    expect((await call("POST", "/api/v1/auth/forgot-password", JSON_HEADERS, { email: "nobody@mail.test" })).status).toBe(200);
    expect(outbox.length).toBe(before);
    expect((await call("POST", "/api/v1/auth/forgot-password", JSON_HEADERS, { email: "new@mail.test" })).status).toBe(200);
    expect(outbox.at(-1)!.msg.html).toContain("https://mail.example.test/reset-password?token=");
    const token = /token=([0-9a-f]{64})/.exec(outbox.at(-1)!.msg.html)![1]!;
    expect((await call("POST", "/api/v1/auth/reset-password", JSON_HEADERS, { token, password: "BrandNewPass9" })).status).toBe(200);
    // The reset ends the sessions opened with the old password.
    expect((await call("GET", "/api/v1/auth/me", { Authorization: `Bearer ${ok.body.accessToken}` })).status).toBe(401);
    expect((await call("POST", "/api/v1/auth/reset-password", JSON_HEADERS, { token, password: "AnotherPass99" })).status).toBe(400);
    const login = await call<{ accessToken?: string }>("POST", "/api/v1/auth/login", JSON_HEADERS, {
      email: "new@mail.test",
      password: "BrandNewPass9",
    });
    expect(login.status).toBe(200);
  });
});
