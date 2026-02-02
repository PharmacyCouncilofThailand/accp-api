import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { speakers, eventSpeakers, staffEventAssignments, Speaker } from "../../database/schema.js";
import { createSpeakerSchema, updateSpeakerSchema } from "../../schemas/speakers.schema.js";
import { eq, desc, ilike, or, inArray, and } from "drizzle-orm";
import { z } from "zod";

const speakerQuerySchema = z.object({
    eventId: z.coerce.number().optional(),
    sessionId: z.coerce.number().optional(),
});

export default async function (fastify: FastifyInstance) {
    // List Speakers
    fastify.get("", async (request, reply) => {
        // Get user from request (set by auth middleware)
        const user = (request as any).user;

        try {
            const queryResult = speakerQuerySchema.safeParse(request.query);
            const { eventId, sessionId } = queryResult.success ? queryResult.data : { eventId: undefined, sessionId: undefined };

            let speakerList: Speaker[] = [];
            let allowedEventIds: number[] | null = null;

            // If user is not admin, get their assigned events
            if (user && user.role !== 'admin') {
                const assignments = await db
                    .select({ eventId: staffEventAssignments.eventId })
                    .from(staffEventAssignments)
                    .where(eq(staffEventAssignments.staffId, user.id));

                allowedEventIds = assignments.map(a => a.eventId);

                if (allowedEventIds.length === 0) {
                    return reply.send({ speakers: [], eventSpeakers: [] });
                }
            }

            // Get all eventSpeakers relations (filtered by user permissions if not admin)
            let esQuery = db.select().from(eventSpeakers);
            let esConditions = [];

            if (allowedEventIds) {
                esConditions.push(inArray(eventSpeakers.eventId, allowedEventIds));
            }

            if (eventId) {
                esConditions.push(eq(eventSpeakers.eventId, eventId));
            }

            if (sessionId) {
                esConditions.push(eq(eventSpeakers.sessionId, sessionId));
            }

            const allEventSpeakers = await esQuery.where(esConditions.length > 0 ? and(...esConditions) : undefined);
            const speakerIds = [...new Set(allEventSpeakers.map(es => es.speakerId))];

            if (speakerIds.length === 0) {
                // If filtering by eventId or sessionId but no assignments found, return empty
                if (eventId || sessionId) {
                    return reply.send({ speakers: [], eventSpeakers: allEventSpeakers });
                }

                // Otherwise, if admin or allowed, and no specific filter, return all speakers
                if (!allowedEventIds) {
                    speakerList = await db.select().from(speakers).orderBy(desc(speakers.createdAt));
                } else {
                    speakerList = [];
                }
            } else {
                speakerList = await db
                    .select()
                    .from(speakers)
                    .where(inArray(speakers.id, speakerIds))
                    .orderBy(desc(speakers.createdAt));
            }

            return reply.send({ speakers: speakerList, eventSpeakers: allEventSpeakers });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch speakers" });
        }
    });

    // Create Speaker
    fastify.post("", async (request, reply) => {
        const result = createSpeakerSchema.safeParse(request.body);
        if (!result.success) {
            return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
        }

        try {
            const [newSpeaker] = await db.insert(speakers).values(result.data).returning();
            return reply.status(201).send({ speaker: newSpeaker });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to create speaker" });
        }
    });

    // Update Speaker
    fastify.patch("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = updateSpeakerSchema.safeParse(request.body);
        if (!result.success) {
            return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
        }

        try {
            const [updatedSpeaker] = await db
                .update(speakers)
                .set(result.data)
                .where(eq(speakers.id, parseInt(id)))
                .returning();

            if (!updatedSpeaker) return reply.status(404).send({ error: "Speaker not found" });
            return reply.send({ speaker: updatedSpeaker });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to update speaker" });
        }
    });

    // Delete Speaker
    fastify.delete("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        try {
            // Delete related event assignments first (Foreign Key Constraint)
            await db
                .delete(eventSpeakers)
                .where(eq(eventSpeakers.speakerId, parseInt(id)));

            const [deletedSpeaker] = await db
                .delete(speakers)
                .where(eq(speakers.id, parseInt(id)))
                .returning();

            if (!deletedSpeaker) return reply.status(404).send({ error: "Speaker not found" });
            return reply.send({ success: true, message: "Speaker deleted" });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to delete speaker" });
        }
    });

    // Assign Speaker to Events
    fastify.post("/:id/events", async (request, reply) => {
        const { id } = request.params as { id: string };
        const speakerId = parseInt(id);

        const bodySchema = z.object({
            assignments: z.array(z.object({
                eventId: z.number(),
                sessionId: z.number().nullable().optional(),
                speakerType: z.enum(["keynote", "panelist", "moderator", "guest"]).optional().default("guest"),
            })),
        });

        const result = bodySchema.safeParse(request.body);
        if (!result.success) {
            return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
        }

        const { assignments } = result.data;

        try {
            // Check if speaker exists
            const [existingSpeaker] = await db
                .select()
                .from(speakers)
                .where(eq(speakers.id, speakerId));

            if (!existingSpeaker) {
                return reply.status(404).send({ error: "Speaker not found" });
            }

            // Delete existing event assignments for this speaker
            await db
                .delete(eventSpeakers)
                .where(eq(eventSpeakers.speakerId, speakerId));

            // Insert new assignments
            if (assignments.length > 0) {
                const newAssignments = assignments.map(a => ({
                    speakerId,
                    eventId: a.eventId,
                    sessionId: a.sessionId || null,
                    speakerType: a.speakerType as "keynote" | "panelist" | "moderator" | "guest",
                    sortOrder: 0,
                }));

                await db.insert(eventSpeakers).values(newAssignments);
            }

            // Return updated eventSpeakers for this speaker
            const updatedAssignments = await db
                .select()
                .from(eventSpeakers)
                .where(eq(eventSpeakers.speakerId, speakerId));

            return reply.send({
                success: true,
                message: "Speaker event assignments updated",
                eventSpeakers: updatedAssignments,
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to assign speaker to events" });
        }
    });
}
