import axios from "axios";
import { getFullName } from "../utils/name.js";
import { formatIssueDate, renderLetterPdf } from "./letter.service.js";

// ============================================
// NipaMail Configuration
// ============================================
const NIPAMAIL_API_URL = "https://api.nipamail.com";

// Token cache (valid 1 hour, cache 55 min)
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Encode content to Base64
 */
function encodeToBase64(content: string): string {
  return Buffer.from(content).toString("base64");
}

/**
 * Get sender string in format: "Name <email>"
 */
function getSenderString(): string {
  const name = process.env.NIPAMAIL_SENDER_NAME || "ACCP Conference";
  const email = process.env.NIPAMAIL_SENDER_EMAIL;
  if (!email) {
    throw new Error("NIPAMAIL_SENDER_EMAIL not configured");
  }
  return `${name} <${email}>`;
}

/**
 * Get NipaMail access token (with caching)
 */
async function getAccessToken(): Promise<string> {
  // Return cached token if still valid
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
    tokenExpiry = Date.now() + 55 * 60 * 1000; // Cache for 55 minutes
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

/**
 * Attachment to include with an outgoing email.
 * Sent to NipaMail as `attachments[].type = "RAW"` with base64-encoded content.
 */
export interface EmailAttachment {
  /** Raw file bytes (e.g. PDF buffer) */
  content: Buffer;
  /** Filename shown to the recipient, including extension */
  fileName: string;
}

/**
 * Build the NipaMail `attachments` array from our internal EmailAttachment[].
 * Returns undefined (not an empty array) so the field is omitted when empty.
 */
function toNipaAttachments(attachments?: EmailAttachment[]) {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a) => ({
    type: "RAW" as const,
    content: a.content.toString("base64"),
    file_name: a.fileName,
  }));
}

/**
 * Send email via NipaMail API
 */
async function sendNipaMailEmail(
  recipient: string,
  subject: string,
  text: string,
  attachments?: EmailAttachment[],
  retryOnAuth: boolean = true
): Promise<void> {
  const token = await getAccessToken();

  // Convert plain text newlines to HTML line breaks for proper display
  const htmlContent = text.replace(/\n/g, '<br>\n');
  const nipaAttachments = toNipaAttachments(attachments);

  try {
    await axios.post(
      `${NIPAMAIL_API_URL}/v1/messages`,
      {
        type: "EMAIL",
        message: {
          sender: getSenderString(),
          recipient: recipient,
          subject: subject,
          html: encodeToBase64(htmlContent),
          ...(nipaAttachments ? { attachments: nipaAttachments } : {}),
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
    // Retry once if token invalid (401)
    if (
      retryOnAuth &&
      axios.isAxiosError(error) &&
      error.response?.status === 401
    ) {
      cachedToken = null; // Clear cache
      return sendNipaMailEmail(recipient, subject, text, attachments, false);
    }

    if (axios.isAxiosError(error) && error.response) {
      console.error(
        "NipaMail send failed:",
        JSON.stringify(error.response.data)
      );
      throw new Error(
        `Email send failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

/**
 * Send email via NipaMail API (raw HTML version)
 */
async function sendNipaMailHtml(
  recipient: string,
  subject: string,
  html: string,
  attachments?: EmailAttachment[],
  retryOnAuth: boolean = true
): Promise<void> {
  const token = await getAccessToken();
  const nipaAttachments = toNipaAttachments(attachments);

  try {
    await axios.post(
      `${NIPAMAIL_API_URL}/v1/messages`,
      {
        type: "EMAIL",
        message: {
          sender: getSenderString(),
          recipient: recipient,
          subject: subject,
          html: encodeToBase64(html),
          ...(nipaAttachments ? { attachments: nipaAttachments } : {}),
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
      return sendNipaMailHtml(recipient, subject, html, attachments, false);
    }

    if (axios.isAxiosError(error) && error.response) {
      console.error(
        "NipaMail send failed:",
        JSON.stringify(error.response.data)
      );
      throw new Error(
        `Email send failed: ${error.response.data?.message || error.response.status}`
      );
    }
    throw error;
  }
}

/**
 * Get the conference website URL
 */
function getWebsiteUrl(): string {
  return (process.env.BASE_URL || "https://accp2026.com").replace(/\/+$/, "");
}

/**
 * Get the contact email
 */
function getContactEmail(): string {
  return process.env.CONTACT_EMAIL || "info@accp2026.com";
}

// ============================================
// MANUAL REGISTRATION EMAIL
// ============================================

/**
 * Send manual registration confirmation email with QR code
 * Pattern: plain text converted to <br> + injected QR code <img> (same as sendPaymentReceiptEmail)
 */
export async function sendManualRegistrationEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  regCode: string,
  eventName: string,
  ticketName: string,
  sessions: { sessionName: string; startTime: Date; endTime: Date }[]
): Promise<void> {
  const contactEmail = getContactEmail();
  const websiteUrl = getWebsiteUrl();

  const sessionLines = sessions.length > 0
    ? sessions
        .map((s) => {
          const date = s.startTime.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "Asia/Bangkok" });
          const timeFrom = s.startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
          const timeTo = s.endTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
          return `  - ${s.sessionName} (${date}, ${timeFrom} - ${timeTo})`;
        })
        .join("\n")
    : "  - (No sessions)";

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Your registration for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY has been confirmed by the conference staff. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

Registration Code: ${regCode}
Event: ${eventName}
Ticket: ${ticketName}

Registered Sessions:
${sessionLines}

Please present this registration code (or scan the QR code below) at the registration desk on the day of the event.

For more information and details about the conference, go to ${websiteUrl}

If you have any questions, please contact ${contactEmail}

See you soon at ACCP 2026, Bangkok, Thailand.

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  // Convert \n → <br> then inject QR code image after reg-code line
  let htmlContent = plainText.replace(/\n/g, "<br>\n");

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(regCode)}`;
  const qrHtml = `<br><div style="text-align:center;margin:20px 0;"><img src="${qrUrl}" alt="QR Code: ${regCode}" width="200" height="200" style="display:block;margin:0 auto;" /><p style="font-size:13px;color:#6b7280;margin-top:8px;">Scan this QR code at the registration desk for fast check-in</p></div>`;

  htmlContent = htmlContent.replace(
    `Registration Code: ${regCode}`,
    `Registration Code: <strong>${regCode}</strong>${qrHtml}`
  );

  try {
    await sendNipaMailHtml(email, "Manual Registration Confirmed - 25th ACCP 2026", htmlContent);
    console.log(`Manual registration email sent to ${email} [${regCode}]`);
  } catch (error) {
    console.error("Error sending manual registration email:", error);
    throw error;
  }
}

// ============================================
// ABSTRACT EMAILS
// ============================================

/**
 * Send abstract submission confirmation email to main author
 * Template: Abstract receive notification
 */
export async function sendAbstractSubmissionEmail(
  email: string,
  firstName: string,
  lastName: string,
  trackingId: string,
  abstractTitle: string
): Promise<void> {
  const contactEmail = getContactEmail();

  const plainText = `
Thank you for submitting the abstract for the poster or oral presentation at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

We have already received your abstract and will notify you of the result of the abstract acceptance within 2 weeks after abstract submission.

Tracking ID: ${trackingId}
Abstract Title: ${abstractTitle}

If you have any questions, please get in touch with ${contactEmail}

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Abstract Submission Received - 25th ACCP 2026", plainText);
    console.log(`Abstract submission email sent to ${email}`);
  } catch (error) {
    console.error("Error sending abstract submission email:", error);
    throw error;
  }
}

/**
 * Send abstract submission notification to co-author
 * Template: Abstract notification Co-author abstract Receive
 */
export async function sendCoAuthorNotificationEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  mainAuthorName: string,
  trackingId: string,
  abstractTitle: string
): Promise<void> {
  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

We would like to notify you that your co-authored abstract, titled "${abstractTitle}", has been submitted to the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

Tracking ID: ${trackingId}
Submitted by: ${mainAuthorName}

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Co-Author Notification - 25th ACCP 2026 Abstract", plainText);
    console.log(`Co-author notification email sent to ${email}`);
  } catch (error) {
    console.error("Error sending co-author notification email:", error);
    throw error;
  }
}

/**
 * Send abstract accepted as poster presentation email
 * Template: Abstract notification (Poster) >> Accept
 */
export async function sendAbstractAcceptedPosterEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  abstractTitle: string,
  comment?: string,
  attachment?: { pdf: Buffer; fileName: string },
): Promise<void> {
  const websiteUrl = getWebsiteUrl();
  const contactEmail = getContactEmail();
  const commentText = comment ? `\nComment: ${comment}\n` : '';

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Congratulations! Your abstract, titled "${abstractTitle}", is ACCEPTED as a POSTER PRESENTATION at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.
${commentText}
All poster presenters must be registered for the meeting in order to present their poster. For registration information and details go to ${websiteUrl}

We look forward to your presentation. If you have any questions, please contact ${contactEmail}

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(
      email,
      "Congratulations! Abstract Accepted (Poster) - 25th ACCP 2026",
      plainText,
      attachment ? [{ content: attachment.pdf, fileName: attachment.fileName }] : undefined,
    );
    console.log(`Abstract accepted (poster) email sent to ${email}`);
  } catch (error) {
    console.error("Error sending abstract accepted poster email:", error);
    throw error;
  }
}

/**
 * Send abstract accepted as oral presentation email
 * Template: Abstract notification (Oral) >> Accept
 */
export async function sendAbstractAcceptedOralEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  abstractTitle: string,
  comment?: string,
  attachment?: { pdf: Buffer; fileName: string },
): Promise<void> {
  const websiteUrl = getWebsiteUrl();
  const contactEmail = getContactEmail();
  const commentText = comment ? `\nComment: ${comment}\n` : '';

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Congratulations! Your abstract, titled "${abstractTitle}", is ACCEPTED as an ORAL PRESENTATION at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.
${commentText}
All oral presenters must be registered for the meeting in order to present. For registration information and details go to ${websiteUrl}

We look forward to your presentation. If you have any questions, please contact ${contactEmail}

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(
      email,
      "Congratulations! Abstract Accepted (Oral) - 25th ACCP 2026",
      plainText,
      attachment ? [{ content: attachment.pdf, fileName: attachment.fileName }] : undefined,
    );
    console.log(`Abstract accepted (oral) email sent to ${email}`);
  } catch (error) {
    console.error("Error sending abstract accepted oral email:", error);
    throw error;
  }
}

const ABSTRACT_REGISTRATION_DEADLINE = "28 June 2026";

function getAbstractRegistrationUrl(): string {
  return (
    process.env.WEBSITE_URL ||
    process.env.BASE_URL ||
    "https://accp2026bangkok.pharmacycouncil.org"
  ).replace(/\/+$/, "");
}

function buildAbstractAcceptedNoRegistrationPlainText(
  firstName: string,
  middleName: string | null,
  lastName: string,
  abstractTitle: string,
  presentationType: "oral" | "poster",
): string {
  const typeLabel = presentationType === "poster" ? "Poster" : "Oral";
  const registrationUrl = getAbstractRegistrationUrl();

  return `Dear ${getFullName(firstName, middleName, lastName)},

This is an urgent reminder regarding your accepted abstract:
${typeLabel} titled "${abstractTitle}" for presentation at the conference.

According to our records, your conference registration has not yet been completed. Please be advised that the registration deadline is ${ABSTRACT_REGISTRATION_DEADLINE}.

To maintain your presentation status, all presenting authors must complete their registration and payment by the deadline. Failure to do so may result in:
Removal of the abstract from the official conference abstract booklet;
Exclusion from the conference program; and
Loss of eligibility to present at the conference.

Please complete your registration as soon as possible via:
${registrationUrl}

Final Registration Deadline: ${ABSTRACT_REGISTRATION_DEADLINE}

If you have already completed your registration recently, please disregard this message.

Thank you for your prompt attention to this matter. We look forward to welcoming you to Bangkok for the 25th Asian Conference on Clinical Pharmacy (2026 ACCP).

Yours sincerely,
Asst. Prof. Dr. Thanompong Sathienluckana
Chair of the Abstract Review Working Group
The 25th Asian Conference on Clinical Pharmacy (2026 ACCP)`.trim();
}

/**
 * Send registration reminder to accepted abstract authors who have not registered yet.
 * Template: Accepted oral and poster แต่ยังไม่ลงทะเบียนเข้างาน.docx
 */
export async function sendAbstractAcceptedNoRegistrationEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  abstractTitle: string,
  presentationType: "oral" | "poster",
): Promise<void> {
  const plainText = buildAbstractAcceptedNoRegistrationPlainText(
    firstName, middleName, lastName, abstractTitle, presentationType,
  );

  try {
    await sendNipaMailEmail(
      email,
      `Registration Required by ${ABSTRACT_REGISTRATION_DEADLINE} to Confirm Your Presentation at 2026 ACCP Bangkok`,
      plainText,
    );
    console.log(`Abstract accepted (no registration) reminder sent to ${email}`);
  } catch (error) {
    console.error("Error sending abstract accepted no-registration reminder email:", error);
    throw error;
  }
}

/**
 * Send abstract rejected email
 * Template: Abstract notification (Poster) >> Reject
 */
export async function sendAbstractRejectedEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  abstractTitle: string,
  comment?: string
): Promise<void> {
  const commentText = comment ? `\nComment: ${comment}\n` : '';

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you very much for submitting your abstract for poster or oral presentation at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. Unfortunately, there are many high-quality abstracts, but we still have limited availability for poster or oral presentations.

Abstract Title: ${abstractTitle}
${commentText}
Thank you so much again for your submission. Looking forward to your abstract at next year's conference.

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Abstract Submission Update - 25th ACCP 2026", plainText);
    console.log(`Abstract rejected email sent to ${email}`);
  } catch (error) {
    console.error("Error sending abstract rejected email:", error);
    throw error;
  }
}

// ============================================
// STUDENT/USER REGISTRATION EMAILS
// ============================================

/**
 * Send pending approval email to students (thstd, interstd)
 * Called after successful registration
 * Template: For students (Document for confirmation)
 */
export async function sendPendingApprovalEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string
): Promise<void> {
  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for your registration for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

For the student registration fee, we have to check the documents to verify that they are students. This will take 3-5 days. After finishing checking the document, we will email you again for the registration confirmation.

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Registration Received - Document Verification Pending | 25th ACCP 2026", plainText);
    console.log(`Pending approval email sent to ${email}`);
  } catch (error) {
    console.error("Error sending pending approval email:", error);
    throw error;
  }
}

/**
 * Send approval email to students
 * Called after backoffice approval
 * Template: Student Document Approve
 */
export async function sendVerificationApprovedEmail(
  email: string,
  firstName: string,
  comment?: string
): Promise<void> {
  const loginUrl = `${getWebsiteUrl()}/login`;
  const commentText = comment ? `\nComment: ${comment}\n` : '';

  const plainText = `
Dear ${firstName},

Thank you for your registration for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

For the student registration fee, we have to check the documents to verify that they are students. Your document has been approved, so your registration has already confirmed.
${commentText}
See you soon at ACCP 2026, Bangkok, Thailand.

Login to your account: ${loginUrl}

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Document Approved - Registration Confirmed | 25th ACCP 2026", plainText);
    console.log(`Verification approved email sent to ${email}`);
  } catch (error) {
    console.error("Error sending verification approved email:", error);
    throw error;
  }
}

/**
 * Send rejection email to students
 * Called after backoffice rejection
 * Template: Student document Reject
 */
export async function sendVerificationRejectedEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  rejectionReason?: string
): Promise<void> {
  const reasonText = rejectionReason ? `\nReason: ${rejectionReason}\n` : '';

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for your registration for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

For the student registration fee, we have to check the documents to verify that they are students. Your document has some concerns, so could you please send us another document within 2 days? This will take 3-5 days. After finishing checking the document, we will email you again for the registration confirmation.
${reasonText}
Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Document Requires Attention - Please Resubmit | 25th ACCP 2026", plainText);
    console.log(`Verification rejected email sent to ${email}`);
  } catch (error) {
    console.error("Error sending verification rejected email:", error);
    throw error;
  }
}

/**
 * Send role-changed-to-student email
 * Called when admin converts a non-student account into a student account
 * and requires the user to upload a verification document.
 *
 * @param targetLocale "th" or "en" - locale path used in resubmit URL
 */
export async function sendRoleChangedToStudentEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  previousRoleLabel: string,
  newRoleLabel: string,
  reason: string,
  targetLocale: "th" | "en" = "en"
): Promise<void> {
  const websiteUrl = getWebsiteUrl();
  const resubmitUrl = `${websiteUrl}/${targetLocale}/resubmit-document?email=${encodeURIComponent(
    email
  )}&reason=${encodeURIComponent(reason)}`;

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Your account for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY has been updated by our team:

  Previous account type: ${previousRoleLabel}
  New account type:      ${newRoleLabel}

To continue using your account at the student rate, please upload your student verification document (e.g. student ID card or enrollment certificate). Until your document has been reviewed and approved, your account will be temporarily restricted.

Reason from our team:
${reason}

Please upload your document at the link below:
${resubmitUrl}

Once you upload your document, our team will review it within 3-5 business days. We will email you again after review.

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  // Build HTML: convert plain text to <br> and replace the long URL with a styled anchor
  let htmlContent = plainText.replace(/\n/g, "<br>\n");

  htmlContent = htmlContent.replace(
    `Please upload your document at the link below:<br>\n${resubmitUrl}`,
    `Please upload your document by clicking the link: <a href="${resubmitUrl}" style="color:#1a73e8;font-weight:bold;text-decoration:underline;">Upload Document Here</a>`
  );

  try {
    await sendNipaMailHtml(
      email,
      "Account Type Updated - Student Document Required | 25th ACCP 2026",
      htmlContent
    );
    console.log(`Role-changed-to-student email sent to ${email}`);
  } catch (error) {
    console.error("Error sending role-changed-to-student email:", error);
    throw error;
  }
}

/**
 * Send document resubmission confirmation email
 * Called when user resubmits their verification document
 */
export async function sendDocumentResubmittedEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string
): Promise<void> {
  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for resubmitting your verification document for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

We have received your new document and will review it within 3-5 business days. After finishing checking the document, we will email you again for the registration confirmation.

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Document Resubmitted - Pending Review | 25th ACCP 2026", plainText);
    console.log(`Document resubmission email sent to ${email}`);
  } catch (error) {
    console.error("Error sending document resubmission email:", error);
    throw error;
  }
}

/**
 * Send signup notification email (for non-student users)
 * Template: Sign up notification
 */
export async function sendSignupNotificationEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string
): Promise<void> {
  const websiteUrl = getWebsiteUrl();

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for your registration via the website for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

For more information and details about the conference, go to ${websiteUrl}

See you soon at ACCP 2026, Bangkok, Thailand.

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Registration Successful - Welcome to 25th ACCP 2026", plainText);
    console.log(`Signup notification email sent to ${email}`);
  } catch (error) {
    console.error("Error sending signup notification email:", error);
    throw error;
  }
}

/**
 * Send registration confirmation email (after payment)
 * Template: Registration confirmation
 */
export async function sendRegistrationConfirmationEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string
): Promise<void> {
  const websiteUrl = getWebsiteUrl();

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for your registration for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

For more information and details about the conference, go to ${websiteUrl}

After the process, we will send the receipt to you again by email.

See you soon at ACCP 2026, Bangkok, Thailand.

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Registration Confirmed - 25th ACCP 2026", plainText);
    console.log(`Registration confirmation email sent to ${email}`);
  } catch (error) {
    console.error("Error sending registration confirmation email:", error);
    throw error;
  }
}

// ============================================
// PASSWORD RESET EMAIL
// ============================================

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  email: string,
  firstName: string,
  resetToken: string
): Promise<void> {
  const resetUrl = `${getWebsiteUrl()}/reset-password?token=${resetToken}`;

  const plainText = `
Dear ${firstName},

We received a request to reset your password for your 25th ACCP 2026 account.
cp
Click the link below to create a new password:
${resetUrl}

This link will expire in 1 hour. If you didn't request this, please ignore this email.

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Reset Your Password - 25th ACCP 2026", plainText);
    console.log(`Password reset email sent to ${email}`);
  } catch (error) {
    console.error("Error sending password reset email:", error);
    throw error;
  }
}

// ============================================
// PAYMENT RECEIPT EMAIL
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

/**
 * Send payment receipt email with plain text + QR code image URL
 * Called after successful payment (webhook)
 */
export async function sendPaymentReceiptEmail(
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
  taxInvoice?: TaxInvoiceEmailInfo,
  regCode?: string
): Promise<void> {
  const contactEmail = getContactEmail();
  const currencySymbol = currency === "THB" ? "\u0E3F" : "$";
  const methodLabel = paymentChannel === "promptpay" ? "PromptPay (QR)" : "Credit/Debit Card";

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

  const feeLineText = fee > 0
    ? `  - Payment Processing Fee: ${currencySymbol}${fee.toLocaleString()}\n`
    : "";

  const taxInvoiceText = taxInvoice
    ? `
Tax Invoice Details:
Name: ${taxInvoice.taxName || "-"}
Tax ID: ${taxInvoice.taxId || "-"}
Tax Address: ${taxInvoice.taxFullAddress || "-"}`
    : "";

  const websiteUrl = getWebsiteUrl();

  // QR code section using external API URL
  const qrUrl = regCode
    ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(regCode)}`
    : "";

  const plainText = `
Dear ${getFullName(firstName, middleName, lastName)},

Thank you for your registration and payment for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

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

For more information and details about the conference, go to ${websiteUrl}

If you have any questions, please contact ${contactEmail}

See you soon at ACCP 2026, Bangkok, Thailand.

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  // Build HTML: plain text converted to <br> + QR code image from external URL
  let htmlContent = plainText.replace(/\n/g, '<br>\n');

  // Replace plain receipt URL with a styled "Download Here" link
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

  const attachmentFileName = `ACCP2026-Approval-Request-${orderNumber}.pdf`;
  let attachments: EmailAttachment[] | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(
      `Generating approval request letter PDF for order ${orderNumber} (${attachmentFileName}) - attempt ${attempt}/3`,
    );
    try {
      const letterPdf = await renderLetterPdf({
        participantName: getFullName(firstName, middleName, lastName),
        issueDate: formatIssueDate(paidAt),
      });
      attachments = [
        {
          content: letterPdf,
          fileName: attachmentFileName,
        },
      ];
      console.log(
        `Approval request letter PDF generated for order ${orderNumber}: ${attachmentFileName} (${letterPdf.length} bytes) on attempt ${attempt}/3`,
      );
      break;
    } catch (letterError) {
      console.error(
        `Failed to render approval request letter PDF for order ${orderNumber} on attempt ${attempt}/3:`,
        letterError,
      );
    }
  }

  if (!attachments) {
    console.error(
      `Approval request letter PDF could not be generated for order ${orderNumber} after 3 attempts; sending payment receipt email without attachment`,
    );
  }

  try {
    await sendNipaMailHtml(
      email,
      `Payment Receipt - ${orderNumber} | 25th ACCP 2026`,
      htmlContent,
      attachments,
    );
    console.log(
      `Payment receipt email sent to ${email} for order ${orderNumber}`,
    );
  } catch (error) {
    console.error("Error sending payment receipt email:", error);
    throw error;
  }
}

// ============================================
// CONTACT FORM EMAIL
// ============================================

// ============================================
// EMAIL CONTENT BUILDERS (for preview/render)
// ============================================

/**
 * Wrap plain text in a clean HTML email template
 * Mimics the conversion done by sendNipaMailEmail (which calls sendNipaMailHtml internally)
 */
export function buildEmailHtmlFromText(plainText: string): string {
  const bodyHtml = plainText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>\n");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Email Preview</title></head><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;"><div style="max-width:600px;margin:24px auto;background:#ffffff;border-radius:8px;padding:32px 40px;box-shadow:0 2px 8px rgba(0,0,0,0.08);"><div style="color:#374151;font-size:14px;line-height:1.8;">${bodyHtml}</div><hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;"><p style="color:#9ca3af;font-size:12px;text-align:center;margin:0;">25th ACCP Annual Conference 2026 · Bangkok, Thailand</p></div></body></html>`;
}

export function buildSignupNotificationEmailContent(
  firstName: string, middleName: string | null, lastName: string
): { subject: string; html: string } {
  const websiteUrl = getWebsiteUrl();
  const plainText = `Dear ${getFullName(firstName, middleName, lastName)},\n\nThank you for your registration via the website for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.\n\nFor more information and details about the conference, go to ${websiteUrl}\n\nSee you soon at ACCP 2026, Bangkok, Thailand.\n\nSincerely,\n25th ACCP committee\nBangkok Thailand`;
  return { subject: "Registration Successful - Welcome to 25th ACCP 2026", html: buildEmailHtmlFromText(plainText) };
}

export function buildPendingApprovalEmailContent(
  firstName: string, middleName: string | null, lastName: string
): { subject: string; html: string } {
  const plainText = `Dear ${getFullName(firstName, middleName, lastName)},\n\nThank you for your registration for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.\n\nFor the student registration fee, we have to check the documents to verify that they are students. This will take 3-5 days. After finishing checking the document, we will email you again for the registration confirmation.\n\nSincerely,\n25th ACCP committee\nBangkok Thailand`;
  return { subject: "Registration Received - Document Verification Pending | 25th ACCP 2026", html: buildEmailHtmlFromText(plainText) };
}

export function buildAbstractSubmissionEmailContent(
  firstName: string, lastName: string, trackingId: string, abstractTitle: string
): { subject: string; html: string } {
  const contactEmail = getContactEmail();
  const plainText = `Thank you for submitting the abstract for the poster or oral presentation at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.\n\nWe have already received your abstract and will notify you of the result of the abstract acceptance within 2 weeks after abstract submission.\n\nTracking ID: ${trackingId}\nAbstract Title: ${abstractTitle}\n\nIf you have any questions, please get in touch with ${contactEmail}\n\nSincerely,\n25th ACCP committee\nBangkok Thailand`;
  return { subject: "Abstract Submission Received - 25th ACCP 2026", html: buildEmailHtmlFromText(plainText) };
}

export function buildAbstractAcceptedPosterEmailContent(
  firstName: string, middleName: string | null, lastName: string, abstractTitle: string, comment?: string
): { subject: string; html: string } {
  const websiteUrl = getWebsiteUrl();
  const contactEmail = getContactEmail();
  const commentText = comment ? `\nComment: ${comment}\n` : "";
  const plainText = `Dear ${getFullName(firstName, middleName, lastName)},\n\nCongratulations! Your abstract, titled "${abstractTitle}", is ACCEPTED as a POSTER PRESENTATION at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.\n${commentText}\nAll poster presenters must be registered for the meeting in order to present their poster. For registration information and details go to ${websiteUrl}\n\nWe look forward to your presentation. If you have any questions, please contact ${contactEmail}\n\nSincerely,\n25th ACCP committee\nBangkok Thailand`;
  return { subject: "Congratulations! Abstract Accepted (Poster) - 25th ACCP 2026", html: buildEmailHtmlFromText(plainText) };
}

export function buildAbstractAcceptedOralEmailContent(
  firstName: string, middleName: string | null, lastName: string, abstractTitle: string, comment?: string
): { subject: string; html: string } {
  const websiteUrl = getWebsiteUrl();
  const contactEmail = getContactEmail();
  const commentText = comment ? `\nComment: ${comment}\n` : "";
  const plainText = `Dear ${getFullName(firstName, middleName, lastName)},\n\nCongratulations! Your abstract, titled "${abstractTitle}", is ACCEPTED as an ORAL PRESENTATION at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.\n${commentText}\nAll oral presenters must be registered for the meeting in order to present. For registration information and details go to ${websiteUrl}\n\nWe look forward to your presentation. If you have any questions, please contact ${contactEmail}\n\nSincerely,\n25th ACCP committee\nBangkok Thailand`;
  return { subject: "Congratulations! Abstract Accepted (Oral) - 25th ACCP 2026", html: buildEmailHtmlFromText(plainText) };
}

export function buildAbstractAcceptedNoRegistrationEmailContent(
  firstName: string,
  middleName: string | null,
  lastName: string,
  abstractTitle: string,
  presentationType: "oral" | "poster",
): { subject: string; html: string } {
  const plainText = buildAbstractAcceptedNoRegistrationPlainText(
    firstName, middleName, lastName, abstractTitle, presentationType,
  );
  return {
    subject: `Registration Required by ${ABSTRACT_REGISTRATION_DEADLINE} to Confirm Your Presentation at 2026 ACCP Bangkok`,
    html: buildEmailHtmlFromText(plainText),
  };
}

export function buildAbstractRejectedEmailContent(
  firstName: string, middleName: string | null, lastName: string, abstractTitle: string, comment?: string
): { subject: string; html: string } {
  const commentText = comment ? `\nComment: ${comment}\n` : "";
  const plainText = `Dear ${getFullName(firstName, middleName, lastName)},\n\nThank you very much for submitting your abstract for poster or oral presentation at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. Unfortunately, there are many high-quality abstracts, but we still have limited availability for poster or oral presentations.\n\nAbstract Title: ${abstractTitle}\n${commentText}\nThank you so much again for your submission. Looking forward to your abstract at next year's conference.\n\nSincerely,\n25th ACCP committee\nBangkok Thailand`;
  return { subject: "Abstract Submission Update - 25th ACCP 2026", html: buildEmailHtmlFromText(plainText) };
}

export function buildPaymentReceiptEmailContent(
  firstName: string, middleName: string | null, lastName: string,
  orderNumber: string, paidAt: Date, paymentChannel: string,
  items: { name: string; type: string; price: number }[],
  subtotal: number, fee: number, total: number, currency: string,
  receiptDownloadUrl: string, taxInvoice?: { taxName: string | null; taxId: string | null; taxFullAddress: string | null },
  regCode?: string
): { subject: string; html: string } {
  const contactEmail = getContactEmail();
  const currencySymbol = currency === "THB" ? "\u0E3F" : "$";
  const methodLabel = paymentChannel === "promptpay" ? "PromptPay (QR)" : "Credit/Debit Card";
  const dateStr = paidAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
  const itemLines = items.map((i) => `  - ${i.name}: ${currencySymbol}${i.price.toLocaleString()}`).join("\n");
  const feeLineText = fee > 0 ? `  - Payment Processing Fee: ${currencySymbol}${fee.toLocaleString()}\n` : "";
  const taxInvoiceText = taxInvoice ? `\nTax Invoice Details:\nName: ${taxInvoice.taxName || "-"}\nTax ID: ${taxInvoice.taxId || "-"}\nTax Address: ${taxInvoice.taxFullAddress || "-"}` : "";
  const websiteUrl = getWebsiteUrl();
  const qrUrl = regCode ? `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(regCode)}` : "";

  const plainText = `Dear ${getFullName(firstName, middleName, lastName)},\n\nThank you for your registration and payment for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.\n\nYour registration has been confirmed. Below is your payment summary:\n\nOrder Number: ${orderNumber}\nPayment Date: ${dateStr}\nPayment Method: ${methodLabel}\n\nItems:\n${itemLines}\n${feeLineText}Total Paid: ${currencySymbol}${total.toLocaleString()}\n${taxInvoiceText}\n${regCode ? `\nRegistration Code: ${regCode}\nPresent this QR code at the event for check-in.` : ""}\n\nDownload your receipt (PDF): ${receiptDownloadUrl}\n\nFor more information and details about the conference, go to ${websiteUrl}\n\nIf you have any questions, please contact ${contactEmail}\n\nSee you soon at ACCP 2026, Bangkok, Thailand.\n\nSincerely,\n25th ACCP committee\nBangkok Thailand`;

  let htmlContent = plainText
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>\n");

  htmlContent = htmlContent.replace(
    `Download your receipt (PDF): ${receiptDownloadUrl}`,
    `Download your receipt (PDF): <a href="${receiptDownloadUrl}" style="color:#1a73e8;font-weight:bold;text-decoration:underline;">Download Here</a>`
  );

  if (qrUrl && regCode) {
    const qrHtml = `<br><div style="text-align:center;margin:20px 0;"><img src="${qrUrl}" alt="QR: ${regCode}" width="200" height="200" style="display:block;margin:0 auto;" /><p style="font-size:12px;color:#6b7280;margin-top:8px;">${regCode}</p></div>`;
    htmlContent = htmlContent.replace(`Registration Code: ${regCode}`, `Registration Code: <strong>${regCode}</strong>${qrHtml}`);
  }

  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Email Preview</title></head><body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,sans-serif;"><div style="max-width:600px;margin:24px auto;background:#fff;border-radius:8px;padding:32px 40px;box-shadow:0 2px 8px rgba(0,0,0,0.08);"><div style="color:#374151;font-size:14px;line-height:1.8;">${htmlContent}</div><hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0;"><p style="color:#9ca3af;font-size:12px;text-align:center;margin:0;">25th ACCP Annual Conference 2026 · Bangkok, Thailand</p></div></body></html>`;
  return { subject: `Payment Receipt - ${orderNumber} | 25th ACCP 2026`, html: fullHtml };
}

// ============================================
// APPROVAL REQUEST LETTER (manual send only)
// Sent to paid attendees, with the invitation letter PDF attached.
// ============================================

const APPROVAL_REQUEST_PLAIN_TEXT = (recipientName: string) => `Dear ${recipientName},

Approval Request Letter

Following your successful registration for the ACCP 2026 conference and the subsequent issuance of your receipt and E-Ticket, the Organizing Committee is pleased to provide you with the official approval letter for your attendance at the said conference. Please find the details in the attached document.

Sincerely,
25th ACCP committee
Bangkok Thailand`;

export function buildApprovalRequestEmailContent(
  firstName: string,
  middleName: string | null,
  lastName: string,
): { subject: string; html: string } {
  const plainText = APPROVAL_REQUEST_PLAIN_TEXT(getFullName(firstName, middleName, lastName));
  return {
    subject: "Approval Request Letter - 25th ACCP 2026",
    html: buildEmailHtmlFromText(plainText),
  };
}

export async function sendApprovalRequestEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  attachment?: { pdf: Buffer; fileName: string },
): Promise<void> {
  const plainText = APPROVAL_REQUEST_PLAIN_TEXT(getFullName(firstName, middleName, lastName));
  const attachments: EmailAttachment[] | undefined = attachment
    ? [{ content: attachment.pdf, fileName: attachment.fileName }]
    : undefined;

  try {
    await sendNipaMailEmail(
      email,
      "Approval Request Letter - 25th ACCP 2026",
      plainText,
      attachments,
    );
    console.log(`Approval request email sent to ${email}${attachment ? " (with PDF)" : ""}`);
  } catch (error) {
    console.error("Error sending approval request email:", error);
    throw error;
  }
}

// ============================================
// LETTER OF ACCEPTANCE FOR ACADEMIC PAPER (manual send only)
// Sent to abstract authors with the type-specific acceptance letter PDF.
// ============================================

/**
 * Format the presentation type with the correct English indefinite article.
 * "oral"   → "an Oral"
 * "poster" → "a Poster"
 */
function formatPresentationTypeWithArticle(presentationType: string): string {
  const t = (presentationType ?? "").trim();
  if (!t) return "a Poster/Oral";
  const titled = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  const article = /^[aeiou]/i.test(titled) ? "an" : "a";
  return `${article} ${titled}`;
}

const ACADEMIC_ACCEPTANCE_PLAIN_TEXT = (recipientName: string, presentationType: string) => `Dear ${recipientName},

Letter of Acceptance for Academic Paper

The Subcommittee has successfully processed your academic submission through the peer-review process. The Organizing Committee is pleased to inform you that your work has been accepted for ${formatPresentationTypeWithArticle(presentationType)} presentation. Please find further details in the attached document.

To complete your registration and secure your right to present, we kindly request that you register and submit your payment via the website at https://accp2026bangkok.pharmacycouncil.org by May 31, 2026.

Please note that the Poster Template will be announced in due course.

Sincerely,
25th ACCP committee
Bangkok Thailand`;

export function buildAcademicAcceptanceEmailContent(
  firstName: string,
  middleName: string | null,
  lastName: string,
  presentationType: string,
): { subject: string; html: string } {
  const plainText = ACADEMIC_ACCEPTANCE_PLAIN_TEXT(
    getFullName(firstName, middleName, lastName),
    presentationType,
  );
  return {
    subject: "Letter of Acceptance for Academic Paper - 25th ACCP 2026",
    html: buildEmailHtmlFromText(plainText),
  };
}

export async function sendAcademicAcceptanceEmail(
  email: string,
  firstName: string,
  middleName: string | null,
  lastName: string,
  presentationType: string,
  attachment?: { pdf: Buffer; fileName: string },
): Promise<void> {
  const plainText = ACADEMIC_ACCEPTANCE_PLAIN_TEXT(
    getFullName(firstName, middleName, lastName),
    presentationType,
  );
  const attachments: EmailAttachment[] | undefined = attachment
    ? [{ content: attachment.pdf, fileName: attachment.fileName }]
    : undefined;

  try {
    await sendNipaMailEmail(
      email,
      "Letter of Acceptance for Academic Paper - 25th ACCP 2026",
      plainText,
      attachments,
    );
    console.log(`Academic acceptance email sent to ${email}${attachment ? " (with PDF)" : ""}`);
  } catch (error) {
    console.error("Error sending academic acceptance email:", error);
    throw error;
  }
}

/**
 * Send contact form email to conference organizers
 * Email will be sent to accpbangkok2026@gmail.com with Reply-To set to user's email
 */
export async function sendContactFormEmail(
  name: string,
  email: string,
  phone: string,
  subject: string,
  message: string
): Promise<void> {
  const targetEmail = process.env.CONTACT_FORM_EMAIL || "accpbangkok2026@gmail.com";

  const plainText = `
New Contact Form Submission

From: ${name}
Email: ${email}
Phone: ${phone || "Not provided"}

Subject: ${subject}

Message:
${message}

---
This message was sent via the ACCP 2026 website contact form.
  `.trim();

  try {
    await sendNipaMailEmail(targetEmail, `[Contact Form] ${subject}`, plainText);
    console.log(`Contact form email sent from ${email} to ${targetEmail}`);
  } catch (error) {
    console.error("Error sending contact form email:", error);
    throw error;
  }
}
