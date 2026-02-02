import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { sessions, events, staffEventAssignments, speakers, eventSpeakers } from "../../database/schema.js";
import { eq, desc, ilike, and, count, inArray } from "drizzle-orm";
import { z } from "zod";

const sessionQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(1000).default(20),
    search: z.string().optional(),
    eventId: z.coerce.number().optional(),
});

export default async function (fastify: FastifyInstance) {
    // List All Sessions (Global View)
    fastify.get("", async (request, reply) => {
        const queryResult = sessionQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId } = queryResult.data;
        const offset = (page - 1) * limit;

        // Get user from request (set by auth middleware)
        const user = (request as any).user;

        try {
            const conditions = [];

            // If user is not admin, filter by assigned events only
            if (user && user.role !== 'admin') {
                const assignments = await db
                    .select({ eventId: staffEventAssignments.eventId })
                    .from(staffEventAssignments)
                    .where(eq(staffEventAssignments.staffId, user.id));

                const assignedEventIds = assignments.map(a => a.eventId);

                if (assignedEventIds.length === 0) {
                    // No assignments, return empty list
                    return reply.send({
                        sessions: [],
                        pagination: {
                            page,
                            limit,
                            total: 0,
                            totalPages: 0,
                        },
                    });
                }

                conditions.push(inArray(sessions.eventId, assignedEventIds));
            }

            if (eventId) conditions.push(eq(sessions.eventId, eventId));
            if (search) {
                conditions.push(
                    ilike(sessions.sessionName, `%${search}%`)
                );
            }

            const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

            // Count total
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(sessions)
                .where(whereClause);

            // Fetch data
            const sessionsWithMeta = await db
                .select({
                    id: sessions.id,
                    eventId: sessions.eventId,
                    sessionCode: sessions.sessionCode,
                    sessionName: sessions.sessionName,
                    sessionType: sessions.sessionType,
                    description: sessions.description,
                    startTime: sessions.startTime,
                    endTime: sessions.endTime,
                    room: sessions.room,
                    maxCapacity: sessions.maxCapacity,
                    isMainSession: sessions.isMainSession,
                    eventCode: events.eventCode,
                })
                .from(sessions)
                .leftJoin(events, eq(sessions.eventId, events.id))
                .where(whereClause)
                .orderBy(desc(sessions.startTime))
                .limit(limit)
                .offset(offset);

            // Fetch speakers for these sessions and aggregate
            const finalSessions = await Promise.all(sessionsWithMeta.map(async (s) => {
                const sSpeakers = await db
                    .select({
                        id: speakers.id,
                        firstName: speakers.firstName,
                        lastName: speakers.lastName,
                    })
                    .from(eventSpeakers)
                    .innerJoin(speakers, eq(eventSpeakers.speakerId, speakers.id))
                    .where(eq(eventSpeakers.sessionId, s.id));

                return {
                    ...s,
                    speakers: sSpeakers.map(sp => `${sp.firstName} ${sp.lastName}`),
                    speakerIds: sSpeakers.map(sp => sp.id)
                };
            }));

            return reply.send({
                sessions: finalSessions,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch sessions" });
        }
    });
}
