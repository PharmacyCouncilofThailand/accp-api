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
    cpeCredits: z.preprocess((val) => val === "" ? undefined : Number(val), z.number().min(0).optional()),
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
    isMainSession: z.boolean().optional().default(false),
    description: z.string().optional(),
    room: z.string().max(100).optional(),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    speakerIds: z.array(z.number()).optional(), // New way: link to speakers table
    maxCapacity: z.number().int().positive().default(100),
});

export const updateSessionSchema = createSessionSchema.partial();

// Canonical role values matching the DB user_role enum
export const VALID_TICKET_ROLES = ["thstd", "thpro", "interstd", "interpro"] as const;

// Create Ticket Type Schema
export const createTicketTypeSchema = z.object({
    category: z.enum(["primary", "addon"]),
    groupName: z.string().max(100).optional(),
    name: z.string().min(1).max(100),
    sessionId: z.number().int().optional(), // Deprecated: use sessionIds
    sessionIds: z.array(z.number().int()).optional(), // Multi-session linking
    price: z.preprocess((val) => typeof val === 'string' && val.trim() === '' ? 0 : Number(val), z.number().min(0)),
    currency: z.string().max(3).default("THB"),
    allowedRoles: z.string().optional().refine(
        (val) => {
            if (!val) return true; // optional — no value is OK
            try {
                const roles = JSON.parse(val);
                if (!Array.isArray(roles)) return false;
                return roles.every((r: string) => VALID_TICKET_ROLES.includes(r as any));
            } catch {
                return false;
            }
        },
        { message: `allowedRoles must be a JSON array of valid roles: ${VALID_TICKET_ROLES.join(", ")}` }
    ),
    quota: z.number().int().positive(),
    saleStartDate: z.string().datetime().optional(),
    saleEndDate: z.string().datetime().optional(),
    displayOrder: z.number().int().min(0).default(0),
    description: z.string().optional(),
    originalPrice: z.preprocess(
        (val) => val === "" || val === null || val === undefined ? undefined : Number(val),
        z.number().min(0).optional()
    ),
    features: z.array(z.string()).optional().default([]),
    badgeText: z.string().max(50).optional(),
    isActive: z.boolean().optional(),
});

export const updateTicketTypeSchema = createTicketTypeSchema.partial();

// Query params schema
export const eventQuerySchema = z.object({
    status: z.enum(["draft", "published", "cancelled", "completed"]).optional(),
    eventType: z.enum(["single_room", "multi_session"]).optional(),
    search: z.string().optional(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(1000).default(20),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type CreateSessionInput = z.infer<typeof createSessionSchema>;
export type UpdateSessionInput = z.infer<typeof updateSessionSchema>;
export type CreateTicketTypeInput = z.infer<typeof createTicketTypeSchema>;
export type UpdateTicketTypeInput = z.infer<typeof updateTicketTypeSchema>;
export type EventQueryInput = z.infer<typeof eventQuerySchema>;
