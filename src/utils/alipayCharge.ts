export const INTERNATIONAL_ROLES = ["interstd", "interpro"] as const;

/** Official ACCP international USD→THB rate for Alipay (1 USD = 34 THB). */
export const ALIPAY_USD_TO_THB_RATE = 34;

export type InternationalRole = (typeof INTERNATIONAL_ROLES)[number];

export function isInternationalRole(role: string): role is InternationalRole {
  return (INTERNATIONAL_ROLES as readonly string[]).includes(role);
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Convert USD ticket price to THB charge base per official rate table. */
export function convertUsdToThb(usdAmount: number): number {
  if (usdAmount <= 0) return 0;
  return round2(usdAmount * ALIPAY_USD_TO_THB_RATE);
}

export function convertUsdDiscountToThb(usdDiscount: number): number {
  return convertUsdToThb(usdDiscount);
}
