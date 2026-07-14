import { z } from "zod";

export const certificateRecipientSchema = z.object({
  id: z.string().optional(),
  sourceType: z
    .enum(["registration", "abstract", "reviewer", "speaker", "manual", "upload"])
    .optional(),
  sourceId: z.number().int().positive().optional(),
  titlePrefix: z.string().min(1, "title_prefix is required"),
  firstName: z.string().min(1, "first_name is required"),
  middleName: z.string().optional().nullable(),
  lastName: z.string().min(1, "last_name is required"),
  email: z.string().email().optional().nullable().or(z.literal("")),
  institution: z.string().optional().nullable(),
  certificateNameOverride: z.string().optional().nullable(),
});

export const certificateRecipientsSchema = z
  .array(certificateRecipientSchema)
  .min(1, "At least one recipient is required")
  .max(500, "Maximum 500 recipients per batch");

export const certificateTemplateCodeSchema = z.string().min(1);

export const certificateGenerateSchema = z.object({
  templateCode: certificateTemplateCodeSchema,
  recipients: certificateRecipientsSchema,
});

export const certificatePreviewSchema = certificateGenerateSchema;

export const certificateDatabaseFilterSchema = z.object({
  eventId: z.number().int().positive().optional(),
  sessionId: z.number().int().positive().optional(),
  checkedIn: z.boolean().optional(),
  presentationType: z.enum(["oral", "poster"]).optional(),
  abstractStatus: z.string().optional(),
  search: z.string().optional(),
  role: z.string().optional(),
});

export const certificateManualRowSchema = certificateRecipientSchema.omit({
  sourceType: true,
  sourceId: true,
});

export const certificateResolveSchema = z.object({
  templateCode: certificateTemplateCodeSchema,
  sources: z
    .array(
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("database"),
          filter: certificateDatabaseFilterSchema.optional(),
        }),
        z.object({
          type: z.literal("manual"),
          rows: z.array(certificateManualRowSchema).min(1),
        }),
      ]),
    )
    .min(1),
  deduplicateBy: z.enum(["email", "name", "none"]).default("email"),
});

export const certificateSendEmailSchema = z.object({
  templateCode: certificateTemplateCodeSchema,
  recipients: certificateRecipientsSchema,
  subject: z.string().min(1).optional(),
  bodyHtml: z.string().optional(),
  dryRun: z.boolean().default(false),
});

export type CertificateRecipientInput = z.infer<typeof certificateRecipientSchema>;
export type CertificateGenerateInput = z.infer<typeof certificateGenerateSchema>;
export type CertificateResolveInput = z.infer<typeof certificateResolveSchema>;
export type CertificateSendEmailInput = z.infer<typeof certificateSendEmailSchema>;
