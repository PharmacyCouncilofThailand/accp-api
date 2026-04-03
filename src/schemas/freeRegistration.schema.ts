import { z } from "zod";

export const freeRegistrationSchema = z.object({
  eventId: z.coerce.number().int().positive(),
  packageId: z.string().min(1, "Package ID is required"),
});

export type FreeRegistrationBody = z.infer<typeof freeRegistrationSchema>;
