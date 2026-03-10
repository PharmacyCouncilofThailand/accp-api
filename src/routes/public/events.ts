import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { events, eventImages, sessions, ticketTypes } from "../../database/schema.js";
import { eq, desc, min, asc } from "drizzle-orm";

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

      return reply.send({
        event: {
          ...event,
          images: venueImages,
          sessions: sessionList,
          ticketTypes: ticketList,
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch event" });
    }
  });
}
