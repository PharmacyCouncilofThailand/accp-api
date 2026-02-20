import PDFDocument from "pdfkit";
import { PassThrough } from "stream";

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
  paymentChannel: string;
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
}

/**
 * Generate a PDF receipt and return it as a readable stream.
 * Does NOT write to disk — streams directly.
 */
export function generateReceiptPdf(data: ReceiptData): PassThrough {
  const stream = new PassThrough();

  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    info: {
      Title: `Receipt - ${data.orderNumber}`,
      Author: "ACCP 2026",
      Subject: "Payment Receipt",
    },
  });

  doc.pipe(stream);

  const currencySymbol = data.currency === "THB" ? "THB " : "USD ";
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  // ─────────────────────────────────────────
  // Header
  // ─────────────────────────────────────────
  doc
    .fontSize(28)
    .font("Helvetica-Bold")
    .text("ACCP 2026", { align: "center" });

  doc
    .fontSize(14)
    .font("Helvetica")
    .fillColor("#666666")
    .text("25th Asian Conference on Clinical Pharmacy", { align: "center" });

  doc
    .fontSize(12)
    .font("Helvetica")
    .fillColor("#666666")
    .text("July 9-11, 2026 | Centara Grand, Bangkok, Thailand", { align: "center" });

  doc.moveDown(1.5);

  // ─────────────────────────────────────────
  // Receipt Title
  // ─────────────────────────────────────────
  doc
    .fontSize(18)
    .font("Helvetica-Bold")
    .fillColor("#000000")
    .text("PAYMENT RECEIPT", { align: "center" });

  doc.moveDown(0.5);

  // Divider
  const dividerY = doc.y;
  doc
    .strokeColor("#00C853")
    .lineWidth(2)
    .moveTo(doc.page.margins.left, dividerY)
    .lineTo(doc.page.width - doc.page.margins.right, dividerY)
    .stroke();

  doc.moveDown(1);

  // ─────────────────────────────────────────
  // Order Info (two columns)
  // ─────────────────────────────────────────
  const infoStartY = doc.y;
  const leftColX = doc.page.margins.left;
  const rightColX = doc.page.margins.left + pageWidth / 2;

  // Left column
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#888888")
    .text("RECEIPT NUMBER", leftColX, infoStartY);
  doc
    .fontSize(11)
    .font("Helvetica-Bold")
    .fillColor("#000000")
    .text(data.orderNumber, leftColX, doc.y + 2);

  doc.moveDown(1);
  const nameY = doc.y;
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#888888")
    .text("CUSTOMER", leftColX, nameY);
  doc
    .fontSize(11)
    .font("Helvetica")
    .fillColor("#000000")
    .text(data.customerName, leftColX, doc.y + 2);
  doc
    .fontSize(9)
    .fillColor("#666666")
    .text(data.customerEmail, leftColX, doc.y + 1);

  // Right column
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#888888")
    .text("DATE PAID", rightColX, infoStartY);
  const paidDateStr = data.paidAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }) + " at " + data.paidAt.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  doc
    .fontSize(11)
    .font("Helvetica")
    .fillColor("#000000")
    .text(paidDateStr, rightColX, infoStartY + 14);

  // Reset right column position for payment method
  const methodLabelY = nameY;
  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#888888")
    .text("PAYMENT METHOD", rightColX, methodLabelY);
  doc
    .fontSize(11)
    .font("Helvetica")
    .fillColor("#000000")
    .text(
      data.paymentChannel === "promptpay" ? "PromptPay (QR)" : "Credit/Debit Card",
      rightColX,
      methodLabelY + 14
    );

  // Move below both columns
  doc.y = Math.max(doc.y, methodLabelY + 30);
  doc.moveDown(2);

  if (data.taxInvoice) {
    const taxBoxY = doc.y;
    const taxBoxHeight = 60;

    doc
      .rect(doc.page.margins.left, taxBoxY, pageWidth, taxBoxHeight)
      .fill("#fafafa");

    doc
      .fontSize(9)
      .font("Helvetica-Bold")
      .fillColor("#333333")
      .text("TAX INVOICE DETAILS", leftColX + 10, taxBoxY + 10);

    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor("#000000")
      .text(`Name: ${data.taxInvoice.taxName || "-"}`, leftColX + 10, taxBoxY + 24)
      .text(`Tax ID: ${data.taxInvoice.taxId || "-"}`, leftColX + 10, taxBoxY + 38)
      .text(`Address: ${data.taxInvoice.taxFullAddress || "-"}`, leftColX + 10, taxBoxY + 52, {
        width: pageWidth - 20,
      });

    doc.y = taxBoxY + taxBoxHeight + 28;
  }

  // ─────────────────────────────────────────
  // Items Table
  // ─────────────────────────────────────────

  // Table header background
  const tableStartY = doc.y;
  doc
    .rect(doc.page.margins.left, tableStartY, pageWidth, 24)
    .fill("#f5f5f5");

  doc
    .fontSize(9)
    .font("Helvetica-Bold")
    .fillColor("#333333")
    .text("DESCRIPTION", leftColX + 8, tableStartY + 7)
    .text("AMOUNT", doc.page.width - doc.page.margins.right - 100, tableStartY + 7, {
      width: 92,
      align: "right",
    });

  doc.y = tableStartY + 30;

  // Table rows
  for (const item of data.items) {
    const rowY = doc.y;
    const typeLabel = item.type === "ticket" ? "Ticket" : "Add-on";

    doc
      .fontSize(11)
      .font("Helvetica")
      .fillColor("#000000")
      .text(item.name, leftColX + 8, rowY);

    doc
      .fontSize(8)
      .fillColor("#999999")
      .text(typeLabel, leftColX + 8, doc.y + 1);

    doc
      .fontSize(11)
      .font("Helvetica")
      .fillColor("#000000")
      .text(
        `${currencySymbol}${item.price.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
        doc.page.width - doc.page.margins.right - 100,
        rowY,
        { width: 92, align: "right" }
      );

    doc.y = Math.max(doc.y, rowY + 30);

    // Row separator
    doc
      .strokeColor("#eeeeee")
      .lineWidth(0.5)
      .moveTo(leftColX, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .stroke();

    doc.y += 8;
  }

  doc.moveDown(0.5);

  // ─────────────────────────────────────────
  // Totals
  // ─────────────────────────────────────────
  const totalsX = doc.page.width - doc.page.margins.right - 200;

  // Subtotal
  const subtotalY = doc.y;
  doc
    .fontSize(10)
    .font("Helvetica")
    .fillColor("#666666")
    .text("Subtotal", totalsX, subtotalY)
    .text(
      `${currencySymbol}${data.subtotal.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      totalsX + 100,
      subtotalY,
      { width: 100, align: "right" }
    );

  // Discount
  if (data.discount && data.discount > 0) {
    doc.moveDown(0.3);
    const discountY = doc.y;
    const discountLabel = data.promoCode ? `Discount (${data.promoCode})` : "Discount";
    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor("#00C853")
      .text(discountLabel, totalsX, discountY)
      .text(
        `-${currencySymbol}${data.discount.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
        totalsX + 100,
        discountY,
        { width: 100, align: "right" }
      );
  }

  // Fee
  if (data.fee > 0) {
    doc.moveDown(0.3);
    const feeY = doc.y;
    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor("#666666")
      .text("Processing Fee", totalsX, feeY)
      .text(
        `${currencySymbol}${data.fee.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
        totalsX + 100,
        feeY,
        { width: 100, align: "right" }
      );
  }

  doc.moveDown(0.5);

  // Total divider
  const totalDivY = doc.y;
  doc
    .strokeColor("#00C853")
    .lineWidth(1.5)
    .moveTo(totalsX, totalDivY)
    .lineTo(doc.page.width - doc.page.margins.right, totalDivY)
    .stroke();

  doc.moveDown(0.5);
  const totalY = doc.y;
  doc
    .fontSize(14)
    .font("Helvetica-Bold")
    .fillColor("#000000")
    .text("Total Paid", totalsX, totalY)
    .text(
      `${currencySymbol}${data.total.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
      totalsX + 100,
      totalY,
      { width: 100, align: "right" }
    );

  // ─────────────────────────────────────────
  // Footer
  // ─────────────────────────────────────────
  doc.moveDown(4);

  // Footer divider
  const footerDivY = doc.y;
  doc
    .strokeColor("#e0e0e0")
    .lineWidth(0.5)
    .moveTo(doc.page.margins.left, footerDivY)
    .lineTo(doc.page.width - doc.page.margins.right, footerDivY)
    .stroke();

  doc.moveDown(0.8);

  doc
    .fontSize(9)
    .font("Helvetica")
    .fillColor("#999999")
    .text(
      "This receipt was generated by the ACCP 2026 Conference System.",
      doc.page.margins.left, doc.y, { align: "center", width: pageWidth }
    )
    .text(
      `For questions, contact ${process.env.CONTACT_EMAIL || "info@accp2026.com"}`,
      doc.page.margins.left, doc.y, { align: "center", width: pageWidth }
    )
    .text(
      "25th Asian Conference on Clinical Pharmacy | Bangkok, Thailand",
      doc.page.margins.left, doc.y, { align: "center", width: pageWidth }
    );

  doc.end();

  return stream;
}
