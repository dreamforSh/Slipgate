const std = @import("std");

pub const BanDuration = enum {
    none,
    ten_minutes,
    twenty_four_hours,
    permanent,
};

pub const CleanseMode = enum {
    zero,
    official,
    template,
};

/// Computes the escalating device/session ban ladder.
/// Ordinary upstream HTTP 400 responses never increment strikes or trigger bans.
pub fn nextBanTier(prior_strikes: u8, is_ordinary_upstream_400: bool) BanDuration {
    if (is_ordinary_upstream_400) return .none;
    return switch (prior_strikes) {
        0 => .ten_minutes,
        1 => .twenty_four_hours,
        else => .permanent,
    };
}

/// Identifies internal CLI/IDE tools across Claude Code, Codex CLI, and Antigravity that must never leak to callers under Zero-Injection mode.
pub fn isInternalCliTool(tool_name: []const u8) bool {
    const internal_tools = [_][]const u8{
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "NotebookEdit",
        "apply_patch",
        "exec_command",
        "write_stdin",
        "update_plan",
        "view_file_outline",
        "run_command",
        "browser_subagent",
    };
    for (internal_tools) |name| {
        if (std.mem.eql(u8, tool_name, name)) return true;
    }
    return false;
}

/// Returns true when an internal tool should be stripped from outbound/inbound definitions
/// because the caller did not explicitly declare it under CleanseMode.zero.
pub fn shouldStripInternalTool(
    mode: CleanseMode,
    tool_name: []const u8,
    caller_declared_tools: []const []const u8,
) bool {
    if (mode != .zero) return false;
    if (!isInternalCliTool(tool_name)) return false;
    for (caller_declared_tools) |declared| {
        if (std.mem.eql(u8, declared, tool_name)) return false;
    }
    return true;
}

/// Validates a VM slot's 32-char lowercase hex non-zero machine-id invariant.
pub fn isValidGuestMachineId(id: []const u8) bool {
    if (id.len != 32) return false;
    var all_zero = true;
    for (id) |ch| {
        const is_digit = ch >= '0' and ch <= '9';
        const is_hex_lower = ch >= 'a' and ch <= 'f';
        if (!is_digit and !is_hex_lower) return false;
        if (ch != '0') all_zero = false;
    }
    return !all_zero;
}

test "guest machine-id validator rejects zeros, uppercase, and invalid lengths" {
    try std.testing.expect(isValidGuestMachineId("a1b2c3d4e5f60718293a4b5c6d7e8f90"));
    try std.testing.expect(!isValidGuestMachineId("00000000000000000000000000000000"));
    try std.testing.expect(!isValidGuestMachineId("A1B2C3D4E5F60718293A4B5C6D7E8F90"));
    try std.testing.expect(!isValidGuestMachineId("short"));
}

test "ban ladder escalates cleanly and exempts ordinary upstream 400" {
    try std.testing.expectEqual(BanDuration.none, nextBanTier(2, true));
    try std.testing.expectEqual(BanDuration.ten_minutes, nextBanTier(0, false));
    try std.testing.expectEqual(BanDuration.twenty_four_hours, nextBanTier(1, false));
    try std.testing.expectEqual(BanDuration.permanent, nextBanTier(2, false));
}

test "zero-injection gate strips undeclared CLI tools but preserves caller tools" {
    const caller_tools = [_][]const u8{"Bash"};
    try std.testing.expect(!shouldStripInternalTool(.zero, "Bash", &caller_tools));
    try std.testing.expect(shouldStripInternalTool(.zero, "Read", &caller_tools));
    try std.testing.expect(shouldStripInternalTool(.zero, "exec_command", &caller_tools));
    try std.testing.expect(shouldStripInternalTool(.zero, "browser_subagent", &caller_tools));
    try std.testing.expect(!shouldStripInternalTool(.official, "Read", &caller_tools));
}
