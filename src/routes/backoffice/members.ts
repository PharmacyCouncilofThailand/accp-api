import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { users } from "../../database/schema.js";
import { eq, desc, ilike, or, count, and, SQL } from "drizzle-orm";
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
}
