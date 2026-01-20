// Custom API Error Classes

/**
 * Base API Error class with error code support
 */
export class ApiError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    statusCode: number = 400,
    details?: unknown
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON(): { success: boolean; code: string; error: string; details?: unknown } {
    const result: { success: boolean; code: string; error: string; details?: unknown } = {
      success: false,
      code: this.code,
      error: this.message,
    };
    if (this.details !== undefined) {
      result.details = this.details;
    }
    return result;
  }
}

// ============================================================================
// Authentication Errors
// ============================================================================

export class UnauthorizedError extends ApiError {
  constructor(message: string = "Unauthorized") {
    super("AUTH_UNAUTHORIZED", message, 401);
  }
}

export class InvalidCredentialsError extends ApiError {
  constructor() {
    super("AUTH_INVALID_CREDENTIALS", "Invalid email or password", 401);
  }
}

export class AccountPendingError extends ApiError {
  constructor() {
    super("AUTH_ACCOUNT_PENDING", "Account is pending approval", 403);
  }
}

export class AccountRejectedError extends ApiError {
  constructor() {
    super("AUTH_ACCOUNT_REJECTED", "Account has been rejected", 403);
  }
}

export class AccountDisabledError extends ApiError {
  constructor() {
    super("AUTH_ACCOUNT_DISABLED", "Account is disabled", 403);
  }
}

// ============================================================================
// Validation Errors
// ============================================================================

export class ValidationError extends ApiError {
  constructor(details: unknown) {
    super("VALIDATION_ERROR", "Invalid input", 400, details);
  }
}

// ============================================================================
// Resource Errors
// ============================================================================

export class NotFoundError extends ApiError {
  constructor(resource: string = "Resource") {
    super("NOT_FOUND", `${resource} not found`, 404);
  }
}

export class ConflictError extends ApiError {
  constructor(message: string = "Resource already exists") {
    super("CONFLICT", message, 409);
  }
}

// ============================================================================
// Server Errors
// ============================================================================

export class InternalServerError extends ApiError {
  constructor(message: string = "Internal server error") {
    super("INTERNAL_ERROR", message, 500);
  }
}

// ============================================================================
// Rate Limiting Errors
// ============================================================================

export class TooManyRequestsError extends ApiError {
  constructor() {
    super("RATE_LIMIT_EXCEEDED", "Too many requests. Please try again later.", 429);
  }
}
