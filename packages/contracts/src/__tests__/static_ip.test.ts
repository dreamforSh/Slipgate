import { describe, expect, it } from "bun:test";
import {
  isStaticIpSubscription,
  parseStaticIpLine,
  readStaticIpClashYaml,
  staticIpAddress,
  staticIpClashYaml,
  staticIpKey,
} from "../index.ts";

describe("parseStaticIpLine", () => {
  it("reads the common seller formats", () => {
    expect(parseStaticIpLine("socks5://user:p%40ss@1.2.3.4:1080")).toEqual({
      ok: true,
      proxy: { protocol: "socks5", host: "1.2.3.4", port: 1080, username: "user", password: "p@ss" },
    });
    expect(parseStaticIpLine("https://proxy.example.com:8443/")).toMatchObject({
      ok: true,
      proxy: { protocol: "https", host: "proxy.example.com", port: 8443, username: "" },
    });
    expect(parseStaticIpLine("u:p@5.6.7.8:3128", "http")).toMatchObject({ ok: true, proxy: { protocol: "http", username: "u", password: "p" } });
    // host:port:user:pass keeps colons inside the password.
    expect(parseStaticIpLine("9.9.9.9:8000:alice:s3:cr3t")).toMatchObject({
      ok: true,
      proxy: { protocol: "socks5", host: "9.9.9.9", port: 8000, username: "alice", password: "s3:cr3t" },
    });
    expect(parseStaticIpLine("[2001:db8::1]:1080")).toMatchObject({ ok: true, proxy: { host: "2001:db8::1", port: 1080 } });
    expect(parseStaticIpLine("socks5h://h.example:1")).toMatchObject({ ok: true, proxy: { protocol: "socks5" } });
  });

  it("rejects malformed lines with a reason", () => {
    expect(parseStaticIpLine("   ")).toEqual({ ok: false, error: "empty" });
    expect(parseStaticIpLine("ftp://1.2.3.4:21")).toEqual({ ok: false, error: "bad_protocol" });
    expect(parseStaticIpLine("constructor://1.2.3.4:21")).toEqual({ ok: false, error: "bad_protocol" });
    expect(parseStaticIpLine("1.2.3.4")).toEqual({ ok: false, error: "bad_port" });
    expect(parseStaticIpLine("1.2.3.4:70000")).toEqual({ ok: false, error: "bad_port" });
    expect(parseStaticIpLine("999.1.1.1:80")).toEqual({ ok: false, error: "bad_host" });
    expect(parseStaticIpLine("1.2.3.4:80:user")).toEqual({ ok: false, error: "bad_format" });
  });
});

describe("static IP Clash YAML", () => {
  it("round-trips protocol, endpoint and user without exposing the password", () => {
    const proxy = { protocol: "https" as const, host: "1.2.3.4", port: 8443, username: 'we"ird', password: "p#:ss" };
    const yaml = staticIpClashYaml(proxy, "office #1");
    expect(yaml).toContain('name: "office #1"');
    expect(yaml).toContain("type: http");
    expect(yaml).toContain("tls: true");
    expect(yaml).toContain('password: "p#:ss"');
    expect(readStaticIpClashYaml(yaml)).toEqual({ protocol: "https", host: "1.2.3.4", port: 8443, username: 'we"ird', hasPassword: true });
    const socks = staticIpClashYaml({ protocol: "socks5", host: "h.example", port: 1080, username: "", password: "" }, "s");
    expect(readStaticIpClashYaml(socks)).toEqual({ protocol: "socks5", host: "h.example", port: 1080, username: "", hasPassword: false });
    expect(readStaticIpClashYaml("proxies: []")).toBeNull();
  });

  it("names, keys and marks static sources", () => {
    expect(staticIpAddress({ host: "2001:db8::1", port: 1080 })).toBe("[2001:db8::1]:1080");
    expect(staticIpKey({ host: "H.example", port: 1, username: "u" })).toBe("h.example:1:u");
    expect(isStaticIpSubscription("ip-1a2b")).toBe(true);
    expect(isStaticIpSubscription("sub-1a2b")).toBe(false);
  });
});
