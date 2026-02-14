import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  users,
  orders,
  orderItems,
  payments,
  registrations,
  registrationSessions,
  registrationAddons,
  checkIns,
  abstracts,
  abstractReviews,
  passwordResetTokens,
  verificationRejectionHistory,
} from "../../database/schema.js";
import { eq, desc, ilike, or, count, and, SQL, inArray } from "drizzle-orm";
import { z } from "zod";

// Query schema for listing members
const listMembersQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  role: z.enum(["thstd", "interstd", "thpro", "interpro"]).optional(),
  status: z.enum(["pending_approval", "active", "rejected"]).optional(),
});

export default async function (fastify: FastifyInstance) {
  // List Members (users from users table)
  fastify.get("", async (request, reply) => {
    const queryResult = listMembersQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const { page, limit, search, role, status } = queryResult.data;
    const offset = (page - 1) * limit;

    try {
      const conditions: SQL[] = [];

      // Filter by role
      if (role) {
        conditions.push(eq(users.role, role));
      }

      // Filter by status
      if (status) {
        conditions.push(eq(users.status, status));
      }

      // Search by name or email
      if (search) {
        conditions.push(
          or(
            ilike(users.firstName, `%${search}%`),
            ilike(users.lastName, `%${search}%`),
            ilike(users.email, `%${search}%`)
          )!
        );
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Count total
      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(users)
        .where(whereClause);

      // Fetch members
      const members = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          status: users.status,
          phone: users.phone,
          country: users.country,
          institution: users.institution,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(whereClause)
        .orderBy(desc(users.createdAt))
        .limit(limit)
        .offset(offset);

      return reply.send({
        members,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch members" });
    }
  });

  // Get single member by ID
  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const [member] = await db
        .select({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          status: users.status,
          phone: users.phone,
          country: users.country,
          institution: users.institution,
          thaiIdCard: users.thaiIdCard,
          passportId: users.passportId,
          pharmacyLicenseId: users.pharmacyLicenseId,
          verificationDocUrl: users.verificationDocUrl,
          rejectionReason: users.rejectionReason,
          resubmissionCount: users.resubmissionCount,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, parseInt(id)));

      if (!member) {
        return reply.status(404).send({ error: "Member not found" });
      }

      return reply.send({ member });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch member" });
    }
  });

  // Get member statistics
  fastify.get("/stats/summary", async (request, reply) => {
    try {
      // Count by role
      const roleStats = await db
        .select({
          role: users.role,
          count: count(),
        })
        .from(users)
        .groupBy(users.role);

      // Count by status
      const statusStats = await db
        .select({
          status: users.status,
          count: count(),
        })
        .from(users)
        .groupBy(users.status);

      // Total count
      const [{ total }] = await db
        .select({ total: count() })
        .from(users);

      return reply.send({
        total,
        byRole: roleStats,
        byStatus: statusStats,
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch stats" });
    }
  });

  // Delete Member
  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = parseInt(id);

    try {
      // Check if user exists
      const [member] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId));

      if (!member) {
        return reply.status(404).send({ error: "Member not found" });
      }

      // Delete related data in correct order (respecting FK constraints)
      // 1. Verification rejection history (has onDelete cascade, but explicit for safety)
      await db.delete(verificationRejectionHistory).where(eq(verificationRejectionHistory.userId, userId));

      // 2. Password reset tokens (has onDelete cascade, but explicit for safety)
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));

      // 3. Abstract reviews
      await db.delete(abstractReviews).where(eq(abstractReviews.reviewerId, userId));

      // 4. Abstracts
      await db.delete(abstracts).where(eq(abstracts.userId, userId));

      // 5. Get user's registrations for cascading
      const userRegistrations = await db
        .select({ id: registrations.id })
        .from(registrations)
        .where(eq(registrations.userId, userId));

      if (userRegistrations.length > 0) {
        const regIds = userRegistrations.map((r) => r.id);

        // 5a. Check-ins
        await db.delete(checkIns).where(inArray(checkIns.registrationId, regIds));

        // 5b. Registration sessions
        await db.delete(registrationSessions).where(inArray(registrationSessions.registrationId, regIds));

        // 5c. Registration addons
        await db.delete(registrationAddons).where(inArray(registrationAddons.registrationId, regIds));
      }

      // 6. Get user's orders for cascading
      const userOrders = await db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.userId, userId));

      if (userOrders.length > 0) {
        const orderIds = userOrders.map((o) => o.id);

        // 6a. Order items
        await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds));

        // 6b. Payments
        await db.delete(payments).where(inArray(payments.orderId, orderIds));
      }

      // 7. Registrations
      await db.delete(registrations).where(eq(registrations.userId, userId));

      // 8. Orders
      await db.delete(orders).where(eq(orders.userId, userId));

      // 9. Finally delete the user
      const [deletedUser] = await db
        .delete(users)
        .where(eq(users.id, userId))
        .returning({ id: users.id });

      if (!deletedUser) {
        return reply.status(404).send({ error: "Member not found" });
      }

      return reply.send({ success: true, message: "Member deleted" });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to delete member" });
    }
  });
}
