import axios from "axios";

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
 * Send email via NipaMail API
 */
async function sendNipaMailEmail(
  recipient: string,
  subject: string,
  text: string,
  retryOnAuth: boolean = true
): Promise<void> {
  const token = await getAccessToken();

  // Convert plain text newlines to HTML line breaks for proper display
  const htmlContent = text.replace(/\n/g, '<br>\n');

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
      return sendNipaMailEmail(recipient, subject, text, false);
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
  return process.env.BASE_URL || "https://accp2026.com";
}

/**
 * Get the contact email
 */
function getContactEmail(): string {
  return process.env.CONTACT_EMAIL || "info@accp2026.com";
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
  abstractId: number,
  abstractTitle: string
): Promise<void> {
  const contactEmail = getContactEmail();

  const plainText = `
Thank you for submitting the abstract for the poster or oral presentation at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

We have already received your abstract and will notify you of the result of the abstract acceptance within 2 weeks after abstract submission.

Tracking ID: ACCP2026-${abstractId}
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
  lastName: string,
  mainAuthorName: string,
  abstractId: number,
  abstractTitle: string
): Promise<void> {
  const plainText = `
Dear ${firstName} ${lastName},

We would like to notify you that your co-authored abstract, titled "${abstractTitle}", has been submitted to the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

Tracking ID: ACCP2026-${abstractId}
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
  lastName: string,
  abstractTitle: string
): Promise<void> {
  const websiteUrl = getWebsiteUrl();
  const contactEmail = getContactEmail();

  const plainText = `
Dear ${firstName} ${lastName},

Congratulations! Your abstract, titled "${abstractTitle}", is ACCEPTED as a POSTER PRESENTATION at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

All poster presenters must be registered for the meeting in order to present their poster. For registration information and details go to ${websiteUrl}

We look forward to your presentation. If you have any questions, please contact ${contactEmail}

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Congratulations! Abstract Accepted (Poster) - 25th ACCP 2026", plainText);
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
  lastName: string,
  abstractTitle: string
): Promise<void> {
  const websiteUrl = getWebsiteUrl();
  const contactEmail = getContactEmail();

  const plainText = `
Dear ${firstName} ${lastName},

Congratulations! Your abstract, titled "${abstractTitle}", is ACCEPTED as an ORAL PRESENTATION at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

All oral presenters must be registered for the meeting in order to present. For registration information and details go to ${websiteUrl}

We look forward to your presentation. If you have any questions, please contact ${contactEmail}

Sincerely,
25th ACCP committee
Bangkok Thailand
  `.trim();

  try {
    await sendNipaMailEmail(email, "Congratulations! Abstract Accepted (Oral) - 25th ACCP 2026", plainText);
    console.log(`Abstract accepted (oral) email sent to ${email}`);
  } catch (error) {
    console.error("Error sending abstract accepted oral email:", error);
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
  lastName: string,
  abstractTitle: string
): Promise<void> {
  const plainText = `
Dear ${firstName} ${lastName},

Thank you very much for submitting your abstract for poster or oral presentation at the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. Unfortunately, there are many high-quality abstracts, but we still have limited availability for poster or oral presentations.

Abstract Title: ${abstractTitle}

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
  lastName: string
): Promise<void> {
  const plainText = `
Dear ${firstName} ${lastName},

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
  firstName: string
): Promise<void> {
  const loginUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/login`
    : "http://localhost:3000/login";

  const plainText = `
Dear ${firstName},

Thank you for your registration for the 25th ASIAN CONFERENCE ON CLINICAL PHARMACY. The meeting will take place July 9-11, 2026, at Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand.

For the student registration fee, we have to check the documents to verify that they are students. Your document has been approved, so your registration has already confirmed.

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
  lastName: string,
  rejectionReason?: string
): Promise<void> {
  const reasonText = rejectionReason ? `\nReason: ${rejectionReason}\n` : '';

  const plainText = `
Dear ${firstName} ${lastName},

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
 * Send signup notification email (for non-student users)
 * Template: Sign up notification
 */
export async function sendSignupNotificationEmail(
  email: string,
  firstName: string,
  lastName: string
): Promise<void> {
  const websiteUrl = getWebsiteUrl();

  const plainText = `
Dear ${firstName} ${lastName},

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
  lastName: string
): Promise<void> {
  const websiteUrl = getWebsiteUrl();

  const plainText = `
Dear ${firstName} ${lastName},

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
  const resetUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/reset-password?token=${resetToken}`
    : `http://localhost:3000/reset-password?token=${resetToken}`;

  const plainText = `
Dear ${firstName},

We received a request to reset your password for your 25th ACCP 2026 account.

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
// CONTACT FORM EMAIL
// ============================================

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
