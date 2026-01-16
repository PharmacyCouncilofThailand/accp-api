import { z } from 'zod';

export const registrationListSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(10),
    search: z.string().optional(),
    eventId: z.coerce.number().optional(),
    status: z.enum(['confirmed', 'cancelled']).optional(),
    ticketTypeId: z.coerce.number().optional(),
});

export const updateRegistrationSchema = z.object({
    userId: z.number().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    status: z.enum(['confirmed', 'cancelled']).optional(),
    dietaryRequirements: z.string().optional(),
});
