import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { abstracts, abstractCoAuthors, events, users } from "../../database/schema.js";
import { abstractListSchema, updateAbstractStatusSchema } from "../../schemas/abstracts.schema.js";
import { eq, desc, ilike, and, or, count, inArray } from "drizzle-orm";

export default async function (fastify: FastifyInstance) {
    // List Abstracts
    fastify.get("", async (request, reply) => {
        const queryResult = abstractListSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId, status, category } = queryResult.data;
        const offset = (page - 1) * limit;

        // Get user info from JWT
        const user = request.user;

        try {
            const conditions = [];

            // Category-based access control for reviewers
            // Admin sees all, Reviewer sees only assigned categories
            console.log('User JWT:', JSON.stringify(user)); // DEBUG
            if (user.role === 'reviewer') {
                const assignedCategories = user.assignedCategories || [];
                console.log('Reviewer assignedCategories:', assignedCategories); // DEBUG
                if (assignedCategories.length > 0) {
                    // Reviewer can only see abstracts in their assigned categories
                    // Cast to enum type for TypeScript compatibility
                    type CategoryType = "clinical_pharmacy" | "social_administrative" | "pharmaceutical_sciences" | "pharmacology_toxicology" | "pharmacy_education" | "digital_pharmacy";
                    const validCategories = assignedCategories.filter(
                        (cat): cat is CategoryType =>
                            ["clinical_pharmacy", "social_administrative", "pharmaceutical_sciences", "pharmacology_toxicology", "pharmacy_education", "digital_pharmacy"].includes(cat)
                    );
                    if (validCategories.length > 0) {
                        conditions.push(inArray(abstracts.category, validCategories));
                    } else {
                        // No valid categories assigned
                        return reply.send({
                            abstracts: [],
                            pagination: { page, limit, total: 0, totalPages: 0 },
                        });
                    }
                } else {
                    // Reviewer with no assigned categories sees nothing
                    return reply.send({
                        abstracts: [],
                        pagination: { page, limit, total: 0, totalPages: 0 },
                    });
                }
            }
            // Admin and other roles see all abstracts (no category filter applied)

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
                    keywords: abstracts.keywords,
                    background: abstracts.background,
                    methods: abstracts.methods,
                    results: abstracts.results,
                    conclusion: abstracts.conclusion,
                    status: abstracts.status,
                    fullPaperUrl: abstracts.fullPaperUrl,
                    createdAt: abstracts.createdAt,
                    author: {
                        firstName: users.firstName,
                        lastName: users.lastName,
                        email: users.email,
                        phone: users.phone,
                        country: users.country,
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

            // Fetch co-authors for each abstract
            const abstractIds = abstractList.map(a => a.id);
            const coAuthorsList = abstractIds.length > 0
                ? await db
                    .select()
                    .from(abstractCoAuthors)
                    .where(or(...abstractIds.map(id => eq(abstractCoAuthors.abstractId, id))))
                : [];

            // Merge co-authors with abstracts
            const abstractsWithCoAuthors = abstractList.map(abs => ({
                ...abs,
                coAuthors: coAuthorsList.filter(ca => ca.abstractId === abs.id)
            }));

            return reply.send({
                abstracts: abstractsWithCoAuthors,
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

    // Get Single Abstract by ID
    fastify.get("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            const [abstractData] = await db
                .select({
                    id: abstracts.id,
                    title: abstracts.title,
                    category: abstracts.category,
                    presentationType: abstracts.presentationType,
                    keywords: abstracts.keywords,
                    background: abstracts.background,
                    methods: abstracts.methods,
                    results: abstracts.results,
                    conclusion: abstracts.conclusion,
                    status: abstracts.status,
                    fullPaperUrl: abstracts.fullPaperUrl,
                    createdAt: abstracts.createdAt,
                    author: {
                        firstName: users.firstName,
                        lastName: users.lastName,
                        email: users.email,
                        phone: users.phone,
                        country: users.country,
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
                .where(eq(abstracts.id, parseInt(id)));

            if (!abstractData) {
                return reply.status(404).send({ error: "Abstract not found" });
            }

            // Fetch co-authors for this abstract
            const coAuthors = await db
                .select()
                .from(abstractCoAuthors)
                .where(eq(abstractCoAuthors.abstractId, parseInt(id)));

            return reply.send({
                abstract: {
                    ...abstractData,
                    coAuthors
                }
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch abstract" });
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

            // If there's a comment, we might want to store it in reviews or just log it.
            // For now, minimal implementation just updates status.

            return reply.send({ abstract: updatedAbstract });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to update abstract" });
        }
    });
}
