const std = @import("std");

/// Fixed-point monetary unit: 1 USD = 1_000_000_000 nano-USD.
pub const NANO_PER_USD: i128 = 1_000_000_000;

pub const LedgerError = error{
    InvalidAmount,
    InsufficientQuota,
    InvalidHoldAmount,
    Overflow,
};

pub const Wallet = struct {
    balance_nano: i128 = 0,
    held_nano: i128 = 0,

    pub fn available(self: Wallet) i128 {
        return self.balance_nano - self.held_nano;
    }

    pub fn credit(self: *Wallet, amount_nano: i128) LedgerError!void {
        if (amount_nano <= 0) return error.InvalidAmount;
        self.balance_nano = std.math.add(i128, self.balance_nano, amount_nano) catch return error.Overflow;
    }

    pub fn hold(self: *Wallet, amount_nano: i128) LedgerError!void {
        if (amount_nano <= 0) return error.InvalidHoldAmount;
        if (self.available() < amount_nano) return error.InsufficientQuota;
        self.held_nano = std.math.add(i128, self.held_nano, amount_nano) catch return error.Overflow;
    }

    pub fn settle(self: *Wallet, held_amount_nano: i128, actual_cost_nano: i128) LedgerError!void {
        if (held_amount_nano <= 0 or actual_cost_nano < 0) return error.InvalidHoldAmount;
        if (self.held_nano < held_amount_nano) return error.InvalidHoldAmount;
        self.held_nano -= held_amount_nano;
        self.balance_nano = std.math.sub(i128, self.balance_nano, actual_cost_nano) catch return error.Overflow;
    }

    pub fn release(self: *Wallet, held_amount_nano: i128) LedgerError!void {
        if (held_amount_nano <= 0 or self.held_nano < held_amount_nano) return error.InvalidHoldAmount;
        self.held_nano -= held_amount_nano;
    }
};

test "two-phase hold and settle preserves nano-USD precision" {
    var w = Wallet{};
    try w.credit(10 * NANO_PER_USD);
    try w.hold(2 * NANO_PER_USD);
    try std.testing.expectEqual(8 * NANO_PER_USD, w.available());

    try w.settle(2 * NANO_PER_USD, 125_000_000); // $0.125
    try std.testing.expectEqual(@as(i128, 0), w.held_nano);
    try std.testing.expectEqual(@as(i128, 9_875_000_000), w.available());
}

test "hold fails when available quota is insufficient" {
    var w = Wallet{ .balance_nano = 500_000_000 };
    try std.testing.expectError(error.InsufficientQuota, w.hold(600_000_000));
}
