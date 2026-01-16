import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { ticketTypes, events, staffEventAssignments } from "../../database/schema.js";
import { eq, desc, ilike, and, count, inArray } from "drizzle-orm";
import { z } from "zod";

const ticketQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    search: z.string().optional(),
    eventId: z.coerce.number().optional(),
    category: z.enum(['primary', 'addon']).optional(),
});

export default async function (fastify: FastifyInstance) {
    // List All Tickets (Global View)
    fastify.get("", async (request, reply) => {
        const queryResult = ticketQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId, category } = queryResult.data;
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
                        tickets: [],
                        pagination: {
                            page,
                            limit,
                            total: 0,
                            totalPages: 0,
                        },
                    });
                }

                conditions.push(inArray(ticketTypes.eventId, assignedEventIds));
            }

            if (eventId) conditions.push(eq(ticketTypes.eventId, eventId));
            if (search) {
                conditions.push(
                    ilike(ticketTypes.name, `%${search}%`)
                );
            }
            if (category) conditions.push(eq(ticketTypes.category, category));

            const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

            // Count total
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(ticketTypes)
                .where(whereClause);

            // Fetch data
            const tickets = await db
                .select({
                    id: ticketTypes.id,
                    eventId: ticketTypes.eventId,
                    code: ticketTypes.groupName,
                    name: ticketTypes.name,
                    category: ticketTypes.category,
                    price: ticketTypes.price,
                    currency: ticketTypes.currency,
                    quota: ticketTypes.quota,
                    sold: ticketTypes.soldCount,
                    allowedRoles: ticketTypes.allowedRoles,
                    startDate: ticketTypes.saleStartDate,
                    endDate: ticketTypes.saleEndDate,
                    eventCode: events.eventCode,
                })
                .from(ticketTypes)
                .leftJoin(events, eq(ticketTypes.eventId, events.id))
                .where(whereClause)
                .orderBy(desc(ticketTypes.id))
                .limit(limit)
                .offset(offset);

            return reply.send({
                tickets,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch tickets" });
        }
    });
}
