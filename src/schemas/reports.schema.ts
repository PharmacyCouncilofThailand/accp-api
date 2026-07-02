import { z } from "zod";

export const reportsEventQuerySchema = z.object({
  eventId: z.coerce.number().min(1, "eventId is required"),
});

export const reportsTrendQuerySchema = z.object({
  eventId: z.coerce.number().min(1, "eventId is required"),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const reportsExportQuerySchema = z.object({
  eventId: z.coerce.number().min(1).optional(),
  sessionId: z.coerce.number().min(1).optional(),
  format: z.enum(["csv"]).default("csv"),
  status: z.enum(["accepted", "pending", "rejected"]).optional(),
  presentationType: z.enum(["oral", "poster"]).optional(),
});

export const reportsExportTypeSchema = z.enum([
  "registrations",
  "orders",
  "members",
  "checkins",
  "abstracts",
  "sessions",
]);
