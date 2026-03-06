import { z } from 'zod';

export const registrationListSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(1000).default(10),
    search: z.string().optional(),
    eventId: z.coerce.number().optional(),
    status: z.enum(['confirmed', 'cancelled']).optional(),
    ticketTypeId: z.coerce.number().optional(),
    source: z.enum(['purchase', 'manual']).optional(),
});

export const updateRegistrationSchema = z.object({
    userId: z.number().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    status: z.enum(['confirmed', 'cancelled']).optional(),
    dietaryRequirements: z.string().optional(),
});

export const manualRegistrationSchema = z.object({
    userId: z.number().min(1, "User is required"),
    eventId: z.number().min(1, "Event is required"),
    ticketTypeId: z.number().min(1, "Ticket type is required"),
    sessionIds: z.array(z.number()).optional().default([]),
    note: z.string().max(500).optional(),
});

export const addSessionsSchema = z.object({
    sessionIds: z.array(z.number()).min(1, "At least one session required"),
    ticketTypeId: z.number().min(1, "Ticket type is required"),
    note: z.string().max(500).optional(),
});

export const batchManualRegistrationSchema = z.object({
    userIds: z.array(z.number()).min(1, "At least one user required").max(50, "Maximum 50 users per batch"),
    eventId: z.number().min(1, "Event is required"),
    ticketTypeId: z.number().min(1, "Ticket type is required"),
    sessionIds: z.array(z.number()).optional().default([]),
    note: z.string().max(500).optional(),
});

export const checkRegisteredUsersSchema = z.object({
    eventId: z.coerce.number().min(1),
    ticketTypeId: z.coerce.number().optional(),
});
