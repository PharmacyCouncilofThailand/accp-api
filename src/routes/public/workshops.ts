import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { sessions, events, ticketTypes, registrations, ticketSessions, eventSpeakers, speakers } from "../../database/schema.js";
import { eq, desc, sql, and, count, inArray } from "drizzle-orm";

export default async function publicWorkshopsRoutes(fastify: FastifyInstance) {
    // Get all published workshop sessions (public, no auth required)
    // Workshops are sessions belonging to events with category containing 'workshop'
    fastify.get("", async (request, reply) => {
        try {
            // Get all published events that are workshop-type
            const workshopEvents = await db
                .select({
                    id: events.id,
                    eventCode: events.eventCode,
                    eventName: events.eventName,
                    startDate: events.startDate,
                    location: events.location,
                })
                .from(events)
                .where(eq(events.status, "published"));

            if (workshopEvents.length === 0) {
                return reply.send({ workshops: [] });
            }

            const eventIds = workshopEvents.map(e => e.id);

            const workshopSessions = await db
                .select({
                    id: sessions.id,
                    eventId: sessions.eventId,
                    sessionCode: sessions.sessionCode,
                    sessionName: sessions.sessionName,
                    sessionType: sessions.sessionType,
                    description: sessions.description,
                    room: sessions.room,
                    startTime: sessions.startTime,
                    endTime: sessions.endTime,
                    maxCapacity: sessions.maxCapacity,
                })
                .from(sessions)
                .where(
                    and(
                        inArray(sessions.eventId, eventIds),
                        eq(sessions.isActive, true),
                        eq(sessions.sessionType, 'workshop')
                    )
                )
                .orderBy(sessions.startTime);

            // Fetch speakers for these sessions
            const workshopSessionIds = workshopSessions.map(s => s.id);
            const workshopSpeakers = workshopSessionIds.length > 0
                ? await db
                    .select({
                        sessionId: eventSpeakers.sessionId,
                        firstName: speakers.firstName,
                        lastName: speakers.lastName,
                        organization: speakers.organization,
                    })
                    .from(eventSpeakers)
                    .innerJoin(speakers, eq(eventSpeakers.speakerId, speakers.id))
                    .where(inArray(eventSpeakers.sessionId, workshopSessionIds))
                : [];

            // Get enrollment counts for each session
            // First get ticket types for these sessions
            const sessionIds = workshopSessions.map(s => s.id);

            // Get ticket types that are linked to these sessions
            // Get ticket types linked via ticketSessions (new way)
            const linkedTicketTypes = sessionIds.length > 0
                ? await db
                    .select({
                        sessionId: ticketSessions.sessionId,
                        ticketTypeId: ticketTypes.id,
                        name: ticketTypes.name,
                        price: ticketTypes.price,
                        saleStartDate: ticketTypes.saleStartDate,
                        currency: ticketTypes.currency,
                        allowedRoles: ticketTypes.allowedRoles
                    })
                    .from(ticketSessions)
                    .innerJoin(ticketTypes, eq(ticketSessions.ticketTypeId, ticketTypes.id))
                    .where(inArray(ticketSessions.sessionId, sessionIds))
                : [];

            // Get ticket types linked via legacy sessionId column
            const legacyTicketTypes = sessionIds.length > 0
                ? await db
                    .select({
                        sessionId: ticketTypes.sessionId,
                        ticketTypeId: ticketTypes.id,
                        name: ticketTypes.name,
                        price: ticketTypes.price,
                        saleStartDate: ticketTypes.saleStartDate,
                        currency: ticketTypes.currency,
                        allowedRoles: ticketTypes.allowedRoles
                    })
                    .from(ticketTypes)
                    .where(inArray(ticketTypes.sessionId, sessionIds))
                : [];

            // Merge both
            const sessionTicketTypes = [...linkedTicketTypes, ...legacyTicketTypes];

            // Get registration counts per ticket type
            const ticketTypeIds = sessionTicketTypes.map(t => t.ticketTypeId);

            interface RegistrationCount {
                ticketTypeId: number;
                count: number;
            }

            let registrationCounts: RegistrationCount[] = [];
            if (ticketTypeIds.length > 0) {
                registrationCounts = await db
                    .select({
                        ticketTypeId: registrations.ticketTypeId,
                        count: count(),
                    })
                    .from(registrations)
                    .where(
                        and(
                            inArray(registrations.ticketTypeId, ticketTypeIds),
                            eq(registrations.status, "confirmed")
                        )
                    )
                    .groupBy(registrations.ticketTypeId);
            }

            // Build enrollment map: sessionId -> count
            const enrollmentMap = new Map<number, number>();
            const saleDateMap = new Map<number, Date | null>();
            const sessionTicketsMap = new Map<number, typeof sessionTicketTypes>();


            for (const tt of sessionTicketTypes) {
                if (tt.sessionId) {
                    const regCount = registrationCounts.find(r => r.ticketTypeId === tt.ticketTypeId);
                    const currentCount = enrollmentMap.get(tt.sessionId) || 0;
                    enrollmentMap.set(tt.sessionId, currentCount + (regCount?.count || 0));

                    // Collect tickets for this session
                    const tickets = sessionTicketsMap.get(tt.sessionId) || [];
                    tickets.push(tt);
                    sessionTicketsMap.set(tt.sessionId, tickets);

                    // Track earliest sale start date
                    if (tt.saleStartDate) {
                        const existingDate = saleDateMap.get(tt.sessionId);
                        const newDate = new Date(tt.saleStartDate);
                        if (!existingDate || newDate < existingDate) {
                            saleDateMap.set(tt.sessionId, newDate);
                        }
                    }
                }
            }

            // Build response
            const workshops = workshopSessions.map((session, index) => {
                const event = workshopEvents.find(e => e.id === session.eventId);
                const enrolledCount = enrollmentMap.get(session.id) || 0;

                // Get all tickets for this session
                const sessionTickets = sessionTicketsMap.get(session.id) || [];

                // Format tickets for frontend
                const availableTickets = sessionTickets.map(t => ({
                    id: t.ticketTypeId,
                    name: t.name,
                    price: t.price,
                    currency: t.currency,
                    allowedRoles: t.allowedRoles ? JSON.parse(t.allowedRoles as string) : null,
                    saleStartDate: t.saleStartDate
                }));

                const isFull = session.maxCapacity ? enrolledCount >= session.maxCapacity : false;
                const saleStartDate = saleDateMap.get(session.id); // Get earliest sale date

                // Get speakers for this session
                const instructors = workshopSpeakers
                    .filter(ws => ws.sessionId === session.id)
                    .map(ws => ({
                        name: `${ws.firstName} ${ws.lastName}`,
                        affiliation: ws.organization || undefined
                    }));

                // Calculate duration
                const start = new Date(session.startTime);
                const end = new Date(session.endTime);
                const durationMs = end.getTime() - start.getTime();
                const durationHours = durationMs / (1000 * 60 * 60);

                // Assign colors based on index
                const colors = ['#8B5CF6', '#3B82F6', '#10B981', '#F59E0B', '#EC4899', '#6366F1'];
                const icons = ['fa-flask-vial', 'fa-microscope', 'fa-clipboard-check', 'fa-vial', 'fa-brain', 'fa-dna'];

                return {
                    id: session.sessionCode,
                    sessionId: session.id,
                    eventId: session.eventId,
                    title: session.sessionName,
                    description: session.description,
                    date: event?.startDate ? new Date(event.startDate).toLocaleDateString('en-US', {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric'
                    }) : '',
                    time: `${start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })} - ${end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
                    duration: durationHours >= 6 ? 'fullDay' : 'halfDay',
                    venue: session.room || event?.location || '',
                    capacity: session.maxCapacity || 0,
                    enrolled: enrolledCount,
                    // fee property is deprecated but kept for backward compatibility if needed, though frontend should use tickets
                    fee: availableTickets.length > 0
                        ? `${availableTickets[0].currency} ${parseFloat(availableTickets[0].price).toLocaleString()}`
                        : 'Free',
                    tickets: availableTickets,
                    instructors: instructors,
                    color: colors[index % colors.length],
                    icon: icons[index % icons.length],
                    isFull,
                    saleStartDate: saleStartDate ? saleStartDate.toISOString() : null,
                };
            });

            return reply.send({ workshops });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch workshops" });
        }
    });
}
