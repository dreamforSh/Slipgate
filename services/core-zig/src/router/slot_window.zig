const std = @import("std");

pub const SlotQuotaWindow = struct {
    used_5h_bps: u16 = 0,
    used_7d_bps: u16 = 0,
    watermark_bps: u16 = 9500,
    active_subagents: u8 = 0,
    max_subagents: u8 = 20,

    pub fn isSchedulable(self: SlotQuotaWindow) bool {
        return self.used_5h_bps < self.watermark_bps and
            self.used_7d_bps < self.watermark_bps and
            self.active_subagents < self.max_subagents;
    }

    pub fn maxUsedBps(self: SlotQuotaWindow) u16 {
        return @max(self.used_5h_bps, self.used_7d_bps);
    }

    pub fn tryReserveSeat(self: *SlotQuotaWindow) error{ QuotaWatermarkReached, SubagentCapacityFull }!void {
        if (self.used_5h_bps >= self.watermark_bps or self.used_7d_bps >= self.watermark_bps) {
            return error.QuotaWatermarkReached;
        }
        if (self.active_subagents >= self.max_subagents) {
            return error.SubagentCapacityFull;
        }
        self.active_subagents += 1;
    }

    pub fn releaseSeat(self: *SlotQuotaWindow) void {
        if (self.active_subagents > 0) {
            self.active_subagents -= 1;
        }
    }
};

pub const ContinuationError = error{
    ToolResultReplayed, // Maps to HTTP 409
    ContinuationExpired, // Maps to HTTP 410
};

/// Enforces native handoff slot commitment: once a visible tool delta reaches the caller,
/// failover to another slot is locked for the remainder of the turn.
pub const NativeTurnTracker = struct {
    committed_to_slot: bool = false,
    visible_tool_deltas: u32 = 0,

    pub fn onVisibleToolDelta(self: *NativeTurnTracker) void {
        self.committed_to_slot = true;
        self.visible_tool_deltas += 1;
    }

    pub fn canFailover(self: NativeTurnTracker) bool {
        return !self.committed_to_slot;
    }

    pub fn validateContinuation(replayed_tool_result: bool, expired: bool) ContinuationError!void {
        if (replayed_tool_result) return error.ToolResultReplayed;
        if (expired) return error.ContinuationExpired;
    }
};

test "5h/7d watermark trips circuit before hard limit and enforces 20 subagent cap" {
    var win = SlotQuotaWindow{ .used_5h_bps = 9500 };
    try std.testing.expect(!win.isSchedulable());
    try std.testing.expectError(error.QuotaWatermarkReached, win.tryReserveSeat());

    win.used_5h_bps = 4200;
    var i: u8 = 0;
    while (i < 20) : (i += 1) {
        try win.tryReserveSeat();
    }
    try std.testing.expectError(error.SubagentCapacityFull, win.tryReserveSeat());
    win.releaseSeat();
    try std.testing.expectEqual(@as(u8, 19), win.active_subagents);
}

test "native handoff locks failover after first visible tool delta and preserves 409/410" {
    var turn = NativeTurnTracker{};
    try std.testing.expect(turn.canFailover());
    turn.onVisibleToolDelta();
    try std.testing.expect(!turn.canFailover());

    try std.testing.expectError(error.ToolResultReplayed, NativeTurnTracker.validateContinuation(true, false));
    try std.testing.expectError(error.ContinuationExpired, NativeTurnTracker.validateContinuation(false, true));
}
