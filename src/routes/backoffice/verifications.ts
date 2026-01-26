import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { users } from "../../database/schema.js";
import { eq, desc, isNotNull } from "drizzle-orm";
import z from "zod";
import {
  sendVerificationApprovedEmail,
  sendVerificationRejectedEmail,
} from "../../services/emailService.js";

const rejectSchema = z.object({
  reason: z.string().min(1, "Reason is required"),
});

export default async function (fastify: FastifyInstance) {
  // List all verifications (filtered by having a document URL)
  fastify.get("", async (request, reply) => {
    try {
      const usersWithDocs = await db
        .select()
        .from(users)
        // Filter users who submitted verification document (all history)
        .where(isNotNull(users.verificationDocUrl))
        .orderBy(desc(users.createdAt));

      /* 
               Map to Verification interface expected by frontend
            */
      const verifications = usersWithDocs.map((user) => ({
        id: user.id.toString(), // Frontend expects string ID usually
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        university: user.institution || "N/A",
        studentId: user.thaiIdCard || user.passportId || "N/A", // Use ID card/Passport as Student ID equivalent for now
        role: user.role === "thstd" ? "thai-student" : "intl-student",
        documentType: "Student Document", // Generic label
        documentUrl: user.verificationDocUrl,
        registrationCode: "-", // Placeholder as registration might happen after approval
        status:
          user.status === "pending_approval"
            ? "pending"
            : user.status === "active"
            ? "approved"
            : user.status,
        submittedAt: user.createdAt.toISOString(),
        rejectionReason: user.rejectionReason,
      }));

      return reply.send({ pendingUsers: verifications });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch verifications" });
    }
  });

  // Approve User
  fastify.post("/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const [updatedUser] = await db
        .update(users)
        .set({ status: "active" }) // Set to active (approved)
        .where(eq(users.id, parseInt(id)))
        .returning();

      if (!updatedUser) {
        return reply.status(404).send({ error: "User not found" });
      }

      // Send email notification
      await sendVerificationApprovedEmail(
        updatedUser.email,
        updatedUser.firstName
      );

      return reply.send({ success: true, user: updatedUser });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to approve user" });
    }
  });

  // Reject User
  fastify.post("/:id/reject", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = rejectSchema.safeParse(request.body);

    if (!result.success) {
      return reply.status(400).send({
        error: "Invalid input",
        details: result.error.flatten(),
      });
    }

    try {
      const [updatedUser] = await db
        .update(users)
        .set({
          status: "rejected",
          rejectionReason: result.data.reason,
        })
        .where(eq(users.id, parseInt(id)))
        .returning();

      if (!updatedUser) {
        return reply.status(404).send({ error: "User not found" });
      }

      // Send email notification
      await sendVerificationRejectedEmail(
        updatedUser.email,
        updatedUser.firstName,
        result.data.reason
      );

      return reply.send({ success: true, user: updatedUser });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to reject user" });
    }
  });
}
