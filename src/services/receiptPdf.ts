import puppeteer from "puppeteer";
import PDFDocument from "pdfkit";
import { PassThrough } from "stream";
import { existsSync } from "fs";
import path from "path";

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
  const datePart = d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "Asia/Bangkok" });
  const timePart = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Bangkok" });
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
 * [LEGACY / FALLBACK] Generate a PDF receipt via puppeteer (headless Chrome).
 * Kept as fallback for rollback/testing. Uses ~200-300MB RAM per request.
 * To use this version instead, import `generateReceiptPdfPuppeteer` in the route.
 */
export async function generateReceiptPdfPuppeteer(data: ReceiptData): Promise<PassThrough> {
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

/**
 * Generate a PDF receipt via PDFKit (pure JS, no browser required).
 * Uses ~5-10MB RAM per request (vs ~200-300MB for Puppeteer) and is ~20-50x faster.
 * Returns a readable stream — does NOT write to disk.
 */
export async function generateReceiptPdf(data: ReceiptData): Promise<PassThrough> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 0,
    info: {
      Title: `ACCP 2026 Receipt - ${data.orderNumber}`,
      Author: "ACCP 2026 Conference",
    },
  });

  const stream = new PassThrough();
  doc.pipe(stream);

  // ── Register Arial fonts (to match Puppeteer rendering) ───────────────
  const fontDir = path.join(process.cwd(), "public", "Font", "arial");
  doc.registerFont("Arial", path.join(fontDir, "ARIAL.TTF"));
  doc.registerFont("Arial-Bold", path.join(fontDir, "ARIALBD.TTF"));
  doc.registerFont("Arial-Italic", path.join(fontDir, "ARIALI.TTF"));
  doc.registerFont("Arial-BoldItalic", path.join(fontDir, "ARIALBI.TTF"));

  // ── Layout constants (mirrors the HTML template) ──────────────────────
  const PAGE_W = doc.page.width;         // A4: 595.28 pt
  const PAGE_H = doc.page.height;        // A4: 841.89 pt
  const MARGIN_X = 48;
  const MARGIN_TOP = 40;
  const CONTENT_W = PAGE_W - MARGIN_X * 2;

  // Colors (matching the original HTML)
  const C_BLACK = "#000000";
  const C_BODY = "#333333";
  const C_MUTED = "#555555";
  const C_FOOTER = "#666666";
  const C_BORDER_LIGHT = "#cccccc";
  const C_BORDER_FAINT = "#eeeeee";

  let y = MARGIN_TOP;

  // ── Header Section (centered) ─────────────────────────────────────────
  // Note: PDFKit uses pt (72 dpi), HTML uses px (96 dpi). 1pt = 1.333px, so
  // multiply HTML px values by 0.75 to get equivalent pt size.
  doc.font("Arial-Bold").fontSize(22).fillColor(C_BLACK); // HTML 30px ≈ 22pt
  doc.text("ACCP 2026", MARGIN_X, y, { width: CONTENT_W, align: "center" });
  y = doc.y + 4;

  doc.font("Arial").fontSize(16).fillColor(C_BLACK); // HTML 22px ≈ 16pt
  doc.text("25th Asian Conference on Clinical Pharmacy", MARGIN_X, y, {
    width: CONTENT_W,
    align: "center",
  });
  y = doc.y + 4;

  doc.font("Arial").fontSize(10).fillColor(C_BODY); // HTML 14px ≈ 10pt
  doc.text("July 9-11, 2026 | Centara Grand, Bangkok, Thailand", MARGIN_X, y, {
    width: CONTENT_W,
    align: "center",
  });
  y = doc.y + 22;

  // ── Title ─────────────────────────────────────────────────────────────
  doc.font("Arial-Bold").fontSize(13).fillColor(C_BLACK); // HTML h3 ≈ 13pt
  doc.text("PAYMENT RECEIPT", MARGIN_X, y, {
    width: CONTENT_W,
    align: "center",
    characterSpacing: 1,
  });
  y = doc.y + 22;

  // ── Information Grid (2 columns 50/50) ────────────────────────────────
  const colGap = 20;
  const colW = (CONTENT_W - colGap) / 2;
  const leftX = MARGIN_X;
  const rightX = MARGIN_X + colW + colGap;
  const gridStartY = y;

  const drawLabel = (text: string, x: number, yy: number) => {
    doc.font("Arial-Bold").fontSize(10).fillColor(C_BLACK);
    doc.text(text, x, yy, { width: colW });
    return doc.y;
  };
  const drawValue = (text: string, x: number, yy: number) => {
    doc.font("Arial").fontSize(10).fillColor(C_MUTED);
    doc.text(text, x, yy, { width: colW });
    return doc.y;
  };

  // Left column
  let leftY = gridStartY;
  leftY = drawLabel("RECEIPT NUMBER", leftX, leftY) + 3;
  leftY = drawValue(data.orderNumber, leftX, leftY) + 15;
  leftY = drawLabel("CUSTOMER", leftX, leftY) + 3;
  leftY = drawValue(data.taxInvoice?.taxName || data.customerName, leftX, leftY);
  leftY = drawValue(data.customerEmail, leftX, leftY);
  if (data.taxInvoice?.taxId) {
    leftY = drawValue(`Tax ID: ${data.taxInvoice.taxId}`, leftX, leftY);
  }
  if (data.taxInvoice?.taxFullAddress) {
    leftY = drawValue(`Address: ${data.taxInvoice.taxFullAddress}`, leftX, leftY);
  }

  // Right column
  let rightY = gridStartY;
  rightY = drawLabel("DATE PAID", rightX, rightY) + 3;
  rightY = drawValue(fmtDateTime(data.paidAt), rightX, rightY) + 15;
  rightY = drawLabel("PAYMENT METHOD", rightX, rightY) + 3;
  rightY = drawValue(paymentChannelLabel(data.paymentChannel), rightX, rightY);

  y = Math.max(leftY, rightY) + 30;

  // ── Items Table ───────────────────────────────────────────────────────
  const tbl = {
    desc: { x: MARGIN_X, w: CONTENT_W * 0.45 },
    qty: { x: MARGIN_X + CONTENT_W * 0.45, w: CONTENT_W * 0.15 },
    unit: { x: MARGIN_X + CONTENT_W * 0.6, w: CONTENT_W * 0.2 },
    amount: { x: MARGIN_X + CONTENT_W * 0.8, w: CONTENT_W * 0.2 },
  };

  // Table header (HTML th has padding: 10px 0 → 7.5pt top + 7.5pt bottom)
  doc.font("Arial-Bold").fontSize(10).fillColor(C_BLACK);
  doc.text("DESCRIPTION", tbl.desc.x, y, { width: tbl.desc.w });
  doc.text("QTY", tbl.qty.x, y, { width: tbl.qty.w, align: "center" });
  doc.text("UNIT PRICE", tbl.unit.x, y, { width: tbl.unit.w, align: "right" });
  doc.text("AMOUNT", tbl.amount.x, y, { width: tbl.amount.w, align: "right" });
  y = doc.y + 7; // HTML th padding-bottom 10px = 7.5pt

  // Header bottom border (2px solid black)
  doc.strokeColor(C_BLACK).lineWidth(1.5);
  doc.moveTo(MARGIN_X, y).lineTo(MARGIN_X + CONTENT_W, y).stroke();
  y += 10; // HTML td padding-top 10px = 7.5pt + border gap

  // Item rows (HTML td padding: 10px 0 → 7.5pt top + 7.5pt bottom between rows)
  doc.font("Arial").fontSize(10).fillColor(C_BLACK);
  for (const item of data.items) {
    const rowStartY = y;
    // Description may wrap, so render it first and capture end Y
    doc.text(item.name, tbl.desc.x, rowStartY, { width: tbl.desc.w - 5 });
    const descEndY = doc.y;
    // Other columns aligned to the same starting Y
    doc.text(String(item.quantity), tbl.qty.x, rowStartY, {
      width: tbl.qty.w,
      align: "center",
    });
    doc.text(fmtMoney(item.price, data.currency), tbl.unit.x, rowStartY, {
      width: tbl.unit.w,
      align: "right",
    });
    doc.text(
      fmtMoney(item.price * item.quantity, data.currency),
      tbl.amount.x,
      rowStartY,
      { width: tbl.amount.w, align: "right" },
    );
    y = descEndY + 12; // HTML padding-bottom 10px + next row padding-top 10px ≈ 15pt, but a bit tighter
  }

  // Items bottom border (1px solid #ccc)
  doc.strokeColor(C_BORDER_LIGHT).lineWidth(0.5);
  doc.moveTo(MARGIN_X, y).lineTo(MARGIN_X + CONTENT_W, y).stroke();
  y += 15;

  // ── Totals (right-aligned, HTML has 70% label / 30% value split) ──────
  const totalsLabelX = MARGIN_X;
  const totalsLabelW = CONTENT_W * 0.7;
  const totalsValueX = MARGIN_X + CONTENT_W * 0.7;
  const totalsValueW = CONTENT_W * 0.3;

  const printTotalRow = (label: string, value: string, isTotal = false) => {
    const fontName = isTotal ? "Arial-Bold" : "Arial";
    const size = isTotal ? 12 : 10; // HTML 16px ≈ 12pt
    doc.font(fontName).fontSize(size).fillColor(C_BLACK);
    const rowY = y;
    doc.text(label, totalsLabelX, rowY, { width: totalsLabelW, align: "right" });
    doc.text(value, totalsValueX, rowY, { width: totalsValueW, align: "right" });
    y = doc.y + (isTotal ? 7 : 4); // HTML padding: 10px (7.5pt) vs 5px (3.75pt)
  };

  printTotalRow("Subtotal", fmtMoney(data.subtotal, data.currency));

  if (data.discount && data.discount > 0) {
    const lbl = `Discount${data.promoCode ? ` (${data.promoCode})` : ""}`;
    printTotalRow(lbl, `-${fmtMoney(data.discount, data.currency)}`);
  }
  if (data.fee > 0) {
    printTotalRow("Processing Fee", fmtMoney(data.fee, data.currency));
  }

  // HTML: td padding-top 10px before Total Paid + border-top
  y += 4;
  // Top border above Total Paid — HTML puts border only on AMOUNT cell (last 30%)
  doc.strokeColor(C_BLACK).lineWidth(1);
  doc.moveTo(totalsValueX, y).lineTo(MARGIN_X + CONTENT_W, y).stroke();
  y += 8; // HTML padding-top: 10px = 7.5pt between border and text
  printTotalRow("Total Paid", fmtMoney(data.total, data.currency), true);
  // Double bottom border under Total Paid (3px double on amount cell only)
  doc.strokeColor(C_BLACK).lineWidth(0.75);
  doc.moveTo(totalsValueX, y).lineTo(MARGIN_X + CONTENT_W, y).stroke();
  doc.moveTo(totalsValueX, y + 1.5).lineTo(MARGIN_X + CONTENT_W, y + 1.5).stroke();

  // ── Footer (pinned near bottom of page) ───────────────────────────────
  const footerY = PAGE_H - 70;
  doc.strokeColor(C_BORDER_FAINT).lineWidth(0.5);
  doc.moveTo(MARGIN_X, footerY).lineTo(MARGIN_X + CONTENT_W, footerY).stroke();

  doc.font("Arial").fontSize(9).fillColor(C_FOOTER);
  doc.text(
    "This receipt was generated by the ACCP 2026 Conference System.",
    MARGIN_X,
    footerY + 12,
    { width: CONTENT_W, align: "center" },
  );
  doc.text("For questions, contact accpbangkok2026@gmail.com", MARGIN_X, doc.y + 2, {
    width: CONTENT_W,
    align: "center",
  });
  doc.text(
    "25th Asian Conference on Clinical Pharmacy | Bangkok, Thailand",
    MARGIN_X,
    doc.y + 2,
    { width: CONTENT_W, align: "center" },
  );

  doc.end();
  return stream;
}
