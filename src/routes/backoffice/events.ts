import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  events,
  sessions,
  ticketTypes,
  ticketSessions,
  eventImages,
  staffEventAssignments,
  registrations,
  speakers,
  eventSpeakers,
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
import type {
  JWTPayload,
  EventUpdatePayload,
  SessionUpdatePayload,
  TicketTypeUpdatePayload,
} from "../../types/index.js";

/**
 * Normalize allowedRoles to CSV format for consistent DB storage.
 * Handles: JSON array string '["thstd","thpro"]' → 'thstd,thpro'
 *          Already CSV 'thstd,thpro' → 'thstd,thpro'
 *          undefined/null → undefined
 */
function normalizeAllowedRoles(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("[")) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.join(",");
    } catch {
      // not valid JSON, return as-is
    }
  }
  return raw;
}

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
      if (user && user.role !== "admin") {
        const assignments = await db
          .select({ eventId: staffEventAssignments.eventId })
          .from(staffEventAssignments)
          .where(eq(staffEventAssignments.staffId, user.id));

        const assignedEventIds = assignments.map((a) => a.eventId);

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
        conditions.push(ilike(events.eventName, `%${search}%`));
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

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
      const sessionList = await db
        .select()
        .from(sessions)
        .where(eq(sessions.eventId, parseInt(id)))
        .orderBy(sessions.startTime);

      // Fetch speakers for these sessions (batch query to avoid N+1)
      const sessionIds = sessionList.map((s) => s.id);
      const allSpeakers =
        sessionIds.length > 0
          ? await db
              .select({
                sessionId: eventSpeakers.sessionId,
                firstName: speakers.firstName,
                lastName: speakers.lastName,
              })
              .from(eventSpeakers)
              .innerJoin(speakers, eq(eventSpeakers.speakerId, speakers.id))
              .where(inArray(eventSpeakers.sessionId, sessionIds))
          : [];

      // Group speakers by session in memory
      const speakersBySession = allSpeakers.reduce<Record<number, string[]>>(
        (acc, s) => {
          if (s.sessionId === null) return acc;
          if (!acc[s.sessionId]) acc[s.sessionId] = [];
          acc[s.sessionId].push(`${s.firstName} ${s.lastName}`);
          return acc;
        },
        {},
      );

      const sessionsWithSpeakers = sessionList.map((s) => ({
        ...s,
        speakers: speakersBySession[s.id] || [],
      }));

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
        sessions: sessionsWithSpeakers,
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
          cpeCredits:
            data.cpeCredits != null ? String(data.cpeCredits) : undefined,
          status: data.status,
          imageUrl: data.imageUrl,
          mapUrl: data.mapUrl,
          abstractStartDate: data.abstractStartDate
            ? new Date(new Date(data.abstractStartDate).setHours(0, 0, 0, 0))
            : null,
          abstractEndDate: data.abstractEndDate
            ? new Date(new Date(data.abstractEndDate).setHours(0, 0, 0, 0))
            : null,
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
              sql`${events.id} != ${parseInt(id)}`,
            ),
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
      if (data.startDate)
        updates.startDate = new Date(
          new Date(data.startDate).setHours(0, 0, 0, 0),
        );
      if (data.endDate)
        updates.endDate = new Date(new Date(data.endDate).setHours(0, 0, 0, 0));
      if (data.abstractStartDate)
        updates.abstractStartDate = new Date(
          new Date(data.abstractStartDate).setHours(0, 0, 0, 0),
        );
      if (data.abstractEndDate)
        updates.abstractEndDate = new Date(
          new Date(data.abstractEndDate).setHours(0, 0, 0, 0),
        );

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
    const eventId = parseInt(id);

    try {
      // Check for related tickets
      const relatedTickets = await db
        .select({ id: ticketTypes.id })
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, eventId))
        .limit(1);

      if (relatedTickets.length > 0) {
        return reply.status(409).send({
          error:
            "Cannot delete event with existing tickets. Please delete all tickets first.",
        });
      }

      // Check for related sessions
      const relatedSessions = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.eventId, eventId))
        .limit(1);

      if (relatedSessions.length > 0) {
        return reply.status(409).send({
          error:
            "Cannot delete event with existing sessions. Please delete all sessions first.",
        });
      }

      const [deletedEvent] = await db
        .delete(events)
        .where(eq(events.id, eventId))
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

      // Fetch speakers for these sessions (batch query to avoid N+1)
      const sessionIds = sessionList.map((s) => s.id);
      const allSpeakers =
        sessionIds.length > 0
          ? await db
              .select({
                sessionId: eventSpeakers.sessionId,
                firstName: speakers.firstName,
                lastName: speakers.lastName,
              })
              .from(eventSpeakers)
              .innerJoin(speakers, eq(eventSpeakers.speakerId, speakers.id))
              .where(inArray(eventSpeakers.sessionId, sessionIds))
          : [];

      // Group speakers by session in memory
      const speakersBySession = allSpeakers.reduce<Record<number, string[]>>(
        (acc, s) => {
          if (s.sessionId === null) return acc;
          if (!acc[s.sessionId]) acc[s.sessionId] = [];
          acc[s.sessionId].push(`${s.firstName} ${s.lastName}`);
          return acc;
        },
        {},
      );

      const sessionsWithSpeakers = sessionList.map((s) => ({
        ...s,
        speakers: speakersBySession[s.id] || [],
      }));

      return reply.send({ sessions: sessionsWithSpeakers });
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

      const newSession = await db.transaction(async (tx) => {
        const [session] = await tx
          .insert(sessions)
          .values({
            eventId: parseInt(eventId),
            sessionCode: data.sessionCode,
            sessionName: data.sessionName,
            sessionType: data.sessionType,
            isMainSession: data.isMainSession ?? false,
            description: data.description,
            room: data.room,
            startTime: new Date(data.startTime),
            endTime: new Date(data.endTime),
            maxCapacity: data.maxCapacity,
          })
          .returning();

        // Handle speaker assignments
        if (data.speakerIds && data.speakerIds.length > 0) {
          await tx.insert(eventSpeakers).values(
            data.speakerIds.map((sid) => ({
              eventId: parseInt(eventId),
              sessionId: session.id,
              speakerId: sid,
              speakerType: "guest" as const, // Default to guest, can be updated later if needed
              sortOrder: 0,
            })),
          );
        }

        return session;
      });

      return reply.status(201).send({ session: newSession });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to create session" });
    }
  });

  // Update Session
  fastify.patch("/:eventId/sessions/:sessionId", async (request, reply) => {
    const { eventId, sessionId } = request.params as {
      eventId: string;
      sessionId: string;
    };
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
      const updatedSession = await db.transaction(async (tx) => {
        const [session] = await tx
          .update(sessions)
          .set(updates)
          .where(eq(sessions.id, parseInt(sessionId)))
          .returning();

        if (!session) return null;

        // Handle speaker assignments update if provided
        if (data.speakerIds !== undefined) {
          // Delete existing mappings for this session
          await tx
            .delete(eventSpeakers)
            .where(eq(eventSpeakers.sessionId, session.id));

          // Add new mappings
          if (data.speakerIds && data.speakerIds.length > 0) {
            await tx.insert(eventSpeakers).values(
              data.speakerIds.map((sid) => ({
                eventId: parseInt(eventId),
                sessionId: session.id,
                speakerId: sid,
                speakerType: "guest" as const,
                sortOrder: 0,
              })),
            );
          }
        }

        return session;
      });

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
    const { sessionId } = request.params as {
      eventId: string;
      sessionId: string;
    };

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

  // Get Session Enrollments (people registered for this session)
  fastify.get(
    "/:eventId/sessions/:sessionId/enrollments",
    async (request, reply) => {
      const { sessionId } = request.params as {
        eventId: string;
        sessionId: string;
      };

      try {
        // Get all ticket types for this session
        const sessionTicketTypes = await db
          .select({ id: ticketTypes.id })
          .from(ticketTypes)
          .where(eq(ticketTypes.sessionId, parseInt(sessionId)));

        if (sessionTicketTypes.length === 0) {
          // No ticket types for this session, return empty list
          return reply.send({ enrollments: [], count: 0 });
        }

        const ticketTypeIds = sessionTicketTypes.map((t) => t.id);

        // Get all registrations for these ticket types
        const enrollmentList = await db
          .select({
            id: registrations.id,
            regCode: registrations.regCode,
            email: registrations.email,
            firstName: registrations.firstName,
            lastName: registrations.lastName,
            status: registrations.status,
            createdAt: registrations.createdAt,
            ticketTypeId: registrations.ticketTypeId,
            ticketName: ticketTypes.name,
          })
          .from(registrations)
          .leftJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
          .where(inArray(registrations.ticketTypeId, ticketTypeIds))
          .orderBy(desc(registrations.createdAt));

        return reply.send({
          enrollments: enrollmentList,
          count: enrollmentList.length,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply
          .status(500)
          .send({ error: "Failed to fetch session enrollments" });
      }
    },
  );

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

      // Fetch linked sessions for all tickets in ONE query (avoid N+1)
      const ticketIds = ticketList.map((t) => t.id);
      const allSessionLinks =
        ticketIds.length > 0
          ? await db
              .select()
              .from(ticketSessions)
              .where(inArray(ticketSessions.ticketTypeId, ticketIds))
          : [];

      // Group session links by ticket in memory
      const sessionsByTicket = allSessionLinks.reduce<Record<number, number[]>>(
        (acc, link) => {
          if (!acc[link.ticketTypeId]) acc[link.ticketTypeId] = [];
          acc[link.ticketTypeId].push(link.sessionId);
          return acc;
        },
        {},
      );

      const ticketsWithSessions = ticketList.map((t) => ({
        ...t,
        sessionIds: sessionsByTicket[t.id] || [],
      }));

      return reply.send({ tickets: ticketsWithSessions });
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

      // Start transaction
      const newTicket = await db.transaction(async (tx) => {
        const [ticket] = await tx
          .insert(ticketTypes)
          .values({
            eventId: parseInt(eventId),
            category: data.category,
            groupName: data.groupName,
            name: data.name,
            sessionId: data.sessionId, // Keep for backward compat
            price: String(data.price),
            currency: data.currency,
            allowedRoles: normalizeAllowedRoles(data.allowedRoles),
            quota: data.quota,
            displayOrder: data.displayOrder,
            saleStartDate: data.saleStartDate
              ? new Date(data.saleStartDate)
              : null,
            saleEndDate: data.saleEndDate ? new Date(data.saleEndDate) : null,
            description: data.description,
            originalPrice:
              data.originalPrice != null
                ? String(data.originalPrice)
                : null,
            features: data.features,
            badgeText: data.badgeText,
            isActive: data.isActive ?? true,
          })
          .returning();

        // Handle session linking
        const sessionsToLink =
          data.sessionIds || (data.sessionId ? [data.sessionId] : []);

        if (sessionsToLink.length > 0) {
          await tx.insert(ticketSessions).values(
            sessionsToLink.map((sid) => ({
              ticketTypeId: ticket.id,
              sessionId: sid,
            })),
          );
        }

        return {
          ...ticket,
          sessionIds: sessionsToLink,
        };
      });

      return reply.status(201).send({ ticket: newTicket });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to create ticket" });
    }
  });

  // Update Ticket Type
  fastify.patch("/:eventId/tickets/:ticketId", async (request, reply) => {
    const { ticketId } = request.params as {
      eventId: string;
      ticketId: string;
    };
    const result = updateTicketTypeSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const data = result.data;
    const updates: Record<string, unknown> = { ...data };

    // Remove fields that aren't direct DB columns
    delete updates.sessionIds;
    delete updates.sessionId;

    if (data.allowedRoles !== undefined) updates.allowedRoles = normalizeAllowedRoles(data.allowedRoles);
    if (data.price !== undefined) updates.price = String(data.price);
    if (data.originalPrice !== undefined)
      updates.originalPrice =
        data.originalPrice != null ? String(data.originalPrice) : null;
    if (data.saleStartDate)
      updates.saleStartDate = new Date(data.saleStartDate);
    if (data.saleEndDate) updates.saleEndDate = new Date(data.saleEndDate);

    try {
      const updatedTicket = await db.transaction(async (tx) => {
        const [ticket] = await tx
          .update(ticketTypes)
          .set(updates)
          .where(eq(ticketTypes.id, parseInt(ticketId)))
          .returning();

        if (!ticket) return null;

        // Handle session linking update if provided
        if (data.sessionIds !== undefined) {
          // Delete existing links
          await tx
            .delete(ticketSessions)
            .where(eq(ticketSessions.ticketTypeId, ticket.id));

          // Add new links
          if (data.sessionIds && data.sessionIds.length > 0) {
            await tx.insert(ticketSessions).values(
              data.sessionIds.map((sid) => ({
                ticketTypeId: ticket.id,
                sessionId: sid,
              })),
            );
          }
        } else if (data.sessionId !== undefined) {
          // Backward compatibility: if only sessionId is provided
          await tx
            .delete(ticketSessions)
            .where(eq(ticketSessions.ticketTypeId, ticket.id));
          if (data.sessionId) {
            await tx.insert(ticketSessions).values({
              ticketTypeId: ticket.id,
              sessionId: data.sessionId,
            });
          }
        }

        // Get current linked sessions
        const linkedSessions = await tx
          .select({ sessionId: ticketSessions.sessionId })
          .from(ticketSessions)
          .where(eq(ticketSessions.ticketTypeId, ticket.id));

        return {
          ...ticket,
          sessionIds: linkedSessions.map((ls) => ls.sessionId),
        };
      });

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
    const { ticketId } = request.params as {
      eventId: string;
      ticketId: string;
    };

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
    const {
      imageUrl,
      caption,
      imageType = "venue",
    } = request.body as {
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
