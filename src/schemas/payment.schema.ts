import { z } from "zod";

export const createPaymentIntentSchema = z.object({
  packageId: z.string().min(1, "Package ID is required"),
  addOnIds: z.array(z.string()).optional().default([]),
  currency: z.enum(["THB", "USD"]),
  paymentMethod: z.enum(["qr", "card"]).optional().default("card"),
  promoCode: z.string().optional(),
});

export type CreatePaymentIntentBody = z.infer<typeof createPaymentIntentSchema>;
