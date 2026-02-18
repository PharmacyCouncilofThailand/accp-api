import axios from "axios";

export type PaySolutionsChannel = "promptpay" | "full" | "amex";

export interface CreateSecureLinkParams {
  amount: number;
  orderDetail: string;
  refNo: string;
  userEmail: string;
  userTelNo?: string;
  returnURL: string;
  postBackURL: string;
  channel: PaySolutionsChannel;
  currency: "THB" | "USD";
  oneTime?: "Y" | "N";
}

export interface CreateSecureLinkResult {
  paymentUrl: string;
  encryptedToken: string;
  rawResponse: Record<string, unknown>;
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

function formatPaySolutionsDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}-${mi}-${ss}`;
}

function getPaySolutionsBaseUrl(): string {
  return process.env.PAY_SOLUTIONS_BASE_URL || "https://apis.paysolutions.asia";
}

function getPaySolutionsPayUrlBase(): string {
  return process.env.PAY_SOLUTIONS_PAY_URL_BASE || "https://pay.sn";
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

export async function createSecureLink(
  params: CreateSecureLinkParams
): Promise<CreateSecureLinkResult> {
  const apikey = getRequiredEnv("PAY_SOLUTIONS_API_KEY");
  const merchantLinkName = getRequiredEnv("PAY_SOLUTIONS_PAYMENT_LINK_NAME");

  const secureEndpoint = `${getPaySolutionsBaseUrl()}/secure/v3/secure/encryptz/${encodeURIComponent(merchantLinkName)}`;
  const expireDate = formatPaySolutionsDate(new Date(Date.now() + 1000 * 60 * 30)); // 30 min

  const payload = {
    merchant: merchantLinkName,
    payValue: String(round2(params.amount)),
    orderDetail: sanitizeOrderDetail(params.orderDetail),
    expireDate,
    userEMail: params.userEmail,
    userTelNo: params.userTelNo || "",
    postBackURL: params.postBackURL,
    returnURL: params.returnURL,
    monthInstallment: "",
    bankInstallment: "",
    oneTime: params.oneTime || "Y",
    refNo: params.refNo,
    cc: toCurrencyCode(params.currency),
    channel: params.channel,
  };

  const response = await axios.post<Record<string, unknown>>(secureEndpoint, payload, {
    headers: {
      "Content-Type": "application/json",
      apikey,
    },
    timeout: 20000,
  });

  const body = response.data || {};
  const payValue = String(body.payValue || "").trim();
  const encryptedToken = String(body.orderDetail || "").trim();

  if (!payValue || !encryptedToken) {
    throw new Error("Invalid Secure Link response from Pay Solutions");
  }

  const paymentUrl = `${getPaySolutionsPayUrlBase()}/${merchantLinkName}/${encodeURIComponent(payValue)}/${encodeURIComponent(encryptedToken)}`;

  return {
    paymentUrl,
    encryptedToken,
    rawResponse: body,
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

  if (cardTypeNorm === "A" || cardTypeNorm === "AMEX") {
    return "amex";
  }

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
    if (["promptpay", "amex", "card", "full"].includes(normalizedFallback)) {
      return normalizedFallback === "full" ? "card" : normalizedFallback;
    }
  }

  return "card";
}
