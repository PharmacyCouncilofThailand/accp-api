import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
    events,
    sessions,
    ticketTypes,
    eventImages,
    staffEventAssignments,
} from "../../database/schema.js";
import {
    createEventSchema,
    updateEventSchema,
    createSessionSchema,
    updateSessionSchema,
    createTicketTypeSchema,
    updateTicketTypeSchema,
    eventQuerySchema,
} from "../../schemas/events.schema.js";
import { eq, desc, ilike, and, sql, count, inArray } from "drizzle-orm";
import type { JWTPayload, EventUpdatePayload, SessionUpdatePayload, TicketTypeUpdatePayload } from "../../types/index.js";

export default async function (fastify: FastifyInstance) {
    // ============================================================================
    // EVENTS CRUD
    // ============================================================================

    // List Events with pagination and filters
    fastify.get("", async (request, reply) => {
        const queryResult = eventQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply
                .status(400)
                .send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { status, eventType, search, page, limit } = queryResult.data;
        const offset = (page - 1) * limit;

        // Get user from request (set by auth middleware)
        const user = (request as { user?: JWTPayload }).user;

        try {
            // Build where conditions
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
                        events: [],
                        pagination: {
                            page,
                            limit,
                            total: 0,
                            totalPages: 0,
                        },
                    });
                }

                conditions.push(inArray(events.id, assignedEventIds));
            }

            if (status) {
                conditions.push(eq(events.status, status));
            }
            if (eventType) {
                conditions.push(eq(events.eventType, eventType));
            }
            if (search) {
                conditions.push(
                    ilike(events.eventName, `%${search}%`)
                );
            }

            const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

            // Get total count
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(events)
                .where(whereClause);

            // Get events
            const eventList = await db
                .select()
                .from(events)
                .where(whereClause)
                .orderBy(desc(events.createdAt))
                .limit(limit)
                .offset(offset);

            return reply.send({
                events: eventList,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch events" });
        }
    });

    // Get Single Event by ID (with sessions and tickets)
    fastify.get("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            const [event] = await db
                .select()
                .from(events)
                .where(eq(events.id, parseInt(id)))
                .limit(1);

            if (!event) {
                return reply.status(404).send({ error: "Event not found" });
            }

            // Get sessions for this event
            const eventSessions = await db
                .select()
                .from(sessions)
                .where(eq(sessions.eventId, parseInt(id)))
                .orderBy(sessions.startTime);

            // Get tickets for this event
            const eventTickets = await db
                .select()
                .from(ticketTypes)
                .where(eq(ticketTypes.eventId, parseInt(id)));

            // Get venue images
            const venueImages = await db
                .select()
                .from(eventImages)
                .where(eq(eventImages.eventId, parseInt(id)))
                .orderBy(eventImages.sortOrder);

            return reply.send({
                event,
                sessions: eventSessions,
                tickets: eventTickets,
                venueImages,
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch event" });
        }
    });

    // Create Event
    fastify.post("", async (request, reply) => {
        const result = createEventSchema.safeParse(request.body);
        if (!result.success) {
            return reply
                .status(400)
                .send({ error: "Invalid input", details: result.error.flatten() });
        }

        const data = result.data;

        try {
            // Check if event code already exists
            const existing = await db
                .select()
                .from(events)
                .where(eq(events.eventCode, data.eventCode))
                .limit(1);

            if (existing.length > 0) {
                return reply.status(409).send({ error: "Event code already exists" });
            }

            const [newEvent] = await db
                .insert(events)
                .values({
                    eventCode: data.eventCode,
                    eventName: data.eventName,
                    description: data.description,
                    eventType: data.eventType,
                    location: data.location,
                    category: data.category,
                    startDate: new Date(new Date(data.startDate).setHours(0, 0, 0, 0)),
                    endDate: new Date(new Date(data.endDate).setHours(0, 0, 0, 0)),
                    maxCapacity: data.maxCapacity,
                    conferenceCode: data.conferenceCode,
                    cpeCredits: data.cpeCredits,
                    status: data.status,
                    imageUrl: data.imageUrl,
                    mapUrl: data.mapUrl,
                    abstractStartDate: data.abstractStartDate ? new Date(new Date(data.abstractStartDate).setHours(0, 0, 0, 0)) : null,
                    abstractEndDate: data.abstractEndDate ? new Date(new Date(data.abstractEndDate).setHours(0, 0, 0, 0)) : null,
                })
                .returning();

            return reply.status(201).send({ event: newEvent });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to create event" });
        }
    });

    // Update Event
    fastify.patch("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = updateEventSchema.safeParse(request.body);
        if (!result.success) {
            return reply
                .status(400)
                .send({ error: "Invalid input", details: result.error.flatten() });
        }

        const data = result.data;

        try {
            // Check if event code already exists (if updating eventCode)
            if (data.eventCode) {
                const existing = await db
                    .select()
                    .from(events)
                    .where(
                        and(
                            eq(events.eventCode, data.eventCode),
                            sql`${events.id} != ${parseInt(id)}`
                        )
                    )
                    .limit(1);

                if (existing.length > 0) {
                    return reply.status(409).send({ error: "Event code already exists" });
                }
            }

            const updates: Record<string, unknown> = {
                ...data,
                updatedAt: new Date(),
            };

            // Convert date strings to Date objects
            if (data.startDate) updates.startDate = new Date(new Date(data.startDate).setHours(0, 0, 0, 0));
            if (data.endDate) updates.endDate = new Date(new Date(data.endDate).setHours(0, 0, 0, 0));
            if (data.abstractStartDate) updates.abstractStartDate = new Date(new Date(data.abstractStartDate).setHours(0, 0, 0, 0));
            if (data.abstractEndDate) updates.abstractEndDate = new Date(new Date(data.abstractEndDate).setHours(0, 0, 0, 0));

            const [updatedEvent] = await db
                .update(events)
                .set(updates)
                .where(eq(events.id, parseInt(id)))
                .returning();

            if (!updatedEvent) {
                return reply.status(404).send({ error: "Event not found" });
            }

            return reply.send({ event: updatedEvent });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to update event" });
        }
    });

    // Delete Event
    fastify.delete("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            const [deletedEvent] = await db
                .delete(events)
                .where(eq(events.id, parseInt(id)))
                .returning();

            if (!deletedEvent) {
                return reply.status(404).send({ error: "Event not found" });
            }

            return reply.send({ success: true, message: "Event deleted" });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to delete event" });
        }
    });

    // ============================================================================
    // SESSIONS CRUD (nested under events)
    // ============================================================================

    // List Sessions for an Event
    fastify.get("/:eventId/sessions", async (request, reply) => {
        const { eventId } = request.params as { eventId: string };

        try {
            const sessionList = await db
                .select()
                .from(sessions)
                .where(eq(sessions.eventId, parseInt(eventId)))
                .orderBy(sessions.startTime);

            return reply.send({ sessions: sessionList });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch sessions" });
        }
    });

    // Create Session
    fastify.post("/:eventId/sessions", async (request, reply) => {
        const { eventId } = request.params as { eventId: string };
        const result = createSessionSchema.safeParse(request.body);
        if (!result.success) {
            return reply
                .status(400)
                .send({ error: "Invalid input", details: result.error.flatten() });
        }

        const data = result.data;

        try {
            // Verify event exists
            const [event] = await db
                .select()
                .from(events)
                .where(eq(events.id, parseInt(eventId)))
                .limit(1);

            if (!event) {
                return reply.status(404).send({ error: "Event not found" });
            }

            const [newSession] = await db
                .insert(sessions)
                .values({
                    eventId: parseInt(eventId),
                    sessionCode: data.sessionCode,
                    sessionName: data.sessionName,
                    description: data.description,
                    room: data.room,
                    startTime: new Date(data.startTime),
                    endTime: new Date(data.endTime),
                    speakers: data.speakers,
                    maxCapacity: data.maxCapacity,
                })
                .returning();

            return reply.status(201).send({ session: newSession });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to create session" });
        }
    });

    // Update Session
    fastify.patch("/:eventId/sessions/:sessionId", async (request, reply) => {
        const { sessionId } = request.params as { eventId: string; sessionId: string };
        const result = updateSessionSchema.safeParse(request.body);
        if (!result.success) {
            return reply
                .status(400)
                .send({ error: "Invalid input", details: result.error.flatten() });
        }

        const data = result.data;
        const updates: Record<string, unknown> = { ...data, updatedAt: new Date() };

        if (data.startTime) updates.startTime = new Date(data.startTime);
        if (data.endTime) updates.endTime = new Date(data.endTime);

        try {
            const [updatedSession] = await db
                .update(sessions)
                .set(updates)
                .where(eq(sessions.id, parseInt(sessionId)))
                .returning();

            if (!updatedSession) {
                return reply.status(404).send({ error: "Session not found" });
            }

            return reply.send({ session: updatedSession });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to update session" });
        }
    });

    // Delete Session
    fastify.delete("/:eventId/sessions/:sessionId", async (request, reply) => {
        const { sessionId } = request.params as { eventId: string; sessionId: string };

        try {
            const [deletedSession] = await db
                .delete(sessions)
                .where(eq(sessions.id, parseInt(sessionId)))
                .returning();

            if (!deletedSession) {
                return reply.status(404).send({ error: "Session not found" });
            }

            return reply.send({ success: true, message: "Session deleted" });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to delete session" });
        }
    });

    // ============================================================================
    // TICKET TYPES CRUD (nested under events)
    // ============================================================================

    // List Ticket Types for an Event
    fastify.get("/:eventId/tickets", async (request, reply) => {
        const { eventId } = request.params as { eventId: string };

        try {
            const ticketList = await db
                .select()
                .from(ticketTypes)
                .where(eq(ticketTypes.eventId, parseInt(eventId)));

            return reply.send({ tickets: ticketList });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch tickets" });
        }
    });

    // Create Ticket Type
    fastify.post("/:eventId/tickets", async (request, reply) => {
        const { eventId } = request.params as { eventId: string };
        const result = createTicketTypeSchema.safeParse(request.body);
        if (!result.success) {
            return reply
                .status(400)
                .send({ error: "Invalid input", details: result.error.flatten() });
        }

        const data = result.data;

        try {
            // Verify event exists
            const [event] = await db
                .select()
                .from(events)
                .where(eq(events.id, parseInt(eventId)))
                .limit(1);

            if (!event) {
                return reply.status(404).send({ error: "Event not found" });
            }

            const [newTicket] = await db
                .insert(ticketTypes)
                .values({
                    eventId: parseInt(eventId),
                    category: data.category,
                    groupName: data.groupName,
                    name: data.name,
                    sessionId: data.sessionId,
                    price: data.price,
                    currency: data.currency,
                    allowedRoles: data.allowedRoles,
                    quota: data.quota,
                    saleStartDate: data.saleStartDate ? new Date(data.saleStartDate) : null,
                    saleEndDate: data.saleEndDate ? new Date(data.saleEndDate) : null,
                })
                .returning();

            return reply.status(201).send({ ticket: newTicket });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to create ticket" });
        }
    });

    // Update Ticket Type
    fastify.patch("/:eventId/tickets/:ticketId", async (request, reply) => {
        const { ticketId } = request.params as { eventId: string; ticketId: string };
        const result = updateTicketTypeSchema.safeParse(request.body);
        if (!result.success) {
            return reply
                .status(400)
                .send({ error: "Invalid input", details: result.error.flatten() });
        }

        const data = result.data;
        const updates: Record<string, unknown> = { ...data };

        if (data.saleStartDate) updates.saleStartDate = new Date(data.saleStartDate);
        if (data.saleEndDate) updates.saleEndDate = new Date(data.saleEndDate);

        try {
            const [updatedTicket] = await db
                .update(ticketTypes)
                .set(updates)
                .where(eq(ticketTypes.id, parseInt(ticketId)))
                .returning();

            if (!updatedTicket) {
                return reply.status(404).send({ error: "Ticket not found" });
            }

            return reply.send({ ticket: updatedTicket });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to update ticket" });
        }
    });

    // Delete Ticket Type
    fastify.delete("/:eventId/tickets/:ticketId", async (request, reply) => {
        const { ticketId } = request.params as { eventId: string; ticketId: string };

        try {
            const [deletedTicket] = await db
                .delete(ticketTypes)
                .where(eq(ticketTypes.id, parseInt(ticketId)))
                .returning();

            if (!deletedTicket) {
                return reply.status(404).send({ error: "Ticket not found" });
            }

            return reply.send({ success: true, message: "Ticket deleted" });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to delete ticket" });
        }
    });

    // ============================================================================
    // EVENT IMAGES
    // ============================================================================

    // Add venue image
    fastify.post("/:eventId/images", async (request, reply) => {
        const { eventId } = request.params as { eventId: string };
        const { imageUrl, caption, imageType = "venue" } = request.body as {
            imageUrl: string;
            caption?: string;
            imageType?: string;
        };

        if (!imageUrl) {
            return reply.status(400).send({ error: "imageUrl is required" });
        }

        try {
            // Get next sort order
            const lastImage = await db
                .select({ sortOrder: eventImages.sortOrder })
                .from(eventImages)
                .where(eq(eventImages.eventId, parseInt(eventId)))
                .orderBy(desc(eventImages.sortOrder))
                .limit(1);

            const nextSortOrder = (lastImage[0]?.sortOrder ?? -1) + 1;

            const [newImage] = await db
                .insert(eventImages)
                .values({
                    eventId: parseInt(eventId),
                    imageUrl,
                    caption,
                    imageType,
                    sortOrder: nextSortOrder,
                })
                .returning();

            return reply.status(201).send({ image: newImage });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to add image" });
        }
    });

    // Delete venue image
    fastify.delete("/:eventId/images/:imageId", async (request, reply) => {
        const { imageId } = request.params as { eventId: string; imageId: string };

        try {
            const [deletedImage] = await db
                .delete(eventImages)
                .where(eq(eventImages.id, parseInt(imageId)))
                .returning();

            if (!deletedImage) {
                return reply.status(404).send({ error: "Image not found" });
            }

            return reply.send({ success: true, message: "Image deleted" });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to delete image" });
        }
    });
}
