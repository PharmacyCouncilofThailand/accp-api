import { FastifyInstance } from "fastify";
import { db } from "../../../database/index.js";
import { users } from "../../../database/schema.js";
import { eq } from "drizzle-orm";

/**
 * Get current user's profile (JWT-protected)
 * This endpoint is used to autofill user data in forms
 */
export default async function (fastify: FastifyInstance) {
  fastify.get("/profile", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const [user] = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          phone: users.phone,
          country: users.country,
          institution: users.institution,
        })
        .from(users)
        .where(eq(users.id, request.user.id))
        .limit(1);

      if (!user) {
        return reply.status(404).send({
          success: false,
          error: "User not found",
        });
      }

      return reply.send({
        success: true,
        user,
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Internal server error",
      });
    }
  });
}
