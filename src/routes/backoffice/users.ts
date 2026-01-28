import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  backofficeUsers,
  staffEventAssignments,
  events,
} from "../../database/schema.js";
import {
  createUserSchema,
  updateUserSchema,
  assignEventSchema,
} from "../../schemas/backoffice-users.schema.js";
import bcrypt from "bcryptjs";
import { eq, desc, ne, and } from "drizzle-orm";
import { BCRYPT_ROUNDS } from "../../constants/auth.js";

export default async function (fastify: FastifyInstance) {
  // List Users
  fastify.get("", async (request, reply) => {
    try {
      const users = await db
        .select({
          id: backofficeUsers.id,
          email: backofficeUsers.email,
          firstName: backofficeUsers.firstName,
          lastName: backofficeUsers.lastName,
          role: backofficeUsers.role,
          isActive: backofficeUsers.isActive,
          assignedCategories: backofficeUsers.assignedCategories,
          createdAt: backofficeUsers.createdAt,
        })
        .from(backofficeUsers)
        .orderBy(desc(backofficeUsers.createdAt));

      // Fetch assignments for each user
      const usersWithAssignments = await Promise.all(
        users.map(async (user) => {
          if (user.role === "admin") {
            return { ...user, assignedEventIds: [] };
          }
          const assignments = await db
            .select({ eventId: staffEventAssignments.eventId })
            .from(staffEventAssignments)
            .where(eq(staffEventAssignments.staffId, user.id));

          return {
            ...user,
            assignedEventIds: assignments.map((a) => a.eventId),
          };
        })
      );

      return reply.send({ users: usersWithAssignments });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch users" });
    }
  });

  // Create User
  fastify.post("", async (request, reply) => {
    const result = createUserSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const { email, password, firstName, lastName, role, assignedCategories } = result.data;

    try {
      const existingUser = await db
        .select()
        .from(backofficeUsers)
        .where(eq(backofficeUsers.email, email))
        .limit(1);

      if (existingUser.length > 0) {
        return reply.status(409).send({ error: "Email already exists" });
      }

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const [newUser] = await db
        .insert(backofficeUsers)
        .values({
          email,
          passwordHash,
          firstName,
          lastName,
          role,
          isActive: true,
          assignedCategories: assignedCategories || [],
        })
        .returning();

      return reply.send({ user: newUser });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to create user" });
    }
  });

  // Update User
  fastify.patch("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateUserSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const updates: Record<string, unknown> = { ...result.data };

    // Check email uniqueness if email is being updated
    if (updates.email) {
      const existingUser = await db
        .select()
        .from(backofficeUsers)
        .where(and(
          eq(backofficeUsers.email, updates.email as string),
          ne(backofficeUsers.id, parseInt(id))
        ))
        .limit(1);

      if (existingUser.length > 0) {
        return reply.status(409).send({ error: "Email already exists" });
      }
    }

    if (updates.password) {
      updates.passwordHash = await bcrypt.hash(updates.password as string, BCRYPT_ROUNDS);
      delete updates.password;
    }

    // Auto-update timestamp
    updates.updatedAt = new Date();

    try {
      const [updatedUser] = await db
        .update(backofficeUsers)
        .set(updates)
        .where(eq(backofficeUsers.id, parseInt(id)))
        .returning();

      if (!updatedUser) {
        return reply.status(404).send({ error: "User not found" });
      }

      return reply.send({ user: updatedUser });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to update user" });
    }
  });

  // Delete User
  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      // Cascade delete handles staffEventAssignments
      const [deletedUser] = await db
        .delete(backofficeUsers)
        .where(eq(backofficeUsers.id, parseInt(id)))
        .returning();

      if (!deletedUser) {
        return reply.status(404).send({ error: "User not found" });
      }

      return reply.send({ success: true });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to delete user" });
    }
  });

  // Assign Events
  fastify.post("/:id/assignments", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = assignEventSchema.safeParse(request.body);
    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const { eventIds } = result.data;
    const userId = parseInt(id);

    try {
      await db.transaction(async (tx) => {
        // Clear existing assignments
        await tx
          .delete(staffEventAssignments)
          .where(eq(staffEventAssignments.staffId, userId));

        // Insert new assignments
        if (eventIds.length > 0) {
          await tx.insert(staffEventAssignments).values(
            eventIds.map((eventId) => ({
              staffId: userId,
              eventId,
            }))
          );
        }
      });

      return reply.send({ success: true, count: eventIds.length });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to assign events" });
    }
  });
}
