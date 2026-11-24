const std = @import("std");

pub const HEADER_LEN: usize = 10;
pub const MAX_PAYLOAD_LEN: u32 = 16 * 1024 * 1024;

pub const FrameType = enum(u8) {
    ping = 0x01,
    pong = 0x02,
    req_headers = 0x10,
    req_body_chunk = 0x11,
    dispatch_directive = 0x12,
    upstream_chunk = 0x13,
    stream_end = 0x14,
    settle_report = 0x15,
    settle_ack = 0x16,
    settle_confirm = 0x17,
    exit_health = 0x20,
    sync_state = 0x30,
    sync_ack = 0x31,
    _,
};

pub const FLAG_END_STREAM: u8 = 1 << 0;
pub const FLAG_PASSTHROUGH: u8 = 1 << 1;
pub const FLAG_ERROR: u8 = 1 << 2;
pub const FLAG_AUTH: u8 = 1 << 3;

pub const MAX_CONCURRENT_CONNS: u32 = 256;
pub const MAX_RETAINED_ARENA_BYTES: usize = 256 * 1024;

pub const Header = struct {
    stream_id: u32,
    frame_type: FrameType,
    flags: u8,
    payload_len: u32,

    pub fn encode(self: Header) error{PayloadTooLarge}![HEADER_LEN]u8 {
        if (self.payload_len > MAX_PAYLOAD_LEN) {
            return error.PayloadTooLarge;
        }
        var buf: [HEADER_LEN]u8 = undefined;
        std.mem.writeInt(u32, buf[0..4], self.stream_id, .big);
        buf[4] = @intFromEnum(self.frame_type);
        buf[5] = self.flags;
        std.mem.writeInt(u32, buf[6..10], self.payload_len, .big);
        return buf;
    }

    pub fn decode(buf: []const u8) error{ ShortHeader, PayloadTooLarge }!Header {
        if (buf.len < HEADER_LEN) {
            return error.ShortHeader;
        }
        const payload_len = std.mem.readInt(u32, buf[6..10], .big);
        if (payload_len > MAX_PAYLOAD_LEN) {
            return error.PayloadTooLarge;
        }
        return .{
            .stream_id = std.mem.readInt(u32, buf[0..4], .big),
            .frame_type = @enumFromInt(buf[4]),
            .flags = buf[5],
            .payload_len = payload_len,
        };
    }
};

pub const FrameReply = struct {
    frame_type: FrameType,
    flags: u8,
    payload: []const u8,
};

pub const Endpoint = struct {
    host: []const u8,
    port: u16,
};

pub fn parseEndpoint(raw: []const u8, default_port: u16) !Endpoint {
    const trimmed = if (std.mem.startsWith(u8, raw, "tcp://")) raw["tcp://".len..] else raw;
    const colon = std.mem.lastIndexOfScalar(u8, trimmed, ':') orelse return .{
        .host = "127.0.0.1",
        .port = default_port,
    };
    const host = if (colon == 0) "127.0.0.1" else trimmed[0..colon];
    const port = try std.fmt.parseInt(u16, trimmed[colon + 1 ..], 10);
    return .{ .host = host, .port = port };
}

pub fn writeFrame(writer: anytype, stream_id: u32, reply: FrameReply) !void {
    const resp_hdr = try (Header{
        .stream_id = stream_id,
        .frame_type = reply.frame_type,
        .flags = reply.flags,
        .payload_len = @intCast(reply.payload.len),
    }).encode();
    try writer.writeAll(&resp_hdr);
    if (reply.payload.len > 0) {
        try writer.writeAll(reply.payload);
    }
}

pub fn unwrapAuthenticatedPayload(
    flags: u8,
    raw_payload: []const u8,
    required_token: []const u8,
) error{UnauthorizedIpc}![]const u8 {
    if ((flags & FLAG_AUTH) == 0) {
        if (required_token.len > 0) return error.UnauthorizedIpc;
        return raw_payload;
    }
    if (raw_payload.len < 2) return error.UnauthorizedIpc;
    const tok_len: usize = std.mem.readInt(u16, raw_payload[0..2], .big);
    if (raw_payload.len < 2 + tok_len) return error.UnauthorizedIpc;
    const provided = raw_payload[2 .. 2 + tok_len];
    const inner = raw_payload[2 + tok_len ..];
    if (required_token.len == 0) return inner;
    if (provided.len != required_token.len) return error.UnauthorizedIpc;
    var diff: u8 = 0;
    for (provided, required_token) |a, b| {
        diff |= a ^ b;
    }
    if (diff != 0) return error.UnauthorizedIpc;
    return inner;
}

/// Static directive server used by slipgate-guestd and baseline frame tests.
pub fn serveConnection(
    allocator: std.mem.Allocator,
    conn: std.net.Server.Connection,
    directive_json: []const u8,
) void {
    serveConnectionBounded(allocator, conn, directive_json, null);
}

pub fn serveConnectionBounded(
    allocator: std.mem.Allocator,
    conn: std.net.Server.Connection,
    directive_json: []const u8,
    active_conns: ?*std.atomic.Value(u32),
) void {
    defer if (active_conns) |ac| {
        _ = ac.fetchSub(1, .release);
    };
    defer conn.stream.close();

    const reader = conn.stream.reader();
    const writer = conn.stream.writer();

    var frame_arena = std.heap.ArenaAllocator.init(allocator);
    defer frame_arena.deinit();
    var last_payload_len: usize = 0;

    while (true) {
        if (last_payload_len > MAX_RETAINED_ARENA_BYTES) {
            _ = frame_arena.reset(.free_all);
        } else {
            _ = frame_arena.reset(.retain_capacity);
        }
        const arena = frame_arena.allocator();

        var hdr_buf: [HEADER_LEN]u8 = undefined;
        const read_n = reader.readAll(&hdr_buf) catch return;
        if (read_n == 0 or read_n < HEADER_LEN) return;

        const hdr = Header.decode(&hdr_buf) catch return;
        last_payload_len = hdr.payload_len;
        const payload = arena.alloc(u8, hdr.payload_len) catch return;

        if (hdr.payload_len > 0) {
            const payload_n = reader.readAll(payload) catch return;
            if (payload_n != hdr.payload_len) return;
        }

        const inner = unwrapAuthenticatedPayload(hdr.flags, payload, "") catch {
            writeFrame(writer, hdr.stream_id, .{
                .frame_type = .stream_end,
                .flags = FLAG_END_STREAM | FLAG_ERROR,
                .payload = "{\"error\":\"unauthorized_ipc\"}",
            }) catch {};
            return;
        };

        switch (hdr.frame_type) {
            .ping => {
                writeFrame(writer, hdr.stream_id, .{
                    .frame_type = .pong,
                    .flags = FLAG_END_STREAM,
                    .payload = inner,
                }) catch return;
            },
            .req_headers => {
                writeFrame(writer, hdr.stream_id, .{
                    .frame_type = .dispatch_directive,
                    .flags = FLAG_END_STREAM | FLAG_PASSTHROUGH,
                    .payload = directive_json,
                }) catch return;
            },
            else => {
                writeFrame(writer, hdr.stream_id, .{
                    .frame_type = .stream_end,
                    .flags = FLAG_END_STREAM | FLAG_ERROR,
                    .payload = "{\"error\":\"unsupported_frame\"}",
                }) catch return;
            },
        }
    }
}

test "frame header big-endian roundtrip" {
    const original = Header{
        .stream_id = 0x01020304,
        .frame_type = .req_headers,
        .flags = FLAG_END_STREAM | FLAG_PASSTHROUGH,
        .payload_len = 512,
    };
    const encoded = try original.encode();
    try std.testing.expectEqual(@as(u8, 0x10), encoded[4]);
    const decoded = try Header.decode(&encoded);
    try std.testing.expectEqual(original.stream_id, decoded.stream_id);
    try std.testing.expectEqual(original.frame_type, decoded.frame_type);
    try std.testing.expectEqual(original.flags, decoded.flags);
    try std.testing.expectEqual(original.payload_len, decoded.payload_len);
}

test "frame header rejects oversized payload" {
    const bad = Header{
        .stream_id = 1,
        .frame_type = .req_body_chunk,
        .flags = 0,
        .payload_len = MAX_PAYLOAD_LEN + 1,
    };
    try std.testing.expectError(error.PayloadTooLarge, bad.encode());
}
