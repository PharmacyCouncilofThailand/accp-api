import crypto from "crypto";

export type KtbPayMethod = "CC" | "QR";
export type KtbPayType = "N";
export type KtbLang = "T" | "E";

export interface KtbConfig {
  merchantId: string;
  secureHashKey: string;
  currencyCode: string;
  paymentFormUrl: string;
}

export interface CreateKtbFormPayloadParams {
  orderRef: string;
  amount: number | string;
  successUrl: string;
  failUrl: string;
  cancelUrl: string;
  payType?: KtbPayType;
  lang?: KtbLang;
  payMethod?: KtbPayMethod;
  customerEmail?: string | null;
  remark?: string | null;
  orderRef1?: string | null;
  orderRef2?: string | null;
}

export interface KtbFormResult {
  actionUrl: string;
  method: "POST";
  fields: Record<string, string>;
}

export interface NormalizedKtbDataFeedPayload {
  orderRef: string;
  prc: string;
  src: string;
  ord: string;
  holder: string;
  successcode: string;
  payRef: string;
  payMethod: string;
  amt: string;
  cur: string;
  authId: string;
  eci: string;
  payerAuth: string;
  sourceIp: string;
  ipCountry: string;
  cardNo: string;
  payTime: string;
  securityKey: string;
  raw: Record<string, unknown>;
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for KTB FASTPAY`);
  }
  return value;
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return String(value).trim();
}

export function getOptionalKtbConfig(): KtbConfig | null {
  const merchantId = process.env.KTB_MERCHANT_ID?.trim();
  const secureHashKey = process.env.KTB_SECURE_HASH_KEY?.trim();
  const paymentFormUrl = process.env.KTB_PAYMENT_FORM_URL?.trim();
  const currencyCode = process.env.KTB_CURRENCY_CODE?.trim() || "764";

  if (!merchantId || !secureHashKey || !paymentFormUrl) {
    return null;
  }

  return {
    merchantId,
    secureHashKey,
    currencyCode,
    paymentFormUrl,
  };
}

export function getKtbConfig(): KtbConfig {
  return (
    getOptionalKtbConfig() || {
      merchantId: getRequiredEnv("KTB_MERCHANT_ID"),
      secureHashKey: getRequiredEnv("KTB_SECURE_HASH_KEY"),
      currencyCode: process.env.KTB_CURRENCY_CODE?.trim() || "764",
      paymentFormUrl: getRequiredEnv("KTB_PAYMENT_FORM_URL"),
    }
  );
}

export function isKtbFastpayConfigured(): boolean {
  return getOptionalKtbConfig() !== null;
}

export function canonicalizeKtbAmount(value: number | string): string {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    throw new Error("Invalid KTB FASTPAY amount");
  }
  return numericValue.toFixed(2);
}

export function normalizeKtbLang(value?: string | null): KtbLang {
  const normalized = stringifyValue(value).toLowerCase();
  return normalized.startsWith("th") || normalized === "t" ? "T" : "E";
}

export function mapRequestedPaymentMethodToKtb(value?: string | null): KtbPayMethod | undefined {
  const normalized = stringifyValue(value).toLowerCase();
  if (normalized === "qr") {
    return "QR";
  }
  if (normalized === "card") {
    return "CC";
  }
  return undefined;
}

export function generateKtbOrderRef(orderId: number): string {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = `KTB-${orderId}-${Date.now()
      .toString(36)
      .toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    if (candidate.length <= 35) {
      return candidate;
    }
  }

  throw new Error(`Unable to generate KTB FASTPAY orderRef for order ${orderId}`);
}

export function generateKtbOutgoingSecurityKey(params: {
  merchantId: string;
  orderRef: string;
  currCode: string;
  amount: string;
  payType: string;
  secureHashKey: string;
}): string {
  const concat = [
    params.merchantId,
    params.orderRef,
    params.currCode,
    params.amount,
    params.payType,
    params.secureHashKey,
  ].join("|");

  return crypto.createHash("sha512").update(concat).digest("hex");
}

export function createKtbFormPayload(params: CreateKtbFormPayloadParams): KtbFormResult {
  const config = getKtbConfig();
  const payType = params.payType || "N";
  const amount = canonicalizeKtbAmount(params.amount);

  const fields: Record<string, string> = {
    merchantId: config.merchantId,
    orderRef: params.orderRef,
    amount,
    currCode: config.currencyCode,
    successUrl: params.successUrl,
    failUrl: params.failUrl,
    cancelUrl: params.cancelUrl,
    payType,
    lang: params.lang || "E",
    securityKey: generateKtbOutgoingSecurityKey({
      merchantId: config.merchantId,
      orderRef: params.orderRef,
      currCode: config.currencyCode,
      amount,
      payType,
      secureHashKey: config.secureHashKey,
    }),
  };

  if (params.payMethod) {
    fields.payMethod = params.payMethod;
  }

  if (params.customerEmail) {
    fields.eMail = params.customerEmail.trim();
  }

  if (params.remark?.trim()) {
    fields.remark = params.remark.trim().slice(0, 200);
  }

  if (params.orderRef1?.trim()) {
    fields.orderRef1 = params.orderRef1.trim();
  }

  if (params.orderRef2?.trim()) {
    fields.orderRef2 = params.orderRef2.trim();
  }

  return {
    actionUrl: config.paymentFormUrl,
    method: "POST",
    fields,
  };
}

export function normalizeKtbDataFeedPayload(
  payload: Record<string, unknown>
): NormalizedKtbDataFeedPayload {
  return {
    orderRef: stringifyValue(payload.orderRef),
    prc: stringifyValue(payload.prc),
    src: stringifyValue(payload.src),
    ord: stringifyValue(payload.ord),
    holder: stringifyValue(payload.holder),
    successcode: stringifyValue(payload.successcode),
    payRef: stringifyValue(payload.payRef),
    payMethod: stringifyValue(payload.payMethod),
    amt: stringifyValue(payload.amt),
    cur: stringifyValue(payload.cur),
    authId: stringifyValue(payload.authId),
    eci: stringifyValue(payload.eci),
    payerAuth: stringifyValue(payload.payerAuth),
    sourceIp: stringifyValue(payload.sourceIp),
    ipCountry: stringifyValue(payload.ipCountry),
    cardNo: stringifyValue(payload.cardNo),
    payTime: stringifyValue(payload.payTime),
    securityKey: stringifyValue(payload.securityKey),
    raw: payload,
  };
}

export function verifyKtbDataFeedSecurityKey(
  payload: NormalizedKtbDataFeedPayload,
  secureHashKey: string
): boolean {
  if (
    !payload.securityKey ||
    !payload.orderRef ||
    !payload.cur ||
    !payload.amt ||
    !payload.successcode ||
    !payload.payRef ||
    !payload.sourceIp ||
    !payload.payTime ||
    !secureHashKey
  ) {
    return false;
  }

  const { merchantId } = getKtbConfig();
  // KTB may omit authId for failed or cancelled payments; the hash input must
  // still preserve the empty slot rather than treating it as missing data.
  const concat = [
    merchantId,
    payload.orderRef,
    payload.cur,
    payload.amt,
    payload.successcode,
    payload.payRef,
    payload.authId,
    payload.sourceIp,
    payload.payTime,
    secureHashKey,
  ].join("|");

  const calculatedHash = crypto.createHash("sha512").update(concat).digest("hex");
  return calculatedHash.toLowerCase() === payload.securityKey.toLowerCase();
}

export function isKtbPaymentSuccess(successcode: string): boolean {
  return successcode === "0";
}

export function isKtbPaymentFailed(successcode: string): boolean {
  return successcode === "1";
}

export function isKtbPaymentCancelled(successcode: string): boolean {
  return successcode === "2";
}

export function normalizeKtbPayMethod(payMethod: string): string {
  const normalized = stringifyValue(payMethod).toUpperCase();

  switch (normalized) {
    case "QR":
      return "qr";
    case "UPOP":
      return "upop";
    case "G-WALLET":
      return "wallet";
    case "VISA":
    case "MASTER":
    case "MASTERCARD":
    case "JCB":
    case "ITMX":
    default:
      return "card";
  }
}
