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

export interface ChargeDisplayInfo {
  /** Total paid expressed in the order (ticket) currency */
  totalPaid: number;
  /** Fee expressed in the order (ticket) currency */
  fee: number;
  /** Set when the actual charge currency differs from the order currency (Alipay USD orders charged in THB) */
  chargeCurrency: "THB" | null;
  chargeAmount: number | null;
}

/**
 * Alipay orders are priced in USD but charged in THB (1 USD = ALIPAY_USD_TO_THB_RATE).
 * payments.amount / orders.totalAmount store the THB charge, while order items,
 * subtotal, and discount stay in USD. For display we convert the THB charge back
 * to USD so all receipt lines share one currency, and expose the real THB charge
 * separately for a reference note.
 */
export function resolveChargeDisplay(
  orderCurrency: string,
  chargedAmount: string | number,
  netAmount: number,
  paymentDetails: unknown,
): ChargeDisplayInfo {
  const amount = Number(chargedAmount);
  const details =
    paymentDetails && typeof paymentDetails === "object" && !Array.isArray(paymentDetails)
      ? (paymentDetails as Record<string, unknown>)
      : {};
  const chargeCurrency =
    typeof details.chargeCurrency === "string" ? details.chargeCurrency : orderCurrency;

  if (orderCurrency === "USD" && chargeCurrency === "THB") {
    const totalPaid = round2(amount / ALIPAY_USD_TO_THB_RATE);
    const fee = round2(totalPaid - netAmount);
    return { totalPaid, fee: fee > 0 ? fee : 0, chargeCurrency: "THB", chargeAmount: amount };
  }

  const fee = round2(amount - netAmount);
  return { totalPaid: amount, fee: fee > 0 ? fee : 0, chargeCurrency: null, chargeAmount: null };
}

export function buildChargeNote(info: ChargeDisplayInfo): string | undefined {
  if (!info.chargeCurrency || info.chargeAmount === null) return undefined;
  return `Charged as THB ${info.chargeAmount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} via Alipay (1 USD = ${ALIPAY_USD_TO_THB_RATE} THB)`;
}
