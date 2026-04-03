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
import { checkinListSchema, createCheckinSchema, checkinStatsSchema, undoCheckinSchema } from "../../schemas/checkins.schema.js";
import { eq, desc, ilike, and, or, count, isNotNull, isNull, sql } from "drizzle-orm";

export default async function (fastify: FastifyInstance) {
    // List Check-ins (reads from registration_sessions WHERE checkedInAt IS NOT NULL)
    fastify.get("", async (request, reply) => {
        const queryResult = checkinListSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId, sessionId } = queryResult.data;
        const offset = (page - 1) * limit;

        try {
            const conditions: any[] = [isNotNull(registrationSessions.checkedInAt)];
            if (eventId) conditions.push(eq(registrations.eventId, eventId));
            if (sessionId) conditions.push(eq(registrationSessions.sessionId, sessionId));
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

    // Check-in Stats (total registered vs checked-in, filterable by event/session)
    // When eventId is provided, also returns per-session breakdown
    fastify.get("/stats", async (request, reply) => {
        const queryResult = checkinStatsSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { eventId, sessionId } = queryResult.data;

        try {
            const conditions: any[] = [];
            if (eventId) conditions.push(eq(registrations.eventId, eventId));
            if (sessionId) conditions.push(eq(registrationSessions.sessionId, sessionId));

            // Only count confirmed registrations
            conditions.push(eq(registrations.status, "confirmed"));

            const whereClause = and(...conditions);

            // Total registration_sessions (= total slots)
            const [{ total }] = await db
                .select({ total: count() })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .where(whereClause);

            // Checked-in count
            const checkedInConditions = [...conditions, isNotNull(registrationSessions.checkedInAt)];
            const [{ checkedIn }] = await db
                .select({ checkedIn: count() })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .where(and(...checkedInConditions));

            // Per-session breakdown when eventId is provided
            let sessionBreakdown: any[] = [];
            if (eventId && !sessionId) {
                const breakdown = await db
                    .select({
                        sessionId: sessions.id,
                        sessionName: sessions.sessionName,
                        sessionType: sessions.sessionType,
                        room: sessions.room,
                        startTime: sessions.startTime,
                        endTime: sessions.endTime,
                        total: count(),
                        checkedIn: sql<number>`count(case when ${registrationSessions.checkedInAt} is not null then 1 end)`,
                    })
                    .from(registrationSessions)
                    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                    .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
                    .where(and(
                        eq(registrations.eventId, eventId),
                        eq(registrations.status, "confirmed"),
                    ))
                    .groupBy(sessions.id, sessions.sessionName, sessions.sessionType, sessions.room, sessions.startTime, sessions.endTime)
                    .orderBy(sessions.startTime);

                sessionBreakdown = breakdown.map(s => ({
                    sessionId: s.sessionId,
                    sessionName: s.sessionName,
                    sessionType: s.sessionType,
                    room: s.room,
                    startTime: s.startTime,
                    endTime: s.endTime,
                    total: s.total,
                    checkedIn: Number(s.checkedIn),
                    remaining: s.total - Number(s.checkedIn),
                    percentage: s.total > 0 ? Math.round((Number(s.checkedIn) / s.total) * 100) : 0,
                }));
            }

            return reply.send({
                total,
                checkedIn,
                remaining: total - checkedIn,
                percentage: total > 0 ? Math.round((checkedIn / total) * 100) : 0,
                ...(sessionBreakdown.length > 0 && { sessionBreakdown }),
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch stats" });
        }
    });

    // Create Check-in (Scan)
    // Supports 4 modes:
    //   1. { regCode } → return session list for staff to choose
    //   2. { regCode, sessionId } → check-in specific session
    //   3. { regCode, checkInAll: true } → check-in all sessions at once
    //   4. { regCode, assignedSessionId } → staff-assigned fast scan (auto check-in)
    fastify.post("", async (request, reply) => {
        const bodyResult = createCheckinSchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: "Invalid body", details: bodyResult.error.flatten() });
        }

        const { regCode, sessionId, checkInAll, assignedSessionId } = bodyResult.data;
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

            // ─── Case 4: Staff-assigned fast scan ───
            if (assignedSessionId) {
                const regSession = regSessions.find((rs: any) => rs.sessionId === assignedSessionId);

                if (!regSession) {
                    return reply.status(400).send({
                        error: "ผู้ลงทะเบียนไม่มีสิทธิ์เข้า session นี้",
                        code: "NO_ACCESS",
                        registration: {
                            regCode: registration.regCode,
                            firstName: registration.firstName,
                            lastName: registration.lastName,
                        },
                    });
                }

                if (regSession.checkedInAt) {
                    return reply.status(409).send({
                        error: "เช็คอินแล้ว",
                        code: "ALREADY_CHECKED_IN",
                        checkedInAt: regSession.checkedInAt,
                        sessionName: (regSession as any).session?.sessionName,
                        registration: {
                            regCode: registration.regCode,
                            firstName: registration.firstName,
                            lastName: registration.lastName,
                        },
                    });
                }

                // ─── Session time window validation ───
                const session = (regSession as any).session;
                if (session) {
                    const now = new Date();
                    
                    if (session.startTime && now < new Date(session.startTime)) {
                        return reply.status(400).send({
                            error: "Session has not started yet",
                            code: "SESSION_NOT_STARTED",
                            sessionName: session.sessionName,
                            startTime: session.startTime,
                            registration: {
                                regCode: registration.regCode,
                                firstName: registration.firstName,
                                lastName: registration.lastName,
                            },
                        });
                    }

                    if (session.endTime && now > new Date(session.endTime)) {
                        return reply.status(400).send({
                            error: "Session has already ended",
                            code: "SESSION_ENDED",
                            sessionName: session.sessionName,
                            endTime: session.endTime,
                            registration: {
                                regCode: registration.regCode,
                                firstName: registration.firstName,
                                lastName: registration.lastName,
                            },
                        });
                    }
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

            // ─── Case 1: Check-in ALL sessions at once ───
            if (checkInAll) {
                const unchecked = regSessions.filter((rs: any) => !rs.checkedInAt);
                if (unchecked.length === 0) {
                    return reply.status(409).send({
                        error: "All sessions already checked in",
                        code: "ALREADY_CHECKED_IN",
                    });
                }

                // ─── Session time window validation for all sessions ───
                const now = new Date();
                const validSessions = [];
                const invalidSessions = [];

                for (const rs of unchecked) {
                    const session = (rs as any).session;
                    if (session) {
                        if (session.startTime && now < new Date(session.startTime)) {
                            invalidSessions.push({
                                sessionName: session.sessionName,
                                reason: "Session has not started yet",
                                startTime: session.startTime,
                            });
                        } else if (session.endTime && now > new Date(session.endTime)) {
                            invalidSessions.push({
                                sessionName: session.sessionName,
                                reason: "Session has already ended",
                                endTime: session.endTime,
                            });
                        } else {
                            validSessions.push(rs);
                        }
                    } else {
                        validSessions.push(rs);
                    }
                }

                if (invalidSessions.length > 0 && validSessions.length === 0) {
                    return reply.status(400).send({
                        error: "No sessions are currently available for check-in",
                        code: "NO_ACTIVE_SESSIONS",
                        invalidSessions,
                    });
                }

                // Check-in only valid sessions
                for (const rs of validSessions) {
                    await db
                        .update(registrationSessions)
                        .set({ checkedInAt: new Date(), checkedInBy: staffUserId })
                        .where(eq(registrationSessions.id, rs.id));
                }

                const response = {
                    success: true,
                    checkedInCount: validSessions.length,
                    registration: {
                        id: registration.id,
                        regCode: registration.regCode,
                        firstName: registration.firstName,
                        lastName: registration.lastName,
                        ticketName: (registration as any).ticketType?.name,
                        eventName: (registration as any).event?.eventName,
                    },
                };

                if (invalidSessions.length > 0) {
                    return reply.status(207).send({
                        ...response,
                        skippedSessions: invalidSessions,
                        message: `Checked in ${validSessions.length} sessions. ${invalidSessions.length} sessions were skipped due to time restrictions.`,
                    });
                }

                return reply.send(response);
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

                // ─── Session time window validation ───
                const session = (regSession as any).session;
                if (session) {
                    const now = new Date();
                    
                    if (session.startTime && now < new Date(session.startTime)) {
                        return reply.status(400).send({
                            error: "Session has not started yet",
                            code: "SESSION_NOT_STARTED",
                            sessionName: session.sessionName,
                            startTime: session.startTime,
                        });
                    }

                    if (session.endTime && now > new Date(session.endTime)) {
                        return reply.status(400).send({
                            error: "Session has already ended",
                            code: "SESSION_ENDED",
                            sessionName: session.sessionName,
                            endTime: session.endTime,
                        });
                    }
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

    // Undo Check-in (clear checked_in_at and checked_in_by)
    fastify.post("/undo", async (request, reply) => {
        const bodyResult = undoCheckinSchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: "Invalid body", details: bodyResult.error.flatten() });
        }

        const { registrationSessionId } = bodyResult.data;
        const staffRole = (request as any).user?.role;

        try {
            // Find the registration_session
            const [rs] = await db
                .select({
                    id: registrationSessions.id,
                    checkedInAt: registrationSessions.checkedInAt,
                    sessionName: sessions.sessionName,
                    regCode: registrations.regCode,
                    firstName: registrations.firstName,
                    lastName: registrations.lastName,
                })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .leftJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
                .where(eq(registrationSessions.id, registrationSessionId))
                .limit(1);

            if (!rs) {
                return reply.status(404).send({ error: "Registration session not found" });
            }

            if (!rs.checkedInAt) {
                return reply.status(400).send({ error: "Not checked in yet" });
            }

            // Non-admin: only allow undo within 5 minutes
            if (staffRole !== "admin") {
                const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
                if (rs.checkedInAt < fiveMinAgo) {
                    return reply.status(403).send({
                        error: "สามารถยกเลิกเช็คอินได้ภายใน 5 นาทีเท่านั้น กรุณาติดต่อ admin",
                        code: "UNDO_TIMEOUT",
                    });
                }
            }

            // Clear check-in
            await db
                .update(registrationSessions)
                .set({ checkedInAt: null, checkedInBy: null })
                .where(eq(registrationSessions.id, registrationSessionId));

            return reply.send({
                success: true,
                undone: {
                    registrationSessionId,
                    sessionName: rs.sessionName,
                    regCode: rs.regCode,
                    name: `${rs.firstName} ${rs.lastName}`,
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to undo check-in" });
        }
    });
}
