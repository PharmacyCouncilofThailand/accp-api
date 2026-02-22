import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
    registrations,
    registrationSessions,
    sessions,
    backofficeUsers,
    events,
    ticketTypes,
} from "../../database/schema.js";
import { checkinListSchema, createCheckinSchema } from "../../schemas/checkins.schema.js";
import { eq, desc, ilike, and, or, count, isNotNull } from "drizzle-orm";

export default async function (fastify: FastifyInstance) {
    // List Check-ins (reads from registration_sessions WHERE checkedInAt IS NOT NULL)
    fastify.get("", async (request, reply) => {
        const queryResult = checkinListSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId } = queryResult.data;
        const offset = (page - 1) * limit;

        try {
            const conditions: any[] = [isNotNull(registrationSessions.checkedInAt)];
            if (eventId) conditions.push(eq(registrations.eventId, eventId));
            if (search) {
                conditions.push(
                    or(
                        ilike(registrations.firstName, `%${search}%`),
                        ilike(registrations.lastName, `%${search}%`),
                        ilike(registrations.regCode, `%${search}%`)
                    )
                );
            }

            const whereClause = and(...conditions);

            // Count total
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .where(whereClause);

            // Fetch data
            const checkinList = await db
                .select({
                    id: registrationSessions.id,
                    scannedAt: registrationSessions.checkedInAt,
                    regCode: registrations.regCode,
                    firstName: registrations.firstName,
                    lastName: registrations.lastName,
                    email: registrations.email,
                    ticketName: ticketTypes.name,
                    sessionName: sessions.sessionName,
                    eventName: events.eventName,
                    scannedBy: {
                        firstName: backofficeUsers.firstName,
                        lastName: backofficeUsers.lastName,
                    }
                })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .leftJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
                .leftJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
                .leftJoin(events, eq(registrations.eventId, events.id))
                .leftJoin(backofficeUsers, eq(registrationSessions.checkedInBy, backofficeUsers.id))
                .where(whereClause)
                .orderBy(desc(registrationSessions.checkedInAt))
                .limit(limit)
                .offset(offset);

            return reply.send({
                checkins: checkinList,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch check-ins" });
        }
    });

    // Create Check-in (Scan)
    // Supports 3 modes:
    //   1. { regCode } → return session list for staff to choose
    //   2. { regCode, sessionId } → check-in specific session
    //   3. { regCode, checkInAll: true } → check-in all sessions at once
    fastify.post("", async (request, reply) => {
        const bodyResult = createCheckinSchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: "Invalid body", details: bodyResult.error.flatten() });
        }

        const { regCode, sessionId, checkInAll } = bodyResult.data;
        const staffUserId = (request as any).user?.id;

        try {
            // Find registration with all linked sessions
            const registration = await db.query.registrations.findFirst({
                where: ilike(registrations.regCode, regCode),
                with: {
                    event: true,
                    ticketType: true,
                    registrationSessions: {
                        with: {
                            session: true,
                            ticketType: true,
                        },
                    },
                }
            });

            if (!registration) {
                return reply.status(404).send({ error: "Registration not found", code: "NOT_FOUND" });
            }

            if (registration.status !== 'confirmed') {
                return reply.status(400).send({
                    error: `Registration status is ${registration.status}`,
                    code: "INVALID_STATUS",
                    registration
                });
            }

            const regSessions = registration.registrationSessions || [];

            // ─── Case 1: Check-in ALL sessions at once ───
            if (checkInAll) {
                const unchecked = regSessions.filter((rs: any) => !rs.checkedInAt);
                if (unchecked.length === 0) {
                    return reply.status(409).send({
                        error: "All sessions already checked in",
                        code: "ALREADY_CHECKED_IN",
                    });
                }

                for (const rs of unchecked) {
                    await db
                        .update(registrationSessions)
                        .set({ checkedInAt: new Date(), checkedInBy: staffUserId })
                        .where(eq(registrationSessions.id, rs.id));
                }

                return reply.send({
                    success: true,
                    checkedInCount: unchecked.length,
                    registration: {
                        id: registration.id,
                        regCode: registration.regCode,
                        firstName: registration.firstName,
                        lastName: registration.lastName,
                        ticketName: (registration as any).ticketType?.name,
                        eventName: (registration as any).event?.eventName,
                    },
                });
            }

            // ─── Case 2: Check-in a specific session ───
            if (sessionId) {
                const regSession = regSessions.find((rs: any) => rs.sessionId === sessionId);

                if (!regSession) {
                    return reply.status(400).send({
                        error: "No access to this session",
                        code: "NO_ACCESS",
                    });
                }

                if (regSession.checkedInAt) {
                    return reply.status(409).send({
                        error: "Already checked in for this session",
                        code: "ALREADY_CHECKED_IN",
                        checkedInAt: regSession.checkedInAt,
                        sessionName: (regSession as any).session?.sessionName,
                    });
                }

                await db
                    .update(registrationSessions)
                    .set({ checkedInAt: new Date(), checkedInBy: staffUserId })
                    .where(eq(registrationSessions.id, regSession.id));

                return reply.send({
                    success: true,
                    checkedInSession: {
                        sessionId: regSession.sessionId,
                        sessionName: (regSession as any).session?.sessionName,
                        ticketName: (regSession as any).ticketType?.name,
                    },
                    registration: {
                        id: registration.id,
                        regCode: registration.regCode,
                        firstName: registration.firstName,
                        lastName: registration.lastName,
                        ticketName: (registration as any).ticketType?.name,
                        eventName: (registration as any).event?.eventName,
                    },
                });
            }

            // ─── Case 3: No sessionId → return session list for staff to choose ───
            return reply.send({
                registration: {
                    id: registration.id,
                    regCode: registration.regCode,
                    firstName: registration.firstName,
                    lastName: registration.lastName,
                    email: registration.email,
                    status: registration.status,
                    ticketName: (registration as any).ticketType?.name,
                    eventName: (registration as any).event?.eventName,
                },
                sessions: regSessions.map((rs: any) => ({
                    id: rs.id,
                    sessionId: rs.sessionId,
                    sessionName: rs.session?.sessionName,
                    sessionType: rs.session?.sessionType,
                    ticketName: rs.ticketType?.name,
                    checkedInAt: rs.checkedInAt,
                })),
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to process check-in" });
        }
    });
}
