const std = @import("std");

pub const Provider = enum {
    anthropic,
    openai,
    gemini,
    antigravity,
    grok,
    deepseek,
    glm,
    kimi,
    minimax,
};

pub const EndpointKind = enum {
    any,
    messages,
    count_tokens,
    responses,
    chat_completions,
    embeddings,
    images,
    gemini,
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
    if (std.mem.startsWith(u8, model, "claude-") or std.mem.startsWith(u8, model, "anthropic/")) return .anthropic;
    if (std.mem.startsWith(u8, model, "gemini-") or std.mem.startsWith(u8, model, "google/")) return .gemini;
    if (std.mem.startsWith(u8, model, "gpt-") or std.mem.startsWith(u8, model, "codex-") or std.mem.startsWith(u8, model, "openai/")) return .openai;
    if (std.mem.startsWith(u8, model, "grok-") or std.mem.startsWith(u8, model, "xai/")) return .grok;
    if (std.mem.startsWith(u8, model, "deepseek-")) return .deepseek;
    if (std.mem.startsWith(u8, model, "glm-")) return .glm;
    if (std.mem.startsWith(u8, model, "kimi-") or std.mem.startsWith(u8, model, "moonshot-")) return .kimi;
    if (std.mem.startsWith(u8, model, "minimax-") or std.mem.startsWith(u8, model, "abab")) return .minimax;
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
