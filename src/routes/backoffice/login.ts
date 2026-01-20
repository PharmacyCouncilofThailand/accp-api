import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  backofficeUsers,
  staffEventAssignments,
  events,
} from "../../database/schema.js";
import { backofficeLoginSchema } from "../../schemas/backoffice.schema.js";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

export default async function (fastify: FastifyInstance) {
  fastify.post("/login", async (request, reply) => {
    // 1. Validate
    const result = backofficeLoginSchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        success: false,
        error: "Invalid input",
        details: result.error.flatten(),
      });
    }

    const { email, password } = result.data;

    try {
      // 2. Find staff user
      const staffList = await db
        .select()
        .from(backofficeUsers)
        .where(eq(backofficeUsers.email, email))
        .limit(1);


      if (staffList.length === 0) {
        return reply.status(401).send({
          success: false,
          error: "Invalid email or password",
        });
      }

      const staff = staffList[0];

      // 3. Check active status
      if (!staff.isActive) {
        return reply.status(403).send({
          success: false,
          error: "Account is disabled",
        });
      }

      // 4. Verify password
      const isValid = await bcrypt.compare(password, staff.passwordHash);

      if (!isValid) {
        return reply.status(401).send({
          success: false,
          error: "Invalid email or password",
        });
      }

      // 5. Get assigned events (skip for admin)
      let assignedEvents: { id: number; code: string; name: string }[] = [];
      if (staff.role !== "admin") {
        const assignments = await db
          .select({
            eventId: events.id,
            eventCode: events.eventCode,
            eventName: events.eventName,
          })
          .from(staffEventAssignments)
          .innerJoin(events, eq(staffEventAssignments.eventId, events.id))
          .where(eq(staffEventAssignments.staffId, staff.id));

        assignedEvents = assignments.map((a) => ({
          id: a.eventId,
          code: a.eventCode,
          name: a.eventName,
        }));
      }

      // 6. Sign JWT
      const token = fastify.jwt.sign(
        {
          id: staff.id,
          email: staff.email,
          role: staff.role,
        },
        { expiresIn: "7d" }
      );

      // 7. Return
      return reply.send({
        success: true,
        token,
        user: {
          id: staff.id,
          email: staff.email,
          firstName: staff.firstName,
          lastName: staff.lastName,
          role: staff.role,
          assignedEvents,
        },
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
