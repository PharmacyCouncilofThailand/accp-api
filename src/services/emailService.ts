import axios from "axios";

// URL ของ ThaiBulkSMS Email API (อ้างอิงจากคู่มือ)
const THAIBULK_API_URL = "https://email-api.thaibulksms.com/email/v1/send_template";

/**
 * Helper function สำหรับส่งอีเมลผ่าน ThaiBulk API
 * รองรับการส่งแบบ Template พร้อมตัวแปร (Merge Tags)
 */
async function sendEmailViaThaiBulk(
  to: string,
  subject: string,
  templateUuid: string,
  variables: Record<string, any> = {},
): Promise<any> {
  const apiKey = process.env.THAIBULK_API_KEY;
  const apiSecret = process.env.THAIBULK_API_SECRET;

  // ใช้ EMAIL_FROM ใน .env หรือค่า default
  const fromEmailEnv =
    process.env.EMAIL_FROM || "ACCP Conference <no-reply@test-resend.jo3.org>";

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
    // แปลง variables เป็น UPPERCASE keys ตามที่ API ต้องการ
    const uppercaseVariables: Record<string, any> = {};
    Object.keys(variables).forEach(key => {
      uppercaseVariables[key.toUpperCase()] = variables[key];
    });

    // สร้าง Payload ตาม OpenAPI Specification อย่างถูกต้อง
    const payload = {
      template_uuid: templateUuid,
      mail_from: {
        email: fromAddress,
        name: fromName  // optional แต่ควรใส่
      },
      mail_to: {
        email: to  // เป็น object เดี่ยว ไม่ใช่ array!
      },
      subject: subject,
      payload: uppercaseVariables, // Merge tags ต้องเป็น UPPERCASE
    };

    // สำหรับ debug
    console.log("📤 Sending email payload:", JSON.stringify(payload, null, 2));

    // สร้าง Authorization Header แบบ Basic Auth
    const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

    const response = await axios.post(THAIBULK_API_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
        "User-Agent": "ACCP-API/1.0",
      },
      timeout: 15000,
    });

    console.log(
      `✅ Email sent successfully to ${to}`,
      `Message ID: ${response.data.message_id}`,
      `Credit remaining: ${response.data.credit_remain}`,
    );
    
    return response.data;
  } catch (error: any) {
    console.error("\n❌ Error sending email via ThaiBulk:");
    
    if (error?.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data, null, 2)}`);
      
      // แสดง error ตามประเภท
      switch (error.response.status) {
        case 400:
          console.error("🔄 Bad Request - ตรวจสอบข้อมูลที่ส่ง (UUID, email format, etc.)");
          break;
        case 401:
          console.error("🔑 Authentication Failed - ตรวจสอบ API Key/Secret");
          break;
        case 402:
          console.error("💰 Insufficient Credit - เครดิตไม่พอ");
          break;
        case 404:
          console.error("🔍 Not Found - Template หรือ Sender ไม่พบ");
          break;
        case 429:
          console.error("⏰ Rate Limit Exceeded - รอสักครู่แล้วลองใหม่");
          break;
        case 500:
          console.error("🚨 Internal Server Error - Server ของ ThaiBulk มีปัญหา");
          break;
      }
    } else if (error?.request) {
      console.error("📡 No response received - ตรวจสอบ network connection");
    } else {
      console.error("💥 Error:", error.message);
    }
    
    // แสดง payload ที่ส่ง
    if (error?.config?.data) {
      try {
        console.error("\n📦 Last attempted payload:");
        console.error(JSON.stringify(JSON.parse(error.config.data), null, 2));
      } catch (e) {
        console.error("📦 Last attempted payload (raw):", error.config.data);
      }
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
  const templateUuid = process.env.THAIBULK_TEMPLATE_UUID_SUBMISSION;
  if (!templateUuid)
    throw new Error("Missing THAIBULK_TEMPLATE_UUID_SUBMISSION in .env");

  await sendEmailViaThaiBulk(
    email,
    "Abstract Submission Confirmation - ACCP 2026",
    templateUuid,
    {
      FIRST_NAME: firstName,
      LAST_NAME: lastName,
      ABSTRACT_ID: `ACCP2026-${abstractId}`,
      ABSTRACT_TITLE: abstractTitle,
      REVIEW_DEADLINE: "April 10, 2026",
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
  const templateUuid = process.env.THAIBULK_TEMPLATE_UUID_COAUTHOR;
  if (!templateUuid)
    throw new Error("Missing THAIBULK_TEMPLATE_UUID_COAUTHOR in .env");

  await sendEmailViaThaiBulk(
    email,
    "You've been added as Co-Author - ACCP 2026 Abstract",
    templateUuid,
    {
      FIRST_NAME: firstName,
      LAST_NAME: lastName,
      MAIN_AUTHOR_NAME: mainAuthorName,
      ABSTRACT_ID: `ACCP2026-${abstractId}`,
      ABSTRACT_TITLE: abstractTitle,
      ANNOUNCE_DATE: "April 10, 2026",
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
  const templateUuid = process.env.THAIBULK_TEMPLATE_UUID_PENDING;
  if (!templateUuid)
    throw new Error("Missing THAIBULK_TEMPLATE_UUID_PENDING in .env");

  await sendEmailViaThaiBulk(
    email,
    "Registration Received - Pending Verification",
    templateUuid,
    {
      FIRST_NAME: firstName,
      LAST_NAME: lastName,
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
  const templateUuid = process.env.THAIBULK_TEMPLATE_UUID_APPROVED;
  if (!templateUuid)
    throw new Error("Missing THAIBULK_TEMPLATE_UUID_APPROVED in .env");

  const loginUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/login`
    : "http://localhost:3000/login";

  await sendEmailViaThaiBulk(
    email,
    "Account Approved - ACCP Conference 2026",
    templateUuid,
    {
      FIRST_NAME: firstName,
      LOGIN_URL: loginUrl,
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
  const templateUuid = process.env.THAIBULK_TEMPLATE_UUID_RESET_PASSWORD;
  if (!templateUuid)
    throw new Error("Missing THAIBULK_TEMPLATE_UUID_RESET_PASSWORD in .env");

  const resetUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/reset-password?token=${resetToken}`
    : `http://localhost:3000/reset-password?token=${resetToken}`;

  await sendEmailViaThaiBulk(
    email,
    "Reset Your Password - ACCP Conference 2026",
    templateUuid,
    {
      FIRST_NAME: firstName,
      RESET_URL: resetUrl,
    },
  );
}

/**
 * Send custom email using template
 */
export async function sendCustomEmail(
  to: string,
  subject: string,
  templateUuid: string,
  variables: Record<string, any> = {},
): Promise<any> {
  if (!templateUuid) {
    throw new Error("Template UUID is required");
  }

  return await sendEmailViaThaiBulk(to, subject, templateUuid, variables);
}

/**
 * Function สำหรับเช็คเครดิตคงเหลือ
 */
export async function checkEmailCredit(): Promise<number> {
  const apiKey = process.env.THAIBULK_API_KEY;
  const apiSecret = process.env.THAIBULK_API_SECRET;

  if (!apiKey || !apiSecret) {
    throw new Error(
      "THAIBULK_API_KEY or THAIBULK_API_SECRET not configured in .env",
    );
  }

  try {
    const authHeader = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
    
    const response = await axios.get("https://email-api.thaibulksms.com/email/v1/credit", {
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
    });

    console.log(`📧 Email credit remaining: ${response.data.credit_remain}`);
    return response.data.credit_remain;
  } catch (error: any) {
    console.error("❌ Error checking email credit:", error?.response?.data || error.message);
    throw error;
  }
}

/**
 * Test function สำหรับทดสอบการส่งอีเมล
 */
export async function testEmailService(
  testEmail: string = "test@example.com"
): Promise<boolean> {
  console.log("🧪 Testing email service...");
  
  try {
    // ตรวจสอบเครดิตก่อน
    const credit = await checkEmailCredit();
    console.log(`💰 Credit available: ${credit}`);
    
    if (credit <= 0) {
      console.error("❌ Insufficient email credit");
      return false;
    }

    // ทดสอบส่งอีเมล (ใช้ template ที่มีอยู่)
    const templateUuid = process.env.THAIBULK_TEMPLATE_UUID_APPROVED;
    if (!templateUuid) {
      console.error("❌ No test template configured");
      return false;
    }

    console.log(`📧 Testing email to: ${testEmail}`);
    console.log(`🔑 Using template UUID: ${templateUuid}`);
    
    const result = await sendEmailViaThaiBulk(
      testEmail,
      "Test Email - ACCP Conference 2026",
      templateUuid,
      {
        FIRST_NAME: "Test",
        LOGIN_URL: "https://localhost:3000/login",
      }
    );
    
    console.log("✅ Email test completed successfully");
    console.log(`📝 Message ID: ${result.message_id}`);
    return true;
  } catch (error) {
    console.error("❌ Email test failed:", error);
    return false;
  }
}

/**
 * Validate email address format
 */
export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Get email service status
 */
export async function getEmailServiceStatus(): Promise<{
  credit: number;
  apiKeyConfigured: boolean;
  templates: Record<string, boolean>;
}> {
  const apiKeyConfigured = !!(process.env.THAIBULK_API_KEY && process.env.THAIBULK_API_SECRET);
  
  let credit = 0;
  const templates: Record<string, boolean> = {
    submission: !!process.env.THAIBULK_TEMPLATE_UUID_SUBMISSION,
    coauthor: !!process.env.THAIBULK_TEMPLATE_UUID_COAUTHOR,
    pending: !!process.env.THAIBULK_TEMPLATE_UUID_PENDING,
    approved: !!process.env.THAIBULK_TEMPLATE_UUID_APPROVED,
    resetPassword: !!process.env.THAIBULK_TEMPLATE_UUID_RESET_PASSWORD,
  };

  try {
    if (apiKeyConfigured) {
      credit = await checkEmailCredit();
    }
  } catch (error) {
    console.error("Failed to check credit:", error);
  }

  return {
    credit,
    apiKeyConfigured,
    templates,
  };
}