import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { abstracts, events, users } from "../../database/schema.js";
import { abstractListSchema, updateAbstractStatusSchema } from "../../schemas/abstracts.schema.js";
import { eq, desc, ilike, and, or, count } from "drizzle-orm";
import {
    sendAbstractAcceptedPosterEmail,
    sendAbstractAcceptedOralEmail,
    sendAbstractRejectedEmail,
} from "../../services/emailService.js";

export default async function (fastify: FastifyInstance) {
    // List Abstracts
    fastify.get("", async (request, reply) => {
        const queryResult = abstractListSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId, status, category } = queryResult.data;
        const offset = (page - 1) * limit;

        try {
            const conditions = [];
            if (eventId) conditions.push(eq(abstracts.eventId, eventId));
            if (status) conditions.push(eq(abstracts.status, status));
            if (category) conditions.push(eq(abstracts.category, category));
            if (search) {
                conditions.push(
                    or(
                        ilike(abstracts.title, `%${search}%`),
                        ilike(users.firstName, `%${search}%`),
                        ilike(users.lastName, `%${search}%`),
                        ilike(users.email, `%${search}%`)
                    )
                );
            }

            const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

            // Count total
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(abstracts)
                .leftJoin(users, eq(abstracts.userId, users.id))
                .where(whereClause);

            // Fetch data
            const abstractList = await db
                .select({
                    id: abstracts.id,
                    title: abstracts.title,
                    category: abstracts.category,
                    presentationType: abstracts.presentationType,
                    status: abstracts.status,
                    fullPaperUrl: abstracts.fullPaperUrl,
                    createdAt: abstracts.createdAt,
                    author: {
                        firstName: users.firstName,
                        lastName: users.lastName,
                        email: users.email,
                        institution: users.institution,
                    },
                    event: {
                        name: events.eventName,
                        code: events.eventCode,
                    }
                })
                .from(abstracts)
                .leftJoin(users, eq(abstracts.userId, users.id))
                .leftJoin(events, eq(abstracts.eventId, events.id))
                .where(whereClause)
                .orderBy(desc(abstracts.createdAt))
                .limit(limit)
                .offset(offset);

            return reply.send({
                abstracts: abstractList,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch abstracts" });
        }
    });

    // Update Abstract Status
    fastify.patch("/:id/status", async (request, reply) => {
        const { id } = request.params as { id: string };
        const result = updateAbstractStatusSchema.safeParse(request.body);

        if (!result.success) {
            return reply.status(400).send({ error: "Invalid input", details: result.error.flatten() });
        }

        const { status, comment } = result.data;

        try {
            const [updatedAbstract] = await db
                .update(abstracts)
                .set({ status })
                .where(eq(abstracts.id, parseInt(id)))
                .returning();

            if (!updatedAbstract) return reply.status(404).send({ error: "Abstract not found" });

            // Get author information for email (skip if no userId)
            let author = null;
            if (updatedAbstract.userId) {
                const [authorResult] = await db
                    .select({
                        firstName: users.firstName,
                        lastName: users.lastName,
                        email: users.email,
                    })
                    .from(users)
                    .where(eq(users.id, updatedAbstract.userId))
                    .limit(1);
                author = authorResult;
            }

            // Send email notification based on status
            if (author) {
                try {
                    if (status === "accepted") {
                        // Check presentationType to determine poster or oral email
                        if (updatedAbstract.presentationType === "poster") {
                            await sendAbstractAcceptedPosterEmail(
                                author.email,
                                author.firstName,
                                author.lastName,
                                updatedAbstract.title
                            );
                            fastify.log.info(`Abstract accepted (poster) email sent to ${author.email}`);
                        } else if (updatedAbstract.presentationType === "oral") {
                            await sendAbstractAcceptedOralEmail(
                                author.email,
                                author.firstName,
                                author.lastName,
                                updatedAbstract.title
                            );
                            fastify.log.info(`Abstract accepted (oral) email sent to ${author.email}`);
                        }
                    } else if (status === "rejected") {
                        await sendAbstractRejectedEmail(
                            author.email,
                            author.firstName,
                            author.lastName,
                            updatedAbstract.title
                        );
                        fastify.log.info(`Abstract rejected email sent to ${author.email}`);
                    }
                } catch (emailError) {
                    fastify.log.error({ err: emailError }, "Failed to send abstract status email");
                }
            }

            return reply.send({ abstract: updatedAbstract });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to update abstract" });
        }
    });
}

