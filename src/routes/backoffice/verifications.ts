import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { users, verificationRejectionHistory, backofficeUsers } from "../../database/schema.js";
import { eq, desc, isNotNull, ilike, or, count, and, SQL } from "drizzle-orm";
import z from "zod";
import { sendVerificationApprovedEmail, sendVerificationRejectedEmail } from "../../services/emailService.js";

const rejectSchema = z.object({
  reason: z.string().min(1, "Reason is required"),
});

const approveSchema = z.object({
  comment: z.string().optional(),
});

// Query schema for listing verifications
const listVerificationsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
});

export default async function (fastify: FastifyInstance) {
  // List all verifications (with pagination)
  fastify.get("", async (request, reply) => {
    const queryResult = listVerificationsQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const { page, limit, search, status } = queryResult.data;
    const offset = (page - 1) * limit;

    try {
      const conditions: SQL[] = [];

      // Filter users who submitted verification document
      conditions.push(isNotNull(users.verificationDocUrl));

      // Filter by status (map to db status)
      if (status) {
        const dbStatus = status === "approved" ? "active" : status === "pending" ? "pending_approval" : status;
        conditions.push(eq(users.status, dbStatus as any));
      }

      // Search by name, email, id, or registration code
      if (search) {
        conditions.push(
          or(
            ilike(users.firstName, `%${search}%`),
            ilike(users.lastName, `%${search}%`),
            ilike(users.email, `%${search}%`),
            ilike(users.thaiIdCard, `%${search}%`),
            ilike(users.passportId, `%${search}%`)
          )!
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Count total
      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(users)
        .where(whereClause);

      // Fetch verifications with pagination
      const usersWithDocs = await db
        .select()
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);

      /* Map to Verification interface expected by frontend */
      const verifications = usersWithDocs.map((user) => ({
        id: user.id.toString(),
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        university: user.institution || "N/A",
        studentId: user.thaiIdCard || user.passportId || "N/A",
        role: user.role === "thstd" ? "thai-student" : "intl-student",
        documentType: "Student Document",
        documentUrl: user.verificationDocUrl,
        registrationCode: "-",
        status:
          user.status === "pending_approval"
            ? "pending"
            : user.status === "active"
            ? "approved"
            : user.status,
        submittedAt: user.createdAt.toISOString(),
        rejectionReason: user.rejectionReason,
        resubmissionCount: user.resubmissionCount ?? 0,
      }));

      return reply.send({
        verifications,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch verifications" });
    }
  });

  // Approve User
  fastify.post("/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const bodyResult = approveSchema.safeParse(request.body);
    const comment = bodyResult.success ? bodyResult.data.comment : undefined;

    try {
      const [updatedUser] = await db
        .update(users)
        .set({ status: "active" })
        .where(eq(users.id, parseInt(id)))
        .returning();

      if (!updatedUser) {
        return reply.status(404).send({ error: "User not found" });
      }

      // Send email notification
      await sendVerificationApprovedEmail(
        updatedUser.email,
        updatedUser.firstName,
        comment
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

      // Save rejection history with the backoffice user who rejected
      const backofficeUser = request.user as { id: number } | undefined;
      await db.insert(verificationRejectionHistory).values({
        userId: parseInt(id),
        reason: result.data.reason,
        rejectedBy: backofficeUser?.id ?? null,
      });

      // Send rejection email notification
      try {
        await sendVerificationRejectedEmail(
          updatedUser.email,
          updatedUser.firstName,
          updatedUser.lastName,
          result.data.reason
        );
        fastify.log.info(`Verification rejected email sent to ${updatedUser.email}`);
      } catch (emailError) {
        fastify.log.error({ err: emailError }, "Failed to send rejection email");
      }

      return reply.send({ success: true, user: updatedUser });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to reject user" });
    }
  });

  // Get rejection history for a user
  fastify.get("/:id/rejection-history", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const history = await db
        .select({
          id: verificationRejectionHistory.id,
          reason: verificationRejectionHistory.reason,
          rejectedAt: verificationRejectionHistory.rejectedAt,
          rejectedBy: verificationRejectionHistory.rejectedBy,
          rejectedByName: backofficeUsers.firstName,
          rejectedByLastName: backofficeUsers.lastName,
        })
        .from(verificationRejectionHistory)
        .leftJoin(backofficeUsers, eq(verificationRejectionHistory.rejectedBy, backofficeUsers.id))
        .where(eq(verificationRejectionHistory.userId, parseInt(id)))
        .orderBy(desc(verificationRejectionHistory.rejectedAt));

      // Format the response to include full name
      const formattedHistory = history.map(h => ({
        id: h.id,
        reason: h.reason,
        rejectedAt: h.rejectedAt,
        rejectedBy: h.rejectedBy,
        rejectedByName: h.rejectedByName && h.rejectedByLastName 
          ? `${h.rejectedByName} ${h.rejectedByLastName}` 
          : h.rejectedByName || null,
      }));

      return reply.send({ history: formattedHistory });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch rejection history" });
    }
  });
}
