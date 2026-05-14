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
    registrationStatsByCountrySchema, registrationStatsByAddonSchema,
} from "../../schemas/registrations.schema.js";
import { eq, desc, ilike, and, count, sql, or, inArray, exists, notExists } from "drizzle-orm";

function generateRegCode(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `REG-${ts}${rand}`;
}

function uniquePositiveIds(ids: number[] = [], excludeId?: number): number[] {
    return [...new Set(ids)].filter((id) => Number.isInteger(id) && id > 0 && id !== excludeId);
}

function buildTicketSessionSelectionMap(
    selections: { ticketTypeId: number; sessionIds: number[] }[] = [],
): Map<number, number[]> {
    const map = new Map<number, number[]>();
    for (const selection of selections) {
        map.set(selection.ticketTypeId, uniquePositiveIds(selection.sessionIds));
    }
    return map;
}

async function validateEventSessionIds(tx: any, eventId: number, sessionIds: number[]): Promise<number[]> {
    const uniqueIds = uniquePositiveIds(sessionIds);
    if (uniqueIds.length === 0) return [];

    const validSessions = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(
            inArray(sessions.id, uniqueIds),
            eq(sessions.eventId, eventId),
        ));

    if (validSessions.length !== uniqueIds.length) {
        throw new Error("SESSION_NOT_FOUND");
    }

    return uniqueIds;
}

async function getLinkedSessionIdsForTicket(tx: any, eventId: number, ticketTypeId: number): Promise<number[]> {
    const linkedSessions = await tx
        .select({ sessionId: ticketSessions.sessionId })
        .from(ticketSessions)
        .innerJoin(sessions, eq(ticketSessions.sessionId, sessions.id))
        .where(and(
            eq(ticketSessions.ticketTypeId, ticketTypeId),
            eq(sessions.eventId, eventId),
        ));

    return linkedSessions.map((ls: { sessionId: number }) => ls.sessionId);
}

async function getAutoSessionIdsForTicket(tx: any, eventId: number, ticketTypeId: number): Promise<number[]> {
    const linkedSessionIds = await getLinkedSessionIdsForTicket(tx, eventId, ticketTypeId);
    if (linkedSessionIds.length > 0) return linkedSessionIds;

    const mainSessions = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.eventId, eventId), eq(sessions.isMainSession, true)));

    return mainSessions.map((s: { id: number }) => s.id);
}

async function validateTicketSessionSelection(
    tx: any,
    eventId: number,
    ticketTypeId: number,
    selectedSessionIds: number[],
    allowMainSessionFallback = false,
): Promise<number[]> {
    const selectedIds = uniquePositiveIds(selectedSessionIds);
    if (selectedIds.length === 0) return [];

    let linkedSessionIds = await getLinkedSessionIdsForTicket(tx, eventId, ticketTypeId);
    if (linkedSessionIds.length === 0 && allowMainSessionFallback) {
        linkedSessionIds = await getAutoSessionIdsForTicket(tx, eventId, ticketTypeId);
    }

    const linkedSet = new Set(linkedSessionIds);
    if (selectedIds.some((sessionId) => !linkedSet.has(sessionId))) {
        throw new Error("SESSION_NOT_LINKED_TO_TICKET");
    }

    return selectedIds;
}

async function resolvePrimarySessionIds(
    tx: any,
    eventId: number,
    ticketTypeId: number,
    explicitSessionIds: number[] = [],
    selectionMap = new Map<number, number[]>(),
): Promise<number[]> {
    if (selectionMap.has(ticketTypeId)) {
        return validateTicketSessionSelection(
            tx,
            eventId,
            ticketTypeId,
            selectionMap.get(ticketTypeId) || [],
            true,
        );
    }

    if (explicitSessionIds.length > 0) {
        return validateEventSessionIds(tx, eventId, explicitSessionIds);
    }

    return getAutoSessionIdsForTicket(tx, eventId, ticketTypeId);
}

async function getAddonSessionLinks(
    tx: any,
    eventId: number,
    addonTickets: { id: number; groupName: string | null }[],
    selectionMap = new Map<number, number[]>(),
): Promise<{ ticketTypeId: number; sessionId: number }[]> {
    const addonTicketTypeIds = addonTickets.map((ticket) => ticket.id);
    if (addonTicketTypeIds.length === 0) return [];

    const rows = await tx
        .select({
            ticketTypeId: ticketSessions.ticketTypeId,
            sessionId: ticketSessions.sessionId,
            sessionType: sessions.sessionType,
        })
        .from(ticketSessions)
        .innerJoin(sessions, eq(ticketSessions.sessionId, sessions.id))
        .where(and(
            inArray(ticketSessions.ticketTypeId, addonTicketTypeIds),
            eq(sessions.eventId, eventId),
        ));

    const ticketIdsWithSessions = new Set(rows.map((row: { ticketTypeId: number }) => row.ticketTypeId));
    const missingSessionTicket = addonTicketTypeIds.find((id) => !ticketIdsWithSessions.has(id));
    if (missingSessionTicket) {
        throw new Error("ADDON_TICKET_HAS_NO_SESSIONS");
    }

    const links: { ticketTypeId: number; sessionId: number }[] = [];
    for (const addon of addonTickets) {
        const linkedRows = rows.filter((row: { ticketTypeId: number }) => row.ticketTypeId === addon.id);
        const linkedSessionIds = linkedRows.map((row: { sessionId: number }) => row.sessionId);
        const hasExplicitSelection = selectionMap.has(addon.id);
        const selectedSessionIds = hasExplicitSelection
            ? uniquePositiveIds(selectionMap.get(addon.id) || [])
            : linkedSessionIds;

        if (selectedSessionIds.length === 0) {
            throw new Error("ADDON_TICKET_REQUIRES_SESSION");
        }

        const linkedSet = new Set(linkedSessionIds);
        if (selectedSessionIds.some((sessionId: number) => !linkedSet.has(sessionId))) {
            throw new Error("SESSION_NOT_LINKED_TO_TICKET");
        }

        const isWorkshop = (addon.groupName || "").toLowerCase() === "workshop" ||
            linkedRows.some((row: { sessionType: string | null }) => row.sessionType === "workshop");
        if (isWorkshop && selectedSessionIds.length !== 1) {
            throw new Error("WORKSHOP_REQUIRES_ONE_SESSION");
        }

        for (const sessionId of selectedSessionIds) {
            links.push({ ticketTypeId: addon.id, sessionId });
        }
    }

    return links;
}

async function getRelatedAddonTicketIds(tx: any, addonTicketTypeIds: number[]): Promise<number[]> {
    if (addonTicketTypeIds.length === 0) return [];

    const linkedSessions = await tx
        .select({ sessionId: ticketSessions.sessionId })
        .from(ticketSessions)
        .where(inArray(ticketSessions.ticketTypeId, addonTicketTypeIds));

    const sessionIds = uniquePositiveIds(linkedSessions.map((row: { sessionId: number }) => row.sessionId));
    if (sessionIds.length === 0) return addonTicketTypeIds;

    const relatedTickets = await tx
        .select({ ticketTypeId: ticketSessions.ticketTypeId })
        .from(ticketSessions)
        .innerJoin(ticketTypes, eq(ticketSessions.ticketTypeId, ticketTypes.id))
        .where(and(
            inArray(ticketSessions.sessionId, sessionIds),
            eq(ticketTypes.category, "addon"),
        ));

    return uniquePositiveIds([
        ...addonTicketTypeIds,
        ...relatedTickets.map((row: { ticketTypeId: number }) => row.ticketTypeId),
    ]);
}

export default async function (fastify: FastifyInstance) {
    // List Registrations
    fastify.get("", async (request, reply) => {
        const queryResult = registrationListSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId, status, ticketTypeId, source, country } = queryResult.data;
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
            if (country) conditions.push(eq(users.country, country));
            if (search) {
                conditions.push(
                    or(
                        ilike(registrations.firstName, `%${search}%`),
                        ilike(registrations.middleName, `%${search}%`),
                        ilike(registrations.lastName, `%${search}%`),
                        ilike(registrations.email, `%${search}%`),
                        ilike(registrations.regCode, `%${search}%`)
                    )
                );
            }

            const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

            // Count total (need to join users for country filter to work in count too)
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(registrations)
                .leftJoin(users, eq(registrations.userId, users.id))
                .where(whereClause);

            // Fetch data
            const registrationList = await db
                .select({
                    id: registrations.id,
                    regCode: registrations.regCode,
                    firstName: registrations.firstName,
                    middleName: registrations.middleName,
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
                    userCountry: users.country,
                })
                .from(registrations)
                .leftJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
                .leftJoin(events, eq(registrations.eventId, events.id))
                .leftJoin(backofficeUsers, eq(registrations.addedBy, backofficeUsers.id))
                .leftJoin(users, eq(registrations.userId, users.id))
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
                    middleName: registrations.middleName,
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

        const { userId, eventId, ticketTypeId, addonTicketTypeIds, ticketSessionSelections, sessionIds, note } = result.data;

        try {
            const registration = await db.transaction(async (tx) => {
                const selectedAddonTicketIds = uniquePositiveIds(addonTicketTypeIds, ticketTypeId);
                const selectionMap = buildTicketSessionSelectionMap(ticketSessionSelections);

                // 1. Validate user exists
                const [user] = await tx
                    .select({ id: users.id, email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
                    .from(users)
                    .where(eq(users.id, userId))
                    .limit(1);
                if (!user) throw new Error("USER_NOT_FOUND");

                // 2. Validate event exists
                const [event] = await tx
                    .select({
                        id: events.id,
                        eventName: events.eventName,
                        startDate: events.startDate,
                        endDate: events.endDate,
                        location: events.location,
                        websiteUrl: events.websiteUrl,
                        shortName: events.shortName,
                    })
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

                const addonTickets = selectedAddonTicketIds.length > 0
                    ? await tx
                        .select({ id: ticketTypes.id, name: ticketTypes.name, groupName: ticketTypes.groupName, quota: ticketTypes.quota, soldCount: ticketTypes.soldCount })
                        .from(ticketTypes)
                        .where(and(
                            inArray(ticketTypes.id, selectedAddonTicketIds),
                            eq(ticketTypes.eventId, eventId),
                            eq(ticketTypes.category, "addon"),
                        ))
                    : [];
                if (addonTickets.length !== selectedAddonTicketIds.length) {
                    throw new Error("ADDON_TICKET_NOT_FOUND");
                }

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

                if (selectedAddonTicketIds.length > 0) {
                    const relatedAddonTicketIds = await getRelatedAddonTicketIds(tx, selectedAddonTicketIds);
                    const existingAddons = await tx
                        .select({ id: registrationSessions.id })
                        .from(registrationSessions)
                        .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                        .where(and(
                            eq(registrations.userId, userId),
                            eq(registrations.eventId, eventId),
                            eq(registrations.status, "confirmed"),
                            inArray(registrationSessions.ticketTypeId, relatedAddonTicketIds),
                        ))
                        .limit(1);
                    if (existingAddons.length > 0) throw new Error("DUPLICATE_ADDON_REGISTRATION");
                }

                // 5. Check quota
                if (ticket.quota > 0 && ticket.soldCount >= ticket.quota) throw new Error("TICKET_SOLD_OUT");
                for (const addon of addonTickets) {
                    if (addon.quota > 0 && addon.soldCount >= addon.quota) {
                        throw new Error("ADDON_TICKET_SOLD_OUT");
                    }
                }

                // 6. Generate regCode & insert registration
                const regCode = generateRegCode();
                const [newReg] = await tx.insert(registrations).values({
                    regCode,
                    eventId,
                    ticketTypeId,
                    userId,
                    email: user.email,
                    firstName: user.firstName,
                    middleName: user.middleName,
                    lastName: user.lastName,
                    status: "confirmed",
                    source: "manual",
                    addedBy: staffUser.id,
                    addedNote: note || null,
                }).returning();

                // 7. Determine sessions to link. Add-ons always use their own ticket type.
                const addonSessionLinks = await getAddonSessionLinks(tx, eventId, addonTickets, selectionMap);
                const addonSessionIds = new Set(addonSessionLinks.map(link => link.sessionId));
                const sessionsToLink = (await resolvePrimarySessionIds(tx, eventId, ticketTypeId, sessionIds || [], selectionMap))
                    .filter((sid) => !addonSessionIds.has(sid));

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
                for (const link of addonSessionLinks) {
                    await tx.insert(registrationSessions).values({
                        registrationId: newReg.id,
                        sessionId: link.sessionId,
                        ticketTypeId: link.ticketTypeId,
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
                for (const addon of addonTickets) {
                    await tx
                        .update(ticketTypes)
                        .set({ soldCount: sql`${ticketTypes.soldCount} + 1` })
                        .where(eq(ticketTypes.id, addon.id));
                }

                const allLinkedSessionIds = uniquePositiveIds([
                    ...sessionsToLink,
                    ...addonSessionLinks.map(link => link.sessionId),
                ]);

                return {
                    ...newReg,
                    ticketName: ticket.name,
                    eventName: event.eventName,
                    eventRow: event,
                    sessionCount: allLinkedSessionIds.length,
                    sessionsLinked: allLinkedSessionIds,
                    userEmail: user.email,
                    userFirstName: user.firstName,
                    userMiddleName: user.middleName,
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
                    const sessionDetails = registration.sessionsLinked.length > 0
                        ? await db
                            .select({ sessionName: sessions.sessionName, startTime: sessions.startTime, endTime: sessions.endTime })
                            .from(sessions)
                            .where(inArray(sessions.id, registration.sessionsLinked))
                        : [];
                    if (eventId === 1) {
                        const { sendManualRegistrationEmail } = await import("../../services/emailService.js");
                        await sendManualRegistrationEmail(
                            registration.userEmail,
                            registration.userFirstName,
                            registration.userMiddleName,
                            registration.userLastName,
                            registration.regCode,
                            registration.eventRow.eventName,
                            registration.ticketName,
                            sessionDetails,
                        );
                    } else {
                        const { sendEventRegistrationEmail } = await import("../../services/emailTemplates.js");
                        const { buildEventEmailContext } = await import("../../services/emailTemplates.types.js");
                        const eventCtx = buildEventEmailContext(registration.eventRow);
                        await sendEventRegistrationEmail(
                            registration.userEmail,
                            registration.userFirstName,
                            registration.userMiddleName,
                            registration.userLastName,
                            registration.regCode,
                            registration.ticketName,
                            sessionDetails,
                            eventCtx,
                        );
                    }
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
                DUPLICATE_ADDON_REGISTRATION: { status: 409, message: "User already has one of the selected add-ons" },
                TICKET_SOLD_OUT: { status: 409, message: "Ticket is sold out" },
                ADDON_TICKET_NOT_FOUND: { status: 404, message: "Add-on ticket not found or does not belong to event" },
                ADDON_TICKET_SOLD_OUT: { status: 409, message: "One of the selected add-ons is sold out" },
                ADDON_TICKET_HAS_NO_SESSIONS: { status: 400, message: "One of the selected add-ons has no linked sessions" },
                ADDON_TICKET_REQUIRES_SESSION: { status: 400, message: "Please select at least one session for each selected add-on" },
                WORKSHOP_REQUIRES_ONE_SESSION: { status: 400, message: "Workshop add-ons require exactly one selected session" },
                SESSION_NOT_FOUND: { status: 400, message: "Some selected sessions do not belong to this event" },
                SESSION_NOT_LINKED_TO_TICKET: { status: 400, message: "Some selected sessions are not linked to the selected ticket type" },
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

    // ── Stats: Registrations grouped by Country ───────────
    // Returns count of registrations per country (default: confirmed only).
    // Restricts to staff-assigned events when not admin.
    fastify.get("/stats/by-country", async (request, reply) => {
        const queryResult = registrationStatsByCountrySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { eventId, status } = queryResult.data;
        const user = (request as any).user;

        try {
            const conditions = [eq(registrations.status, status)];

            // Restrict non-admin staff to assigned events only
            if (user && user.role !== "admin") {
                const assignments = await db
                    .select({ eventId: staffEventAssignments.eventId })
                    .from(staffEventAssignments)
                    .where(eq(staffEventAssignments.staffId, user.id));

                const assignedEventIds = assignments.map((a) => a.eventId);
                if (assignedEventIds.length === 0) {
                    return reply.send({ total: 0, withCountry: 0, unknown: 0, byCountry: [] });
                }
                conditions.push(inArray(registrations.eventId, assignedEventIds));
            }

            if (eventId) conditions.push(eq(registrations.eventId, eventId));

            const whereClause = and(...conditions);

            // Group by country (NULL/empty grouped as "Unknown")
            const rows = await db
                .select({
                    country: users.country,
                    count: count(),
                })
                .from(registrations)
                .leftJoin(users, eq(registrations.userId, users.id))
                .where(whereClause)
                .groupBy(users.country)
                .orderBy(desc(count()));

            let total = 0;
            let unknown = 0;
            const byCountry: { country: string; count: number }[] = [];

            for (const row of rows) {
                const c = Number(row.count);
                total += c;
                if (!row.country || row.country.trim() === "") {
                    unknown += c;
                } else {
                    byCountry.push({ country: row.country, count: c });
                }
            }

            return reply.send({
                total,
                withCountry: total - unknown,
                unknown,
                byCountry,
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch country stats" });
        }
    });

    // ── Stats: Add-on breakdown (Gala / Workshop / Ticket Only) ──
    // Returns counts of confirmed registrations per add-on group:
    //   - gala:       has at least one confirmed Gala add-on
    //   - workshop:   has at least one confirmed Workshop add-on
    //   - ticketOnly: has NO add-on at all (primary ticket only)
    //   - total:      total confirmed registrations for the event
    fastify.get("/stats/by-addon", async (request, reply) => {
        const queryResult = registrationStatsByAddonSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { eventId, status } = queryResult.data;
        const user = (request as any).user;

        try {
            const conditions = [
                eq(registrations.eventId, eventId),
                eq(registrations.status, status),
            ];

            // Restrict non-admin staff to assigned events only
            if (user && user.role !== "admin") {
                const assignments = await db
                    .select({ eventId: staffEventAssignments.eventId })
                    .from(staffEventAssignments)
                    .where(eq(staffEventAssignments.staffId, user.id));

                const assignedEventIds = assignments.map((a) => a.eventId);
                if (assignedEventIds.length === 0 || !assignedEventIds.includes(eventId)) {
                    return reply.send({ total: 0, gala: 0, workshop: 0, ticketOnly: 0 });
                }
            }

            // EXISTS subquery factory: registration has at least one add-on of given groupName
            const hasAddonGroup = (groupNameLower: string) =>
                exists(
                    db.select({ id: registrationSessions.id })
                        .from(registrationSessions)
                        .innerJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
                        .where(and(
                            eq(registrationSessions.registrationId, registrations.id),
                            eq(ticketTypes.category, "addon"),
                            sql`LOWER(${ticketTypes.groupName}) = ${groupNameLower}`,
                        ))
                );

            // NOT EXISTS: registration has no add-on at all
            const hasNoAddon = notExists(
                db.select({ id: registrationSessions.id })
                    .from(registrationSessions)
                    .innerJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
                    .where(and(
                        eq(registrationSessions.registrationId, registrations.id),
                        eq(ticketTypes.category, "addon"),
                    ))
            );

            const baseWhere = and(...conditions);

            // Run all 4 counts in parallel
            const [totalRow, galaRow, workshopRow, ticketOnlyRow] = await Promise.all([
                db.select({ c: count() })
                    .from(registrations)
                    .where(baseWhere),
                db.select({ c: count() })
                    .from(registrations)
                    .where(and(baseWhere, hasAddonGroup("gala"))),
                db.select({ c: count() })
                    .from(registrations)
                    .where(and(baseWhere, hasAddonGroup("workshop"))),
                db.select({ c: count() })
                    .from(registrations)
                    .where(and(baseWhere, hasNoAddon)),
            ]);

            return reply.send({
                total: Number(totalRow[0]?.c ?? 0),
                gala: Number(galaRow[0]?.c ?? 0),
                workshop: Number(workshopRow[0]?.c ?? 0),
                ticketOnly: Number(ticketOnlyRow[0]?.c ?? 0),
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch add-on stats" });
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

        const { userIds, eventId, ticketTypeId, addonTicketTypeIds, ticketSessionSelections, sessionIds, note } = result.data;

        try {
            const results = await db.transaction(async (tx) => {
                const selectedAddonTicketIds = uniquePositiveIds(addonTicketTypeIds, ticketTypeId);
                const selectionMap = buildTicketSessionSelectionMap(ticketSessionSelections);

                // 1. Validate event exists
                const [event] = await tx
                    .select({
                        id: events.id,
                        eventName: events.eventName,
                        startDate: events.startDate,
                        endDate: events.endDate,
                        location: events.location,
                        websiteUrl: events.websiteUrl,
                        shortName: events.shortName,
                    })
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

                const addonTickets = selectedAddonTicketIds.length > 0
                    ? await tx
                        .select({ id: ticketTypes.id, name: ticketTypes.name, groupName: ticketTypes.groupName, quota: ticketTypes.quota, soldCount: ticketTypes.soldCount })
                        .from(ticketTypes)
                        .where(and(
                            inArray(ticketTypes.id, selectedAddonTicketIds),
                            eq(ticketTypes.eventId, eventId),
                            eq(ticketTypes.category, "addon"),
                        ))
                    : [];
                if (addonTickets.length !== selectedAddonTicketIds.length) {
                    throw new Error("ADDON_TICKET_NOT_FOUND");
                }

                // 3. Get all users
                const userList = await tx
                    .select({ id: users.id, email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
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

                let alreadyHasSelectedAddon = new Set<number | null>();
                if (selectedAddonTicketIds.length > 0) {
                    const relatedAddonTicketIds = await getRelatedAddonTicketIds(tx, selectedAddonTicketIds);
                    const existingAddonRegs = await tx
                        .select({ userId: registrations.userId })
                        .from(registrationSessions)
                        .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                        .where(and(
                            inArray(registrations.userId, userIds),
                            eq(registrations.eventId, eventId),
                            eq(registrations.status, "confirmed"),
                            inArray(registrationSessions.ticketTypeId, relatedAddonTicketIds),
                        ));
                    alreadyHasSelectedAddon = new Set(existingAddonRegs.map(r => r.userId));
                }

                // 5. Determine sessions to link
                const addonSessionLinks = await getAddonSessionLinks(tx, eventId, addonTickets, selectionMap);
                const addonSessionIds = new Set(addonSessionLinks.map(link => link.sessionId));
                const sessionsToLink = (await resolvePrimarySessionIds(tx, eventId, ticketTypeId, sessionIds || [], selectionMap))
                    .filter((sid) => !addonSessionIds.has(sid));

                // 6. Process each user
                const successList: any[] = [];
                const skippedList: { userId: number; reason: string }[] = [];
                let addedCount = 0;
                const addonAddedCounts = new Map<number, number>();

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
                    if (alreadyHasSelectedAddon.has(userId)) {
                        skippedList.push({ userId, reason: "ADDON_ALREADY_REGISTERED" });
                        continue;
                    }

                    // Check quota
                    if (ticket.quota > 0 && ticket.soldCount + addedCount >= ticket.quota) {
                        skippedList.push({ userId, reason: "TICKET_SOLD_OUT" });
                        continue;
                    }
                    const soldOutAddon = addonTickets.find((addon) => (
                        addon.quota > 0 &&
                        addon.soldCount + (addonAddedCounts.get(addon.id) || 0) >= addon.quota
                    ));
                    if (soldOutAddon) {
                        skippedList.push({ userId, reason: "ADDON_TICKET_SOLD_OUT" });
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
                        middleName: user.middleName,
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
                    for (const link of addonSessionLinks) {
                        await tx.insert(registrationSessions).values({
                            registrationId: newReg.id,
                            sessionId: link.sessionId,
                            ticketTypeId: link.ticketTypeId,
                            source: "manual",
                            addedBy: staffUser.id,
                            addedNote: note || null,
                        });
                    }

                    addedCount++;
                    for (const addon of addonTickets) {
                        addonAddedCounts.set(addon.id, (addonAddedCounts.get(addon.id) || 0) + 1);
                    }
                    successList.push({
                        registrationId: newReg.id,
                        userId,
                        regCode: newReg.regCode,
                        firstName: user.firstName,
                        middleName: user.middleName,
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
                for (const [addonTicketTypeId, countToAdd] of addonAddedCounts.entries()) {
                    if (countToAdd > 0) {
                        await tx
                            .update(ticketTypes)
                            .set({ soldCount: sql`${ticketTypes.soldCount} + ${countToAdd}` })
                            .where(eq(ticketTypes.id, addonTicketTypeId));
                    }
                }

                const allLinkedSessionIds = uniquePositiveIds([
                    ...sessionsToLink,
                    ...addonSessionLinks.map(link => link.sessionId),
                ]);

                return { successList, skippedList, addedCount, sessionsToLink: allLinkedSessionIds, eventRow: event };
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
                        const sessionDetails = results.sessionsToLink.length > 0
                            ? await db
                                .select({ sessionName: sessions.sessionName, startTime: sessions.startTime, endTime: sessions.endTime })
                                .from(sessions)
                                .where(inArray(sessions.id, results.sessionsToLink))
                            : [];

                        const isAccp = eventId === 1;
                        const { sendEventRegistrationEmail } = isAccp ? { sendEventRegistrationEmail: null } : await import("../../services/emailTemplates.js");
                        const { sendManualRegistrationEmail } = isAccp ? await import("../../services/emailService.js") : { sendManualRegistrationEmail: null };
                        const eventCtx = isAccp ? null : (await import("../../services/emailTemplates.types.js")).buildEventEmailContext(results.eventRow);

                        for (const reg of results.successList) {
                            try {
                                const user = await db
                                    .select({ email: users.email })
                                    .from(users)
                                    .where(eq(users.id, reg.userId))
                                    .limit(1);
                                const ticketRow = await db
                                    .select({ name: ticketTypes.name })
                                    .from(ticketTypes)
                                    .where(eq(ticketTypes.id, ticketTypeId))
                                    .limit(1);

                                if (user[0] && ticketRow[0]) {
                                    if (isAccp && sendManualRegistrationEmail) {
                                        await sendManualRegistrationEmail(
                                            user[0].email,
                                            reg.firstName,
                                            reg.middleName,
                                            reg.lastName,
                                            reg.regCode,
                                            results.eventRow.eventName,
                                            ticketRow[0].name,
                                            sessionDetails,
                                        );
                                    } else if (!isAccp && sendEventRegistrationEmail && eventCtx) {
                                        await sendEventRegistrationEmail(
                                            user[0].email,
                                            reg.firstName,
                                            reg.middleName,
                                            reg.lastName,
                                            reg.regCode,
                                            ticketRow[0].name,
                                            sessionDetails,
                                            eventCtx,
                                        );
                                    }
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
                ADDON_TICKET_NOT_FOUND: { status: 404, message: "Add-on ticket not found or does not belong to event" },
                ADDON_TICKET_HAS_NO_SESSIONS: { status: 400, message: "One of the selected add-ons has no linked sessions" },
                ADDON_TICKET_REQUIRES_SESSION: { status: 400, message: "Please select at least one session for each selected add-on" },
                WORKSHOP_REQUIRES_ONE_SESSION: { status: 400, message: "Workshop add-ons require exactly one selected session" },
                SESSION_NOT_FOUND: { status: 400, message: "Some selected sessions do not belong to this event" },
                SESSION_NOT_LINKED_TO_TICKET: { status: 400, message: "Some selected sessions are not linked to the selected ticket type" },
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
