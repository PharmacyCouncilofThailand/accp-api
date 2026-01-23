import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { users, passwordResetTokens } from "../../database/schema.js";
import { resetPasswordSchema } from "../../schemas/auth.schema.js";
import { eq, and, isNull, gt } from "drizzle-orm";
import bcrypt from "bcryptjs";

export default async function (fastify: FastifyInstance) {
  fastify.post("/reset-password", async (request, reply) => {
    // 1. Validate request body
    const result = resetPasswordSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        success: false,
        error: "Invalid input",
        details: result.error.flatten(),
      });
    }

    const { token, newPassword } = result.data;

    try {
      // 2. Find valid token (not used, not expired)
      const tokenList = await db
        .select()
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.token, token),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date())
          )
        )
        .limit(1);

      if (tokenList.length === 0) {
        return reply.status(400).send({
          success: false,
          error: "Invalid or expired reset token",
        });
      }

      const resetToken = tokenList[0];

      // 3. Hash new password
      const passwordHash = await bcrypt.hash(newPassword, 12);

      // 4. Update user password
      await db
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, resetToken.userId));

      // 5. Mark token as used
      await db
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, resetToken.id));

      return reply.send({
        success: true,
        message: "Password reset successfully",
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
