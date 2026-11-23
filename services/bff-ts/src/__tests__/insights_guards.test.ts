import { describe, expect, it } from "bun:test";
import { reRedactStoredAuditBody, redactAuditBody, WindowLimiter } from "../insights.ts";

describe("redactAuditBody", () => {
  it("redacts secret fields at any depth, whatever their spelling", () => {
    const body = redactAuditBody(
      JSON.stringify({
        easypay: { enabled: true, pid: "1001", key: "merchant-key-123", keySet: true },
        stripe: { secretKey: "sk_test_abcdefghijklmnop", webhookSecret: "whsec_abcdefghijklmnop" },
        customKey: "my-own-key-0123456789",
        node: { sshKeyPem: "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----" },
        plugin: { config: { url: "https://hooks.example.com/x", secret: "s3cr3t" } },
        "X-Api-Key": "abc123",
        api_key: "abc123",
        keys: ["k1", "k2"],
        accounts: [{ name: "acct", credentials: { access_token: "at", refresh_token: "rt" } }],
        totpCode: "123456",
        password: "",
        passwordSet: false,
      }),
    );
    const parsed = JSON.parse(body) as Record<string, any>;
    expect(parsed.easypay).toEqual({ enabled: true, pid: "1001", key: "[redacted]", keySet: true });
    expect(parsed.stripe).toEqual({ secretKey: "[redacted]", webhookSecret: "[redacted]" });
    expect(parsed.customKey).toBe("[redacted]");
    expect(parsed.node.sshKeyPem).toBe("[redacted]");
    expect(parsed.plugin.config).toEqual({ url: "https://hooks.example.com/x", secret: "[redacted]" });
    expect(parsed["X-Api-Key"]).toBe("[redacted]");
    expect(parsed.api_key).toBe("[redacted]");
    expect(parsed.keys).toBe("[redacted]");
    expect(parsed.accounts[0]).toEqual({ name: "acct", credentials: "[redacted]" });
    expect(parsed.totpCode).toBe("[redacted]");
    // Empty strings and booleans say "cleared"/"set" without leaking anything.
    expect(parsed.password).toBe("");
    expect(parsed.passwordSet).toBe(false);
    for (const secret of ["merchant-key-123", "sk_test_", "whsec_", "my-own-key", "OPENSSH", "s3cr3t", "abc123"]) {
      expect(body).not.toContain(secret);
    }
  });

  it("keeps ordinary fields, including ids that merely mention keys", () => {
    const input = { keyIds: ["key_1", "key_2"], name: "Pro", groupId: "grp_1", tempEmail: "a@b.c", pid: "1001", monthly: 30 };
    expect(JSON.parse(redactAuditBody(JSON.stringify(input)))).toEqual(input);
  });

  it("scrubs credential-shaped text out of free-form strings", () => {
    const body = redactAuditBody(
      JSON.stringify({
        proxy: "socks5://alice:hunter2@10.0.0.1:1080",
        sourceUrl: "https://sub.example.com/link?token=abcdef123456&flag=clash",
        notes: "use sk-ant-api03-AAAAAAAAAAAAAAAAAAAA or Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
        pemDump: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      }),
    );
    const parsed = JSON.parse(body) as Record<string, string>;
    expect(parsed.proxy).toBe("socks5://[redacted]@10.0.0.1:1080");
    expect(parsed.sourceUrl).toBe("https://sub.example.com/link?token=[redacted]&flag=clash");
    expect(parsed.notes).toBe("use [redacted] or Bearer [redacted]");
    expect(parsed.pemDump).toBe("[redacted]");
  });

  it("summarises non-JSON bodies and caps the size", () => {
    expect(redactAuditBody("")).toBe("");
    expect(redactAuditBody("key=secret")).toBe("[non-JSON body, 10 bytes]");
    const long = redactAuditBody(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => "x".repeat(300) + i) }));
    expect(long.length).toBeLessThanOrEqual(4097);
  });

  it("scrubs adversarial text in linear time", () => {
    // Each of these took 0.2-1.1 s at 32k characters (and 4x that at 64k) with the unbounded
    // scheme / parameter-name repetitions; the whole set now runs in a few milliseconds.
    const n = 64_000;
    const inputs = [
      "?a".repeat(n / 2),
      "a.".repeat(n / 2),
      `?${"key".repeat(n / 3)}`,
      `&${"token".repeat(n / 5)}`,
      "eyJ-".repeat(n / 4),
      "AIza-".repeat(n / 5),
      "a.a.a.a.a.a.a.a://xxxxxxxxxxxxxxxx".repeat(n / 34),
      "-----BEGIN ".repeat(n / 11),
    ];
    for (const s of inputs) {
      const started = performance.now();
      redactAuditBody(JSON.stringify({ notes: s }));
      expect(performance.now() - started).toBeLessThan(250);
    }
    // Strings past the stored prefix are not scrubbed at all, so many long strings stay cheap.
    const many = JSON.stringify(Object.fromEntries(Array.from({ length: 5_000 }, (_, i) => [`k${i}`, "?a".repeat(500)])));
    const started = performance.now();
    const out = redactAuditBody(many);
    expect(performance.now() - started).toBeLessThan(250);
    expect(out.length).toBe(4097);
    // Scrubbing still applies to everything that is kept.
    const early = redactAuditBody(JSON.stringify({ a: "x".repeat(3_000), b: "see ?token=abcdef123456", c: "y".repeat(5_000) }));
    expect(early).toContain("?token=[redacted]");
    expect(early).not.toContain("abcdef123456");
  });
});

describe("reRedactStoredAuditBody", () => {
  it("applies the current rules to bodies older builds stored, and only changes what they hide", () => {
    const old = JSON.stringify({
      name: "node-1",
      signature: "abc123def",
      otp: 123456,
      proxy: "socks5://alice:hunter2@10.0.0.1:1080",
      notes: "Bearer abcdefghijklmnop and sk-ant-api03-AAAAAAAAAAAAAAAAAAAA",
      items: ["a", "b", "[+30 more]"],
      long: `${"z".repeat(200)}…`,
      deep: { d: { d: { d: { d: { d: { d: "[…]" } } } } } },
      enabled: true,
      password: "",
    });
    const next = reRedactStoredAuditBody(old);
    const parsed = JSON.parse(next) as Record<string, unknown>;
    expect(parsed.signature).toBe("[redacted]");
    expect(parsed.otp).toBe("[redacted]");
    expect(parsed.proxy).toBe("socks5://[redacted]@10.0.0.1:1080");
    expect(parsed.notes).toBe("Bearer [redacted] and [redacted]");
    // Earlier cuts are kept as they are, not cut again.
    expect(parsed.items).toEqual(["a", "b", "[+30 more]"]);
    expect(parsed.long).toBe(`${"z".repeat(200)}…`);
    expect(parsed.deep).toEqual(JSON.parse(old).deep);
    expect(parsed.name).toBe("node-1");
    expect(parsed.enabled).toBe(true);
    expect(parsed.password).toBe("");
    expect(reRedactStoredAuditBody(next)).toBe(next);
    // Nothing to hide: the exact same text comes back.
    const clean = JSON.stringify({ name: "Pro", keyIds: ["key_1"], monthly: 30, url: "https://example.com/a?b=c" });
    expect(reRedactStoredAuditBody(clean)).toBe(clean);
    expect(reRedactStoredAuditBody("")).toBe("");
    expect(reRedactStoredAuditBody("[non-JSON body, 10 bytes]")).toBe("[non-JSON body, 10 bytes]");
  });

  it("redacts bodies the size cap cut mid-JSON without losing the rest", () => {
    const cut =
      '{"name":"n1","otp":123456,"keys":["a",{"b":"c"}],"mnemonic":{"words":["x","y"]},"flag":false,' +
      '"url":"https://u:p4ss@h.example/x?token=abc123&q=1","escaped":"say \\"Bearer abcdefghijklmn\\" ok",' +
      '"nested":{"sshKeyPem":"-----BEGIN OPENSSH PRIVATE KEY-----\\nAAAA","notes":"sk-abcdefghijklmnopqr…';
    const next = reRedactStoredAuditBody(cut);
    expect(next).toBe(
      '{"name":"n1","otp":"[redacted]","keys":"[redacted]","mnemonic":"[redacted]","flag":false,' +
        '"url":"https://[redacted]@h.example/x?token=[redacted]&q=1","escaped":"say \\"Bearer [redacted]\\" ok",' +
        '"nested":{"sshKeyPem":"[redacted]","notes":"[redacted]…',
    );
    expect(reRedactStoredAuditBody(next)).toBe(next);
    // A secret value cut by the cap is replaced up to the end.
    expect(reRedactStoredAuditBody('{"a":"b","signature":"abcdef…')).toBe('{"a":"b","signature":"[redacted]…');
    expect(reRedactStoredAuditBody('{"a":"b","keys":["k1","k2…')).toBe('{"a":"b","keys":"[redacted]"');
  });
});

describe("WindowLimiter", () => {
  it("limits each key per window and starts a fresh window afterwards", () => {
    const limiter = new WindowLimiter(2, 1_000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 10)).toBe(true);
    expect(limiter.allow("a", 20)).toBe(false);
    expect(limiter.allow("b", 20)).toBe(true);
    expect(limiter.allow("a", 1_000)).toBe(true);
    expect(limiter.allow("a", 1_001)).toBe(true);
    expect(limiter.allow("a", 1_002)).toBe(false);
  });

  it("drops expired keys as time passes, including keys that restarted their window", () => {
    const limiter = new WindowLimiter(5, 1_000);
    limiter.allow("old", 0);
    limiter.allow("mid", 500);
    limiter.allow("old", 1_100); // new window for "old": now expires after "mid"
    expect(limiter.size).toBe(2);
    limiter.allow("other", 1_600); // "mid" expired at 1_500
    expect(limiter.size).toBe(2);
    limiter.allow("other", 2_101); // "old" expired at 2_100
    expect(limiter.size).toBe(1);
  });

  it("stays bounded and fast under a flood of distinct live keys", () => {
    const limiter = new WindowLimiter(30, 60_000, 1_000);
    for (let i = 0; i < 5_000; i++) limiter.allow(`flood-${i}`, 1_000);
    expect(limiter.size).toBe(1_000);
    // The newest keys are kept and still counted.
    for (let i = 0; i < 30; i++) limiter.allow("flood-4999", 1_000);
    expect(limiter.allow("flood-4999", 1_000)).toBe(false);

    // Default cap: well past the old 10k prune threshold with every entry still live. The old
    // code walked the whole map on each insert (minutes for this loop); now it is O(1) each.
    const big = new WindowLimiter(30, 60_000);
    const started = performance.now();
    for (let i = 0; i < 120_000; i++) big.allow(`ip-${i}`, 5_000);
    expect(big.size).toBe(50_000);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it("stores header-sized keys as fixed-size digests, still counted per exact key", () => {
    const limiter = new WindowLimiter(2, 60_000, 100);
    const hits = (limiter as unknown as { hits: Map<string, unknown> }).hits;
    // ~16 KB keys (about the most a request header can carry) sharing all but their last character.
    const prefix = `promo:${"9".repeat(16_000)}`;
    for (let i = 0; i < 500; i++) limiter.allow(`${prefix}${i}`, 1_000);
    expect(limiter.size).toBe(100);
    let chars = 0;
    for (const k of hits.keys()) chars += k.length;
    expect(chars).toBeLessThanOrEqual(100 * 64);
    // Keys differing only at the end are separate counters; the same long key is one counter.
    expect(limiter.allow(`${prefix}a`, 1_000)).toBe(true);
    expect(limiter.allow(`${prefix}a`, 1_000)).toBe(true);
    expect(limiter.allow(`${prefix}a`, 1_000)).toBe(false);
    expect(limiter.allow(`${prefix}b`, 1_000)).toBe(true);
    // Short keys are stored as given.
    limiter.allow("code:203.0.113.9", 1_000);
    expect(hits.has("code:203.0.113.9")).toBe(true);
  });
});
