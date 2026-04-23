import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../../database/index.js";
import {
  registrations,
  registrationSessions,
  ticketTypes,
  ticketSessions,
  sessions,
  users,
  events,
} from "../../database/schema.js";
import { eq, and, sql, desc, count } from "drizzle-orm";
import { freeRegistrationSchema } from "../../schemas/freeRegistration.schema.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function generateRegCode(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `REG-${ts}${rand}`;
}

type ResolvedTicket = { id: number; price: string; eventId: number; name: string };

/**
 * Resolve a frontend package string ID to the actual DB ticketType for free tickets.
 * Only resolves primary tickets with price = 0.
 */
async function resolveFreeTicket(
  packageId: string,
  eventId: number,
): Promise<ResolvedTicket | null> {
  const allTickets = await db
    .select({
      id: ticketTypes.id,
      price: ticketTypes.price,
      currency: ticketTypes.currency,
      category: ticketTypes.category,
      groupName: ticketTypes.groupName,
      allowedRoles: ticketTypes.allowedRoles,
      quota: ticketTypes.quota,
      soldCount: ticketTypes.soldCount,
      eventId: ticketTypes.eventId,
      isActive: ticketTypes.isActive,
      displayOrder: ticketTypes.displayOrder,
      saleStartDate: ticketTypes.saleStartDate,
      saleEndDate: ticketTypes.saleEndDate,
      name: ticketTypes.name,
    })
    .from(ticketTypes)
    .where(
      and(
        eq(ticketTypes.eventId, eventId),
        eq(ticketTypes.category, "primary"),
      )
    );

  const now = new Date();
  const active = allTickets.filter((t) => {
    if (t.isActive === false) return false;
    const saleStart = t.saleStartDate ? new Date(t.saleStartDate) : null;
    const saleEnd = t.saleEndDate ? new Date(t.saleEndDate) : null;
    if (saleStart && now < saleStart) return false;
    if (saleEnd && now > saleEnd) return false;
    return true;
  });

  // Match by role pattern in allowedRoles (same as payment route)
  const roleMap: Record<string, string[]> = {
    student: ["thstd", "interstd"],
    professional: ["thpro", "interpro"],
  };
  const roles = roleMap[packageId];
  if (!roles) return null;

  const matched = active.filter((t) => {
    if (!t.allowedRoles) return false;
    return roles.some((r) => t.allowedRoles!.includes(r));
  });

  if (matched.length === 0) return null;
  matched.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));

  const ticket = matched[0];

  // Only allow if price is 0
  if (Number(ticket.price) !== 0) return null;

  return { id: ticket.id, price: ticket.price, eventId: ticket.eventId, name: ticket.name };
}

// ─────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────

export default async function freeRegistrationRoutes(fastify: FastifyInstance) {
  /**
   * GET /registrations/check?eventId=X
   *
   * Check if the current user is registered for a given event.
   * Checks the registrations table directly (covers both free and paid).
   */
  fastify.get(
    "/check",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { eventId } = request.query as { eventId?: string };

      if (!eventId || !/^\d+$/.test(eventId)) {
        return reply.status(400).send({
          success: false,
          error: "eventId is required and must be numeric",
        });
      }

      try {
        const [reg] = await db
          .select({
            id: registrations.id,
            regCode: registrations.regCode,
            status: registrations.status,
            ticketTypeId: registrations.ticketTypeId,
          })
          .from(registrations)
          .where(
            and(
              eq(registrations.userId, request.user.id),
              eq(registrations.eventId, parseInt(eventId, 10)),
              eq(registrations.status, "confirmed"),
            )
          )
          .limit(1);

        return reply.send({
          success: true,
          isRegistered: !!reg,
          regCode: reg?.regCode || null,
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: "Failed to check registration",
        });
      }
    }
  );

  /**
   * POST /registrations/free
   *
   * Register for a free event — no orders, no payments, no checkout.
   * Creates registration + registration_sessions directly.
   */
  fastify.post(
    "/free",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = freeRegistrationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "Invalid input",
          details: parsed.error.flatten(),
        });
      }

      const { eventId, packageId } = parsed.data;
      const userId = request.user.id;

      fastify.log.info(
        `[FREE-REG] userId=${userId}, eventId=${eventId}, packageId=${packageId}`
      );

      try {
        // 1. Verify event exists and is published
        const [event] = await db
          .select({
            id: events.id,
            eventName: events.eventName,
            status: events.status,
            startDate: events.startDate,
            endDate: events.endDate,
            location: events.location,
            websiteUrl: events.websiteUrl,
            shortName: events.shortName,
          })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1);

        if (!event) {
          return reply.status(404).send({
            success: false,
            code: "EVENT_NOT_FOUND",
            error: "Event not found",
          });
        }

        if (event.status !== "published") {
          return reply.status(400).send({
            success: false,
            code: "EVENT_NOT_AVAILABLE",
            error: "Event is not available for registration",
          });
        }

        // 2. Resolve the free ticket
        const ticket = await resolveFreeTicket(packageId, eventId);
        if (!ticket) {
          return reply.status(400).send({
            success: false,
            code: "NOT_FREE_TICKET",
            error: "No free ticket found for this package. Use the checkout flow for paid tickets.",
          });
        }

        // 3. Check ticket availability
        const [currentTicket] = await db
          .select({
            quota: ticketTypes.quota,
            soldCount: ticketTypes.soldCount,
            saleStartDate: ticketTypes.saleStartDate,
            saleEndDate: ticketTypes.saleEndDate,
          })
          .from(ticketTypes)
          .where(eq(ticketTypes.id, ticket.id))
          .limit(1);

        if (currentTicket) {
          const now = new Date();
          const saleStart = currentTicket.saleStartDate
            ? new Date(currentTicket.saleStartDate)
            : null;
          const saleEnd = currentTicket.saleEndDate
            ? new Date(currentTicket.saleEndDate)
            : null;

          if (saleStart && now < saleStart) {
            return reply.status(400).send({
              success: false,
              code: "SALE_NOT_STARTED",
              error: "Registration has not started yet",
              saleStartDate: saleStart.toISOString(),
            });
          }

          if (saleEnd && now > saleEnd) {
            return reply.status(400).send({
              success: false,
              code: "SALE_ENDED",
              error: "Registration period has ended",
            });
          }

          if (currentTicket.quota > 0 && currentTicket.soldCount >= currentTicket.quota) {
            return reply.status(400).send({
              success: false,
              code: "SOLD_OUT",
              error: "No spots remaining",
            });
          }
        }

        // 4. Duplicate check — user already registered for this event
        const [existingReg] = await db
          .select({ id: registrations.id, regCode: registrations.regCode })
          .from(registrations)
          .where(
            and(
              eq(registrations.userId, userId),
              eq(registrations.eventId, eventId),
              eq(registrations.status, "confirmed"),
            )
          )
          .limit(1);

        if (existingReg) {
          return reply.status(409).send({
            success: false,
            code: "ALREADY_REGISTERED",
            error: "You are already registered for this event",
            regCode: existingReg.regCode,
          });
        }

        // 5. Get user info
        const [user] = await db
          .select({
            email: users.email,
            firstName: users.firstName,
            middleName: users.middleName,
            lastName: users.lastName,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        if (!user) {
          return reply.status(404).send({
            success: false,
            code: "USER_NOT_FOUND",
            error: "User not found",
          });
        }

        // 6. Create registration + sessions in transaction
        const result = await db.transaction(async (tx) => {
          // Insert registration (no orderId — this is a free registration)
          const regCode = generateRegCode();
          const [newReg] = await tx.insert(registrations).values({
            regCode,
            eventId,
            ticketTypeId: ticket.id,
            userId,
            email: user.email,
            firstName: user.firstName,
            middleName: user.middleName,
            lastName: user.lastName,
            status: "confirmed",
            source: "free",
          }).returning();

          // Determine sessions to link (from ticket_sessions junction)
          let sessionIdsToLink: number[] = [];

          const linkedSessions = await tx
            .select({ sessionId: ticketSessions.sessionId })
            .from(ticketSessions)
            .innerJoin(sessions, eq(ticketSessions.sessionId, sessions.id))
            .where(
              and(
                eq(ticketSessions.ticketTypeId, ticket.id),
                eq(sessions.eventId, eventId),
              )
            );

          sessionIdsToLink = linkedSessions.map((ls) => ls.sessionId);

          // Fallback: auto-link to main sessions if no ticket_sessions rows
          if (sessionIdsToLink.length === 0) {
            const mainSessions = await tx
              .select({ id: sessions.id })
              .from(sessions)
              .where(
                and(
                  eq(sessions.eventId, eventId),
                  eq(sessions.isMainSession, true),
                )
              );
            sessionIdsToLink = mainSessions.map((s) => s.id);

            // Backfill ticket_sessions so future lookups work
            if (sessionIdsToLink.length > 0) {
              await tx.insert(ticketSessions).values(
                sessionIdsToLink.map((sid) => ({
                  ticketTypeId: ticket.id,
                  sessionId: sid,
                }))
              );
              fastify.log.info(
                `[FREE-REG] Backfilled ticket_sessions for ticket ${ticket.id} → ${sessionIdsToLink.length} main sessions`
              );
            }
          }

          // Insert registration_sessions
          for (const sid of sessionIdsToLink) {
            await tx.insert(registrationSessions).values({
              registrationId: newReg.id,
              sessionId: sid,
              ticketTypeId: ticket.id,
              source: "free",
            });
          }

          // Update soldCount
          await tx
            .update(ticketTypes)
            .set({
              soldCount: sql`${ticketTypes.soldCount} + 1`,
            })
            .where(eq(ticketTypes.id, ticket.id));

          fastify.log.info(
            `[FREE-REG] Created registration ${newReg.id} (regCode=${regCode}) + ${sessionIdsToLink.length} session links for user ${userId}`
          );

          return { regCode, registrationId: newReg.id, sessionIds: sessionIdsToLink };
        });

        // 7. Send confirmation email (non-blocking)
        setImmediate(async () => {
          try {
            const sessionDetails =
              result.sessionIds.length > 0
                ? await db
                    .select({
                      sessionName: sessions.sessionName,
                      startTime: sessions.startTime,
                      endTime: sessions.endTime,
                    })
                    .from(sessions)
                    .where(
                      sql`${sessions.id} IN (${sql.join(
                        result.sessionIds.map((id) => sql`${id}`),
                        sql`, `
                      )})`
                    )
                : [];

            if (event.id === 1) {
              const { sendManualRegistrationEmail } = await import(
                "../../services/emailService.js"
              );
              await sendManualRegistrationEmail(
                user.email,
                user.firstName,
                user.middleName,
                user.lastName,
                result.regCode,
                event.eventName,
                ticket.name,
                sessionDetails,
              );
            } else {
              const { sendEventRegistrationEmail } = await import(
                "../../services/emailTemplates.js"
              );
              const { buildEventEmailContext } = await import(
                "../../services/emailTemplates.types.js"
              );
              const eventCtx = buildEventEmailContext(event);
              await sendEventRegistrationEmail(
                user.email,
                user.firstName,
                user.middleName,
                user.lastName,
                result.regCode,
                ticket.name,
                sessionDetails,
                eventCtx,
              );
            }

            fastify.log.info(
              `[FREE-REG] Confirmation email sent to ${user.email}`
            );
          } catch (emailErr) {
            fastify.log.error(
              { err: emailErr },
              "[FREE-REG] Failed to send confirmation email"
            );
          }
        });

        // 8. Return success
        return reply.status(201).send({
          success: true,
          data: {
            regCode: result.regCode,
            eventName: event.eventName,
            ticketName: ticket.name,
          },
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: "Failed to process free registration",
        });
      }
    }
  );
}
