import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  events,
  eventImages,
  sessions,
  ticketTypes,
  ticketSessions,
  registrations,
  users,
} from "../../database/schema.js";
import { eq, desc, min, asc, sql, and, inArray } from "drizzle-orm";

export default async function publicEventsRoutes(fastify: FastifyInstance) {
  // List all published events (public, no auth required)
  fastify.get("", async (request, reply) => {
    try {
      const eventList = await db
        .select({
          id: events.id,
          eventCode: events.eventCode,
          eventName: events.eventName,
          description: events.description,
          startDate: events.startDate,
          endDate: events.endDate,
          location: events.location,
          eventType: events.eventType,
          status: events.status,
          imageUrl: events.imageUrl,
          coverImage: events.coverImage,
          videoUrl: events.videoUrl,
          websiteUrl: events.websiteUrl,
          documents: events.documents,
        })
        .from(events)
        .where(eq(events.status, "published"))
        .orderBy(desc(events.startDate));

      // Fetch earliest session start time for each event
      const eventIds = eventList.map((e) => e.id);
      let sessionTimesMap: Record<number, string> = {};
      if (eventIds.length > 0) {
        const sessionTimes = await db
          .select({
            eventId: sessions.eventId,
            earliestStart: min(sessions.startTime),
          })
          .from(sessions)
          .where(eq(sessions.isActive, true))
          .groupBy(sessions.eventId);

        for (const st of sessionTimes) {
          if (st.earliestStart) {
            sessionTimesMap[st.eventId] = new Date(st.earliestStart).toISOString();
          }
        }
      }

      const enrichedEvents = eventList.map((e) => ({
        ...e,
        firstSessionStart: sessionTimesMap[e.id] || null,
      }));

      return reply.send({ events: enrichedEvents });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch events" });
    }
  });

  // Get single event by ID or code (public)
  fastify.get("/:id/university-stats", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const isNumeric = /^\d+$/.test(id);

      const [event] = await db
        .select({
          id: events.id,
          eventCode: events.eventCode,
          eventName: events.eventName,
          status: events.status,
        })
        .from(events)
        .where(isNumeric ? eq(events.id, parseInt(id, 10)) : eq(events.eventCode, id))
        .limit(1);

      if (!event || event.status !== "published") {
        return reply.status(404).send({ error: "Event not found" });
      }

      const universityRows = await db
        .select({
          university: users.university,
          count: sql<number>`count(*)::int`,
        })
        .from(registrations)
        .innerJoin(users, eq(registrations.userId, users.id))
        .where(
          and(
            eq(registrations.eventId, event.id),
            eq(registrations.status, "confirmed"),
            sql`${users.university} IS NOT NULL`,
            sql`trim(${users.university}) <> ''`
          )
        )
        .groupBy(users.university)
        .orderBy(desc(sql<number>`count(*)::int`), asc(users.university));

      const [summary] = await db
        .select({
          totalRegistrants: sql<number>`count(*)::int`,
        })
        .from(registrations)
        .where(
          and(
            eq(registrations.eventId, event.id),
            eq(registrations.status, "confirmed")
          )
        );

      return reply.send({
        eventId: event.id,
        eventCode: event.eventCode,
        eventName: event.eventName,
        totalRegistrants: summary?.totalRegistrants || 0,
        totalUniversities: universityRows.length,
        universities: universityRows.map((row) => ({
          name: row.university,
          count: row.count,
        })),
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch university stats" });
    }
  });

  // Get single event by ID or code (public)
  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      // Check if id is numeric (ID) or string (event code)
      const isNumeric = /^\d+$/.test(id);

      const [event] = await db
        .select()
        .from(events)
        .where(isNumeric ? eq(events.id, parseInt(id)) : eq(events.eventCode, id))
        .limit(1);

      if (!event) {
        return reply.status(404).send({ error: "Event not found" });
      }

      // Only return if published
      if (event.status !== "published") {
        return reply.status(404).send({ error: "Event not found" });
      }

      // Fetch venue images for this event
      const venueImages = await db
        .select()
        .from(eventImages)
        .where(eq(eventImages.eventId, event.id))
        .orderBy(eventImages.sortOrder);

      // Fetch sessions for this event
      const sessionList = await db
        .select()
        .from(sessions)
        .where(eq(sessions.eventId, event.id))
        .orderBy(sessions.startTime);

      // Fetch ticket types for this event
      const ticketList = await db
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, event.id));

      // Fetch ticket-session mappings for workshop tickets
      const ticketIds = ticketList.map(t => t.id);
      let ticketSessionMap: Record<number, typeof sessionList> = {};
      
      if (ticketIds.length > 0) {
        const ticketSessionRows = await db
          .select({
            ticketTypeId: ticketSessions.ticketTypeId,
            sessionId: ticketSessions.sessionId,
          })
          .from(ticketSessions)
          .where(inArray(ticketSessions.ticketTypeId, ticketIds));

        // Group sessions by ticketTypeId
        for (const row of ticketSessionRows) {
          if (!ticketSessionMap[row.ticketTypeId]) {
            ticketSessionMap[row.ticketTypeId] = [];
          }
          const session = sessionList.find(s => s.id === row.sessionId);
          if (session) {
            ticketSessionMap[row.ticketTypeId].push(session);
          }
        }
      }

      // Enrich ticket types with their sessions
      const enrichedTicketList = ticketList.map(ticket => ({
        ...ticket,
        sessions: ticketSessionMap[ticket.id] || [],
      }));

      // Count registrations for this event (confirmed only)
      const [regCount] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(registrations)
        .where(
          and(
            eq(registrations.eventId, event.id),
            eq(registrations.status, "confirmed")
          )
        );

      return reply.send({
        event: {
          ...event,
          images: venueImages,
          sessions: sessionList,
          ticketTypes: enrichedTicketList,
          registeredCount: regCount?.count || 0,
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch event" });
    }
  });
}
