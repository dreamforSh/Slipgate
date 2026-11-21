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
    exit_health = 0x20,
    _,
};

pub const FLAG_END_STREAM: u8 = 1 << 0;
pub const FLAG_PASSTHROUGH: u8 = 1 << 1;
pub const FLAG_ERROR: u8 = 1 << 2;

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
