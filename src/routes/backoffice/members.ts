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
import { eq, desc, ilike, or, count, and, SQL, inArray, exists, ne } from "drizzle-orm";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { BCRYPT_ROUNDS } from "../../constants/auth.js";

// Query schema for listing members
const listMembersQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  role: z.enum(["thstd", "interstd", "thpro", "interpro", "general", "admin"]).optional(),
  status: z.enum(["pending_approval", "active", "rejected"]).optional(),
  eventId: z.coerce.number().int().positive().optional(),
});

export default async function (fastify: FastifyInstance) {
  // List Members (users from users table)
  fastify.get("", async (request, reply) => {
    const queryResult = listMembersQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const { page, limit, search, role, status, eventId } = queryResult.data;
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

      // Filter by event (users with confirmed registration in that event)
      if (eventId) {
        conditions.push(
          exists(
            db.select({ id: registrations.id })
              .from(registrations)
              .where(and(
                eq(registrations.userId, users.id),
                eq(registrations.eventId, eventId),
                eq(registrations.status, "confirmed"),
              ))
          )
        );
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

  // Create Member
  fastify.post("", async (request, reply) => {
    const createSchema = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      firstName: z.string().min(1).max(100),
      lastName: z.string().min(1).max(100),
      role: z.enum(["thstd", "interstd", "thpro", "interpro", "general", "admin"]),
      status: z.enum(["pending_approval", "active", "rejected"]).default("active"),
      phone: z.string().max(20).optional().nullable(),
      country: z.string().max(100).optional().nullable(),
      institution: z.string().max(255).optional().nullable(),
      university: z.string().max(255).optional().nullable(),
      thaiIdCard: z.string().max(13).optional().nullable(),
      passportId: z.string().max(20).optional().nullable(),
      pharmacyLicenseId: z.string().max(20).optional().nullable(),
    });

    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid data", details: parsed.error.flatten() });
    }

    const { password, ...data } = parsed.data;

    try {
      // Check duplicate email
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, data.email));
      if (existing) {
        return reply.status(409).send({ error: "Email already exists" });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

      const [member] = await db
        .insert(users)
        .values({
          ...data,
          passwordHash,
          phone: data.phone ?? null,
          country: data.country ?? null,
          institution: data.institution ?? null,
          university: data.university ?? null,
          thaiIdCard: data.thaiIdCard ?? null,
          passportId: data.passportId ?? null,
          pharmacyLicenseId: data.pharmacyLicenseId ?? null,
        })
        .returning({
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
        });

      return reply.status(201).send({ member });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to create member" });
    }
  });

  // Update Member
  fastify.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = parseInt(id);

    const updateSchema = z.object({
      email: z.string().email().optional(),
      password: z.string().min(6).optional(),
      firstName: z.string().min(1).max(100).optional(),
      lastName: z.string().min(1).max(100).optional(),
      role: z.enum(["thstd", "interstd", "thpro", "interpro", "general", "admin"]).optional(),
      status: z.enum(["pending_approval", "active", "rejected"]).optional(),
      phone: z.string().max(20).optional().nullable(),
      country: z.string().max(100).optional().nullable(),
      institution: z.string().max(255).optional().nullable(),
      university: z.string().max(255).optional().nullable(),
      thaiIdCard: z.string().max(13).optional().nullable(),
      passportId: z.string().max(20).optional().nullable(),
      pharmacyLicenseId: z.string().max(20).optional().nullable(),
    });

    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid data", details: parsed.error.flatten() });
    }

    try {
      // Check if user exists
      const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
      if (!existing) {
        return reply.status(404).send({ error: "Member not found" });
      }

      // Check duplicate email if email is being changed
      if (parsed.data.email) {
        const [emailExists] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.email, parsed.data.email), ne(users.id, userId)));
        if (emailExists) {
          return reply.status(409).send({ error: "Email already exists" });
        }
      }

      const { password, ...updateFields } = parsed.data;
      const updateData: Record<string, unknown> = { ...updateFields };

      if (password) {
        updateData.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      }

      const [member] = await db
        .update(users)
        .set(updateData)
        .where(eq(users.id, userId))
        .returning({
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          role: users.role,
          status: users.status,
          phone: users.phone,
          country: users.country,
          institution: users.institution,
          university: users.university,
          thaiIdCard: users.thaiIdCard,
          passportId: users.passportId,
          pharmacyLicenseId: users.pharmacyLicenseId,
          createdAt: users.createdAt,
        });

      return reply.send({ member });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to update member" });
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

      // Execute all deletions in a transaction
      await db.transaction(async (tx) => {
        // 1. Verification rejection history
        await tx.delete(verificationRejectionHistory).where(eq(verificationRejectionHistory.userId, userId));

        // 2. Password reset tokens
        await tx.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, userId));

        // 3. Abstract reviews (where user is REVIEWER)
        await tx.delete(abstractReviews).where(eq(abstractReviews.reviewerId, userId));

        // 3.1. Delete reviews ON user's abstracts (where user is AUTHOR)
        const userAbstracts = await tx
          .select({ id: abstracts.id })
          .from(abstracts)
          .where(eq(abstracts.userId, userId));

        if (userAbstracts.length > 0) {
          const abstractIds = userAbstracts.map((a) => a.id);
          // Delete reviews of these abstracts
          await tx.delete(abstractReviews).where(inArray(abstractReviews.abstractId, abstractIds));
        }

        // 4. Abstracts (will cascade delete co-authors)
        await tx.delete(abstracts).where(eq(abstracts.userId, userId));

        // 5. Get user's registrations for cascading
        const userRegistrations = await tx
          .select({ id: registrations.id })
          .from(registrations)
          .where(eq(registrations.userId, userId));

        if (userRegistrations.length > 0) {
          const regIds = userRegistrations.map((r) => r.id);

          // 5a. Check-ins
          await tx.delete(checkIns).where(inArray(checkIns.registrationId, regIds));

          // 5b. Registration sessions
          await tx.delete(registrationSessions).where(inArray(registrationSessions.registrationId, regIds));

          // 5c. Registration addons
          await tx.delete(registrationAddons).where(inArray(registrationAddons.registrationId, regIds));
        }

        // 6. Get user's orders for cascading
        const userOrders = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(eq(orders.userId, userId));

        if (userOrders.length > 0) {
          const orderIds = userOrders.map((o) => o.id);

          // 6a. Order items
          await tx.delete(orderItems).where(inArray(orderItems.orderId, orderIds));

          // 6b. Payments
          await tx.delete(payments).where(inArray(payments.orderId, orderIds));
        }

        // 7. Registrations
        await tx.delete(registrations).where(eq(registrations.userId, userId));

        // 8. Orders
        await tx.delete(orders).where(eq(orders.userId, userId));

        // 9. Finally delete the user
        const [deletedUser] = await tx
          .delete(users)
          .where(eq(users.id, userId))
          .returning({ id: users.id });

        if (!deletedUser) {
          throw new Error("Failed to delete user record");
        }
      });

      return reply.send({ success: true, message: "Member deleted" });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        error: "Failed to delete member",
        details: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });
}
