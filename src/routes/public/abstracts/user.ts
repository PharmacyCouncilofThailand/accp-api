import { FastifyInstance } from "fastify";
import { db } from "../../../database/index.js";
import { abstracts, abstractCoAuthors } from "../../../database/schema.js";
import { eq, desc } from "drizzle-orm";

export default async function (fastify: FastifyInstance) {
    // Get current user's abstracts (JWT-protected)
    fastify.get("", { preHandler: [fastify.authenticate] }, async (request, reply) => {
        try {
            const userId = request.user.id;

            // Fetch user's abstracts
            const userAbstracts = await db
                .select({
                    id: abstracts.id,
                    trackingId: abstracts.trackingId,
                    title: abstracts.title,
                    category: abstracts.category,
                    presentationType: abstracts.presentationType,
                    status: abstracts.status,
                    keywords: abstracts.keywords,
                    background: abstracts.background,
                    methods: abstracts.methods,
                    results: abstracts.results,
                    conclusion: abstracts.conclusion,
                    fullPaperUrl: abstracts.fullPaperUrl,
                    createdAt: abstracts.createdAt,
                })
                .from(abstracts)
                .where(eq(abstracts.userId, userId))
                .orderBy(desc(abstracts.createdAt));

            // Fetch co-authors for each abstract
            const abstractsWithCoAuthors = await Promise.all(
                userAbstracts.map(async (abstract) => {
                    const coAuthors = await db
                        .select()
                        .from(abstractCoAuthors)
                        .where(eq(abstractCoAuthors.abstractId, abstract.id));

                    return {
                        ...abstract,
                        coAuthors,
                    };
                })
            );

            return reply.send({
                abstracts: abstractsWithCoAuthors,
                total: abstractsWithCoAuthors.length,
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch abstracts" });
        }
    });
}
