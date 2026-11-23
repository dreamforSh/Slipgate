import { describe, expect, it } from "bun:test";
import { CustomNavLinkSchema, PortalSettingsSchema, type AccountExportFile } from "@slipgate/contracts";
import { createBffApp } from "../app.ts";
import { assertSafeOutboundUrl, isBlockedHostname, isBlockedIpAddress, ssrfSafeFetch } from "../security/ssrf.ts";
import { TOTP_STEP_SECONDS, totpAt } from "../security/totp.ts";

const JSON_HEADERS = { "Content-Type": "application/json" };

describe("P0 security regressions", () => {
  it("blocks SSRF private, loopback, CGNAT, and metadata targets including redirect hops", async () => {
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254", true)).toBe(true);
    expect(isBlockedIpAddress("100.100.100.200")).toBe(true);
    expect(isBlockedIpAddress("10.1.2.3")).toBe(true);
    expect(isBlockedIpAddress("172.16.5.4")).toBe(true);
    expect(isBlockedIpAddress("192.168.1.1")).toBe(true);
    expect(isBlockedIpAddress("fc00::1")).toBe(true);
    expect(isBlockedIpAddress("fe80::1", true)).toBe(true);
    expect(isBlockedIpAddress("93.184.216.34")).toBe(false);

    expect(isBlockedHostname("metadata.google.internal", true)).toBe(true);
    expect(isBlockedHostname("redis.internal")).toBe(true);
    expect(isBlockedHostname("localhost")).toBe(true);

    await expect(assertSafeOutboundUrl("http://169.254.169.254/latest/meta-data/", { resolveDns: false })).rejects.toThrow();

    const mockRedirectFetch = (async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data/" },
      })) as unknown as typeof fetch;
    await expect(ssrfSafeFetch("https://93.184.216.34/hook", { method: "POST" }, mockRedirectFetch, { resolveDns: false })).rejects.toThrow();
  });

  it("rejects protocol-relative // URLs in portal settings and custom nav links", () => {
    expect(CustomNavLinkSchema.safeParse({ label: "Docs", url: "//evil.example.com/phish" }).success).toBe(false);
    expect(CustomNavLinkSchema.safeParse({ label: "Docs", url: "/docs" }).success).toBe(true);
    expect(PortalSettingsSchema.shape.logoUrl.safeParse("//evil.example.com/logo.png").success).toBe(false);
  });

  it("enforces fresh 2FA TOTP step-up on /api/v1/admin/accounts/export when admin has 2FA enabled", async () => {
    const app = createBffApp({
      jwtSecret: "p0-export-jwt-secret-32-bytes-minimum!!",
      vaultSecret: "p0-export-vault-secret-32-bytes-minimum!",
    });
    const adminPassword = "AdminPassword123!";
    const initRes = await app.request("/api/v1/setup/initialize", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        siteName: "P0 Test",
        adminEmail: "admin@p0.test",
        adminPassword,
        allowRegistration: false,
      }),
    });
    expect(initRes.status).toBe(201);
    const { accessToken } = (await initRes.json()) as { accessToken: string };
    const authHeaders = { ...JSON_HEADERS, Authorization: `Bearer ${accessToken}` };

    // Set up and enable 2FA on the admin account.
    const setupTotpRes = await app.request("/api/v1/user/totp/setup", { method: "POST", headers: authHeaders });
    expect(setupTotpRes.status).toBe(200);
    const { secret } = (await setupTotpRes.json()) as { secret: string };
    const step0 = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
    const enableCode = await totpAt(secret, step0 - 1);
    const enableRes = await app.request("/api/v1/user/totp/enable", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ code: enableCode }),
    });
    expect(enableRes.status).toBe(200);

    // Password alone must now be refused with 403 totp_required.
    const missingTotp = await app.request("/api/v1/admin/accounts/export", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ password: adminPassword }),
    });
    expect(missingTotp.status).toBe(403);
    expect(((await missingTotp.json()) as { error: string }).error).toBe("totp_required");

    // Replaying the already-accepted enableCode must be refused with 403 invalid_totp.
    const replayed = await app.request("/api/v1/admin/accounts/export", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ password: adminPassword, totpCode: enableCode }),
    });
    expect(replayed.status).toBe(403);

    // Fresh current step code succeeds.
    const freshCode = await totpAt(secret, step0);
    const okRes = await app.request("/api/v1/admin/accounts/export", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ password: adminPassword, totpCode: freshCode }),
    });
    expect(okRes.status).toBe(200);
    const exported = (await okRes.json()) as AccountExportFile;
    expect(exported.type).toBe("slipgate-accounts");
  });
});
