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
});

export const loginBodySchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export type RegisterInput = z.infer<typeof registerBodySchema>;
// export const registerSchema ... (removed wrapper to simplify manual usage)
