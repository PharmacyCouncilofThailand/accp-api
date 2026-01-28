import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { ticketTypes, events } from "../../database/schema.js";
import { eq, and, or, isNull, gt } from "drizzle-orm";

export default async function publicTicketsRoutes(fastify: FastifyInstance) {
    // List all public tickets for published events
    fastify.get("", async (request, reply) => {
        try {
            const now = new Date();

            const tickets = await db
                .select({
                    id: ticketTypes.id,
                    eventId: ticketTypes.eventId,
                    category: ticketTypes.category,
                    groupName: ticketTypes.groupName,
                    name: ticketTypes.name,
                    price: ticketTypes.price,
                    currency: ticketTypes.currency,
                    saleStartDate: ticketTypes.saleStartDate,
                    saleEndDate: ticketTypes.saleEndDate,
                    allowedRoles: ticketTypes.allowedRoles,
                })
                .from(ticketTypes)
                .innerJoin(events, eq(ticketTypes.eventId, events.id))
                .where(
                    and(
                        eq(events.status, "published"),
                        // Optional: Filter by sale date? Maybe frontend should handle "Available on" logic like workshops
                        // For now, let's return all and let frontend decide
                    )
                );

            return reply.send({ tickets });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch tickets" });
        }
    });
}
