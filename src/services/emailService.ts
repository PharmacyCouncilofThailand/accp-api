import axios from "axios";

// URL ของ ThaiBulkSMS Email API (อ้างอิงจากคู่มือ)
const THAIBULK_API_URL =
  "https://tbs-email-api-gateway.omb.to/email/v1/send_template";

/**
 * Helper function สำหรับส่งอีเมลผ่าน ThaiBulk API
 * รองรับการส่งแบบ Template พร้อมตัวแปร (Merge Tags)
 */
async function sendEmailViaThaiBulk(
  to: string,
  subject: string,
  templateId: string,
  variables: Record<string, any> = {},
): Promise<void> {
  const apiKey = process.env.THAIBULK_API_KEY;
  const apiSecret = process.env.THAIBULK_API_SECRET;

  // ใช้ EMAIL_FROM ใน .env หรือค่า default
  const fromEmailEnv =
    process.env.EMAIL_FROM || "ACCP Conference <info@accp2026.com>";

  if (!apiKey || !apiSecret) {
    throw new Error(
      "THAIBULK_API_KEY or THAIBULK_API_SECRET not configured in .env",
    );
  }

  // แยกชื่อและอีเมลผู้ส่ง (รองรับ format "Name <email>")
  let fromName = "ACCP Conference";
  let fromAddress = fromEmailEnv;
  const match = fromEmailEnv.match(/(.*)<(.+)>/);
  if (match) {
    fromName = match[1].trim();
    fromAddress = match[2].trim();
  }

  try {
    // สร้าง Payload ตามเอกสาร ThaiBulk หน้า 11
    const payload = {
      template_id: templateId,
      mail_from: fromAddress,
      name: fromName,
      mail_to: to,
      subject: subject,
      ...variables, // Spread ตัวแปรต่างๆ ลงไปใน root level ของ JSON ตามที่ API ต้องการ
    };

    // สร้าง Authorization Header แบบ Basic Auth
    const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

    const response = await axios.post(THAIBULK_API_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
    });

    console.log(
      `Email sent via ThaiBulk to ${to} (Message ID: ${response.data.message_id})`,
    );
  } catch (error: any) {
    // Log Error อย่างละเอียดเพื่อการ Debug
    console.error(
      "Error sending email via ThaiBulk:",
      error?.response?.data || error.message,
    );
    if (error?.response?.data) {
      console.error(
        "ThaiBulk Error Detail:",
        JSON.stringify(error.response.data, null, 2),
      );
    }
    throw error;
  }
}

/**
 * Send abstract submission confirmation email to main author
 */
export async function sendAbstractSubmissionEmail(
  email: string,
  firstName: string,
  lastName: string,
  abstractId: number,
  abstractTitle: string,
): Promise<void> {
  // รับ ID จาก .env ถ้าไม่มีจะ Error เตือน
  const templateId = process.env.THAIBULK_TEMPLATE_ID_SUBMISSION;
  if (!templateId)
    throw new Error("Missing THAIBULK_TEMPLATE_ID_SUBMISSION in .env");

  await sendEmailViaThaiBulk(
    email,
    "Abstract Submission Confirmation - ACCP 2026",
    templateId,
    {
      firstName,
      lastName,
      // จัดรูปแบบ ID ให้สวยงามก่อนส่งไปแสดงผล
      abstractId: `ACCP2026-${abstractId}`,
      abstractTitle,
      reviewDeadline: "April 10, 2026",
    },
  );
}

/**
 * Send abstract submission notification to co-author
 */
export async function sendCoAuthorNotificationEmail(
  email: string,
  firstName: string,
  lastName: string,
  mainAuthorName: string,
  abstractId: number,
  abstractTitle: string,
): Promise<void> {
  const templateId = process.env.THAIBULK_TEMPLATE_ID_COAUTHOR;
  if (!templateId)
    throw new Error("Missing THAIBULK_TEMPLATE_ID_COAUTHOR in .env");

  await sendEmailViaThaiBulk(
    email,
    "You've been added as Co-Author - ACCP 2026 Abstract",
    templateId,
    {
      firstName,
      lastName,
      mainAuthorName,
      abstractId: `ACCP2026-${abstractId}`,
      abstractTitle,
      announceDate: "April 10, 2026",
    },
  );
}

/**
 * Send pending approval email to students (thstd, interstd)
 * Called after successful registration
 */
export async function sendPendingApprovalEmail(
  email: string,
  firstName: string,
  lastName: string,
): Promise<void> {
  const templateId = process.env.THAIBULK_TEMPLATE_ID_PENDING;
  if (!templateId)
    throw new Error("Missing THAIBULK_TEMPLATE_ID_PENDING in .env");

  await sendEmailViaThaiBulk(
    email,
    "Registration Received - Pending Verification",
    templateId,
    {
      firstName,
      lastName,
    },
  );
}

/**
 * Send approval email to students
 * Called after backoffice approval
 */
export async function sendVerificationApprovedEmail(
  email: string,
  firstName: string,
): Promise<void> {
  const templateId = process.env.THAIBULK_TEMPLATE_ID_APPROVED;
  if (!templateId)
    throw new Error("Missing THAIBULK_TEMPLATE_ID_APPROVED in .env");

  const loginUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/login`
    : "http://localhost:3000/login";

  await sendEmailViaThaiBulk(
    email,
    "Account Approved - ACCP Conference 2026",
    templateId,
    {
      firstName,
      loginUrl, // ส่ง URL เต็มไปให้ปุ่มใน Template ลิงก์ไป
    },
  );
}

/**
 * Send password reset email
 */
export async function sendPasswordResetEmail(
  email: string,
  firstName: string,
  resetToken: string,
): Promise<void> {
  const templateId = process.env.THAIBULK_TEMPLATE_ID_RESET_PASSWORD;
  if (!templateId)
    throw new Error("Missing THAIBULK_TEMPLATE_ID_RESET_PASSWORD in .env");

  const resetUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/reset-password?token=${resetToken}`
    : `http://localhost:3000/reset-password?token=${resetToken}`;

  await sendEmailViaThaiBulk(
    email,
    "Reset Your Password - ACCP Conference 2026",
    templateId,
    {
      firstName,
      resetUrl, // ส่ง URL เต็มไปให้ปุ่มใน Template ลิงก์ไป
    },
  );
}
