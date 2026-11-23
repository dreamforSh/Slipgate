const std = @import("std");
const core = @import("slipgate_core");
const frame = core.frame;
const gateway = core.gateway;

const VERSION = "0.2.0";

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    for (args[1..]) |arg| {
        if (std.mem.eql(u8, arg, "--version")) {
            try std.io.getStdOut().writer().print("slipgate-core {s}\n", .{VERSION});
            return;
        }
    }

    var engine = gateway.GatewayEngine.init(allocator);
    defer engine.deinit();

    const raw_addr = std.process.getEnvVarOwned(allocator, "SLIPGATE_CORE_ADDR") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, "127.0.0.1:19081"),
        else => return err,
    };
    defer allocator.free(raw_addr);

    const raw_token = std.process.getEnvVarOwned(allocator, "SLIPGATE_INTERNAL_TOKEN") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, ""),
        else => return err,
    };
    defer allocator.free(raw_token);
    const ipc_token = std.mem.trim(u8, raw_token, " \t\r\n");

    const parsed = try frame.parseEndpoint(raw_addr, 19081);
    const addr = try std.net.Address.parseIp(parsed.host, parsed.port);
    var server = try addr.listen(.{ .reuse_address = true });
    defer server.deinit();

    var active_conns = std.atomic.Value(u32).init(0);

    std.log.info("slipgate-core {s} listening on {s}:{d} (ipc_auth={})", .{ VERSION, parsed.host, parsed.port, ipc_token.len > 0 });

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
        const thread = std.Thread.spawn(.{}, gateway.serveEngineConnectionAuth, .{ allocator, conn, &engine, ipc_token, &active_conns }) catch |err| {
            _ = active_conns.fetchSub(1, .release);
            std.log.err("thread spawn error: {s}", .{@errorName(err)});
            conn.stream.close();
            continue;
        };
        thread.detach();
    }
}
