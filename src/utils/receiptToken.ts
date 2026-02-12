import crypto from "crypto";

const TOKEN_PREFIX = "receipt";

/**
 * Get the secret used for HMAC signing.
 * Uses JWT_SECRET with a namespace prefix to avoid collision.
 */
function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }
  return secret;
}

/**
 * Generate a signed receipt token for a given orderId.
 * Format: {orderId}.{hmac_hex}
 * No expiry — receipts should be downloadable forever.
 */
export function generateReceiptToken(orderId: number): string {
  const payload = `${TOKEN_PREFIX}:${orderId}`;
  const signature = crypto
    .createHmac("sha256", getSecret())
    .update(payload)
    .digest("hex");
  return `${orderId}.${signature}`;
}

/**
 * Verify a receipt token and extract the orderId.
 * Returns the orderId if valid, null if invalid.
 */
export function verifyReceiptToken(token: string): number | null {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return null;

  const idStr = token.substring(0, dotIndex);
  const signature = token.substring(dotIndex + 1);

  const orderId = parseInt(idStr, 10);
  if (isNaN(orderId) || orderId <= 0) return null;

  const expectedPayload = `${TOKEN_PREFIX}:${orderId}`;
  const expectedSignature = crypto
    .createHmac("sha256", getSecret())
    .update(expectedPayload)
    .digest("hex");

  // Constant-time comparison to prevent timing attacks
  if (signature.length !== expectedSignature.length) return null;

  const sigBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expectedSignature, "hex");

  if (sigBuffer.length !== expectedBuffer.length) return null;

  if (!crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;

  return orderId;
}
