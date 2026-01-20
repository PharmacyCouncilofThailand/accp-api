// Authentication Constants

/**
 * Number of bcrypt rounds for password hashing.
 * Higher = more secure but slower.
 * 12 is recommended for production.
 */
export const BCRYPT_ROUNDS = 12;

/**
 * JWT token expiration time
 */
export const JWT_EXPIRY = "7d";

/**
 * Session expiration time (in milliseconds)
 */
export const SESSION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
