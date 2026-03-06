import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
    registrations, registrationSessions, ticketTypes, ticketSessions,
    events, sessions, users, staffEventAssignments, backofficeUsers,
} from "../../database/schema.js";
import {
    registrationListSchema, updateRegistrationSchema,
    manualRegistrationSchema, addSessionsSchema,
    batchManualRegistrationSchema, checkRegisteredUsersSchema,
} from "../../schemas/registrations.schema.js";
import { eq, desc, ilike, and, count, sql, or, inArray } from "drizzle-orm";

function generateRegCode(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `REG-${ts}${rand}`;
}

export default async function (fastify: FastifyInstance) {
    // List Registrations
    fastify.get("", async (request, reply) => {
        const queryResult = registrationListSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId, status, ticketTypeId, source } = queryResult.data;
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
                        registrations: [],
                        pagination: {
                            page,
                            limit,
                            total: 0,
                            totalPages: 0,
                        },
                    });
                }

                conditions.push(inArray(registrations.eventId, assignedEventIds));
            }

            if (eventId) conditions.push(eq(registrations.eventId, eventId));
            if (status) conditions.push(eq(registrations.status, status));
            if (ticketTypeId) conditions.push(eq(registrations.ticketTypeId, ticketTypeId));
            if (source) conditions.push(eq(registrations.source, source));
            if (search) {
                conditions.push(
                    or(
                        ilike(registrations.firstName, `%${search}%`),
                        ilike(registrations.lastName, `%${search}%`),
                        ilike(registrations.email, `%${search}%`),
                        ilike(registrations.regCode, `%${search}%`)
                    )
                );
            }

            const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

            // Count total
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(registrations)
                .where(whereClause);

            // Fetch data
            const registrationList = await db
                .select({
                    id: registrations.id,
                    regCode: registrations.regCode,
                    firstName: registrations.firstName,
                    lastName: registrations.lastName,
                    email: registrations.email,
                    status: registrations.status,
                    createdAt: registrations.createdAt,
                    ticketName: ticketTypes.name,
                    eventName: events.eventName,
                    eventCode: events.eventCode,
                    source: registrations.source,
                    addedNote: registrations.addedNote,
                    addedByFirstName: backofficeUsers.firstName,
                    addedByLastName: backofficeUsers.lastName,
                })
                .from(registrations)
                .leftJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
                .leftJoin(events, eq(registrations.eventId, events.id))
                .leftJoin(backofficeUsers, eq(registrations.addedBy, backofficeUsers.id))
                .where(whereClause)
                .orderBy(desc(registrations.createdAt))
                .limit(limit)
                .offset(offset);

            return reply.send({
                registrations: registrationList,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch registrations" });
        }
    });

    // Get Registration Detail
    fastify.get("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            // Get registration with related data
            const [reg] = await db
                .select({
                    id: registrations.id,
                    regCode: registrations.regCode,
                    email: registrations.email,
                    firstName: registrations.firstName,
                    lastName: registrations.lastName,
                    dietaryRequirements: registrations.dietaryRequirements,
                    status: registrations.status,
                    source: registrations.source,
                    addedNote: registrations.addedNote,
                    createdAt: registrations.createdAt,
                    eventId: registrations.eventId,
                    eventName: events.eventName,
                    eventCode: events.eventCode,
                    ticketTypeId: registrations.ticketTypeId,
                    ticketName: ticketTypes.name,
                    ticketCategory: ticketTypes.category,
                    ticketPrice: ticketTypes.price,
                    ticketCurrency: ticketTypes.currency,
                    userId: registrations.userId,
                    userPhone: users.phone,
                    userRole: users.role,
                    userInstitution: users.institution,
                    userCountry: users.country,
                    addedById: registrations.addedBy,
                    addedByFirstName: backofficeUsers.firstName,
                    addedByLastName: backofficeUsers.lastName,
                })
                .from(registrations)
                .innerJoin(events, eq(registrations.eventId, events.id))
                .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
                .leftJoin(users, eq(registrations.userId, users.id))
                .leftJoin(backofficeUsers, eq(registrations.addedBy, backofficeUsers.id))
                .where(eq(registrations.id, parseInt(id)))
                .limit(1);

            if (!reg) {
                return reply.status(404).send({ error: "Registration not found" });
            }

            // Get registration sessions with session details
            const regSessions = await db
                .select({
                    id: registrationSessions.id,
                    sessionId: registrationSessions.sessionId,
                    ticketTypeId: registrationSessions.ticketTypeId,
                    checkedInAt: registrationSessions.checkedInAt,
                    checkedInById: registrationSessions.checkedInBy,
                    createdAt: registrationSessions.createdAt,
                    sessionCode: sessions.sessionCode,
                    sessionName: sessions.sessionName,
                    sessionType: sessions.sessionType,
                    startTime: sessions.startTime,
                    endTime: sessions.endTime,
                    room: sessions.room,
                    ticketName: ticketTypes.name,
                    ticketCategory: ticketTypes.category,
                    checkedInByFirstName: backofficeUsers.firstName,
                    checkedInByLastName: backofficeUsers.lastName,
                })
                .from(registrationSessions)
                .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
                .innerJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
                .leftJoin(backofficeUsers, eq(registrationSessions.checkedInBy, backofficeUsers.id))
                .where(eq(registrationSessions.registrationId, parseInt(id)))
                .orderBy(sessions.startTime);

            return reply.send({
                registration: {
                    ...reg,
                    sessions: regSessions,
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch registration" });
        }
    });

    // Update Registration
    fastify.patch("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = updateRegistrationSchema.safeParse(request.body);

        if (!result.success) {
            return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
        }

        try {
            const [updatedReg] = await db
                .update(registrations)
                .set(result.data)
                .where(eq(registrations.id, parseInt(id)))
                .returning();

            if (!updatedReg) return reply.status(404).send({ error: "Registration not found" });
            return reply.send({ registration: updatedReg });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to update registration" });
        }
    });

    // ── Manual Add Registration ──────────────────────────
    fastify.post("/manual", async (request, reply) => {
        const staffUser = (request as any).user;
        const result = manualRegistrationSchema.safeParse(request.body);
        if (!result.success) {
            return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
        }

        const { userId, eventId, ticketTypeId, sessionIds, note } = result.data;

        try {
            const registration = await db.transaction(async (tx) => {
                // 1. Validate user exists
                const [user] = await tx
                    .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
                    .from(users)
                    .where(eq(users.id, userId))
                    .limit(1);
                if (!user) throw new Error("USER_NOT_FOUND");

                // 2. Validate event exists
                const [event] = await tx
                    .select({ id: events.id, eventName: events.eventName })
                    .from(events)
                    .where(eq(events.id, eventId))
                    .limit(1);
                if (!event) throw new Error("EVENT_NOT_FOUND");

                // 3. Validate ticket type exists & belongs to event
                const [ticket] = await tx
                    .select({ id: ticketTypes.id, name: ticketTypes.name, quota: ticketTypes.quota, soldCount: ticketTypes.soldCount })
                    .from(ticketTypes)
                    .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
                    .limit(1);
                if (!ticket) throw new Error("TICKET_NOT_FOUND");

                // 4. Check duplicate: same user + event + ticket type
                const [existing] = await tx
                    .select({ id: registrations.id })
                    .from(registrations)
                    .where(and(
                        eq(registrations.userId, userId),
                        eq(registrations.eventId, eventId),
                        eq(registrations.ticketTypeId, ticketTypeId),
                        eq(registrations.status, "confirmed"),
                    ))
                    .limit(1);
                if (existing) throw new Error("DUPLICATE_REGISTRATION");

                // 5. Check quota
                if (ticket.soldCount >= ticket.quota) throw new Error("TICKET_SOLD_OUT");

                // 6. Generate regCode & insert registration
                const regCode = generateRegCode();
                const [newReg] = await tx.insert(registrations).values({
                    regCode,
                    eventId,
                    ticketTypeId,
                    userId,
                    email: user.email,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    status: "confirmed",
                    source: "manual",
                    addedBy: staffUser.id,
                    addedNote: note || null,
                }).returning();

                // 7. Determine sessions to link
                let sessionsToLink = sessionIds || [];

                // If no sessions specified, auto-link from ticket_sessions junction
                if (sessionsToLink.length === 0) {
                    const linkedSessions = await tx
                        .select({ sessionId: ticketSessions.sessionId })
                        .from(ticketSessions)
                        .where(eq(ticketSessions.ticketTypeId, ticketTypeId));
                    sessionsToLink = linkedSessions.map(ls => ls.sessionId);

                    // Fallback: main sessions of the event
                    if (sessionsToLink.length === 0) {
                        const mainSessions = await tx
                            .select({ id: sessions.id })
                            .from(sessions)
                            .where(and(eq(sessions.eventId, eventId), eq(sessions.isMainSession, true)));
                        sessionsToLink = mainSessions.map(s => s.id);
                    }
                }

                // 8. Insert registration_sessions
                for (const sid of sessionsToLink) {
                    await tx.insert(registrationSessions).values({
                        registrationId: newReg.id,
                        sessionId: sid,
                        ticketTypeId,
                        source: "manual",
                        addedBy: staffUser.id,
                        addedNote: note || null,
                    });
                }

                // 9. Update soldCount
                await tx
                    .update(ticketTypes)
                    .set({ soldCount: sql`${ticketTypes.soldCount} + 1` })
                    .where(eq(ticketTypes.id, ticketTypeId));

                return {
                    ...newReg,
                    ticketName: ticket.name,
                    eventName: event.eventName,
                    sessionCount: sessionsToLink.length,
                    sessionsLinked: sessionsToLink,
                    userEmail: user.email,
                    userFirstName: user.firstName,
                    userLastName: user.lastName,
                };
            });

            reply.status(201).send({
                success: true,
                registration,
            });

            // Send confirmation email in background (non-blocking)
            setImmediate(async () => {
                try {
                    const { sendManualRegistrationEmail } = await import("../../services/emailService.js");
                    const sessionDetails = registration.sessionsLinked.length > 0
                        ? await db
                            .select({ sessionName: sessions.sessionName, startTime: sessions.startTime, endTime: sessions.endTime })
                            .from(sessions)
                            .where(inArray(sessions.id, registration.sessionsLinked))
                        : [];
                    await sendManualRegistrationEmail(
                        registration.userEmail,
                        registration.userFirstName,
                        registration.userLastName,
                        registration.regCode,
                        registration.eventName,
                        registration.ticketName,
                        sessionDetails,
                    );
                } catch (emailErr) {
                    fastify.log.error({ err: emailErr }, "Failed to send manual registration email");
                }
            });

            return;
        } catch (error: any) {
            const knownErrors: Record<string, { status: number; message: string }> = {
                USER_NOT_FOUND: { status: 404, message: "User not found" },
                EVENT_NOT_FOUND: { status: 404, message: "Event not found" },
                TICKET_NOT_FOUND: { status: 404, message: "Ticket type not found or does not belong to event" },
                DUPLICATE_REGISTRATION: { status: 409, message: "User already has an active registration for this event/ticket" },
                TICKET_SOLD_OUT: { status: 409, message: "Ticket is sold out" },
            };

            const known = knownErrors[error?.message];
            if (known) {
                return reply.status(known.status).send({ error: known.message, code: error.message });
            }

            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to create manual registration" });
        }
    });

    // ── Add Sessions to Existing Registration ────────────
    fastify.post("/:id/sessions", async (request, reply) => {
        const staffUser = (request as any).user;
        const { id } = request.params as { id: string };
        const result = addSessionsSchema.safeParse(request.body);
        if (!result.success) {
            return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
        }

        const { sessionIds, ticketTypeId, note } = result.data;
        const regId = parseInt(id);

        try {
            // Verify registration exists
            const [reg] = await db
                .select({ id: registrations.id, eventId: registrations.eventId })
                .from(registrations)
                .where(eq(registrations.id, regId))
                .limit(1);

            if (!reg) return reply.status(404).send({ error: "Registration not found" });

            // Verify sessions belong to same event
            const validSessions = await db
                .select({ id: sessions.id })
                .from(sessions)
                .where(and(
                    inArray(sessions.id, sessionIds),
                    eq(sessions.eventId, reg.eventId),
                ));

            if (validSessions.length !== sessionIds.length) {
                return reply.status(400).send({ error: "Some sessions do not belong to the registration's event" });
            }

            // Check for duplicates
            const existingSessions = await db
                .select({ sessionId: registrationSessions.sessionId })
                .from(registrationSessions)
                .where(eq(registrationSessions.registrationId, regId));

            const existingIds = new Set(existingSessions.map(s => s.sessionId));
            const newSessionIds = sessionIds.filter(sid => !existingIds.has(sid));

            if (newSessionIds.length === 0) {
                return reply.status(409).send({ error: "All sessions already added" });
            }

            // Insert new registration_sessions
            const inserted = [];
            for (const sid of newSessionIds) {
                const [row] = await db.insert(registrationSessions).values({
                    registrationId: regId,
                    sessionId: sid,
                    ticketTypeId,
                    source: "manual",
                    addedBy: staffUser.id,
                    addedNote: note || null,
                }).returning();
                inserted.push(row);
            }

            return reply.status(201).send({
                success: true,
                addedCount: inserted.length,
                sessions: inserted,
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to add sessions" });
        }
    });

    // ── Get Registered User IDs for Event/Ticket ──────────
    // Primary tickets: block if user has ANY primary ticket for this event
    // Add-on tickets: block only if user has this specific ticket
    fastify.get("/registered-users", async (request, reply) => {
        const queryResult = checkRegisteredUsersSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { eventId, ticketTypeId } = queryResult.data;

        try {
            let ticketCategory: string | null = null;

            // Determine the category of the selected ticket
            if (ticketTypeId) {
                const [ticket] = await db
                    .select({ category: ticketTypes.category })
                    .from(ticketTypes)
                    .where(eq(ticketTypes.id, ticketTypeId))
                    .limit(1);
                ticketCategory = ticket?.category || null;
            }

            let userIds: number[] = [];

            if (ticketTypeId && ticketCategory === "addon") {
                // Add-on: check registration_sessions table
                // THB and USD versions of the same add-on share the same session_id
                // So we need to find all ticket_type_ids that link to the same session(s)
                
                // 1. Get session_ids linked to the selected ticket
                const linkedSessions = await db
                    .select({ sessionId: ticketSessions.sessionId })
                    .from(ticketSessions)
                    .where(eq(ticketSessions.ticketTypeId, ticketTypeId));
                const sessionIds = linkedSessions.map(s => s.sessionId);

                // 2. Get all ticket_type_ids that link to those sessions (THB + USD versions)
                let addonTicketIds = [ticketTypeId];
                if (sessionIds.length > 0) {
                    const relatedTickets = await db
                        .select({ ticketTypeId: ticketSessions.ticketTypeId })
                        .from(ticketSessions)
                        .where(inArray(ticketSessions.sessionId, sessionIds));
                    addonTicketIds = [...new Set(relatedTickets.map(t => t.ticketTypeId))];
                }

                // 3. Check if user has any of these add-on tickets in registration_sessions
                const registered = await db
                    .select({ userId: registrations.userId })
                    .from(registrationSessions)
                    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                    .where(and(
                        eq(registrations.eventId, eventId),
                        eq(registrations.status, "confirmed"),
                        inArray(registrationSessions.ticketTypeId, addonTicketIds),
                    ));
                userIds = registered
                    .map(r => r.userId)
                    .filter((id): id is number => id !== null);
            } else if (ticketTypeId && ticketCategory === "primary") {
                // Primary: block users who have ANY primary ticket for this event
                const primaryTicketIds = await db
                    .select({ id: ticketTypes.id })
                    .from(ticketTypes)
                    .where(and(
                        eq(ticketTypes.eventId, eventId),
                        eq(ticketTypes.category, "primary"),
                    ));
                const pIds = primaryTicketIds.map(t => t.id);
                if (pIds.length > 0) {
                    const registered = await db
                        .select({ userId: registrations.userId })
                        .from(registrations)
                        .where(and(
                            eq(registrations.eventId, eventId),
                            eq(registrations.status, "confirmed"),
                            inArray(registrations.ticketTypeId, pIds),
                        ));
                    userIds = registered
                        .map(r => r.userId)
                        .filter((id): id is number => id !== null);
                }
            } else {
                // No ticket selected: return all users registered for the event
                const registered = await db
                    .select({ userId: registrations.userId })
                    .from(registrations)
                    .where(and(
                        eq(registrations.eventId, eventId),
                        eq(registrations.status, "confirmed"),
                    ));
                userIds = registered
                    .map(r => r.userId)
                    .filter((id): id is number => id !== null);
            }

            return reply.send({ registeredUserIds: userIds, ticketCategory });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch registered users" });
        }
    });

    // ── Batch Manual Add Registration ─────────────────────
    fastify.post("/manual/batch", async (request, reply) => {
        const staffUser = (request as any).user;
        const result = batchManualRegistrationSchema.safeParse(request.body);
        if (!result.success) {
            return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
        }

        const { userIds, eventId, ticketTypeId, sessionIds, note } = result.data;

        try {
            const results = await db.transaction(async (tx) => {
                // 1. Validate event exists
                const [event] = await tx
                    .select({ id: events.id, eventName: events.eventName })
                    .from(events)
                    .where(eq(events.id, eventId))
                    .limit(1);
                if (!event) throw new Error("EVENT_NOT_FOUND");

                // 2. Validate ticket type exists & belongs to event
                const [ticket] = await tx
                    .select({ id: ticketTypes.id, name: ticketTypes.name, category: ticketTypes.category, quota: ticketTypes.quota, soldCount: ticketTypes.soldCount })
                    .from(ticketTypes)
                    .where(and(eq(ticketTypes.id, ticketTypeId), eq(ticketTypes.eventId, eventId)))
                    .limit(1);
                if (!ticket) throw new Error("TICKET_NOT_FOUND");

                // 3. Get all users
                const userList = await tx
                    .select({ id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName })
                    .from(users)
                    .where(inArray(users.id, userIds));

                const userMap = new Map(userList.map(u => [u.id, u]));

                // 4. Check existing registrations (category-aware)
                // Primary: block if user has ANY primary ticket for this event (check registrations table)
                // Add-on: block if user has this specific add-on (check registration_sessions table)
                let alreadyRegistered: Set<number | null>;

                if (ticket.category === "addon") {
                    // Add-on: check registration_sessions
                    // THB and USD versions of the same add-on share the same session_id
                    // So we need to find all ticket_type_ids that link to the same session(s)
                    
                    // 1. Get session_ids linked to the selected ticket
                    const linkedSessions = await tx
                        .select({ sessionId: ticketSessions.sessionId })
                        .from(ticketSessions)
                        .where(eq(ticketSessions.ticketTypeId, ticketTypeId));
                    const sessionIds = linkedSessions.map(s => s.sessionId);

                    // 2. Get all ticket_type_ids that link to those sessions (THB + USD versions)
                    let addonTicketIds = [ticketTypeId];
                    if (sessionIds.length > 0) {
                        const relatedTickets = await tx
                            .select({ ticketTypeId: ticketSessions.ticketTypeId })
                            .from(ticketSessions)
                            .where(inArray(ticketSessions.sessionId, sessionIds));
                        addonTicketIds = [...new Set(relatedTickets.map(t => t.ticketTypeId))];
                    }

                    // 3. Check if user has any of these add-on tickets in registration_sessions
                    const existingRegs = await tx
                        .select({ userId: registrations.userId })
                        .from(registrationSessions)
                        .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                        .where(and(
                            inArray(registrations.userId, userIds),
                            eq(registrations.eventId, eventId),
                            eq(registrations.status, "confirmed"),
                            inArray(registrationSessions.ticketTypeId, addonTicketIds),
                        ));
                    alreadyRegistered = new Set(existingRegs.map(r => r.userId));
                } else {
                    // Primary: check against ALL primary tickets for this event
                    const primaryTicketIds = await tx
                        .select({ id: ticketTypes.id })
                        .from(ticketTypes)
                        .where(and(
                            eq(ticketTypes.eventId, eventId),
                            eq(ticketTypes.category, "primary"),
                        ));
                    const pIds = primaryTicketIds.map(t => t.id);
                    const existingRegs = pIds.length > 0
                        ? await tx
                            .select({ userId: registrations.userId })
                            .from(registrations)
                            .where(and(
                                inArray(registrations.userId, userIds),
                                eq(registrations.eventId, eventId),
                                eq(registrations.status, "confirmed"),
                                inArray(registrations.ticketTypeId, pIds),
                            ))
                        : [];
                    alreadyRegistered = new Set(existingRegs.map(r => r.userId));
                }

                // 5. Determine sessions to link
                let sessionsToLink = sessionIds || [];
                if (sessionsToLink.length === 0) {
                    const linkedSessions = await tx
                        .select({ sessionId: ticketSessions.sessionId })
                        .from(ticketSessions)
                        .where(eq(ticketSessions.ticketTypeId, ticketTypeId));
                    sessionsToLink = linkedSessions.map(ls => ls.sessionId);

                    if (sessionsToLink.length === 0) {
                        const mainSessions = await tx
                            .select({ id: sessions.id })
                            .from(sessions)
                            .where(and(eq(sessions.eventId, eventId), eq(sessions.isMainSession, true)));
                        sessionsToLink = mainSessions.map(s => s.id);
                    }
                }

                // 6. Process each user
                const successList: any[] = [];
                const skippedList: { userId: number; reason: string }[] = [];
                let addedCount = 0;

                for (const userId of userIds) {
                    const user = userMap.get(userId);
                    if (!user) {
                        skippedList.push({ userId, reason: "USER_NOT_FOUND" });
                        continue;
                    }
                    if (alreadyRegistered.has(userId)) {
                        skippedList.push({ userId, reason: "ALREADY_REGISTERED" });
                        continue;
                    }

                    // Check quota
                    if (ticket.soldCount + addedCount >= ticket.quota) {
                        skippedList.push({ userId, reason: "TICKET_SOLD_OUT" });
                        continue;
                    }

                    // Insert registration
                    const regCode = generateRegCode();
                    const [newReg] = await tx.insert(registrations).values({
                        regCode,
                        eventId,
                        ticketTypeId,
                        userId,
                        email: user.email,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        status: "confirmed",
                        source: "manual",
                        addedBy: staffUser.id,
                        addedNote: note || null,
                    }).returning();

                    // Insert registration_sessions
                    for (const sid of sessionsToLink) {
                        await tx.insert(registrationSessions).values({
                            registrationId: newReg.id,
                            sessionId: sid,
                            ticketTypeId,
                            source: "manual",
                            addedBy: staffUser.id,
                            addedNote: note || null,
                        });
                    }

                    addedCount++;
                    successList.push({
                        userId,
                        regCode: newReg.regCode,
                        firstName: user.firstName,
                        lastName: user.lastName,
                    });
                }

                // 7. Update soldCount
                if (addedCount > 0) {
                    await tx
                        .update(ticketTypes)
                        .set({ soldCount: sql`${ticketTypes.soldCount} + ${addedCount}` })
                        .where(eq(ticketTypes.id, ticketTypeId));
                }

                return { successList, skippedList, addedCount, sessionsToLink };
            });

            reply.status(201).send({
                success: true,
                addedCount: results.addedCount,
                successList: results.successList,
                skippedList: results.skippedList,
            });

            // Send confirmation emails in background (non-blocking)
            if (results.successList.length > 0) {
                setImmediate(async () => {
                    try {
                        const { sendManualRegistrationEmail } = await import("../../services/emailService.js");
                        const sessionDetails = results.sessionsToLink.length > 0
                            ? await db
                                .select({ sessionName: sessions.sessionName, startTime: sessions.startTime, endTime: sessions.endTime })
                                .from(sessions)
                                .where(inArray(sessions.id, results.sessionsToLink))
                            : [];

                        for (const reg of results.successList) {
                            try {
                                const user = await db
                                    .select({ email: users.email })
                                    .from(users)
                                    .where(eq(users.id, reg.userId))
                                    .limit(1);
                                const ticketRow = await db
                                    .select({ name: ticketTypes.name, eventName: events.eventName })
                                    .from(ticketTypes)
                                    .innerJoin(events, eq(ticketTypes.eventId, events.id))
                                    .where(eq(ticketTypes.id, ticketTypeId))
                                    .limit(1);

                                if (user[0] && ticketRow[0]) {
                                    await sendManualRegistrationEmail(
                                        user[0].email,
                                        reg.firstName,
                                        reg.lastName,
                                        reg.regCode,
                                        ticketRow[0].eventName,
                                        ticketRow[0].name,
                                        sessionDetails,
                                    );
                                }
                            } catch (emailErr) {
                                fastify.log.error({ err: emailErr, regCode: reg.regCode }, "Failed to send manual registration email");
                            }
                        }
                    } catch (err) {
                        fastify.log.error({ err }, "Failed to send batch manual registration emails");
                    }
                });
            }

            return;
        } catch (error: any) {
            const knownErrors: Record<string, { status: number; message: string }> = {
                EVENT_NOT_FOUND: { status: 404, message: "Event not found" },
                TICKET_NOT_FOUND: { status: 404, message: "Ticket type not found or does not belong to event" },
            };

            const known = knownErrors[error?.message];
            if (known) {
                return reply.status(known.status).send({ error: known.message, code: error.message });
            }

            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to create batch registrations" });
        }
    });
}
