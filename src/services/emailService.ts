import { Resend } from "resend";

// Lazy Resend initialization
let resendClient: Resend | null = null;

function getResendClient(): Resend {
  if (!resendClient) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error(
        "RESEND_API_KEY not configured. Set RESEND_API_KEY in .env"
      );
    }
    resendClient = new Resend(process.env.RESEND_API_KEY);
  }
  return resendClient;
}

/**
 * Get the sender email address
 * Uses EMAIL_FROM or falls back to Resend's testing domain
 */
function getFromEmail(): string {
  return process.env.EMAIL_FROM || "ACCP Conference <onboarding@resend.dev>";
}

/**
 * Send abstract submission confirmation email to main author
 */
export async function sendAbstractSubmissionEmail(
  email: string,
  firstName: string,
  lastName: string,
  abstractId: number,
  abstractTitle: string
): Promise<void> {
  try {
    const { error } = await getResendClient().emails.send({
      from: getFromEmail(),
      to: [email],
      subject: "Abstract Submission Confirmation - ACCP 2026",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #1a237e; margin-bottom: 10px;">ACCP 2026</h1>
            <p style="color: #666; font-size: 16px;">Asian Conference on Clinical Pharmacy</p>
          </div>
          
          <div style="background: #f8f9fa; border-radius: 12px; padding: 30px; margin-bottom: 30px;">
            <h2 style="color: #1a1a1a; font-size: 24px; margin-bottom: 20px;">✅ Abstract Submitted Successfully!</h2>
            
            <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
              Dear <strong>${firstName} ${lastName}</strong>,
            </p>
            
            <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
              Thank you for submitting your abstract to ACCP 2026. We have received your submission successfully.
            </p>
            
            <div style="background: #fff; border-left: 4px solid #FFBA00; padding: 20px; margin: 20px 0; border-radius: 8px;">
              <p style="margin: 0; color: #666; font-size: 14px; margin-bottom: 8px;"><strong>Tracking ID:</strong></p>
              <p style="margin: 0; color: #1a237e; font-size: 20px; font-weight: bold;">ACCP2026-${abstractId}</p>
              
              <p style="margin: 15px 0 0 0; color: #666; font-size: 14px;"><strong>Abstract Title:</strong></p>
              <p style="margin: 5px 0 0 0; color: #333; font-size: 16px;">${abstractTitle}</p>
            </div>
            
            <div style="background: #fff3cd; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <p style="color: #856404; font-size: 16px; line-height: 1.6; margin: 0;">
                📅 <strong>Review Deadline:</strong> April 10, 2026<br/>
                You will receive notification about the selection results on this date.
              </p>
            </div>
            
            <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
              Our review committee will carefully evaluate your submission. Please keep this email for your records.
            </p>
          </div>
          
          <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px;">
            <p style="color: #666; font-size: 14px; margin: 0;">
              If you have any questions, please contact us at <a href="mailto:info@accp2026.com" style="color: #1a237e;">info@accp2026.com</a>
            </p>
          </div>
          
          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
            <p style="color: #999; font-size: 12px; margin: 0;">
              © 2026 ACCP Conference. All rights reserved.
            </p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error("Error sending abstract submission email:", error);
      throw error;
    }
    console.log(`Abstract submission email sent to ${email}`);
  } catch (error) {
    console.error("Error sending abstract submission email:", error);
    throw error;
  }
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
  abstractTitle: string
): Promise<void> {
  try {
    const { error } = await getResendClient().emails.send({
      from: getFromEmail(),
      to: [email],
      subject: "You've been added as Co-Author - ACCP 2026 Abstract",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #1a237e; margin-bottom: 10px;">ACCP 2026</h1>
            <p style="color: #666; font-size: 16px;">Asian Conference on Clinical Pharmacy</p>
          </div>
          
          <div style="background: #f8f9fa; border-radius: 12px; padding: 30px; margin-bottom: 30px;">
            <h2 style="color: #1a1a1a; font-size: 24px; margin-bottom: 20px;">🤝 Co-Author Notification</h2>
            
            <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
              Dear <strong>${firstName} ${lastName}</strong>,
            </p>
            
            <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
              You have been listed as a co-author on an abstract submitted to ACCP 2026 by <strong>${mainAuthorName}</strong>.
            </p>
            
            <div style="background: #fff; border-left: 4px solid #FFBA00; padding: 20px; margin: 20px 0; border-radius: 8px;">
              <p style="margin: 0; color: #666; font-size: 14px; margin-bottom: 8px;"><strong>Tracking ID:</strong></p>
              <p style="margin: 0; color: #1a237e; font-size: 20px; font-weight: bold;">ACCP2026-${abstractId}</p>
              
              <p style="margin: 15px 0 0 0; color: #666; font-size: 14px;"><strong>Abstract Title:</strong></p>
              <p style="margin: 5px 0 0 0; color: #333; font-size: 16px;">${abstractTitle}</p>
            </div>
            
            <div style="background: #e8f5e9; border-radius: 8px; padding: 20px; margin: 20px 0;">
              <p style="color: #2e7d32; font-size: 16px; line-height: 1.6; margin: 0;">
                ✅ <strong>Abstract Submitted Successfully</strong><br/>
                The review results will be announced on <strong>April 10, 2026</strong>
              </p>
            </div>
            
            <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
              Please keep this email for your records. If you have any questions about this submission, please contact the main author directly.
            </p>
          </div>
          
          <div style="text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px;">
            <p style="color: #666; font-size: 14px; margin: 0;">
              Questions? Contact us at <a href="mailto:info@accp2026.com" style="color: #1a237e;">info@accp2026.com</a>
            </p>
          </div>
          
          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
            <p style="color: #999; font-size: 12px; margin: 0;">
              © 2026 ACCP Conference. All rights reserved.
            </p>
          </div>
        </div>
      `,
    });

    if (error) {
      console.error("Error sending co-author notification email:", error);
      throw error;
    }
    console.log(`Co-author notification email sent to ${email}`);
  } catch (error) {
    console.error("Error sending co-author notification email:", error);
    throw error;
  }
}



/**
 * Send pending approval email to students (thstd, interstd)
 * Called after successful registration
 */
export async function sendPendingApprovalEmail(
  email: string,
  firstName: string,
  lastName: string
): Promise<void> {
  const { error } = await getResendClient().emails.send({
    from: getFromEmail(),
    to: [email],
    subject: "Registration Received - Pending Verification",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #2563eb;">Thank you for registering!</h2>
        <p>Dear ${firstName} ${lastName},</p>
        <p>We have received your registration request for <strong>ACCP Conference 2026</strong>.</p>
        <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0;">
          <strong>Your account is currently pending verification.</strong>
          <p style="margin: 10px 0 0 0;">Our team will review your submitted documents and verify your student status.</p>
        </div>
        <p>You will receive another email once your account has been approved.</p>
        <p>This process typically takes <strong>5-7 business days</strong>.</p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;"/>
        <p style="color: #6b7280; font-size: 14px;">
          If you have any questions, please contact us at <a href="mailto:support@accp.com">support@accp.com</a>
        </p>
        <p style="color: #374151;">Best regards,<br/><strong>ACCP Conference Team</strong></p>
      </div>
    `,
  });

  if (error) {
    console.error("Error sending pending approval email:", error);
    throw error;
  }
}

/**
 * Send approval email to students
 * Called after backoffice approval
 */
export async function sendVerificationApprovedEmail(
  email: string,
  firstName: string
): Promise<void> {
  const loginUrl = process.env.BASE_URL
    ? `${process.env.BASE_URL}/login`
    : "http://localhost:3000/login";

  const { error } = await getResendClient().emails.send({
    from: getFromEmail(),
    to: [email],
    subject: "Account Approved - ACCP Conference 2026",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #10b981;">Verification Successful!</h2>
        <p>Dear ${firstName},</p>
        <p>Great news! Your student documents have been verified and your account is now <strong>active</strong>.</p>
        <p>You can now log in to access your dashboard and complete your registration payment.</p>
        
        <div style="margin: 30px 0; text-align: center;">
          <a href="${loginUrl}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Login to Your Account</a>
        </div>

        <p>If the button doesn't work, copy and paste this link into your browser:</p>
        <p style="color: #6b7280; word-break: break-all;">${loginUrl}</p>

        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;"/>
        <p style="color: #374151;">Best regards,<br/><strong>ACCP Conference Team</strong></p>
      </div>
    `,
  });

  if (error) {
    console.error("Error sending verification approved email:", error);
    throw error;
  }
}

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

  const { error } = await getResendClient().emails.send({
    from: getFromEmail(),
    to: [email],
    subject: "Reset Your Password - ACCP Conference 2026",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #1a237e; margin-bottom: 10px;">ACCP 2026</h1>
          <p style="color: #666; font-size: 16px;">Password Reset Request</p>
        </div>
        
        <div style="background: #f8f9fa; border-radius: 12px; padding: 30px; margin-bottom: 30px;">
          <h2 style="color: #1a1a1a; font-size: 20px; margin-bottom: 20px;">🔐 Reset Your Password</h2>
          
          <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 15px;">
            Dear <strong>${firstName}</strong>,
          </p>
          
          <p style="color: #333; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
            We received a request to reset your password. Click the button below to create a new password:
          </p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="background-color: #1a237e; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
              Reset Password
            </a>
          </div>
          
          <div style="background: #fff3cd; border-radius: 8px; padding: 15px; margin: 20px 0;">
            <p style="color: #856404; font-size: 14px; line-height: 1.6; margin: 0;">
              ⏰ <strong>This link will expire in 1 hour.</strong><br/>
              If you didn't request this, please ignore this email.
            </p>
          </div>
          
          <p style="color: #666; font-size: 14px; line-height: 1.6; margin-top: 20px;">
            If the button doesn't work, copy and paste this link into your browser:<br/>
            <a href="${resetUrl}" style="color: #1a237e; word-break: break-all;">${resetUrl}</a>
          </p>
        </div>
        
        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
          <p style="color: #999; font-size: 12px; margin: 0;">
            © 2026 ACCP Conference. All rights reserved.
          </p>
        </div>
      </div>
    `,
  });

  if (error) {
    console.error("Error sending password reset email:", error);
    throw error;
  }
  console.log(`Password reset email sent to ${email}`);
}
