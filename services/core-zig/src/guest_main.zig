const std = @import("std");
const core = @import("slipgate_core");
const frame = core.frame;
const risk_gate = core.risk_gate;

const VERSION = "0.1.0";
const GUEST_DIRECTIVE_JSON = "{\"daemon\":\"slipgate-guestd\",\"native_handoff_v1\":true,\"max_subagents\":20}";

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

    if (std.process.getEnvVarOwned(allocator, "SLIPGATE_GUEST_MACHINE_ID")) |machine_id| {
        defer allocator.free(machine_id);
        if (!risk_gate.isValidGuestMachineId(machine_id)) {
            std.log.err("invalid SLIPGATE_GUEST_MACHINE_ID: must be 32 lowercase hex chars and non-zero", .{});
            return error.InvalidGuestMachineId;
        }
    } else |err| switch (err) {
        error.EnvironmentVariableNotFound => {},
        else => return err,
    }

    const raw_addr = std.process.getEnvVarOwned(allocator, "SLIPGATE_GUEST_LISTEN") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, "127.0.0.1:19083"),
        else => return err,
    };
    defer allocator.free(raw_addr);

    const parsed = try frame.parseEndpoint(raw_addr, 19083);
    const addr = try std.net.Address.parseIp(parsed.host, parsed.port);
    var server = try addr.listen(.{ .reuse_address = true });
    defer server.deinit();

    std.log.info("slipgate-guestd {s} listening on {s}:{d}", .{ VERSION, parsed.host, parsed.port });

    while (true) {
        const conn = server.accept() catch |err| {
            std.log.err("accept error: {s}", .{@errorName(err)});
            continue;
        };
        const thread = std.Thread.spawn(.{}, frame.serveConnection, .{ allocator, conn, GUEST_DIRECTIVE_JSON }) catch |err| {
            std.log.err("thread spawn error: {s}", .{@errorName(err)});
            conn.stream.close();
            continue;
        };
        thread.detach();
    }
}
