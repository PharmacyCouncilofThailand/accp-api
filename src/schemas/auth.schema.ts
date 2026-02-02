import { z } from "zod";

export const registerBodySchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  accountType: z.enum([
    "thaiStudent",
    "internationalStudent",
    "thaiProfessional",
    "internationalProfessional",
  ]),
  organization: z.string().optional(),
  idCard: z.string().length(13, "Thai ID Card must be 13 digits").optional(),
  passportId: z.string().min(1, "Passport ID is required for international users").optional(),
  pharmacyLicenseId: z.string().optional(),
  country: z.string().optional(),
  phone: z.string().optional(),
  verificationDocUrl: z.string().optional(),
  recaptchaToken: z.string().optional(),
});

export const loginBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
  recaptchaToken: z.string().optional(),
});

export type RegisterInput = z.infer<typeof registerBodySchema>;

// Forgot Password Schema
export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

// Reset Password Schema
export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  newPassword: z.string().min(6, "Password must be at least 6 characters"),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
