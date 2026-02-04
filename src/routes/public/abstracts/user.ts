import { FastifyInstance } from "fastify";
import { db } from "../../../database/index.js";
import { abstracts, abstractCoAuthors, users } from "../../../database/schema.js";
import { eq, desc } from "drizzle-orm";

export default async function (fastify: FastifyInstance) {
    // Get current user's abstracts
    fastify.get("", async (request, reply) => {
        try {
            // Get user email from headers (set after login)
            const userEmail = request.headers['x-user-email'] as string;
            
            // Debug log
            console.log('🔍 DEBUG - Received email from header:', userEmail);
            
            if (!userEmail) {
                return reply.status(401).send({ 
                    error: "Authentication required",
                    message: "Please log in to view your abstracts" 
                });
            }

            // Find user by email
            const [user] = await db
                .select()
                .from(users)
                .where(eq(users.email, userEmail))
                .limit(1);

            console.log('🔍 DEBUG - Found user:', user ? { id: user.id, email: user.email } : 'NOT FOUND');

            if (!user) {
                return reply.status(404).send({ error: "User not found" });
            }

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
                .where(eq(abstracts.userId, user.id))
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
            console.error("Error fetching user abstracts:", error);
            return reply.status(500).send({ error: "Failed to fetch abstracts" });
        }
    });
}
