import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { sessions, events, staffEventAssignments, speakers, eventSpeakers, registrations, registrationSessions, ticketTypes, users } from "../../database/schema.js";
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
                    agenda: sessions.agenda,
                    documents: sessions.documents,
                    eventCode: events.eventCode,
                })
                .from(sessions)
                .leftJoin(events, eq(sessions.eventId, events.id))
                .where(whereClause)
                .orderBy(desc(sessions.startTime))
                .limit(limit)
                .offset(offset);

            // Count enrollment per session from registration_sessions junction
            const sessionIds = sessionsWithMeta.map(s => s.id);
            let enrollMap = new Map<number, number>();
            if (sessionIds.length > 0) {
                const enrollCounts = await db
                    .select({
                        sessionId: registrationSessions.sessionId,
                        count: count(),
                    })
                    .from(registrationSessions)
                    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                    .where(
                        and(
                            inArray(registrationSessions.sessionId, sessionIds),
                            eq(registrations.status, "confirmed")
                        )
                    )
                    .groupBy(registrationSessions.sessionId);

                enrollMap = new Map(
                    enrollCounts.map(r => [r.sessionId, r.count])
                );
            }

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
                    enrolledCount: enrollMap.get(s.id) || 0,
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

    // GET /sessions/:id/export — download participant list as CSV
    fastify.get("/:id/export", async (request, reply) => {
        const { id } = request.params as { id: string };
        const sessionId = Number(id);
        if (isNaN(sessionId)) return reply.status(400).send({ error: "Invalid session id" });

        try {
            // Get session info for filename
            const [session] = await db
                .select({ sessionCode: sessions.sessionCode, sessionName: sessions.sessionName })
                .from(sessions)
                .where(eq(sessions.id, sessionId))
                .limit(1);

            if (!session) return reply.status(404).send({ error: "Session not found" });

            // Fetch all registrants for this session
            const rows = await db
                .select({
                    regCode: registrations.regCode,
                    firstName: registrations.firstName,
                    middleName: registrations.middleName,
                    lastName: registrations.lastName,
                    email: registrations.email,
                    phone: users.phone,
                    institution: users.institution,
                    role: registrations.ticketTypeId,
                    ticketName: ticketTypes.name,
                    regStatus: registrations.status,
                    checkedInAt: registrationSessions.checkedInAt,
                    createdAt: registrations.createdAt,
                })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .leftJoin(users, eq(registrations.userId, users.id))
                .leftJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
                .where(
                    and(
                        eq(registrationSessions.sessionId, sessionId),
                        eq(registrations.status, "confirmed"),
                    )
                )
                .orderBy(registrations.lastName, registrations.firstName);

            // Build CSV
            const escape = (v: string | null | undefined) => {
                const s = String(v ?? "");
                return s.includes(",") || s.includes('"') || s.includes("\n")
                    ? `"${s.replace(/"/g, '""')}"`
                    : s;
            };

            const headers = ["Reg Code", "First Name", "Middle Name", "Last Name", "Email", "Phone", "Institution", "Ticket", "Status", "Checked In At", "Registered At"];
            const lines = [
                headers.join(","),
                ...rows.map(r => [
                    escape(r.regCode),
                    escape(r.firstName),
                    escape(r.middleName),
                    escape(r.lastName),
                    escape(r.email),
                    escape(r.phone),
                    escape(r.institution),
                    escape(r.ticketName),
                    escape(r.regStatus),
                    r.checkedInAt ? new Date(r.checkedInAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }) : "",
                    new Date(r.createdAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
                ].join(","))
            ];

            const csv = lines.join("\r\n");
            const filename = `session_${session.sessionCode}_participants.csv`;

            reply
                .header("Content-Type", "text/csv; charset=utf-8")
                .header("Content-Disposition", `attachment; filename="${filename}"`)
                .send("\uFEFF" + csv); // BOM for Excel UTF-8
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Export failed" });
        }
    });
}
