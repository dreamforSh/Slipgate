const std = @import("std");

pub const SlotQuotaWindow = struct {
    used_5h_bps: u16 = 0,
    used_7d_bps: u16 = 0,
    reset_5h_unix_ms: i64 = 0,
    reset_7d_unix_ms: i64 = 0,
    watermark_bps: u16 = 9500,
    active_subagents: u8 = 0,
    max_subagents: u8 = 20,

    pub fn effectiveUsed5hBps(self: SlotQuotaWindow, now_ms: i64) u16 {
        if (now_ms > 0 and self.reset_5h_unix_ms > 0 and now_ms >= self.reset_5h_unix_ms) {
            return 0;
        }
        return self.used_5h_bps;
    }

    pub fn effectiveUsed7dBps(self: SlotQuotaWindow, now_ms: i64) u16 {
        if (now_ms > 0 and self.reset_7d_unix_ms > 0 and now_ms >= self.reset_7d_unix_ms) {
            return 0;
        }
        return self.used_7d_bps;
    }

    pub fn isSchedulableAt(self: SlotQuotaWindow, now_ms: i64) bool {
        return self.effectiveUsed5hBps(now_ms) < self.watermark_bps and
            self.effectiveUsed7dBps(now_ms) < self.watermark_bps and
            self.active_subagents < self.max_subagents;
    }

    pub fn isSchedulable(self: SlotQuotaWindow) bool {
        return self.isSchedulableAt(0);
    }

    pub fn maxUsedBpsAt(self: SlotQuotaWindow, now_ms: i64) u16 {
        return @max(self.effectiveUsed5hBps(now_ms), self.effectiveUsed7dBps(now_ms));
    }

    pub fn maxUsedBps(self: SlotQuotaWindow) u16 {
        return self.maxUsedBpsAt(0);
    }

    pub fn tryReserveSeatAt(self: *SlotQuotaWindow, now_ms: i64) error{ QuotaWatermarkReached, SubagentCapacityFull }!void {
        if (self.effectiveUsed5hBps(now_ms) >= self.watermark_bps or self.effectiveUsed7dBps(now_ms) >= self.watermark_bps) {
            return error.QuotaWatermarkReached;
        }
        if (self.active_subagents >= self.max_subagents) {
            return error.SubagentCapacityFull;
        }
        self.active_subagents += 1;
    }

    pub fn tryReserveSeat(self: *SlotQuotaWindow) error{ QuotaWatermarkReached, SubagentCapacityFull }!void {
        return self.tryReserveSeatAt(0);
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

test "elapsed 5h/7d reset timestamps unlock saturated quota windows" {
    const win = SlotQuotaWindow{
        .used_5h_bps = 9800,
        .used_7d_bps = 9600,
        .reset_5h_unix_ms = 1_700_000_000_000,
        .reset_7d_unix_ms = 1_700_100_000_000,
    };
    try std.testing.expect(!win.isSchedulableAt(1_699_999_999_999));
    try std.testing.expect(!win.isSchedulableAt(1_700_050_000_000));
    try std.testing.expect(win.isSchedulableAt(1_700_100_000_000));
    try std.testing.expectEqual(@as(u16, 0), win.maxUsedBpsAt(1_700_100_000_000));
}
