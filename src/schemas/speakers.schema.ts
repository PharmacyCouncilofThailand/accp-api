import { z } from 'zod';

export const createSpeakerSchema = z.object({
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    bio: z.string().optional(),
    organization: z.string().optional(),
    position: z.string().optional(),
    photoUrl: z.string().optional(),
});

export const updateSpeakerSchema = createSpeakerSchema.partial();

export const speakerResponseSchema = createSpeakerSchema.extend({
    id: z.number(),
    createdAt: z.date(),
});
