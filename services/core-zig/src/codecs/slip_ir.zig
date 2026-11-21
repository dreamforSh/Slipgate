const std = @import("std");

/// Unified streaming intermediate representation (SlipIR) used across OpenAI, Anthropic, Gemini, and Grok codecs.
pub const SlipEvent = union(enum) {
    stream_start: struct {
        request_id: []const u8,
        model: []const u8,
    },
    thinking_delta: struct {
        text: []const u8,
        signature: ?[]const u8 = null,
    },
    text_delta: []const u8,
    tool_call_start: struct {
        call_id: []const u8,
        name: []const u8,
    },
    tool_call_delta: struct {
        call_id: []const u8,
        arguments_chunk: []const u8,
    },
    usage_snapshot: struct {
        input_tokens: u64,
        output_tokens: u64,
        cache_read_tokens: u64 = 0,
        cache_write_tokens: u64 = 0,
    },
    stream_end: struct {
        stop_reason: []const u8,
    },
    upstream_error: struct {
        status_code: u16,
        message: []const u8,
    },
};

/// Per-request bump arena enabling O(1) teardown after each AI turn completes.
pub const TurnArena = struct {
    arena: std.heap.ArenaAllocator,

    pub fn init(backing: std.mem.Allocator) TurnArena {
        return .{ .arena = std.heap.ArenaAllocator.init(backing) };
    }

    pub fn deinit(self: *TurnArena) void {
        self.arena.deinit();
    }

    pub fn allocator(self: *TurnArena) std.mem.Allocator {
        return self.arena.allocator();
    }
};

test "turn arena allocates SlipIR events and frees in bulk" {
    var turn = TurnArena.init(std.testing.allocator);
    defer turn.deinit();

    const copy = try turn.allocator().dupe(u8, "hello slipgate");
    const ev = SlipEvent{ .text_delta = copy };
    try std.testing.expectEqualStrings("hello slipgate", ev.text_delta);
}
