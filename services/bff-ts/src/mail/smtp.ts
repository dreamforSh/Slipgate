import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * Minimal SMTP submission client (RFC 5321/4954/3207): implicit TLS (465), STARTTLS
 * (587/25) or plain, AUTH PLAIN/LOGIN, one message per connection. UTF-8 subject and
 * display names are RFC 2047 encoded; bodies are base64 so any language survives.
 */

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
  /** Accept self-signed certificates (private relays only). */
  allowInsecureTls?: boolean;
  timeoutMs?: number;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

function encodeWord(text: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, "$&\r\n");
}

function assertHeaderSafe(value: string, what: string) {
  if (/[\r\n]/.test(value)) throw new Error(`Invalid ${what}`);
}

export function buildMime(cfg: Pick<SmtpConfig, "fromAddress" | "fromName">, msg: MailMessage, now = new Date()): string {
  assertHeaderSafe(msg.to, "recipient");
  assertHeaderSafe(msg.subject, "subject");
  assertHeaderSafe(cfg.fromAddress, "sender");
  const boundary = `sg-${crypto.randomUUID()}`;
  const domain = cfg.fromAddress.split("@")[1] ?? "localhost";
  const text = msg.text ?? msg.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const headers = [
    `From: ${cfg.fromName ? `${encodeWord(cfg.fromName)} ` : ""}<${cfg.fromAddress}>`,
    `To: <${msg.to}>`,
    `Subject: ${encodeWord(msg.subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, "Content-Transfer-Encoding: base64", "", wrap76(Buffer.from(body, "utf8").toString("base64"))].join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${part("text/plain", text)}\r\n${part("text/html", msg.html)}\r\n--${boundary}--\r\n`;
}

/** Line-oriented reader collecting multi-line SMTP replies ("250-..." until "250 ..."). */
class ReplyReader {
  private buffer = "";
  private waiters: ((reply: { code: number; text: string }) => void)[] = [];
  private failure: Error | null = null;
  private failWaiters: ((err: Error) => void)[] = [];
  private lines: string[] = [];

  attach(socket: Socket | TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\r\n")) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        this.lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          const code = Number.parseInt(line.slice(0, 3), 10);
          const text = this.lines.map((l) => l.slice(4)).join("\n");
          this.lines = [];
          this.waiters.shift()?.({ code, text });
          this.failWaiters.shift();
        }
      }
    });
  }

  fail(err: Error) {
    this.failure ??= err;
    for (const w of this.failWaiters.splice(0)) w(err);
    this.waiters = [];
  }

  next(): Promise<{ code: number; text: string }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.failWaiters.push(reject);
    });
  }
}

/** Sends one message. Resolves with the server's final reply text; throws SmtpError on refusal. */
export async function sendMail(cfg: SmtpConfig, msg: MailMessage): Promise<string> {
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const tlsOptions = { servername: cfg.host, rejectUnauthorized: !cfg.allowInsecureTls };
  let socket: Socket | TLSSocket =
    cfg.security === "tls"
      ? tlsConnect({ host: cfg.host, port: cfg.port, ...tlsOptions })
      : netConnect({ host: cfg.host, port: cfg.port });
  let reader = new ReplyReader();
  const arm = (s: Socket | TLSSocket, r: ReplyReader) => {
    s.setTimeout(timeoutMs, () => {
      r.fail(new Error("SMTP connection timed out"));
      s.destroy();
    });
    s.on("error", (err) => r.fail(err));
    s.on("close", () => r.fail(new Error("SMTP connection closed")));
    r.attach(s);
  };
  arm(socket, reader);

  const expect = async (ok: number[], what: string) => {
    const reply = await reader.next();
    if (!ok.includes(reply.code)) throw new SmtpError(`${what} refused: ${reply.code} ${reply.text}`, reply.code);
    return reply;
  };
  const send = (line: string) => socket.write(`${line}\r\n`);

  try {
    await expect([220], "Greeting");
    const ehloName = "slipgate.local";
    send(`EHLO ${ehloName}`);
    let ehlo = await expect([250], "EHLO");

    if (cfg.security === "starttls") {
      if (!/STARTTLS/i.test(ehlo.text)) throw new SmtpError("Server does not offer STARTTLS", 0);
      send("STARTTLS");
      await expect([220], "STARTTLS");
      const plain = socket as Socket;
      plain.removeAllListeners("data");
      plain.removeAllListeners("timeout");
      plain.removeAllListeners("close");
      plain.removeAllListeners("error");
      socket = tlsConnect({ socket: plain, ...tlsOptions });
      reader = new ReplyReader();
      arm(socket, reader);
      await new Promise<void>((resolve, reject) => {
        (socket as TLSSocket).once("secureConnect", () => resolve());
        (socket as TLSSocket).once("error", reject);
      });
      send(`EHLO ${ehloName}`);
      ehlo = await expect([250], "EHLO");
    }

    if (cfg.username) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text)) {
        send(`AUTH PLAIN ${Buffer.from(`\u0000${cfg.username}\u0000${cfg.password}`, "utf8").toString("base64")}`);
        await expect([235], "Authentication");
      } else {
        send("AUTH LOGIN");
        await expect([334], "Authentication");
        send(Buffer.from(cfg.username, "utf8").toString("base64"));
        await expect([334], "Authentication");
        send(Buffer.from(cfg.password, "utf8").toString("base64"));
        await expect([235], "Authentication");
      }
    }

    assertHeaderSafe(msg.to, "recipient");
    send(`MAIL FROM:<${cfg.fromAddress}>`);
    await expect([250], "Sender");
    send(`RCPT TO:<${msg.to}>`);
    await expect([250, 251], "Recipient");
    send("DATA");
    await expect([354], "DATA");
    // Dot-stuffing: lines starting with "." get an extra dot.
    const mime = buildMime(cfg, msg).replace(/\r\n\./g, "\r\n..");
    socket.write(`${mime}\r\n.\r\n`);
    const done = await expect([250], "Message");
    send("QUIT");
    return done.text;
  } finally {
    setTimeout(() => socket.destroy(), 50);
  }
}

export { SmtpError };
