import axios from "axios";

export type PaySolutionsChannel = "promptpay" | "full";

export interface CreateFormSubmitParams {
  amount: number;
  orderDetail: string;
  refNo: string;
  userEmail: string;
  channel: PaySolutionsChannel;
  currency: "THB" | "USD";
  lang?: "TH" | "EN";
}

export interface CreateFormSubmitResult {
  actionUrl: string;
  method: "POST";
  fields: Record<string, string>;
}

interface InquiryRow {
  ReferenceNo?: string;
  OrderNo?: string;
  MerchantID?: string;
  Status?: string;
  StatusName?: string;
  CardType?: string;
  CurrencyCode?: string;
  Total?: number | string;
  [key: string]: unknown;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getPaySolutionsBaseUrl(): string {
  return process.env.PAY_SOLUTIONS_BASE_URL || "https://apis.paysolutions.asia";
}

function getPaySolutionsFormActionUrl(): string {
  return (
    process.env.PAY_SOLUTIONS_PAYMENT_FORM_ACTION_URL ||
    "https://payments.paysolutions.asia/payment"
  );
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function getMerchantIdLast5(merchantId: string): string {
  const digitsOnly = merchantId.replace(/\D/g, "");
  if (digitsOnly.length >= 5) {
    return digitsOnly.slice(-5);
  }
  return merchantId.slice(-5);
}

function sanitizeOrderDetail(value: string): string {
  return value
    .replace(/[<>"'&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);
}

function toCurrencyCode(currency: "THB" | "USD"): "00" | "01" {
  return currency === "USD" ? "01" : "00";
}

function normalizePaySolutionsLang(lang?: "TH" | "EN"): "TH" | "EN" {
  return lang === "TH" ? "TH" : "EN";
}

export function createFormSubmitPayload(
  params: CreateFormSubmitParams
): CreateFormSubmitResult {
  const merchantId = getRequiredEnv("PAY_SOLUTIONS_MERCHANT_ID");

  const fields: Record<string, string> = {
    merchantid: merchantId,
    refno: params.refNo,
    customeremail: params.userEmail.trim(),
    productdetail: sanitizeOrderDetail(params.orderDetail),
    total: round2(params.amount).toFixed(2),
    cc: toCurrencyCode(params.currency),
    lang: normalizePaySolutionsLang(params.lang),
    channel: params.channel,
  };

  return {
    actionUrl: getPaySolutionsFormActionUrl(),
    method: "POST",
    fields,
  };
}

export async function inquiryPayment(refno: string): Promise<InquiryRow | null> {
  const merchantId = getRequiredEnv("PAY_SOLUTIONS_MERCHANT_ID");
  const merchantSecretKey = getRequiredEnv("PAY_SOLUTIONS_SECRET_KEY");
  const apikey = getRequiredEnv("PAY_SOLUTIONS_API_KEY");

  const merchantIdLast5 = getMerchantIdLast5(merchantId);
  const endpoint = `${getPaySolutionsBaseUrl()}/order/orderdetailpost`;

  const response = await axios.post<InquiryRow[]>(
    endpoint,
    {
      merchantID: merchantIdLast5,
      orderNo: "X",
      refno,
      productDetail: "QWERTY",
    },
    {
      headers: {
        "Content-Type": "application/json",
        apikey,
        merchantID: merchantIdLast5,
        merchantSecretKey,
      },
      timeout: 20000,
    }
  );

  const data = response.data;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0];
}

export function normalizePaySolutionsPayload(payload: Record<string, unknown>) {
  return {
    referenceNo: String(payload.ReferenceNo || payload.referenceNo || payload.refNo || payload.refno || ""),
    orderNo: String(payload.OrderNo || payload.orderNo || ""),
    merchantId: String(payload.MerchantID || payload.merchantId || payload.merchantID || ""),
    status: String(payload.Status || payload.status || ""),
    statusName: String(payload.StatusName || payload.statusName || ""),
    cardType: String(payload.CardType || payload.cardType || ""),
    total: String(payload.Total || payload.total || ""),
    currencyCode: String(payload.CurrencyCode || payload.currencyCode || ""),
    raw: payload,
  };
}

export function verifyPaySolutionsPostback(
  normalizedPayload: ReturnType<typeof normalizePaySolutionsPayload>
): boolean {
  if (!normalizedPayload.referenceNo || !normalizedPayload.status) {
    return false;
  }

  const merchantId = process.env.PAY_SOLUTIONS_MERCHANT_ID?.trim();
  if (
    merchantId &&
    normalizedPayload.merchantId &&
    normalizedPayload.merchantId !== merchantId
  ) {
    return false;
  }

  return true;
}

export function isPaySolutionsPaidStatus(status?: string, statusName?: string): boolean {
  const statusNorm = (status || "").trim().toUpperCase();
  const nameNorm = (statusName || "").trim().toUpperCase();
  return (
    statusNorm === "CP" ||
    statusNorm === "Y" ||
    statusNorm === "TC" ||
    statusNorm === "COMPLETE" ||
    statusNorm === "COMPLETED" ||
    statusNorm === "PAID" ||
    nameNorm === "COMPLETE" ||
    nameNorm === "COMPLETED" ||
    nameNorm === "PAID" ||
    nameNorm === "TEST COMPLETE" ||
    nameNorm === "TEST COMPLETED"
  );
}

export function isPaySolutionsFailedStatus(status?: string, statusName?: string): boolean {
  const statusNorm = (status || "").trim().toUpperCase();
  const nameNorm = (statusName || "").trim().toUpperCase();
  return (
    statusNorm === "FL" ||
    statusNorm === "FAILED" ||
    statusNorm === "FAIL" ||
    statusNorm === "CA" ||
    statusNorm === "CANCEL" ||
    statusNorm === "CANCELLED" ||
    statusNorm === "RE" ||
    statusNorm === "VR" ||
    statusNorm === "PF" ||
    statusNorm === "C" ||
    statusNorm === "N" ||
    statusNorm === "NS" ||
    nameNorm === "FAILED" ||
    nameNorm === "FAIL" ||
    nameNorm === "CANCEL" ||
    nameNorm === "CANCELLED" ||
    nameNorm === "REJECTED" ||
    nameNorm === "VBV REJECTED" ||
    nameNorm === "PAYMENT FAILED" ||
    nameNorm === "NOT SUBMIT" ||
    nameNorm === "UNPAID"
  );
}

export function isPaySolutionsRefundStatus(status?: string, statusName?: string): boolean {
  const statusNorm = (status || "").trim().toUpperCase();
  const nameNorm = (statusName || "").trim().toUpperCase();
  return (
    statusNorm === "RF" ||
    statusNorm === "RR" ||
    statusNorm === "VO" ||
    nameNorm === "REFUND" ||
    nameNorm === "REQUEST REFUND" ||
    nameNorm === "VOIDED"
  );
}

export function isPaySolutionsPendingStatus(status?: string, statusName?: string): boolean {
  const statusNorm = (status || "").trim().toUpperCase();
  const nameNorm = (statusName || "").trim().toUpperCase();
  return (
    statusNorm === "VC" ||
    statusNorm === "HO" ||
    nameNorm === "VBV CHECKING" ||
    nameNorm === "HOLD"
  );
}

export function normalizePaySolutionsChannel(
  cardType?: string,
  fallbackChannel?: string | null
): string {
  const cardTypeNorm = (cardType || "").trim().toUpperCase();

  if (
    cardTypeNorm === "Q" ||
    cardTypeNorm === "PP" ||
    cardTypeNorm === "PROMPTPAY"
  ) {
    return "promptpay";
  }

  if (cardTypeNorm) {
    return "card";
  }

  if (fallbackChannel) {
    const normalizedFallback = fallbackChannel.trim().toLowerCase();
    if (["promptpay", "card", "full"].includes(normalizedFallback)) {
      if (normalizedFallback === "full") {
        return "card";
      }
      return normalizedFallback;
    }
  }

  return "card";
}
