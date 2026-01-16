import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { speakers, eventSpeakers, events } from "../../database/schema.js";
import { eq, desc, inArray } from "drizzle-orm";

export default async function publicSpeakersRoutes(fastify: FastifyInstance) {
    // Public: List Speakers for a specific event (or all if no eventId)
    fastify.get("", async (request, reply) => {
        const { eventId } = request.query as { eventId?: string };

        try {
            if (eventId) {
                // Get speakers linked to this event
                const linkedSpeakers = await db
                    .select({ speakerId: eventSpeakers.speakerId })
                    .from(eventSpeakers)
                    .where(eq(eventSpeakers.eventId, parseInt(eventId)));

                const speakerIds = linkedSpeakers.map(s => s.speakerId);

                if (speakerIds.length === 0) {
                    return reply.send({ speakers: [] });
                }

                const speakerList = await db
                    .select()
                    .from(speakers)
                    .where(inArray(speakers.id, speakerIds))
                    .orderBy(desc(speakers.createdAt));

                return reply.send({ speakers: speakerList });
            }

            // No eventId filter - return all speakers
            const speakerList = await db
                .select()
                .from(speakers)
                .orderBy(desc(speakers.createdAt));

            return reply.send({ speakers: speakerList });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch speakers" });
        }
    });
}
