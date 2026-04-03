/**
 * Cloudflare Turnstile Verification Utility
 * (Replaces Google reCAPTCHA v2 — works in China and worldwide)
 */

interface TurnstileResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  "error-codes"?: string[];
  action?: string;
  cdata?: string;
}

/**
 * Get the Turnstile secret key from environment.
 * Supports TURNSTILE_SECRET_KEY (preferred) with RECAPTCHA_SECRET_KEY as fallback.
 */
function getSecretKey(): string | undefined {
  return process.env.TURNSTILE_SECRET_KEY || process.env.RECAPTCHA_SECRET_KEY;
}

/**
 * Verify Cloudflare Turnstile token
 * @param token - The Turnstile token from client
 * @returns true if verification passes, false otherwise
 */
export async function verifyRecaptcha(token: string): Promise<boolean> {
  const secretKey = getSecretKey();

  // If no secret key configured, skip verification (for development)
  if (!secretKey) {
    console.warn("TURNSTILE_SECRET_KEY not configured - skipping verification");
    return true;
  }

  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
      }
    );

    const data = (await response.json()) as TurnstileResponse;

    if (!data.success) {
      console.warn("Turnstile verification failed:", data["error-codes"]);
    }

    return data.success;
  } catch (error) {
    console.error("Turnstile verification error:", error);
    return false;
  }
}

/**
 * Check if CAPTCHA verification is enabled
 */
export function isRecaptchaEnabled(): boolean {
  return !!getSecretKey();
}
