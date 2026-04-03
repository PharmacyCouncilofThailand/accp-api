import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  backofficeUsers,
  staffEventAssignments,
  events,
  sessions,
} from "../../database/schema.js";
import { backofficeLoginSchema } from "../../schemas/backoffice.schema.js";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { JWT_EXPIRY } from "../../constants/auth.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/login", async (request, reply) => {
    // 1. Validate
    const result = backofficeLoginSchema.safeParse(request.body);
    if (!result.success) {
      // Log validation failure for debugging
      fastify.log.warn({
        route: "/backoffice/login",
        validation: result.error.flatten(),
        ip: request.ip,
      }, "Validation failed");

      return reply.status(400).send({
        success: false,
        code: "VALIDATION_ERROR",
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

      // 5. Get assigned events + sessions (skip for admin)
      let assignedEvents: { id: number; code: string; name: string }[] = [];
      let assignedSessions: {
        eventId: number;
        sessionId: number;
        sessionName: string;
        sessionType: string | null;
        room: string | null;
        startTime: Date;
        endTime: Date;
      }[] = [];

      if (staff.role !== "admin") {
        const rawAssignments = await db
          .select({
            eventId: events.id,
            eventCode: events.eventCode,
            eventName: events.eventName,
            sessionId: staffEventAssignments.sessionId,
          })
          .from(staffEventAssignments)
          .innerJoin(events, eq(staffEventAssignments.eventId, events.id))
          .where(eq(staffEventAssignments.staffId, staff.id));

        // Deduplicate events
        const eventMap = new Map<number, { id: number; code: string; name: string }>();
        const sessionIdsToFetch: number[] = [];
        for (const a of rawAssignments) {
          if (!eventMap.has(a.eventId)) {
            eventMap.set(a.eventId, { id: a.eventId, code: a.eventCode, name: a.eventName });
          }
          if (a.sessionId) sessionIdsToFetch.push(a.sessionId);
        }
        assignedEvents = Array.from(eventMap.values());

        // Fetch session details if any session-level assignments exist
        if (sessionIdsToFetch.length > 0) {
          const { inArray } = await import("drizzle-orm");
          const sessionRows = await db
            .select({
              id: sessions.id,
              eventId: sessions.eventId,
              sessionName: sessions.sessionName,
              sessionType: sessions.sessionType,
              room: sessions.room,
              startTime: sessions.startTime,
              endTime: sessions.endTime,
            })
            .from(sessions)
            .where(inArray(sessions.id, sessionIdsToFetch));

          assignedSessions = sessionRows.map((s) => ({
            eventId: s.eventId,
            sessionId: s.id,
            sessionName: s.sessionName,
            sessionType: s.sessionType,
            room: s.room,
            startTime: s.startTime,
            endTime: s.endTime,
          }));
        }
      }

      // 6. Sign JWT (include assignedCategories and assignedPresentationTypes for reviewers)
      const token = fastify.jwt.sign(
        {
          id: staff.id,
          email: staff.email,
          role: staff.role,
          assignedCategories: staff.assignedCategories || [],
          assignedPresentationTypes: staff.assignedPresentationTypes || [],
        },
        { expiresIn: JWT_EXPIRY }
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
          assignedSessions,
          assignedCategories: staff.assignedCategories || [],
          assignedPresentationTypes: staff.assignedPresentationTypes || [],
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
