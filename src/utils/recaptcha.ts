/**
 * reCAPTCHA v2 Verification Utility
 */

interface RecaptchaResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  "error-codes"?: string[];
}

/**
 * Verify reCAPTCHA v2 token with Google
 * @param token - The reCAPTCHA token from client
 * @returns true if verification passes, false otherwise
 */
export async function verifyRecaptcha(token: string): Promise<boolean> {
  const secretKey = process.env.RECAPTCHA_SECRET_KEY;

  // If no secret key configured, skip verification (for development)
  if (!secretKey) {
    console.warn("RECAPTCHA_SECRET_KEY not configured - skipping verification");
    return true;
  }

  try {
    const response = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
      }
    );

    const data = (await response.json()) as RecaptchaResponse;

    if (!data.success) {
      console.warn("reCAPTCHA verification failed:", data["error-codes"]);
    }

    return data.success;
  } catch (error) {
    console.error("reCAPTCHA verification error:", error);
    return false;
  }
}

/**
 * Check if reCAPTCHA verification is enabled
 */
export function isRecaptchaEnabled(): boolean {
  return !!process.env.RECAPTCHA_SECRET_KEY;
}
