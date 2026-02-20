import puppeteer from "puppeteer";
import { PassThrough } from "stream";
import { LOGO_SVG } from "../constants/logoSvg";

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

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildReceiptHtml(data: ReceiptData): string {
  const itemRows = data.items
    .map(
      (item) => `
      <tr>
        <td>${escHtml(item.name)}</td>
        <td class="right">${item.quantity}</td>
        <td class="right">${escHtml(fmtMoney(item.price, data.currency))}</td>
        <td class="right">${escHtml(fmtMoney(item.price * item.quantity, data.currency))}</td>
      </tr>`
    )
    .join("");

  const discountRow =
    data.discount && data.discount > 0
      ? `<tr>
          <td>${escHtml(data.promoCode ? `Discount (${data.promoCode})` : "Discount")}</td>
          <td>-${escHtml(fmtMoney(data.discount, data.currency))}</td>
        </tr>`
      : "";

  const feeRow =
    data.fee > 0
      ? `<tr>
          <td>Processing fee</td>
          <td>${escHtml(fmtMoney(data.fee, data.currency))}</td>
        </tr>`
      : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Receipt ${escHtml(data.orderNumber)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 14px;
      color: #333;
      background: #fff;
    }
    .page {
      max-width: 760px;
      margin: 0 auto;
      padding: 48px 48px 16px;
      position: relative;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 32px;
    }
    .header h1 { font-size: 28px; font-weight: 700; color: #000; }
    .logo {
      width: 80px; height: 80px;
      display: flex; align-items: center; justify-content: center;
    }
    .logo svg { width: 100%; height: 100%; }
    .meta {
      display: grid;
      grid-template-columns: 130px 1fr;
      gap: 2px 0;
      margin-bottom: 28px;
      font-size: 13.5px;
    }
    .meta .label { color: #555; }
    .meta .value { color: #000; font-weight: 600; }
    .billing-row {
      display: flex; gap: 60px;
      margin-bottom: 32px; font-size: 13.5px;
    }
    .billing-col h3 { font-size: 13.5px; font-weight: 700; margin-bottom: 4px; color: #000; }
    .billing-col p { color: #333; line-height: 1.6; }
    .billing-col .email { color: #333; }
    .amount-heading { font-size: 20px; font-weight: 700; margin-bottom: 24px; color: #000; }
    .items-table { width: 100%; border-collapse: collapse; margin-bottom: 0; font-size: 13.5px; }
    .items-table thead tr { border-top: 1px solid #e0e0e0; border-bottom: 1px solid #e0e0e0; }
    .items-table th {
      padding: 8px 0; text-align: left;
      font-weight: 400; color: #666; font-size: 12.5px;
    }
    .items-table th.right, .items-table td.right { text-align: right; }
    .items-table tbody tr { border-bottom: 1px solid #e0e0e0; }
    .items-table td { padding: 14px 0; vertical-align: top; color: #333; }
    .totals { width: 100%; border-collapse: collapse; font-size: 13.5px; margin-top: 0; }
    .totals tr td { padding: 6px 0; color: #333; }
    .totals tr td:first-child { text-align: left; color: #555; }
    .totals tr td:last-child { text-align: right; }
    .totals tr.total-row td { border-top: 1px solid #e0e0e0; padding-top: 8px; color: #333; }
    .totals tr.amount-paid td { font-weight: 700; color: #000; padding-top: 4px; }
    .totals-wrapper { display: flex; justify-content: flex-end; }
    .totals-inner { width: 340px; }
    .section-gap { margin: 36px 0 20px; }
    h2.section-title { font-size: 18px; font-weight: 700; color: #000; margin-bottom: 16px; }
    .payment-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    .payment-table thead tr { border-bottom: 1px solid #e0e0e0; }
    .payment-table th {
      padding: 8px 0; text-align: left;
      font-weight: 400; color: #666; font-size: 12.5px;
    }
    .payment-table td { padding: 14px 0; color: #333; border-bottom: 1px solid #e0e0e0; }
    .footer {
      margin-top: auto; border-top: 1px solid #e0e0e0; padding-top: 16px; padding-bottom: 50px;
      display: flex; justify-content: flex-end;
      font-size: 12px; color: #888;
      position: absolute;
      bottom: 0;
      left: 48px;
      right: 48px;
    }
  </style>
</head>
<body>
<div class="page">

  <div class="header">
    <h1>Receipt</h1>
    <div class="logo">
      ${LOGO_SVG}
    </div>
  </div>

  <div class="meta">
    <span class="label">Event</span><span class="value">${escHtml(data.eventName || "ACCP 2026")}</span>
    <span class="label">Receipt number</span><span class="value">${escHtml(data.orderNumber)}</span>
    <span class="label">Date paid</span><span class="value">${escHtml(fmtDate(data.paidAt))}</span>
  </div>

  <div class="billing-row">
    <div class="billing-col">
      <h3>The Pharmacy Council of Thailand</h3>
      <p>
        Tax ID: 0994000016379<br>
        8th Floor, Mahitaladhibesra Building,<br>
        Ministry of Public Health, 88/19 Moo 4,<br>
        Tiwanon Road, Talat Khwan,<br>
        Mueang Nonthaburi District,<br>
        Nonthaburi 11000, Thailand.
      </p>
    </div>
    <div class="billing-col">
      <h3>Bill to</h3>
      <p>
        Name: ${escHtml(data.taxInvoice?.taxName || data.customerName)}<br>
        ${data.taxInvoice?.taxId ? `Tax ID: ${escHtml(data.taxInvoice.taxId)}<br>` : ""}
        ${data.taxInvoice?.taxFullAddress ? `Address: ${escHtml(data.taxInvoice.taxFullAddress)}<br>` : ""}
        <span class="email">${escHtml(data.customerEmail)}</span>
      </p>
    </div>
  </div>

  <div class="amount-heading">${escHtml(fmtMoney(data.total, data.currency))} paid on ${escHtml(fmtDate(data.paidAt))}</div>

  <table class="items-table">
    <thead>
      <tr>
        <th style="width:55%">Description</th>
        <th class="right" style="width:10%">Qty</th>
        <th class="right" style="width:20%">Unit price</th>
        <th class="right" style="width:15%">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${itemRows}
    </tbody>
  </table>

  <div class="totals-wrapper" style="margin-top:8px;">
    <div class="totals-inner">
      <table class="totals">
        <tr>
          <td>Subtotal</td>
          <td>${escHtml(fmtMoney(data.subtotal, data.currency))}</td>
        </tr>
        ${discountRow}
        ${feeRow}
        <tr class="total-row">
          <td>Total</td>
          <td>${escHtml(fmtMoney(data.total, data.currency))}</td>
        </tr>
        <tr class="amount-paid">
          <td>Amount paid</td>
          <td>${escHtml(fmtMoney(data.total, data.currency))}</td>
        </tr>
      </table>
    </div>
  </div>

  <div class="footer">
    <span>Page 1 of 1</span>
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

  const browser = await puppeteer.launch({
    headless: true,
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
