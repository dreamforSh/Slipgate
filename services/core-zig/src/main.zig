const std = @import("std");
const core = @import("slipgate_core");
const frame = core.frame;

const VERSION = "0.1.0";

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

    const raw_addr = std.process.getEnvVarOwned(allocator, "SLIPGATE_CORE_ADDR") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => try allocator.dupe(u8, "127.0.0.1:19081"),
        else => return err,
    };
    defer allocator.free(raw_addr);

    const parsed = try parseEndpoint(raw_addr);
    const addr = try std.net.Address.parseIp(parsed.host, parsed.port);
    var server = try addr.listen(.{ .reuse_address = true });
    defer server.deinit();

    std.log.info("slipgate-core {s} listening on {s}:{d}", .{ VERSION, parsed.host, parsed.port });

    while (true) {
        const conn = server.accept() catch |err| {
            std.log.err("accept error: {s}", .{@errorName(err)});
            continue;
        };
        const thread = std.Thread.spawn(.{}, handleConnection, .{ allocator, conn }) catch |err| {
            std.log.err("thread spawn error: {s}", .{@errorName(err)});
            conn.stream.close();
            continue;
        };
        thread.detach();
    }
}

const Endpoint = struct {
    host: []const u8,
    port: u16,
};

fn parseEndpoint(raw: []const u8) !Endpoint {
    const trimmed = if (std.mem.startsWith(u8, raw, "tcp://")) raw["tcp://".len..] else raw;
    const colon = std.mem.lastIndexOfScalar(u8, trimmed, ':') orelse return .{
        .host = "127.0.0.1",
        .port = 19081,
    };
    const host = if (colon == 0) "127.0.0.1" else trimmed[0..colon];
    const port = try std.fmt.parseInt(u16, trimmed[colon + 1 ..], 10);
    return .{ .host = host, .port = port };
}

fn handleConnection(allocator: std.mem.Allocator, conn: std.net.Server.Connection) void {
    defer conn.stream.close();

    const reader = conn.stream.reader();
    const writer = conn.stream.writer();

    var frame_arena = std.heap.ArenaAllocator.init(allocator);
    defer frame_arena.deinit();

    while (true) {
        _ = frame_arena.reset(.retain_capacity);
        const arena = frame_arena.allocator();

        var hdr_buf: [frame.HEADER_LEN]u8 = undefined;
        const read_n = reader.readAll(&hdr_buf) catch return;
        if (read_n == 0 or read_n < frame.HEADER_LEN) return;

        const hdr = frame.Header.decode(&hdr_buf) catch return;
        const payload = arena.alloc(u8, hdr.payload_len) catch return;

        if (hdr.payload_len > 0) {
            const payload_n = reader.readAll(payload) catch return;
            if (payload_n != hdr.payload_len) return;
        }

        switch (hdr.frame_type) {
            .ping => {
                const resp_hdr = (frame.Header{
                    .stream_id = hdr.stream_id,
                    .frame_type = .pong,
                    .flags = frame.FLAG_END_STREAM,
                    .payload_len = hdr.payload_len,
                }).encode() catch return;
                writer.writeAll(&resp_hdr) catch return;
                if (payload.len > 0) writer.writeAll(payload) catch return;
            },
            .req_headers => {
                const directive = "{\"engine\":\"slipgate-core\",\"mode\":\"stub-dispatch\"}";
                const resp_hdr = (frame.Header{
                    .stream_id = hdr.stream_id,
                    .frame_type = .dispatch_directive,
                    .flags = frame.FLAG_END_STREAM | frame.FLAG_PASSTHROUGH,
                    .payload_len = @intCast(directive.len),
                }).encode() catch return;
                writer.writeAll(&resp_hdr) catch return;
                writer.writeAll(directive) catch return;
            },
            else => {
                const err_body = "{\"error\":\"unsupported_frame\"}";
                const resp_hdr = (frame.Header{
                    .stream_id = hdr.stream_id,
                    .frame_type = .stream_end,
                    .flags = frame.FLAG_END_STREAM | frame.FLAG_ERROR,
                    .payload_len = @intCast(err_body.len),
                }).encode() catch return;
                writer.writeAll(&resp_hdr) catch return;
                writer.writeAll(err_body) catch return;
            },
        }
    }
}
