/**
 * Stripe Fee Calculation Utility
 *
 * Calculates the total amount to charge the buyer so that after
 * Stripe deducts its fees, the organizer receives the exact net amount.
 *
 * Formula: Total = ceil((Net + FixedFee × 1.07) / (1 - Rate × 1.07))
 */

// Fee rates for Stripe Thailand account
const FEE_CONFIG = {
  promptpay: { rate: 0.0165, fixedFee: 0, vat: 0.07 },
  thai_card: { rate: 0.0365, fixedFee: 10, vat: 0.07 },
  international_card: { rate: 0.0675, fixedFee: 0.30, vat: 0.07 },
} as const;

export type FeeMethod = keyof typeof FEE_CONFIG;

export interface FeeBreakdown {
  net: number;
  fee: number;
  total: number;
  method: FeeMethod;
}

/**
 * Calculate the total amount including Stripe fees.
 * @param netAmount - The amount the organizer should receive (from DB ticket price)
 * @param method - Payment method determining which fee rate to use
 * @returns FeeBreakdown with net, fee, and total amounts
 */
export function calculateStripeFee(
  netAmount: number,
  method: FeeMethod
): FeeBreakdown {
  const config = FEE_CONFIG[method];
  const vatMultiplier = 1 + config.vat;

  const denominator = 1 - config.rate * vatMultiplier;
  const numerator = netAmount + config.fixedFee * vatMultiplier;

  // ceil in smallest currency unit (satang/cent = 2 decimal places)
  const total = Math.ceil((numerator / denominator) * 100) / 100;
  const fee = Math.round((total - netAmount) * 100) / 100;

  return { net: netAmount, fee, total, method };
}

/**
 * Determine the fee method based on user role and payment method selection.
 * @param paymentMethod - 'qr' or 'card' from checkout wizard
 * @param currency - 'THB' or 'USD'
 * @returns The FeeMethod to use for calculation
 */
export function resolveFeeMethod(
  paymentMethod: "qr" | "card",
  currency: "THB" | "USD"
): FeeMethod {
  if (currency === "USD") return "international_card";
  if (paymentMethod === "qr") return "promptpay";
  return "thai_card";
}
