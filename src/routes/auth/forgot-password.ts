import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { users, passwordResetTokens } from "../../database/schema.js";
import { forgotPasswordSchema } from "../../schemas/auth.schema.js";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { sendPasswordResetEmail } from "../../services/emailService.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/forgot-password", async (request, reply) => {
    // 1. Validate request body
    const result = forgotPasswordSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        success: false,
        error: "Invalid input",
        details: result.error.flatten(),
      });
    }

    const { email } = result.data;

    try {
      // 2. Find user by email
      const userList = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (userList.length === 0) {
        return reply.status(404).send({
          success: false,
          error: "Email not found in our system",
        });
      }

      const user = userList[0];

      // 3. Generate secure token
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // 4. Save token to database
      await db.insert(passwordResetTokens).values({
        userId: user.id,
        token,
        expiresAt,
      });

      // 5. Send email with reset link
      await sendPasswordResetEmail(email, user.firstName, token);

      return reply.send({
        success: true,
        message: "Password reset email sent successfully",
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
