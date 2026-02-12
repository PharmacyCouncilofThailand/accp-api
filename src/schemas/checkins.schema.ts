import { z } from 'zod';

export const checkinListSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(50),
    eventId: z.coerce.number().optional(),
    search: z.string().optional(), // Search by user name or reg code
});

export const createCheckinSchema = z.object({
    regCode: z.string().min(1),
    sessionId: z.number().optional(),
    checkInAll: z.boolean().optional(),
});
