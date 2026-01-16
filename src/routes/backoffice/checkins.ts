import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { checkIns, registrations, users, events, ticketTypes } from "../../database/schema.js";
import { checkinListSchema, createCheckinSchema } from "../../schemas/checkins.schema.js";
import { eq, desc, ilike, and, or, count } from "drizzle-orm";

export default async function (fastify: FastifyInstance) {
    // List Check-ins
    fastify.get("", async (request, reply) => {
        const queryResult = checkinListSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId } = queryResult.data;
        const offset = (page - 1) * limit;

        try {
            const conditions = [];
            if (eventId) conditions.push(eq(registrations.eventId, eventId));
            if (search) {
                conditions.push(
                    or(
                        ilike(registrations.firstName, `%${search}%`),
                        ilike(registrations.lastName, `%${search}%`),
                        ilike(registrations.regCode, `%${search}%`)
                    )
                );
            }

            const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

            // Count total
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(checkIns)
                .leftJoin(registrations, eq(checkIns.registrationId, registrations.id))
                .where(whereClause);

            // Fetch data
            const checkinList = await db
                .select({
                    id: checkIns.id,
                    scannedAt: checkIns.scannedAt,
                    regCode: registrations.regCode,
                    firstName: registrations.firstName,
                    lastName: registrations.lastName,
                    email: registrations.email,
                    ticketName: ticketTypes.name,
                    eventName: events.eventName,
                    scannedBy: {
                        firstName: users.firstName,
                        lastName: users.lastName,
                    }
                })
                .from(checkIns)
                .leftJoin(registrations, eq(checkIns.registrationId, registrations.id))
                .leftJoin(ticketTypes, eq(checkIns.ticketTypeId, ticketTypes.id))
                .leftJoin(events, eq(registrations.eventId, events.id))
                .leftJoin(users, eq(checkIns.scannedBy, users.id))
                .where(whereClause)
                .orderBy(desc(checkIns.scannedAt))
                .limit(limit)
                .offset(offset);

            return reply.send({
                checkins: checkinList,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch check-ins" });
        }
    });

    // Create Check-in (Scan)
    fastify.post("", async (request, reply) => {
        const bodyResult = createCheckinSchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: "Invalid body", details: bodyResult.error.flatten() });
        }

        const { regCode } = bodyResult.data;
        const userId = (request as any).user?.id; // Assuming auth middleware populates this

        try {
            // Find registration
            const registration = await db.query.registrations.findFirst({
                where: ilike(registrations.regCode, regCode), // Case insensitive
                with: {
                    event: true,
                    ticketType: true,
                }
            });

            if (!registration) {
                return reply.status(404).send({ error: "Registration not found", code: "NOT_FOUND" });
            }

            if (registration.status !== 'confirmed') {
                return reply.status(400).send({
                    error: `Registration status is ${registration.status}`,
                    code: "INVALID_STATUS",
                    registration
                });
            }

            // Check if already checked in
            const existingCheckin = await db.query.checkIns.findFirst({
                where: eq(checkIns.registrationId, registration.id),
            });

            if (existingCheckin) {
                return reply.status(409).send({
                    error: "Already checked in",
                    code: "ALREADY_CHECKED_IN",
                    checkin: existingCheckin,
                    registration
                });
            }

            // Create check-in
            const [newCheckin] = await db.insert(checkIns).values({
                registrationId: registration.id,
                ticketTypeId: registration.ticketTypeId,
                scannedBy: userId,
                scannedAt: new Date(),
            }).returning();

            return reply.send({
                success: true,
                checkin: newCheckin,
                registration: {
                    ...registration,
                    ticketName: (registration as any).ticketType?.name,
                    eventName: (registration as any).event?.eventName
                }
            });

        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to process check-in" });
        }
    });
}
