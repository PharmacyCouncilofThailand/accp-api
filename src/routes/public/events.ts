import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { events } from "../../database/schema.js";
import { eq, desc } from "drizzle-orm";

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
        })
        .from(events)
        .where(eq(events.status, "published"))
        .orderBy(desc(events.startDate));

      return reply.send({ events: eventList });
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

      return reply.send({ event });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch event" });
    }
  });
}
