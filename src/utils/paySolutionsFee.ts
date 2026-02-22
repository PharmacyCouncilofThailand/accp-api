/**
 * Pay Solutions fee utility
 *
 * Rounding model (from calculator sample):
 * 1) fee = round(gross * rate, 2)
 * 2) vat = round(fee * 0.07, 2)
 * 3) net = gross - fee - vat
 */

const FEE_CONFIG = {
  promptpay: { rate: 0.01, vat: 0.07 },
  card: { rate: 0.028, vat: 0.07 },
  usd_card: { rate: 0.03, vat: 0.07 },
} as const;

export type PaySolutionsFeeMethod = keyof typeof FEE_CONFIG;
export type PaySolutionsPaymentMethod = "qr" | "card";

export interface PaySolutionsFeeBreakdown {
  net: number;
  fee: number;
  total: number;
  method: PaySolutionsFeeMethod;
  processingFee: number;
  processingVat: number;
  rate: number;
  vatRate: number;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toSatang(value: number): number {
  return Math.round(round2(value) * 100);
}

function calculateNetFromGross(grossSatang: number, method: PaySolutionsFeeMethod) {
  const cfg = FEE_CONFIG[method];
  const gross = grossSatang / 100;
  const processingFee = round2(gross * cfg.rate);
  const processingVat = round2(processingFee * cfg.vat);
  const net = round2(gross - processingFee - processingVat);
  const totalFee = round2(processingFee + processingVat);

  return {
    gross,
    net,
    netSatang: toSatang(net),
    processingFee,
    processingVat,
    totalFee,
  };
}

function buildBreakdown(grossSatang: number, method: PaySolutionsFeeMethod): PaySolutionsFeeBreakdown {
  const cfg = FEE_CONFIG[method];
  const calc = calculateNetFromGross(grossSatang, method);
  return {
    net: calc.net,
    fee: calc.totalFee,
    total: calc.gross,
    method,
    processingFee: calc.processingFee,
    processingVat: calc.processingVat,
    rate: cfg.rate,
    vatRate: cfg.vat,
  };
}

export function calculatePaySolutionsFeeExact(
  netAmount: number,
  method: PaySolutionsFeeMethod
): PaySolutionsFeeBreakdown {
  const targetNetSatang = toSatang(netAmount);

  if (targetNetSatang <= 0) {
    return {
      net: 0,
      fee: 0,
      total: 0,
      method,
      processingFee: 0,
      processingVat: 0,
      rate: FEE_CONFIG[method].rate,
      vatRate: FEE_CONFIG[method].vat,
    };
  }

  const cfg = FEE_CONFIG[method];
  const approxGross = Math.ceil(
    (targetNetSatang / 100) / (1 - cfg.rate * (1 + cfg.vat)) * 100
  );

  // Search around approximation for exact satang match.
  const searchWindow = 10000; // +/- 100.00
  const minGross = Math.max(1, approxGross - searchWindow);
  const maxGross = approxGross + searchWindow;

  for (let grossSatang = minGross; grossSatang <= maxGross; grossSatang++) {
    const calc = calculateNetFromGross(grossSatang, method);
    if (calc.netSatang === targetNetSatang) {
      return buildBreakdown(grossSatang, method);
    }
  }

  // Fallback to the first gross that yields net >= target.
  for (let grossSatang = approxGross; grossSatang <= maxGross; grossSatang++) {
    const calc = calculateNetFromGross(grossSatang, method);
    if (calc.netSatang >= targetNetSatang) {
      return buildBreakdown(grossSatang, method);
    }
  }

  // Final fallback (should not happen in normal ranges).
  return buildBreakdown(maxGross, method);
}

export function resolvePaySolutionsFeeMethod(
  paymentMethod: PaySolutionsPaymentMethod,
  currency: "THB" | "USD"
): PaySolutionsFeeMethod {
  if (currency === "USD") return "usd_card";
  if (paymentMethod === "qr") return "promptpay";
  return "card";
}

export function resolvePaySolutionsChannel(
  paymentMethod: PaySolutionsPaymentMethod,
  currency: "THB" | "USD"
): "promptpay" | "full" {
  if (currency === "USD") return "full";

  if (paymentMethod === "qr") return "promptpay";
  return "full";
}
