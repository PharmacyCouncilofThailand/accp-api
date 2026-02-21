import puppeteer from "puppeteer";
import { PassThrough } from "stream";
import { existsSync } from "fs";

/**
 * Get the executable path for Chromium/Puppeteer.
 * In production (Alpine Linux), Chromium is at /usr/bin/chromium-browser.
 * In development, puppeteer will download and use its bundled Chromium.
 */
function getChromiumExecutablePath(): string | undefined {
  // Check for Alpine Linux Chromium location
  if (existsSync("/usr/bin/chromium-browser")) {
    return "/usr/bin/chromium-browser";
  }
  // Check for other common locations
  if (existsSync("/usr/bin/chromium")) {
    return "/usr/bin/chromium";
  }
  if (existsSync("/usr/bin/google-chrome")) {
    return "/usr/bin/google-chrome";
  }
  // Let puppeteer use its default (bundled Chromium)
  return undefined;
}

export interface ReceiptItem {
  name: string;
  type: "ticket" | "addon";
  price: number;
  quantity: number;
}

export interface ReceiptTaxInvoiceInfo {
  taxName: string | null;
  taxId: string | null;
  taxFullAddress: string | null;
}

export interface ReceiptData {
  orderNumber: string;
  paidAt: Date;
  paymentChannel: "promptpay" | "card";
  currency: string;
  items: ReceiptItem[];
  subtotal: number;
  discount?: number;
  promoCode?: string | null;
  fee: number;
  total: number;
  customerName: string;
  customerEmail: string;
  taxInvoice?: ReceiptTaxInvoiceInfo;
  eventName?: string;
}

function fmtMoney(amount: number, currency: string): string {
  const sym = currency === "THB" ? "THB\u00a0" : "USD\u00a0";
  return `${sym}${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDateTime(d: Date): string {
  const datePart = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const timePart = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  return `${datePart} at ${timePart}`;
}

function paymentChannelLabel(ch: "promptpay" | "card"): string {
  return ch === "promptpay" ? "PromptPay (QR)" : "Credit / Debit Card";
}


function buildReceiptHtml(data: ReceiptData): string {
  const itemRows = data.items
    .map(
      (item) => `
                <tr>
                    <td style="padding: 10px 0;">${escHtml(item.name)}</td>
                    <td style="text-align: center; padding: 10px 0;">${item.quantity}</td>
                    <td style="text-align: right; padding: 10px 0;">${escHtml(fmtMoney(item.price, data.currency))}</td>
                    <td style="text-align: right; padding: 10px 0;">${escHtml(fmtMoney(item.price * item.quantity, data.currency))}</td>
                </tr>`
    )
    .join("");

  const discountRow =
    data.discount && data.discount > 0
      ? `
            <tr>
                <td style="text-align: right; padding: 5px 0;">Discount${data.promoCode ? ` (${escHtml(data.promoCode)})` : ""}</td>
                <td style="text-align: right; padding: 5px 0;">-${escHtml(fmtMoney(data.discount, data.currency))}</td>
            </tr>`
      : "";

  const feeRow =
    data.fee > 0
      ? `
            <tr>
                <td style="text-align: right; padding: 5px 0;">Processing Fee</td>
                <td style="text-align: right; padding: 5px 0;">${escHtml(fmtMoney(data.fee, data.currency))}</td>
            </tr>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ACCP 2026 - Payment Receipt</title>
</head>
<body style="font-family: sans-serif; background-color: #ffffff; padding: 0; margin: 0;">

    <div style="max-width: 800px; margin: 0 auto; background-color: #ffffff; padding: 40px 48px; height: 100vh; display: flex; flex-direction: column; box-sizing: border-box;">

        <!-- Header Section -->
        <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="margin: 0; font-size: 30px;">ACCP 2026</h1>
            <h2 style="margin: 5px 0; font-size: 22px; font-weight: normal;">25th Asian Conference on Clinical Pharmacy</h2>
            <p style="margin: 0; font-size: 14px; color: #333;">July 9-11, 2026 | Centara Grand, Bangkok, Thailand</p>
        </div>

        <!-- Title -->
        <h3 style="text-align: center; margin-bottom: 30px; letter-spacing: 1px;">PAYMENT RECEIPT</h3>

        <!-- Information Grid -->
        <table style="width: 100%; margin-bottom: 30px; font-size: 14px;">
            <tr>
                <td style="width: 50%; vertical-align: top; padding-right: 20px;">
                    <p style="margin: 0 0 5px 0; font-weight: bold; color: #000;">RECEIPT NUMBER</p>
                    <p style="margin: 0 0 20px 0; color: #555;">${escHtml(data.orderNumber)}</p>

                    <p style="margin: 0 0 5px 0; font-weight: bold; color: #000;">CUSTOMER</p>
                    <p style="margin: 0; color: #555;">${escHtml(data.taxInvoice?.taxName || data.customerName)}</p>
                    <p style="margin: 0; color: #555;">${escHtml(data.customerEmail)}</p>
                    ${data.taxInvoice?.taxId ? `<p style="margin: 0; color: #555;">Tax ID: ${escHtml(data.taxInvoice.taxId)}</p>` : ""}
                    ${data.taxInvoice?.taxFullAddress ? `<p style="margin: 0; color: #555;">Address: ${escHtml(data.taxInvoice.taxFullAddress)}</p>` : ""}
                </td>
                <td style="width: 50%; vertical-align: top; padding-left: 20px;">
                    <p style="margin: 0 0 5px 0; font-weight: bold; color: #000;">DATE PAID</p>
                    <p style="margin: 0 0 20px 0; color: #555;">${escHtml(fmtDateTime(data.paidAt))}</p>

                    <p style="margin: 0 0 5px 0; font-weight: bold; color: #000;">PAYMENT METHOD</p>
                    <p style="margin: 0; color: #555;">${escHtml(paymentChannelLabel(data.paymentChannel))}</p>
                </td>
            </tr>
        </table>

        <!-- Item Table -->
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 14px;">
            <thead>
                <tr style="border-bottom: 2px solid #000;">
                    <th style="text-align: left; padding: 10px 0;">DESCRIPTION</th>
                    <th style="text-align: center; padding: 10px 0;">QTY</th>
                    <th style="text-align: right; padding: 10px 0;">UNIT PRICE</th>
                    <th style="text-align: right; padding: 10px 0;">AMOUNT</th>
                </tr>
            </thead>
            <tbody>
                ${itemRows}
                <tr style="border-bottom: 1px solid #ccc;">
                    <td style="padding: 0;" colspan="4"></td>
                </tr>
            </tbody>
        </table>

        <!-- Totals Table -->
        <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr>
                <td style="text-align: right; padding: 5px 0; width: 70%;">Subtotal</td>
                <td style="text-align: right; padding: 5px 0; width: 30%;">${escHtml(fmtMoney(data.subtotal, data.currency))}</td>
            </tr>
            ${discountRow}
            ${feeRow}
            <tr>
                <td style="text-align: right; padding: 10px 0; font-weight: bold; font-size: 16px;">Total Paid</td>
                <td style="text-align: right; padding: 10px 0; font-weight: bold; font-size: 16px; border-top: 1px solid #000; border-bottom: 3px double #000;">${escHtml(fmtMoney(data.total, data.currency))}</td>
            </tr>
        </table>

        <!-- Footer -->
        <div style="margin-top: auto; padding-top: 20px; border-top: 1px solid #eee; text-align: center; font-size: 12px; color: #666; line-height: 1.6;">
            <p style="margin: 0;">This receipt was generated by the ACCP 2026 Conference System.</p>
            <p style="margin: 0;">For questions, contact accpbangkok2026@gmail.com</p>
            <p style="margin: 0;">25th Asian Conference on Clinical Pharmacy | Bangkok, Thailand</p>
        </div>

    </div>

</body>
</html>`;
}

/**
 * Generate a PDF receipt via puppeteer (headless Chrome) and return it as a readable stream.
 * Does NOT write to disk — streams directly.
 */
export async function generateReceiptPdf(data: ReceiptData): Promise<PassThrough> {
  const html = buildReceiptHtml(data);

  const executablePath = getChromiumExecutablePath();
  const browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
    });

    const stream = new PassThrough();
    stream.end(Buffer.from(pdfBuffer));
    return stream;
  } finally {
    await browser.close();
  }
}
