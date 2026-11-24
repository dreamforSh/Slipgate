const std = @import("std");
const core = @import("slipgate_core");
const frame = core.frame;
const risk_gate = core.risk_gate;

const VERSION = "0.2.0";

fn getEnvOrDefault(allocator: std.mem.Allocator, name: []const u8, fallback: []const u8) ![]u8 {
    return std.process.getEnvVarOwned(allocator, name) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, fallback),
        else => return err,
    };
}

fn isValidCleanseMode(mode: []const u8) bool {
    return std.mem.eql(u8, mode, "zero") or
        std.mem.eql(u8, mode, "official") or
        std.mem.eql(u8, mode, "template");
}

fn isValidTelemetryMode(mode: []const u8) bool {
    return std.mem.eql(u8, mode, "enabled") or
        std.mem.eql(u8, mode, "isolated") or
        std.mem.eql(u8, mode, "disabled");
}

fn isValidRuntimeProfile(profile: []const u8) bool {
    return std.mem.eql(u8, profile, "claude_code") or
        std.mem.eql(u8, profile, "codex_cli") or
        std.mem.eql(u8, profile, "antigravity");
}

fn isSafeJsonToken(s: []const u8) bool {
    if (s.len == 0 or s.len > 128) return false;
    for (s) |ch| {
        if (ch < 0x20 or ch == '"' or ch == '\\') return false;
    }
    return true;
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    for (args[1..]) |arg| {
        if (std.mem.eql(u8, arg, "--version")) {
            try std.io.getStdOut().writer().print("slipgate-guestd {s}\n", .{VERSION});
            return;
        }
    }

    const machine_id = std.process.getEnvVarOwned(allocator, "SLIPGATE_GUEST_MACHINE_ID") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => {
            std.log.err("SLIPGATE_GUEST_MACHINE_ID is required and must be a non-zero 32-hex string", .{});
            return error.MissingGuestMachineId;
        },
        else => return err,
    };
    defer allocator.free(machine_id);

    if (!risk_gate.isValidGuestMachineId(machine_id)) {
        std.log.err("invalid SLIPGATE_GUEST_MACHINE_ID: must be 32 lowercase hex chars and non-zero", .{});
        return error.InvalidGuestMachineId;
    }

    const slot_id = try getEnvOrDefault(allocator, "SLIPGATE_SLOT_ID", "slot-local");
    defer allocator.free(slot_id);
    if (!isSafeJsonToken(slot_id)) {
        return error.InvalidSlotId;
    }

    const raw_max_subagents = try getEnvOrDefault(allocator, "SLIPGATE_MAX_SUBAGENTS", "20");
    defer allocator.free(raw_max_subagents);
    const parsed_max = std.fmt.parseInt(u32, raw_max_subagents, 10) catch 20;
    const max_subagents: u32 = @max(@as(u32, 1), @min(@as(u32, 64), parsed_max));

    const cleanse_mode = try getEnvOrDefault(allocator, "SLIPGATE_CLEANSE_MODE", "zero");
    defer allocator.free(cleanse_mode);
    if (!isValidCleanseMode(cleanse_mode)) {
        return error.InvalidCleanseMode;
    }

    const telemetry_mode = try getEnvOrDefault(allocator, "SLIPGATE_TELEMETRY_MODE", "isolated");
    defer allocator.free(telemetry_mode);
    if (!isValidTelemetryMode(telemetry_mode)) {
        return error.InvalidTelemetryMode;
    }

    const runtime_profile = try getEnvOrDefault(allocator, "SLIPGATE_RUNTIME_PROFILE", "claude_code");
    defer allocator.free(runtime_profile);
    if (!isValidRuntimeProfile(runtime_profile)) {
        return error.InvalidRuntimeProfile;
    }

    const directive_json = try std.fmt.allocPrint(
        allocator,
        "{{\"daemon\":\"slipgate-guestd\",\"version\":\"{s}\",\"slot_id\":\"{s}\",\"guest_machine_id\":\"{s}\",\"runtime_profile\":\"{s}\",\"native_handoff_v1\":true,\"max_subagents\":{d},\"cleanse_mode\":\"{s}\",\"telemetry_mode\":\"{s}\"}}",
        .{ VERSION, slot_id, machine_id, runtime_profile, max_subagents, cleanse_mode, telemetry_mode },
    );
    defer allocator.free(directive_json);

    const raw_addr = try getEnvOrDefault(allocator, "SLIPGATE_GUEST_ADDR", "127.0.0.1:19090");
    defer allocator.free(raw_addr);

    const guest_token = try getEnvOrDefault(allocator, "SLIPGATE_GUEST_TOKEN", "");
    defer allocator.free(guest_token);

    const parsed = try frame.parseEndpoint(raw_addr, 19090);
    const addr = try std.net.Address.parseIp(parsed.host, parsed.port);
    var server = try addr.listen(.{ .reuse_address = true });
    defer server.deinit();

    var active_conns = std.atomic.Value(u32).init(0);

    std.log.info(
        "slipgate-guestd {s} bound to slot={s} machine_id={s} listening on {s}:{d}",
        .{ VERSION, slot_id, machine_id, parsed.host, parsed.port },
    );

    while (true) {
        const conn = server.accept() catch |err| {
            std.log.err("accept error: {s}", .{@errorName(err)});
            continue;
        };
        if (active_conns.fetchAdd(1, .acq_rel) >= frame.MAX_CONCURRENT_CONNS) {
            _ = active_conns.fetchSub(1, .release);
            conn.stream.close();
            continue;
        }
        const thread = std.Thread.spawn(.{}, frame.serveConnectionAuthBounded, .{ allocator, conn, @as([]const u8, directive_json), @as([]const u8, guest_token), &active_conns }) catch |err| {
            _ = active_conns.fetchSub(1, .release);
            std.log.err("thread spawn error: {s}", .{@errorName(err)});
            conn.stream.close();
            continue;
        };
        thread.detach();
    }
}
