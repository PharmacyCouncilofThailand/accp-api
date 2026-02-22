import { z } from "zod";

export const createPaymentIntentSchema = z.object({
  packageId: z.string().optional().default(""),
  addOnIds: z.array(z.string()).optional().default([]),
  currency: z.enum(["THB", "USD"]),
  paymentMethod: z.enum(["qr", "card"]).optional().default("card"),
  promoCode: z.string().optional(),
  workshopSessionId: z.number().int().positive().optional(),
  needTaxInvoice: z.boolean().optional().default(false),
  taxName: z.string().trim().max(200).optional(),
  taxId: z
    .string()
    .trim()
    .regex(/^\d{13}$/)
    .optional(),
  taxAddress: z.string().trim().max(500).optional(),
  taxSubDistrict: z.string().trim().max(100).optional(),
  taxDistrict: z.string().trim().max(100).optional(),
  taxProvince: z.string().trim().max(100).optional(),
  taxPostalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/)
    .optional(),
}).superRefine((data, ctx) => {
  if (!data.needTaxInvoice) return;

  if (!data.taxName?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxName"],
      message: "Name / Company is required when tax invoice is requested",
    });
  }

  if (!data.taxId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxId"],
      message: "Tax ID is required when tax invoice is requested",
    });
  }

  if (!data.taxAddress?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxAddress"],
      message: "Address is required when tax invoice is requested",
    });
  }

  if (!data.taxSubDistrict?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxSubDistrict"],
      message: "Sub-district is required when tax invoice is requested",
    });
  }

  if (!data.taxDistrict?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxDistrict"],
      message: "District is required when tax invoice is requested",
    });
  }

  if (!data.taxProvince?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxProvince"],
      message: "Province is required when tax invoice is requested",
    });
  }

  if (!data.taxPostalCode?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["taxPostalCode"],
      message: "Postal code is required when tax invoice is requested",
    });
  }
});

export type CreatePaymentIntentBody = z.infer<typeof createPaymentIntentSchema>;
