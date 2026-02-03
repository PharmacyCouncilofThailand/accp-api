import { z } from "zod";

// Valid abstract categories for reviewer assignment
const abstractCategoryEnum = z.enum([
  "clinical_pharmacy",
  "social_administrative",
  "community_pharmacy",
  "pharmacology_toxicology",
  "pharmacy_education",
  "digital_pharmacy",
]);

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(["admin", "organizer", "reviewer", "staff", "verifier"]),
  // For reviewers: categories they can review
  assignedCategories: z.array(abstractCategoryEnum).optional(),
});

export const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z
    .enum(["admin", "organizer", "reviewer", "staff", "verifier"])
    .optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).optional(),
  email: z.string().email().optional(),
  // For reviewers: categories they can review
  assignedCategories: z.array(abstractCategoryEnum).optional(),
});

export const assignEventSchema = z.object({
  eventIds: z.array(z.number()),
});
