import { z } from "zod";
import { NanoUsdStringSchema, UsdAmountSchema } from "./commerce.ts";

/**
 * Affiliate commission pool accounts, custom per-user rebate rates, wallet transfers,
 * and external payout withdrawal requests (Lane C3).
 */

export const AffiliateWithdrawalKindSchema = z.enum(["wallet_transfer", "payout"]);
export type AffiliateWithdrawalKind = z.infer<typeof AffiliateWithdrawalKindSchema>;

export const AffiliateWithdrawalStatusSchema = z.enum(["pending", "approved", "paid", "rejected"]);
export type AffiliateWithdrawalStatus = z.infer<typeof AffiliateWithdrawalStatusSchema>;

export const AffiliateAccountItemSchema = z.object({
  userId: z.string(),
  email: z.string(),
  username: z.string(),
  customRebateBps: z.number().int().min(0).max(5000).nullable(),
  effectiveRebateBps: z.number().int().min(0).max(5000),
  balanceNanoUsd: NanoUsdStringSchema,
  totalEarnedNanoUsd: NanoUsdStringSchema,
  totalTransferredNanoUsd: NanoUsdStringSchema,
  totalWithdrawnNanoUsd: NanoUsdStringSchema,
  inviteeCount: z.number().int().nonnegative(),
  updatedAtIso: z.string(),
});
export type AffiliateAccountItem = z.infer<typeof AffiliateAccountItemSchema>;

export const AffiliateWithdrawalItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userEmail: z.string(),
  kind: AffiliateWithdrawalKindSchema,
  amountNanoUsd: NanoUsdStringSchema,
  status: AffiliateWithdrawalStatusSchema,
  payoutMethod: z.string(),
  payoutAccount: z.string(),
  notes: z.string(),
  reviewNote: z.string(),
  reviewedBy: z.string().nullable(),
  reviewedAtIso: z.string().nullable(),
  createdAtIso: z.string(),
});
export type AffiliateWithdrawalItem = z.infer<typeof AffiliateWithdrawalItemSchema>;

export const SetAffiliateRateRequestSchema = z.object({
  customRebateBps: z.number().int().min(0).max(5000).nullable(),
});
export type SetAffiliateRateRequest = z.infer<typeof SetAffiliateRateRequestSchema>;

export const AffiliateTransferRequestSchema = z.object({
  amountUsd: UsdAmountSchema,
});
export type AffiliateTransferRequest = z.infer<typeof AffiliateTransferRequestSchema>;

export const AffiliateWithdrawRequestSchema = z.object({
  amountUsd: UsdAmountSchema,
  payoutMethod: z.string().trim().min(1).max(32),
  payoutAccount: z.string().trim().min(1).max(200),
  notes: z.string().trim().max(300).default(""),
});
export type AffiliateWithdrawRequest = z.infer<typeof AffiliateWithdrawRequestSchema>;

export const ReviewAffiliateWithdrawalRequestSchema = z.object({
  action: z.enum(["approve", "mark_paid", "reject"]),
  reviewNote: z.string().trim().max(300).default(""),
});
export type ReviewAffiliateWithdrawalRequest = z.infer<typeof ReviewAffiliateWithdrawalRequestSchema>;
