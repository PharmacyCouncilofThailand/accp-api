import { z } from "zod";

// Create Event Schema
export const createEventSchema = z.object({
    eventCode: z.string().min(1).max(50),
    eventName: z.string().min(1).max(255),
    description: z.string().optional(),
    eventType: z.enum(["single_room", "multi_session"]),
    location: z.string().max(255).optional(),
    category: z.string().max(100).optional(),
    startDate: z.string().datetime(),
    endDate: z.string().datetime(),
    maxCapacity: z.number().int().positive().default(100),
    conferenceCode: z.string().max(100).optional(),
    cpeCredits: z.string().optional(),
    status: z.enum(["draft", "published", "cancelled", "completed"]).default("draft"),
    imageUrl: z.string().max(500).optional(),
    mapUrl: z.string().max(500).optional(),
    abstractStartDate: z.string().datetime().optional(),
    abstractEndDate: z.string().datetime().optional(),
});

// Update Event Schema
export const updateEventSchema = createEventSchema.partial();

// Create Session Schema (for multi-session events)
export const createSessionSchema = z.object({
    sessionCode: z.string().min(1).max(50),
    sessionName: z.string().min(1).max(255),
    sessionType: z.enum(["workshop", "gala_dinner", "lecture", "ceremony", "break", "other"]).optional().default("other"),
    description: z.string().optional(),
    room: z.string().max(100).optional(),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    speakers: z.string().optional(),
    maxCapacity: z.number().int().positive().default(100),
});

export const updateSessionSchema = createSessionSchema.partial();

// Create Ticket Type Schema
export const createTicketTypeSchema = z.object({
    category: z.enum(["primary", "addon"]),
    groupName: z.string().max(100).optional(),
    name: z.string().min(1).max(100),
    sessionId: z.number().int().optional(), // Deprecated: use sessionIds
    sessionIds: z.array(z.number().int()).optional(), // Multi-session linking
    price: z.string(),
    currency: z.string().max(3).default("THB"),
    allowedRoles: z.string().optional(),
    quota: z.number().int().positive(),
    saleStartDate: z.string().datetime().optional(),
    saleEndDate: z.string().datetime().optional(),
});

export const updateTicketTypeSchema = createTicketTypeSchema.partial();

// Query params schema
export const eventQuerySchema = z.object({
    status: z.enum(["draft", "published", "cancelled", "completed"]).optional(),
    eventType: z.enum(["single_room", "multi_session"]).optional(),
    search: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
export type CreateTicketTypeInput = z.infer<typeof createTicketTypeSchema>;
export type UpdateTicketTypeInput = z.infer<typeof updateTicketTypeSchema>;
export type EventQueryInput = z.infer<typeof eventQuerySchema>;
