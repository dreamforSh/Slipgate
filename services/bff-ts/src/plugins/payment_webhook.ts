import { defineSlipgatePlugin } from "@slipgate/plugin-sdk";

/**
 * Built-in plugin: POSTs every settled payment to an operator URL as JSON, signed with
 * `X-Slipgate-Signature: sha256=<hex HMAC of the body>` when a secret is set. No-op until a
 * URL is configured.
 */
export const paymentWebhookPlugin = defineSlipgatePlugin({
  name: "payment-webhook",
  version: "1.0.0",
  description: "Forward settled payments to your own HTTPS endpoint (signed JSON).",
  settings: [
    { key: "url", label: "Webhook URL", placeholder: "https://example.com/hooks/slipgate" },
    { key: "secret", label: "Signing secret", secret: true },
  ],
  async onPaymentSettled(ctx, event) {
    const url = ctx.config?.url?.trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    const body = JSON.stringify({ type: "payment.settled", sentAt: new Date().toISOString(), data: event });
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Slipgate-Webhook/1.0" };
    const secret = ctx.config?.secret;
    if (secret) {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
      headers["X-Slipgate-Signature"] = `sha256=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    }
    const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Webhook answered HTTP ${res.status}`);
    ctx.logger("payment webhook delivered", { orderId: event.orderId });
  },
});
