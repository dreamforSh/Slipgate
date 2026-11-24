const std = @import("std");

pub const Provider = enum {
    anthropic,
    openai,
    codex,
    gemini,
    antigravity,
    grok,
    deepseek,
    glm,
    kimi,
    minimax,
    qwen,
    bedrock,
    vertex,
    opencode_go,
    typesafe,
    command_code,
    cline,
};

pub const EndpointKind = enum {
    any,
    messages,
    count_tokens,
    responses,
    chat_completions,
    embeddings,
    images,
    videos,
    gemini,
    systemone,
};

pub const MatchType = enum {
    exact,
    prefix,
};

pub const RouteRule = struct {
    id: []const u8,
    public_model: []const u8,
    match_type: MatchType,
    target_platform: Provider,
    upstream_model: []const u8,
    endpoint: EndpointKind = .any,
    priority: i32 = 100,
    enabled: bool = true,
};

pub const ResolutionSource = enum {
    explicit_rule,
    builtin_detector,
};

pub const RouteMatch = struct {
    provider: Provider,
    upstream_model: []const u8,
    rule_id: ?[]const u8,
    source: ResolutionSource,
};

pub const RouteError = error{
    UnknownModel,
};

fn matchesRule(rule: RouteRule, endpoint: EndpointKind, public_model: []const u8) bool {
    if (!rule.enabled) return false;
    if (rule.endpoint != .any and rule.endpoint != endpoint) return false;
    return switch (rule.match_type) {
        .exact => std.mem.eql(u8, rule.public_model, public_model),
        .prefix => std.mem.startsWith(u8, public_model, rule.public_model),
    };
}

fn ruleBeats(candidate: RouteRule, incumbent: RouteRule) bool {
    const c_exact = candidate.match_type == .exact;
    const i_exact = incumbent.match_type == .exact;
    if (c_exact != i_exact) return c_exact;

    const c_ep_specific = candidate.endpoint != .any;
    const i_ep_specific = incumbent.endpoint != .any;
    if (c_ep_specific != i_ep_specific) return c_ep_specific;

    if (candidate.public_model.len != incumbent.public_model.len) {
        return candidate.public_model.len > incumbent.public_model.len;
    }
    return candidate.priority < incumbent.priority;
}

/// Resolves a public model identifier via explicit composite rules first, then built-in prefixes.
/// Unknown or ambiguous models fail closed with error.UnknownModel.
pub fn resolveRoute(rules: []const RouteRule, endpoint: EndpointKind, public_model: []const u8) RouteError!RouteMatch {
    var best: ?RouteRule = null;
    for (rules) |rule| {
        if (!matchesRule(rule, endpoint, public_model)) continue;
        if (best == null or ruleBeats(rule, best.?)) {
            best = rule;
        }
    }

    if (best) |winner| {
        const upstream = if (winner.upstream_model.len > 0) winner.upstream_model else public_model;
        return .{
            .provider = winner.target_platform,
            .upstream_model = upstream,
            .rule_id = winner.id,
            .source = .explicit_rule,
        };
    }

    if (detectBuiltinProvider(public_model)) |provider| {
        return .{
            .provider = provider,
            .upstream_model = public_model,
            .rule_id = null,
            .source = .builtin_detector,
        };
    }

    return error.UnknownModel;
}

fn detectBuiltinProvider(model: []const u8) ?Provider {
    if (std.mem.startsWith(u8, model, "antigravity/") or std.mem.startsWith(u8, model, "ag-")) return .antigravity;
    if (std.mem.startsWith(u8, model, "codex-") or
        std.mem.startsWith(u8, model, "codex/") or
        std.mem.startsWith(u8, model, "gpt-5-codex") or
        std.mem.startsWith(u8, model, "o3-codex") or
        std.mem.startsWith(u8, model, "o4-mini-codex")) return .codex;
    if (std.mem.startsWith(u8, model, "claude-") or std.mem.startsWith(u8, model, "anthropic/")) return .anthropic;
    if (std.mem.startsWith(u8, model, "gemini-") or
        std.mem.startsWith(u8, model, "google/") or
        std.mem.startsWith(u8, model, "imagen-") or
        std.mem.startsWith(u8, model, "veo-") or
        std.mem.eql(u8, model, "text-embedding-004")) return .gemini;
    if (std.mem.startsWith(u8, model, "gpt-") or
        std.mem.startsWith(u8, model, "chatgpt-") or
        std.mem.startsWith(u8, model, "o1-") or
        std.mem.startsWith(u8, model, "o3-") or
        std.mem.startsWith(u8, model, "o4-") or
        std.mem.startsWith(u8, model, "text-embedding-") or
        std.mem.startsWith(u8, model, "dall-e-") or
        std.mem.startsWith(u8, model, "sora-") or
        std.mem.startsWith(u8, model, "tts-") or
        std.mem.startsWith(u8, model, "whisper-") or
        std.mem.startsWith(u8, model, "text-moderation-") or
        std.mem.startsWith(u8, model, "omni-moderation-") or
        std.mem.startsWith(u8, model, "openai/")) return .openai;
    if (std.mem.startsWith(u8, model, "grok-") or std.mem.startsWith(u8, model, "xai/")) return .grok;
    if (std.mem.startsWith(u8, model, "deepseek-")) return .deepseek;
    if (std.mem.startsWith(u8, model, "glm-") or
        std.mem.startsWith(u8, model, "cogview-") or
        std.mem.startsWith(u8, model, "cogvideox-") or
        std.mem.eql(u8, model, "embedding-3")) return .glm;
    if (std.mem.startsWith(u8, model, "kimi-") or std.mem.startsWith(u8, model, "moonshot-")) return .kimi;
    if (std.ascii.startsWithIgnoreCase(model, "minimax-") or std.mem.startsWith(u8, model, "abab")) return .minimax;
    if (std.mem.startsWith(u8, model, "qwen-") or
        std.mem.startsWith(u8, model, "qwq-") or
        std.mem.startsWith(u8, model, "wanx-") or
        std.mem.startsWith(u8, model, "qwen/")) return .qwen;
    if (std.mem.startsWith(u8, model, "bedrock/") or
        std.mem.startsWith(u8, model, "anthropic.claude") or
        std.mem.startsWith(u8, model, "amazon.nova") or
        std.mem.startsWith(u8, model, "amazon.titan")) return .bedrock;
    if (std.mem.startsWith(u8, model, "vertex/") or std.mem.startsWith(u8, model, "vertex_ai/")) return .vertex;
    if (std.mem.startsWith(u8, model, "jev-") or std.mem.startsWith(u8, model, "typesafe/")) return .typesafe;
    if (std.mem.startsWith(u8, model, "opencode_go/") or
        std.mem.startsWith(u8, model, "opencode-go/") or
        std.mem.startsWith(u8, model, "opencode/") or
        std.mem.startsWith(u8, model, "longcat-") or
        std.mem.startsWith(u8, model, "mimo-") or
        std.mem.startsWith(u8, model, "muse-spark-") or
        std.mem.eql(u8, model, "hy3") or
        std.mem.startsWith(u8, model, "hy4-") or
        std.mem.startsWith(u8, model, "omen-")) return .opencode_go;
    if (std.mem.startsWith(u8, model, "command_code/") or std.mem.startsWith(u8, model, "command-code/")) return .command_code;
    if (std.mem.startsWith(u8, model, "cline/") or
        std.mem.startsWith(u8, model, "cline-pass/") or
        std.mem.startsWith(u8, model, "cline-free/")) return .cline;
    return null;
}

test "explicit exact route beats prefix and builtin detection" {
    const rules = [_]RouteRule{
        .{
            .id = "r-prefix",
            .public_model = "claude-",
            .match_type = .prefix,
            .target_platform = .anthropic,
            .upstream_model = "",
            .endpoint = .any,
            .priority = 10,
        },
        .{
            .id = "r-exact-ag",
            .public_model = "claude-sonnet-4-5",
            .match_type = .exact,
            .target_platform = .antigravity,
            .upstream_model = "claude-sonnet-4-5-thinking",
            .endpoint = .messages,
            .priority = 50,
        },
    };

    const match = try resolveRoute(&rules, .messages, "claude-sonnet-4-5");
    try std.testing.expectEqual(Provider.antigravity, match.provider);
    try std.testing.expectEqualStrings("claude-sonnet-4-5-thinking", match.upstream_model);
    try std.testing.expectEqual(ResolutionSource.explicit_rule, match.source);
}

test "unknown model fails closed" {
    try std.testing.expectError(error.UnknownModel, resolveRoute(&.{}, .chat_completions, "totally-unknown-model"));
}

test "builtin detector distinguishes codex and antigravity models" {
    const codex_match = try resolveRoute(&.{}, .responses, "gpt-5-codex");
    try std.testing.expectEqual(Provider.codex, codex_match.provider);

    const ag_match = try resolveRoute(&.{}, .messages, "antigravity/claude-sonnet-4-5");
    try std.testing.expectEqual(Provider.antigravity, ag_match.provider);

    const qwen_match = try resolveRoute(&.{}, .chat_completions, "qwen-max");
    try std.testing.expectEqual(Provider.qwen, qwen_match.provider);

    const mm_match = try resolveRoute(&.{}, .chat_completions, "MiniMax-M2");
    try std.testing.expectEqual(Provider.minimax, mm_match.provider);

    const oc_match = try resolveRoute(&.{}, .chat_completions, "opencode_go/glm-5.3");
    try std.testing.expectEqual(Provider.opencode_go, oc_match.provider);

    const hy4_match = try resolveRoute(&.{}, .chat_completions, "hy4-preview");
    try std.testing.expectEqual(Provider.opencode_go, hy4_match.provider);

    const ts_match = try resolveRoute(&.{}, .systemone, "jev-latest");
    try std.testing.expectEqual(Provider.typesafe, ts_match.provider);

    const cc_match = try resolveRoute(&.{}, .chat_completions, "command_code/deepseek/deepseek-v4-flash");
    try std.testing.expectEqual(Provider.command_code, cc_match.provider);

    const cline_match = try resolveRoute(&.{}, .chat_completions, "cline-pass/glm-5.3-flash");
    try std.testing.expectEqual(Provider.cline, cline_match.provider);
}
