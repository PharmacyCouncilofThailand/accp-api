import axios from "axios";
import type { EventEmailContext } from "./emailTemplates.types.js";
import { getFullName } from "../utils/name.js";

// ============================================
// NipaMail Configuration (shared with emailService.ts)
// ============================================
const NIPAMAIL_API_URL = "https://api.nipamail.com";

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

function encodeToBase64(content: string): string {
  return Buffer.from(content).toString("base64");
}

function getSenderString(): string {
  const name = process.env.NIPAMAIL_SENDER_NAME || "ACCP Conference";
  const email = process.env.NIPAMAIL_SENDER_EMAIL;
  if (!email) {
    throw new Error("NIPAMAIL_SENDER_EMAIL not configured");
  }
  return `${name} <${email}>`;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const clientId = process.env.NIPAMAIL_CLIENT_ID;
  const clientSecret = process.env.NIPAMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      "NipaMail credentials not configured. Set NIPAMAIL_CLIENT_ID and NIPAMAIL_CLIENT_SECRET in .env"
    );
  }

  try {
    const response = await axios.post(
      `${NIPAMAIL_API_URL}/v1/auth/tokens`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + 55 * 60 * 1000;
    return cachedToken!;
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response) {
      throw new Error(
        `NipaMail auth failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

async function sendNipaMailEmail(
  recipient: string,
  subject: string,
  text: string,
  retryOnAuth: boolean = true
): Promise<void> {
  const token = await getAccessToken();
  const htmlContent = text.replace(/\n/g, "<br>\n");

  try {
    await axios.post(
      `${NIPAMAIL_API_URL}/v1/messages`,
      {
        type: "EMAIL",
        message: {
          sender: getSenderString(),
          recipient,
          subject,
          html: encodeToBase64(htmlContent),
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
  } catch (error: unknown) {
    if (
      retryOnAuth &&
      axios.isAxiosError(error) &&
      error.response?.status === 401
    ) {
      cachedToken = null;
      return sendNipaMailEmail(recipient, subject, text, false);
    }
    if (axios.isAxiosError(error) && error.response) {
      console.error("NipaMail send failed:", JSON.stringify(error.response.data));
      throw new Error(
        `Email send failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

async function sendNipaMailHtml(
  recipient: string,
  subject: string,
  html: string,
  retryOnAuth: boolean = true
): Promise<void> {
  const token = await getAccessToken();

  try {
    await axios.post(
      `${NIPAMAIL_API_URL}/v1/messages`,
      {
        type: "EMAIL",
        message: {
          sender: getSenderString(),
          recipient,
          subject,
          html: encodeToBase64(html),
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }
    );
  } catch (error: unknown) {
    if (
      retryOnAuth &&
      axios.isAxiosError(error) &&
      error.response?.status === 401
    ) {
      cachedToken = null;
      return sendNipaMailHtml(recipient, subject, html, false);
    }
    if (axios.isAxiosError(error) && error.response) {
      console.error("NipaMail send failed:", JSON.stringify(error.response.data));
      throw new Error(
        `Email send failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

// ============================================
// Shared helpers
// ============================================

/** Build email signature block */
function signature(_ctx: EventEmailContext): string {
  return `Sincerely,\nThe Pharmacy Council of Thailand`;
}

/** Build the standard conference intro line */
function introLine(ctx: EventEmailContext): string {
  return `The meeting will take place ${ctx.dates}, at ${ctx.venue}.`;
}

// ============================================
// 1. EVENT REGISTRATION EMAIL (Generic version of sendManualRegistrationEmail)
// ============================================

export async function sendEventRegistrationEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  regCode: string,
  ticketName: string,
  sessions: { sessionName: string; startTime: Date; endTime: Date }[],
  ctx: EventEmailContext
): Promise<void> {
  const sessionLines =
    sessions.length > 0
      ? sessions
          .map((s) => {
            const date = s.startTime.toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
              timeZone: "Asia/Bangkok",
            });
            const timeFrom = s.startTime.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Asia/Bangkok",
            });
            const timeTo = s.endTime.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Asia/Bangkok",
            });
            return `  - ${s.sessionName} (${date}, ${timeFrom} - ${timeTo})`;
          })
          .join("\n")
      : "  - (No sessions)";

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Your registration for the ${ctx.eventName} has been confirmed. ${introLine(ctx)}

Registration Code: ${regCode}
Event: ${ctx.eventName}
Ticket: ${ticketName}

Registered Sessions:
${sessionLines}

Please present this registration code (or scan the QR code below) at the registration desk on the day of the event.

For more information and details about the conference, go to ${ctx.websiteUrl}

If you have any questions, please contact pr@pharmacycouncil.org

See you soon at ${ctx.shortName}.

${signature(ctx)}
  `.trim();

  let htmlContent = plainText.replace(/\n/g, "<br>\n");

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(regCode)}`;
  const qrHtml = `<br><div style="text-align:center;margin:20px 0;"><img src="${qrUrl}" alt="QR Code: ${regCode}" width="200" height="200" style="display:block;margin:0 auto;" /><p style="font-size:13px;color:#6b7280;margin-top:8px;">Scan this QR code at the registration desk for fast check-in</p></div>`;

  htmlContent = htmlContent.replace(
    `Registration Code: ${regCode}`,
    `Registration Code: <strong>${regCode}</strong>${qrHtml}`
  );

  try {
    await sendNipaMailHtml(email, `Registration Confirmed - ${ctx.shortName}`, htmlContent);
    console.log(`[Generic] Registration email sent to ${email} [${regCode}]`);
  } catch (error) {
    console.error("[Generic] Error sending registration email:", error);
    throw error;
  }
}

// ============================================
// 2. EVENT PAYMENT RECEIPT EMAIL (Generic version of sendPaymentReceiptEmail)
// ============================================

interface ReceiptEmailItem {
  name: string;
  type: string;
  price: number;
}

interface TaxInvoiceEmailInfo {
  taxName: string | null;
  taxId: string | null;
  taxFullAddress: string | null;
}

export async function sendEventPaymentReceiptEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  orderNumber: string,
  paidAt: Date,
  paymentChannel: string,
  items: ReceiptEmailItem[],
  subtotal: number,
  fee: number,
  total: number,
  currency: string,
  receiptDownloadUrl: string,
  ctx: EventEmailContext,
  taxInvoice?: TaxInvoiceEmailInfo,
  regCode?: string
): Promise<void> {
  const currencySymbol = currency === "THB" ? "\u0E3F" : "$";
  const methodLabel =
    paymentChannel === "promptpay" ? "PromptPay (QR)" : "Credit/Debit Card";

  const dateStr = paidAt.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Bangkok",
  });

  const itemLines = items
    .map((item) => `  - ${item.name}: ${currencySymbol}${item.price.toLocaleString()}`)
    .join("\n");

  const feeLineText =
    fee > 0
      ? `  - Payment Processing Fee: ${currencySymbol}${fee.toLocaleString()}\n`
      : "";

  const taxInvoiceText = taxInvoice
    ? `
Tax Invoice Details:
Name: ${taxInvoice.taxName || "-"}
Tax ID: ${taxInvoice.taxId || "-"}
Tax Address: ${taxInvoice.taxFullAddress || "-"}`
    : "";

  const qrUrl = regCode
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(regCode)}`
    : "";

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for your registration and payment for the ${ctx.eventName}. ${introLine(ctx)}

Your registration has been confirmed. Below is your payment summary:

Order Number: ${orderNumber}
Payment Date: ${dateStr}
Payment Method: ${methodLabel}

Items:
${itemLines}
${feeLineText}
Total Paid: ${currencySymbol}${total.toLocaleString()}
${taxInvoiceText}
${regCode ? `\nRegistration Code: ${regCode}\nPresent this QR code at the event for check-in.` : ""}

Download your receipt (PDF): ${receiptDownloadUrl}

For more information and details about the conference, go to ${ctx.websiteUrl}

If you have any questions, please contact pr@pharmacycouncil.org

See you soon at ${ctx.shortName}.

${signature(ctx)}
  `.trim();

  let htmlContent = plainText.replace(/\n/g, "<br>\n");

  htmlContent = htmlContent.replace(
    `Download your receipt (PDF): ${receiptDownloadUrl}`,
    `Download your receipt (PDF): <a href="${receiptDownloadUrl}" style="color: #1a73e8; font-weight: bold; text-decoration: underline;">Download Here</a>`
  );

  if (qrUrl && regCode) {
    const qrHtml = `<br><div style="text-align:center;margin:20px 0;"><img src="${qrUrl}" alt="QR Code: ${regCode}" width="200" height="200" style="display:block;margin:0 auto;" /></div>`;
    htmlContent = htmlContent.replace(
      `Registration Code: ${regCode}`,
      `Registration Code: <strong>${regCode}</strong>${qrHtml}`
    );
  }

  try {
    await sendNipaMailHtml(email, `Payment Receipt - ${orderNumber} | ${ctx.shortName}`, htmlContent);
    console.log(`[Generic] Payment receipt email sent to ${email} for order ${orderNumber}`);
  } catch (error) {
    console.error("[Generic] Error sending payment receipt email:", error);
    throw error;
  }
}

// ============================================
// 3. ABSTRACT SUBMISSION EMAIL
// ============================================

export async function sendEventAbstractSubmissionEmail(
  email: string,
  firstName: string,
  lastName: string,
  trackingId: string,
  abstractTitle: string,
  ctx: EventEmailContext
): Promise<void> {
  const plainText = `
Thank you for submitting the abstract for the poster or oral presentation at the ${ctx.eventName}. ${introLine(ctx)}

We have already received your abstract and will notify you of the result of the abstract acceptance within 2 weeks after abstract submission.

Tracking ID: ${trackingId}
Abstract Title: ${abstractTitle}

If you have any questions, please get in touch with pr@pharmacycouncil.org

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Abstract Submission Received - ${ctx.shortName}`, plainText);
    console.log(`[Generic] Abstract submission email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending abstract submission email:", error);
    throw error;
  }
}

// ============================================
// 4. CO-AUTHOR NOTIFICATION EMAIL
// ============================================

export async function sendEventCoAuthorNotificationEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  mainAuthorName: string,
  trackingId: string,
  abstractTitle: string,
  ctx: EventEmailContext
): Promise<void> {
  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

We would like to notify you that your co-authored abstract, titled "${abstractTitle}", has been submitted to the ${ctx.eventName}. ${introLine(ctx)}

Tracking ID: ${trackingId}
Submitted by: ${mainAuthorName}

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Co-Author Notification - ${ctx.shortName} Abstract`, plainText);
    console.log(`[Generic] Co-author notification email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending co-author notification email:", error);
    throw error;
  }
}

// ============================================
// 5. ABSTRACT ACCEPTED EMAIL (poster + oral unified)
// ============================================

export async function sendEventAbstractAcceptedEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  abstractTitle: string,
  presentationType: "poster" | "oral",
  ctx: EventEmailContext,
  comment?: string
): Promise<void> {
  const typeLabel = presentationType === "poster" ? "POSTER PRESENTATION" : "ORAL PRESENTATION";
  const articlePrefix = presentationType === "poster" ? "a" : "an";
  const commentText = comment ? `\nComment: ${comment}\n` : "";

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Congratulations! Your abstract, titled "${abstractTitle}", is ACCEPTED as ${articlePrefix} ${typeLabel} at the ${ctx.eventName}. ${introLine(ctx)}
${commentText}
All ${presentationType} presenters must be registered for the meeting in order to present${presentationType === "poster" ? " their poster" : ""}. For registration information and details go to ${ctx.websiteUrl}

We look forward to your presentation. If you have any questions, please contact pr@pharmacycouncil.org

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(
      email,
      `Congratulations! Abstract Accepted (${presentationType === "poster" ? "Poster" : "Oral"}) - ${ctx.shortName}`,
      plainText
    );
    console.log(`[Generic] Abstract accepted (${presentationType}) email sent to ${email}`);
  } catch (error) {
    console.error(`[Generic] Error sending abstract accepted (${presentationType}) email:`, error);
    throw error;
  }
}

// ============================================
// 6. ABSTRACT REJECTED EMAIL
// ============================================

export async function sendEventAbstractRejectedEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  abstractTitle: string,
  ctx: EventEmailContext,
  comment?: string
): Promise<void> {
  const commentText = comment ? `\nComment: ${comment}\n` : "";

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you very much for submitting your abstract for poster or oral presentation at the ${ctx.eventName}. Unfortunately, there are many high-quality abstracts, but we still have limited availability for poster or oral presentations.

Abstract Title: ${abstractTitle}
${commentText}
Thank you so much again for your submission. Looking forward to your abstract at next year's conference.

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Abstract Submission Update - ${ctx.shortName}`, plainText);
    console.log(`[Generic] Abstract rejected email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending abstract rejected email:", error);
    throw error;
  }
}

// ============================================
// 7. SIGNUP NOTIFICATION EMAIL (non-student auto-approved)
// ============================================

export async function sendEventSignupNotificationEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  ctx: EventEmailContext
): Promise<void> {
  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for your registration via the website for the ${ctx.eventName}. ${introLine(ctx)}

For more information and details about the conference, go to ${ctx.websiteUrl}

See you soon at ${ctx.shortName}.

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Registration Successful - Welcome to ${ctx.shortName}`, plainText);
    console.log(`[Generic] Signup notification email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending signup notification email:", error);
    throw error;
  }
}

// ============================================
// 8. PENDING APPROVAL EMAIL (student document verification)
// ============================================

export async function sendEventPendingApprovalEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  ctx: EventEmailContext
): Promise<void> {
  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for your registration for the ${ctx.eventName}. ${introLine(ctx)}

For the student registration fee, we have to check the documents to verify that they are students. This will take 3-5 days. After finishing checking the document, we will email you again for the registration confirmation.

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Registration Received - Document Verification Pending | ${ctx.shortName}`, plainText);
    console.log(`[Generic] Pending approval email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending pending approval email:", error);
    throw error;
  }
}

// ============================================
// 9. VERIFICATION APPROVED EMAIL
// ============================================

export async function sendEventVerificationApprovedEmail(
  email: string,
  firstName: string,
  ctx: EventEmailContext,
  comment?: string
): Promise<void> {
  const loginUrl = ctx.websiteUrl + "/login";
  const commentText = comment ? `\nComment: ${comment}\n` : "";

  const plainText = `
Dear ${firstName},

Thank you for your registration for the ${ctx.eventName}. ${introLine(ctx)}

For the student registration fee, we have to check the documents to verify that they are students. Your document has been approved, so your registration has already confirmed.
${commentText}
See you soon at ${ctx.shortName}.

Login to your account: ${loginUrl}

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Document Approved - Registration Confirmed | ${ctx.shortName}`, plainText);
    console.log(`[Generic] Verification approved email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending verification approved email:", error);
    throw error;
  }
}

// ============================================
// 10. VERIFICATION REJECTED EMAIL
// ============================================

export async function sendEventVerificationRejectedEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  ctx: EventEmailContext,
  rejectionReason?: string
): Promise<void> {
  const reasonText = rejectionReason ? `\nReason: ${rejectionReason}\n` : "";

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for your registration for the ${ctx.eventName}. ${introLine(ctx)}

For the student registration fee, we have to check the documents to verify that they are students. Your document has some concerns, so could you please send us another document within 2 days? This will take 3-5 days. After finishing checking the document, we will email you again for the registration confirmation.
${reasonText}
${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Document Requires Attention - Please Resubmit | ${ctx.shortName}`, plainText);
    console.log(`[Generic] Verification rejected email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending verification rejected email:", error);
    throw error;
  }
}

// ============================================
// 11. DOCUMENT RESUBMITTED EMAIL
// ============================================

export async function sendEventDocumentResubmittedEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  ctx: EventEmailContext
): Promise<void> {
  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for resubmitting your verification document for the ${ctx.eventName}. ${introLine(ctx)}

We have received your new document and will review it within 3-5 business days. After finishing checking the document, we will email you again for the registration confirmation.

${signature(ctx)}
  `.trim();

  try {
    await sendNipaMailEmail(email, `Document Resubmitted - Pending Review | ${ctx.shortName}`, plainText);
    console.log(`[Generic] Document resubmission email sent to ${email}`);
  } catch (error) {
    console.error("[Generic] Error sending document resubmission email:", error);
    throw error;
  }
}
