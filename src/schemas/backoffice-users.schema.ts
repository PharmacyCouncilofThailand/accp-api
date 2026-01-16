import { z } from "zod";

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(["admin", "organizer", "reviewer", "staff", "verifier"]),
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
});

export const assignEventSchema = z.object({
  eventIds: z.array(z.number()),
});
