import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Readable } from "stream";
import { stripe } from "../../services/stripe.js";
import { db } from "../../database/index.js";
import {
  orders,
  orderItems,
  payments,
  ticketTypes,
  registrations,
  registrationSessions,
  users,
  sessions,
  ticketSessions,
} from "../../database/schema.js";
import { eq, and, sql, inArray, count, desc } from "drizzle-orm";
import { createPaymentIntentSchema } from "../../schemas/payment.schema.js";
import type Stripe from "stripe";
import { calculateStripeFee, resolveFeeMethod } from "../../utils/stripeFee.js";
import { generateReceiptToken, verifyReceiptToken } from "../../utils/receiptToken.js";
import { generateReceiptPdf } from "../../services/receiptPdf.js";
import { sendPaymentReceiptEmail } from "../../services/emailService.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ACCP2026-${ts}-${rand}`;
}

function generateRegCode(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `REG-${ts}${rand}`;
}

/**
 * Resolve a frontend package/addon string ID + currency to the actual DB ticketType.
 * Frontend uses "student"/"professional" for packages, "workshop"/"gala" for addons.
 * Each ticket in DB has one currency, so we match by groupName/allowedRoles + currency.
 */
async function resolveTicketId(
  packageId: string,
  currency: string,
  category: "primary" | "addon"
): Promise<{ id: number; price: string; eventId: number } | null> {
  // For primary packages, match by allowedRoles pattern
  // For addons, match by groupName
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
    })
    .from(ticketTypes)
    .where(
      and(
        eq(ticketTypes.currency, currency),
        eq(ticketTypes.category, category)
      )
    );

  const active = allTickets.filter((t) => t.isActive !== false);

  if (category === "primary") {
    // Match by role pattern in allowedRoles
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

    // Pick best by displayOrder
    if (matched.length === 0) return null;
    matched.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    return { id: matched[0].id, price: matched[0].price, eventId: matched[0].eventId };
  } else {
    // Addon: match by groupName or name-like pattern
    const matched = active.filter((t) => {
      const gn = (t.groupName || "").toLowerCase();
      return gn === packageId.toLowerCase() || gn.includes(packageId.toLowerCase());
    });

    if (matched.length === 0) return null;
    matched.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
    return { id: matched[0].id, price: matched[0].price, eventId: matched[0].eventId };
  }
}

// ─────────────────────────────────────────────────────
// Shared: process a successful payment
// ─────────────────────────────────────────────────────

/**
 * Process a successful payment: create registrations for ALL items + update soldCount.
 * Used by both webhook and verify endpoint.
 * Returns { order, user } for email sending, or null if order not found.
 */
async function processSuccessfulPayment(
  fastify: { log: { info: (...args: any[]) => void; error: (...args: any[]) => void } },
  orderId: number,
  paymentIntentId: string,
  workshopSessionId: number | null,
  receiptUrl: string | null,
  paymentChannel: string,
): Promise<{
  order: { id: number; userId: number; orderNumber: string; totalAmount: string; currency: string; status: string };
  user: { email: string; firstName: string; lastName: string };
  regCode: string;
} | null> {
  return await db.transaction(async (tx) => {
    // Update order status
    const [order] = await tx
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) return null;

    if (order.status !== "paid") {
      await tx
        .update(orders)
        .set({ status: "paid" })
        .where(eq(orders.id, orderId));
    }

    // Update payment record
    await tx
      .update(payments)
      .set({
        status: "paid",
        paymentChannel,
        stripeReceiptUrl: receiptUrl,
        paidAt: new Date(),
      })
      .where(eq(payments.stripeSessionId, paymentIntentId));

    // Get user info
    const [user] = await tx
      .select({
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(eq(users.id, order.userId))
      .limit(1);

    if (!user) return null;

    // Get order items
    const items = await tx
      .select({
        id: orderItems.id,
        itemType: orderItems.itemType,
        ticketTypeId: orderItems.ticketTypeId,
        price: orderItems.price,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));

    // Duplicate guard: check if registration already exists for this order
    const existingRegCount = await tx
      .select({ count: count() })
      .from(registrations)
      .where(eq(registrations.orderId, orderId));

    if (existingRegCount[0].count > 0) {
      fastify.log.info(`Registration already exists for order ${orderId}, skipping creation`);
      const [existingReg] = await tx
        .select({ regCode: registrations.regCode })
        .from(registrations)
        .where(eq(registrations.orderId, orderId))
        .limit(1);
      return { order: { ...order, status: "paid" as string }, user, regCode: existingReg?.regCode || "" };
    }

    // Find primary (ticket) item to get eventId
    const primaryItem = items.find(i => i.itemType === "ticket");
    const isAddonOnlyOrder = !primaryItem;

    let registration: { id: number };
    let regCode: string;
    let eventId: number = 1;

    if (isAddonOnlyOrder) {
      // ── Addon-only order: use existing registration ────
      const [existingReg] = await tx
        .select({ id: registrations.id, regCode: registrations.regCode, eventId: registrations.eventId })
        .from(registrations)
        .where(
          and(
            eq(registrations.userId, order.userId),
            eq(registrations.status, "confirmed")
          )
        )
        .limit(1);

      if (!existingReg) {
        fastify.log.error(`Addon-only order ${orderId} but no existing registration for user ${order.userId}`);
        return null;
      }

      registration = { id: existingReg.id };
      regCode = existingReg.regCode;
      eventId = existingReg.eventId;
      fastify.log.info(`Addon-only order ${orderId}: using existing registration ${existingReg.id}`);
    } else {
      // ── Full order: create new registration ────────────
      const [primaryTicket] = await tx
        .select({ eventId: ticketTypes.eventId })
        .from(ticketTypes)
        .where(eq(ticketTypes.id, primaryItem.ticketTypeId))
        .limit(1);

      eventId = primaryTicket?.eventId || 1;
      regCode = generateRegCode();
      const [newReg] = await tx.insert(registrations).values({
        regCode,
        orderId,
        eventId,
        ticketTypeId: primaryItem.ticketTypeId,
        userId: order.userId,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        status: "confirmed",
      }).returning();

      registration = { id: newReg.id };
    }

    // Create registration_sessions for each order item
    let totalSessionLinks = 0;
    for (const item of items) {
      const [ticket] = await tx
        .select({ groupName: ticketTypes.groupName })
        .from(ticketTypes)
        .where(eq(ticketTypes.id, item.ticketTypeId))
        .limit(1);

      // Determine which session(s) to link
      let sessionIdsToLink: number[] = [];

      if (
        item.itemType === "addon" &&
        ticket?.groupName?.toLowerCase() === "workshop" &&
        workshopSessionId
      ) {
        // Workshop addon → user chose a specific session
        sessionIdsToLink = [workshopSessionId];
      } else {
        // Primary or other addon → lookup sessions from ticketSessions junction
        const linkedSessions = await tx
          .select({ sessionId: ticketSessions.sessionId })
          .from(ticketSessions)
          .where(eq(ticketSessions.ticketTypeId, item.ticketTypeId));

        sessionIdsToLink = linkedSessions.map(ls => ls.sessionId);

        // Fallback for primary tickets: if no ticket_sessions rows, auto-link to main session(s)
        if (sessionIdsToLink.length === 0 && item.itemType === "ticket") {
          const mainSessions = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.eventId, eventId),
                eq(sessions.isMainSession, true)
              )
            );
          sessionIdsToLink = mainSessions.map(s => s.id);

          // Backfill ticket_sessions so future lookups work
          if (sessionIdsToLink.length > 0) {
            await tx.insert(ticketSessions).values(
              sessionIdsToLink.map(sid => ({
                ticketTypeId: item.ticketTypeId,
                sessionId: sid,
              }))
            );
            fastify.log.info(`Backfilled ticket_sessions for primary ticket ${item.ticketTypeId} → ${sessionIdsToLink.length} main sessions`);
          }
        }
      }

      // Insert registration_sessions rows
      for (const sid of sessionIdsToLink) {
        await tx.insert(registrationSessions).values({
          registrationId: registration.id,
          sessionId: sid,
          ticketTypeId: item.ticketTypeId,
        });
        totalSessionLinks++;
      }

      // Update soldCount (unchanged)
      await tx
        .update(ticketTypes)
        .set({
          soldCount: sql`${ticketTypes.soldCount} + ${item.quantity}`,
        })
        .where(eq(ticketTypes.id, item.ticketTypeId));
    }

    fastify.log.info(`${isAddonOnlyOrder ? "Addon-only" : "Created 1 registration"} + ${totalSessionLinks} session links + updated soldCount for order ${orderId}`);

    return { order: { ...order, status: "paid" as string }, user, regCode };
  });
}

// ─────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────

export default async function paymentRoutes(fastify: FastifyInstance) {
  // ─────────────────────────────────────────────────────
  // GET /payments/my-purchases (JWT protected)
  // Returns what the current user has already purchased
  // ─────────────────────────────────────────────────────
  fastify.get(
    "/my-purchases",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user.id;

      try {
        // Find all paid orders for this user
        const paidOrders = await db
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.userId, userId), eq(orders.status, "paid")));

        if (paidOrders.length === 0) {
          return reply.send({
            success: true,
            data: {
              hasPrimaryTicket: false,
              primaryTicketName: null,
              regCode: null,
              purchasedAddOns: [],
            },
          });
        }

        const paidOrderIds = paidOrders.map((o) => o.id);

        // Get all order items from paid orders
        const allItems = await db
          .select({
            itemType: orderItems.itemType,
            ticketTypeId: orderItems.ticketTypeId,
            ticketName: ticketTypes.name,
            groupName: ticketTypes.groupName,
            category: ticketTypes.category,
          })
          .from(orderItems)
          .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
          .where(inArray(orderItems.orderId, paidOrderIds));

        const hasPrimaryTicket = allItems.some((i) => i.category === "primary");
        const primaryItem = allItems.find((i) => i.category === "primary");

        // Get purchased addon groupNames (deduplicated)
        const purchasedAddOns = [
          ...new Set(
            allItems
              .filter((i) => i.category === "addon" && i.groupName)
              .map((i) => i.groupName!.toLowerCase())
          ),
        ];

        // Get regCode from registration
        let regCode: string | null = null;
        if (hasPrimaryTicket) {
          const [reg] = await db
            .select({ regCode: registrations.regCode })
            .from(registrations)
            .where(
              and(
                eq(registrations.userId, userId),
                eq(registrations.status, "confirmed")
              )
            )
            .limit(1);
          regCode = reg?.regCode || null;
        }

        return reply.send({
          success: true,
          data: {
            hasPrimaryTicket,
            primaryTicketName: primaryItem?.ticketName || null,
            regCode,
            purchasedAddOns,
          },
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch purchases",
        });
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // GET /payments/my-tickets (JWT protected)
  // Returns DB-backed ticket data for My Tickets page
  // ─────────────────────────────────────────────────────
  fastify.get(
    "/my-tickets",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user.id;

      try {
        // Primary confirmed registration (single source of truth for ticket owner)
        const [primaryRegistration] = await db
          .select({
            registrationId: registrations.id,
            regCode: registrations.regCode,
            status: registrations.status,
            dietaryRequirements: registrations.dietaryRequirements,
            purchasedAt: registrations.createdAt,
            ticketName: ticketTypes.name,
            ticketPriority: ticketTypes.priority,
            ticketPrice: ticketTypes.price,
            ticketCurrency: ticketTypes.currency,
            ticketFeatures: ticketTypes.features,
          })
          .from(registrations)
          .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
          .where(
            and(
              eq(registrations.userId, userId),
              eq(registrations.status, "confirmed")
            )
          )
          .orderBy(desc(registrations.createdAt))
          .limit(1);

        if (!primaryRegistration) {
          return reply.send({
            success: true,
            data: {
              registration: null,
              galaTicket: null,
              workshops: [],
            },
          });
        }

        const addonRows = await db
          .select({
            ticketTypeId: registrationSessions.ticketTypeId,
            linkedAt: registrationSessions.createdAt,
            groupName: ticketTypes.groupName,
            ticketName: ticketTypes.name,
            ticketPrice: ticketTypes.price,
            ticketCurrency: ticketTypes.currency,
            sessionId: sessions.id,
            sessionName: sessions.sessionName,
            sessionStartTime: sessions.startTime,
            sessionEndTime: sessions.endTime,
            sessionRoom: sessions.room,
          })
          .from(registrationSessions)
          .innerJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
          .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
          .where(
            and(
              eq(registrationSessions.registrationId, primaryRegistration.registrationId),
              eq(ticketTypes.category, "addon")
            )
          )
          .orderBy(desc(registrationSessions.createdAt));

        const workshopRows = addonRows.filter(
          (row) => (row.groupName || "").toLowerCase() === "workshop"
        );
        const galaRow = addonRows.find(
          (row) => (row.groupName || "").toLowerCase() === "gala"
        );

        return reply.send({
          success: true,
          data: {
            registration: {
              regCode: primaryRegistration.regCode,
              status: primaryRegistration.status,
              ticketName: primaryRegistration.ticketName,
              priority: primaryRegistration.ticketPriority,
              purchasedAt: primaryRegistration.purchasedAt?.toISOString() || null,
              amount: primaryRegistration.ticketPrice,
              currency: primaryRegistration.ticketCurrency,
              includes: Array.isArray(primaryRegistration.ticketFeatures)
                ? primaryRegistration.ticketFeatures
                : [],
            },
            galaTicket: galaRow
              ? {
                  id: `${primaryRegistration.regCode}-GALA`,
                  status: primaryRegistration.status,
                  name: galaRow.ticketName,
                  purchasedAt: galaRow.linkedAt?.toISOString() || null,
                  amount: galaRow.ticketPrice,
                  currency: galaRow.ticketCurrency,
                  dateTimeStart: galaRow.sessionStartTime?.toISOString() || null,
                  dateTimeEnd: galaRow.sessionEndTime?.toISOString() || null,
                  venue: galaRow.sessionRoom,
                  dietary: primaryRegistration.dietaryRequirements || null,
                }
              : null,
            workshops: workshopRows.map((row) => ({
              id: `${primaryRegistration.regCode}-WS-${row.sessionId}`,
              status: primaryRegistration.status,
              name: row.sessionName || row.ticketName,
              purchasedAt: row.linkedAt?.toISOString() || null,
              amount: row.ticketPrice,
              currency: row.ticketCurrency,
              dateTimeStart: row.sessionStartTime?.toISOString() || null,
              dateTimeEnd: row.sessionEndTime?.toISOString() || null,
              venue: row.sessionRoom,
            })),
          },
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: "Failed to fetch my tickets",
        });
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // POST /payments/create-intent (JWT protected)
  // ─────────────────────────────────────────────────────
  fastify.post(
    "/create-intent",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // 1. Validate request body with Zod
      const parsed = createPaymentIntentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "Invalid input",
          details: parsed.error.flatten(),
        });
      }

      const { packageId, addOnIds, currency, paymentMethod, promoCode, workshopSessionId } = parsed.data;
      const userId = request.user.id;
      const isAddonOnly = !packageId || packageId === "";

      fastify.log.info(`[CREATE-INTENT] paymentMethod=${paymentMethod}, currency=${currency}, packageId=${packageId || "(addon-only)"}, isAddonOnly=${isAddonOnly}`);

      try {
        // ── Duplicate / addon-only guard ─────────────────────
        // Find user's existing paid orders
        const existingPaidOrders = await db
          .select({ id: orders.id })
          .from(orders)
          .where(and(eq(orders.userId, userId), eq(orders.status, "paid")));

        let userHasPrimary = false;
        const userPurchasedAddOns: string[] = [];

        if (existingPaidOrders.length > 0) {
          const paidOrderIds = existingPaidOrders.map((o) => o.id);
          const existingItems = await db
            .select({
              category: ticketTypes.category,
              groupName: ticketTypes.groupName,
            })
            .from(orderItems)
            .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
            .where(inArray(orderItems.orderId, paidOrderIds));

          userHasPrimary = existingItems.some((i) => i.category === "primary");
          for (const item of existingItems) {
            if (item.category === "addon" && item.groupName) {
              userPurchasedAddOns.push(item.groupName.toLowerCase());
            }
          }
        }

        // Block duplicate primary ticket purchase
        if (!isAddonOnly && userHasPrimary) {
          return reply.status(400).send({
            success: false,
            error: "You already have a registration ticket for this event. Use add-on purchase instead.",
            code: "DUPLICATE_PRIMARY",
          });
        }

        // Addon-only requires existing primary ticket
        if (isAddonOnly && !userHasPrimary) {
          return reply.status(400).send({
            success: false,
            error: "You must purchase a registration ticket before buying add-ons.",
            code: "NO_PRIMARY_TICKET",
          });
        }

        // Addon-only requires at least one addon
        if (isAddonOnly && addOnIds.length === 0) {
          return reply.status(400).send({
            success: false,
            error: "Please select at least one add-on.",
          });
        }

        // Block duplicate addon purchase
        for (const addOnId of addOnIds) {
          if (userPurchasedAddOns.includes(addOnId.toLowerCase())) {
            return reply.status(400).send({
              success: false,
              error: `You already purchased the "${addOnId}" add-on.`,
              code: "DUPLICATE_ADDON",
            });
          }
        }

        // ── Resolve primary ticket (if not addon-only) ──────
        let primaryTicket: { id: number; price: string; eventId: number } | null = null;
        if (!isAddonOnly) {
          primaryTicket = await resolveTicketId(packageId, currency, "primary");
          if (!primaryTicket) {
            return reply.status(404).send({
              success: false,
              error: `No ${currency} ticket found for package "${packageId}"`,
            });
          }

          // Check availability
          const [currentTicket] = await db
            .select({ quota: ticketTypes.quota, soldCount: ticketTypes.soldCount })
            .from(ticketTypes)
            .where(eq(ticketTypes.id, primaryTicket.id))
            .limit(1);

          if (currentTicket && currentTicket.soldCount >= currentTicket.quota) {
            return reply.status(400).send({
              success: false,
              error: "Ticket sold out",
            });
          }
        }

        // ── Resolve add-ons ─────────────────────────────────
        let totalAmount = primaryTicket ? Number(primaryTicket.price) : 0;
        const resolvedAddOns: { id: number; price: string; eventId: number }[] = [];

        for (const addOnId of addOnIds) {
          const addon = await resolveTicketId(addOnId, currency, "addon");
          if (addon) {
            totalAmount += Number(addon.price);
            resolvedAddOns.push(addon);
            fastify.log.info(`[CREATE-INTENT] Resolved addon "${addOnId}" → ticketTypeId=${addon.id}, price=${addon.price}`);
          } else {
            fastify.log.info(`[CREATE-INTENT] Could not resolve addon "${addOnId}" for currency=${currency}`);
          }
        }
        fastify.log.info(`[CREATE-INTENT] addOnIds=${JSON.stringify(addOnIds)}, resolved=${resolvedAddOns.length}, total=${totalAmount}`);

        // Workshop addon must always have exactly one selected session
        if (addOnIds.includes("workshop") && !workshopSessionId) {
          return reply.status(400).send({
            success: false,
            error: "Workshop session is required",
          });
        }

        // ── Validate workshop session if provided ───────────
        if (workshopSessionId && addOnIds.includes("workshop")) {
          const workshopTicketIds = resolvedAddOns.map((a) => a.id);
          if (workshopTicketIds.length > 0) {
            const [linked] = await db
              .select({ id: ticketSessions.id })
              .from(ticketSessions)
              .innerJoin(sessions, eq(ticketSessions.sessionId, sessions.id))
              .where(
                and(
                  inArray(ticketSessions.ticketTypeId, workshopTicketIds),
                  eq(ticketSessions.sessionId, workshopSessionId),
                  eq(sessions.isActive, true)
                )
              )
              .limit(1);

            if (!linked) {
              return reply.status(400).send({
                success: false,
                error: "Invalid workshop session selection",
              });
            }

            // Check session capacity
            const [enrollCount] = await db
              .select({ count: count() })
              .from(registrations)
              .where(
                and(
                  eq(registrations.sessionId, workshopSessionId),
                  eq(registrations.status, "confirmed")
                )
              );

            const [sessionData] = await db
              .select({ maxCapacity: sessions.maxCapacity })
              .from(sessions)
              .where(eq(sessions.id, workshopSessionId))
              .limit(1);

            if (sessionData?.maxCapacity && enrollCount.count >= sessionData.maxCapacity) {
              return reply.status(400).send({
                success: false,
                error: "Selected workshop session is full",
              });
            }
          }
        }

        // 5. Apply promo code (if any)
        // TODO: Validate promo code and calculate discount
        // let discount = 0;
        // totalAmount -= discount;

        // 6. Calculate Stripe fee (pass-through to buyer)
        const feeMethod = resolveFeeMethod(paymentMethod, currency);
        const feeBreakdown = calculateStripeFee(totalAmount, feeMethod);
        const chargeAmount = feeBreakdown.total; // amount buyer pays (net + fee)

        // 7. Create Order record (with orderNumber)
        const orderNumber = generateOrderNumber();
        const [order] = await db
          .insert(orders)
          .values({
            userId,
            orderNumber,
            totalAmount: String(chargeAmount),
            currency,
            status: "pending",
          })
          .returning();

        // 8. Create OrderItems
        if (primaryTicket) {
          await db.insert(orderItems).values({
            orderId: order.id,
            itemType: "ticket",
            ticketTypeId: primaryTicket.id,
            price: primaryTicket.price,
            quantity: 1,
          });
        }

        for (const addon of resolvedAddOns) {
          await db.insert(orderItems).values({
            orderId: order.id,
            itemType: "addon",
            ticketTypeId: addon.id,
            price: addon.price,
            quantity: 1,
          });
        }

        // 9. Create Stripe PaymentIntent
        let paymentMethodTypes: string[];
        if (paymentMethod === "qr" && currency === "THB") {
          paymentMethodTypes = ["promptpay"];
        } else {
          paymentMethodTypes = ["card"];
        }

        // Build detailed description for Stripe receipt
        const ticketIds = [
          ...(primaryTicket ? [primaryTicket.id] : []),
          ...resolvedAddOns.map(a => a.id),
        ];
        const ticketNames = await db
          .select({ id: ticketTypes.id, name: ticketTypes.name })
          .from(ticketTypes)
          .where(sql`${ticketTypes.id} IN (${sql.join(ticketIds.map(id => sql`${id}`), sql`, `)})`);
        const nameMap = new Map(ticketNames.map(t => [t.id, t.name]));

        const descLines = [`ACCP2026 - Order ${orderNumber}${isAddonOnly ? " (Add-on)" : ""}`];
        if (primaryTicket) {
          descLines.push(`• ${nameMap.get(primaryTicket.id) || packageId}: ${currency === "THB" ? "฿" : "$"}${Number(primaryTicket.price).toLocaleString()}`);
        }
        for (const addon of resolvedAddOns) {
          descLines.push(`• ${nameMap.get(addon.id) || "Add-on"}: ${currency === "THB" ? "฿" : "$"}${Number(addon.price).toLocaleString()}`);
        }
        if (feeBreakdown.fee > 0) {
          descLines.push(`• Fee: ${currency === "THB" ? "฿" : "$"}${feeBreakdown.fee.toLocaleString()}`);
        }

        // Stripe expects amount in smallest currency unit (satang/cents)
        const stripeAmount = Math.round(chargeAmount * 100);

        const paymentIntent = await stripe.paymentIntents.create(
          {
            amount: stripeAmount,
            currency: currency.toLowerCase(),
            payment_method_types: paymentMethodTypes,
            metadata: {
              orderId: String(order.id),
              orderNumber,
              userId: String(userId),
              packageId: packageId || "",
              addOnIds: addOnIds.join(",") || "",
              isAddonOnly: isAddonOnly ? "true" : "false",
              netAmount: String(totalAmount),
              fee: String(feeBreakdown.fee),
              feeMethod,
              workshopSessionId: workshopSessionId ? String(workshopSessionId) : "",
            },
            description: descLines.join("\n"),
          },
          {
            idempotencyKey: `create-intent-${order.id}`,
          }
        );

        // 10. Create Payment record
        await db.insert(payments).values({
          orderId: order.id,
          amount: String(chargeAmount),
          status: "pending",
          stripeSessionId: paymentIntent.id,
        });

        // 11. Return clientSecret + fee breakdown
        return reply.send({
          success: true,
          data: {
            clientSecret: paymentIntent.client_secret,
            orderId: order.id,
            orderNumber,
            subtotal: totalAmount,
            fee: feeBreakdown.fee,
            total: chargeAmount,
            currency,
            feeMethod,
          },
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: "Failed to create payment intent",
        });
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // POST /payments/cancel-intent (JWT protected)
  // Cancels a pending PaymentIntent and marks order cancelled
  // ─────────────────────────────────────────────────────
  fastify.post(
    "/cancel-intent",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { orderId } = request.body as { orderId: number };
      const userId = request.user.id;

      if (!orderId) {
        return reply.status(400).send({ success: false, error: "orderId is required" });
      }

      try {
        // Find the order and verify ownership
        const [order] = await db
          .select()
          .from(orders)
          .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
          .limit(1);

        if (!order) {
          return reply.status(404).send({ success: false, error: "Order not found" });
        }

        if (order.status !== "pending") {
          return reply.status(400).send({
            success: false,
            error: `Cannot cancel order with status "${order.status}"`,
          });
        }

        // Find the payment record to get the Stripe PaymentIntent ID
        const [payment] = await db
          .select()
          .from(payments)
          .where(eq(payments.orderId, orderId))
          .limit(1);

        if (payment?.stripeSessionId) {
          // Cancel the Stripe PaymentIntent
          try {
            await stripe.paymentIntents.cancel(payment.stripeSessionId);
            fastify.log.info(`[CANCEL-INTENT] Cancelled PaymentIntent ${payment.stripeSessionId} for order ${orderId}`);
          } catch (stripeErr: any) {
            // If already cancelled or cannot be cancelled, log but continue
            fastify.log.info(`[CANCEL-INTENT] Stripe cancel note: ${stripeErr.message}`);
          }
        }

        // Update order status to cancelled
        await db
          .update(orders)
          .set({ status: "cancelled" })
          .where(eq(orders.id, orderId));

        // Update payment status to cancelled
        if (payment) {
          await db
            .update(payments)
            .set({ status: "cancelled" })
            .where(eq(payments.id, payment.id));
        }

        fastify.log.info(`[CANCEL-INTENT] Order ${orderId} cancelled by user ${userId}`);

        return reply.send({ success: true, data: { orderId, status: "cancelled" } });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ success: false, error: "Failed to cancel payment" });
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // POST /payments/webhook (NO JWT — Stripe calls this)
  // ─────────────────────────────────────────────────────
  fastify.post(
    "/webhook",
    {
      preParsing: async (request: FastifyRequest, _reply: FastifyReply, payload: any) => {
        const chunks: Buffer[] = [];
        for await (const chunk of payload) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        (request as any).rawBody = Buffer.concat(chunks);
        return Readable.from((request as any).rawBody);
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const sig = request.headers["stripe-signature"] as string;
      const rawBody = (request as any).rawBody as Buffer;

      if (!rawBody || !sig) {
        return reply.status(400).send({ error: "Missing signature or body" });
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          rawBody,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET || ""
        );
      } catch (err: any) {
        fastify.log.error(
          `Webhook signature verification failed: ${err.message}`
        );
        return reply.status(400).send({ error: "Invalid signature" });
      }

      switch (event.type) {
        case "payment_intent.succeeded": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          const orderId = parseInt(paymentIntent.metadata.orderId);

          if (isNaN(orderId)) break;

          // Duplicate guard: skip if already processed
          const [existingPayment] = await db
            .select({ status: payments.status })
            .from(payments)
            .where(eq(payments.stripeSessionId, paymentIntent.id))
            .limit(1);

          if (existingPayment?.status === "paid") {
            fastify.log.info(
              `Webhook already processed for order ${orderId}, skipping`
            );
            break;
          }

          // Get receipt URL from latest_charge
          let receiptUrl: string | null = null;
          if (paymentIntent.latest_charge) {
            try {
              const charge = await stripe.charges.retrieve(
                paymentIntent.latest_charge as string
              );
              receiptUrl = charge.receipt_url || null;
            } catch {
              // Non-critical, continue
            }
          }

          // Read workshopSessionId from metadata
          const workshopSessionId = paymentIntent.metadata.workshopSessionId
            ? parseInt(paymentIntent.metadata.workshopSessionId)
            : null;

          const paymentChannel = paymentIntent.payment_method_types?.[0] || "card";

          // Process payment: create registrations for ALL items + update soldCount
          const txResult = await processSuccessfulPayment(
            fastify,
            orderId,
            paymentIntent.id,
            workshopSessionId,
            receiptUrl,
            paymentChannel,
          );

          // Send receipt + confirmation emails (fire-and-forget)
          if (txResult) {
            const { order, user, regCode } = txResult;
            try {
              const emailItems = await db
                .select({
                  name: ticketTypes.name,
                  type: orderItems.itemType,
                  price: orderItems.price,
                  quantity: orderItems.quantity,
                })
                .from(orderItems)
                .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
                .where(eq(orderItems.orderId, orderId));

              const emailSubtotal = emailItems.reduce(
                (sum, item) => sum + Number(item.price) * item.quantity, 0
              );
              const emailTotal = Number(order.totalAmount);
              const emailFee = Math.round((emailTotal - emailSubtotal) * 100) / 100;

              const receiptToken = generateReceiptToken(orderId);
              const apiBaseUrl = process.env.API_BASE_URL || `http://localhost:3002`;
              const receiptDownloadUrl = `${apiBaseUrl}/api/payments/receipt/${receiptToken}`;

              await sendPaymentReceiptEmail(
                user.email,
                user.firstName,
                user.lastName,
                order.orderNumber,
                new Date(),
                paymentChannel,
                emailItems.map((i) => ({
                  name: i.name,
                  type: i.type,
                  price: Number(i.price),
                })),
                emailSubtotal,
                emailFee,
                emailTotal,
                order.currency,
                receiptDownloadUrl,
                regCode
              );

            } catch (emailErr) {
              // Email failure should not fail the webhook
              fastify.log.error(`Failed to send receipt email for order ${orderId}: ${emailErr}`);
            }
          }

          fastify.log.info(`Payment succeeded for order ${orderId}`);
          break;
        }

        case "payment_intent.payment_failed": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          const orderId = parseInt(paymentIntent.metadata.orderId);
          if (isNaN(orderId)) break;

          await db
            .update(orders)
            .set({ status: "cancelled" })
            .where(eq(orders.id, orderId));

          await db
            .update(payments)
            .set({ status: "failed" })
            .where(eq(payments.stripeSessionId, paymentIntent.id));

          fastify.log.warn(`Payment failed for order ${orderId}`);
          break;
        }

        case "payment_intent.canceled": {
          const paymentIntent = event.data.object as Stripe.PaymentIntent;
          const orderId = parseInt(paymentIntent.metadata.orderId);
          if (isNaN(orderId)) break;

          await db
            .update(orders)
            .set({ status: "cancelled" })
            .where(eq(orders.id, orderId));

          await db
            .update(payments)
            .set({ status: "cancelled" })
            .where(eq(payments.stripeSessionId, paymentIntent.id));

          fastify.log.info(`Payment canceled for order ${orderId}`);
          break;
        }
      }

      return reply.send({ received: true });
    }
  );

  // ─────────────────────────────────────────────────────
  // GET /payments/verify?payment_intent=pi_xxx (JWT protected)
  // Used by result page after Stripe redirect
  // ─────────────────────────────────────────────────────
  fastify.get(
    "/verify",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { payment_intent: piId } = request.query as { payment_intent?: string };
      const userId = request.user.id;

      if (!piId) {
        return reply.status(400).send({ success: false, error: "Missing payment_intent parameter" });
      }

      // Find payment by Stripe PaymentIntent ID
      const [payment] = await db
        .select({
          id: payments.id,
          orderId: payments.orderId,
          status: payments.status,
          amount: payments.amount,
          paidAt: payments.paidAt,
          stripeReceiptUrl: payments.stripeReceiptUrl,
          paymentChannel: payments.paymentChannel,
          stripeSessionId: payments.stripeSessionId,
        })
        .from(payments)
        .where(eq(payments.stripeSessionId, piId))
        .limit(1);

      if (!payment) {
        return reply.status(404).send({ success: false, error: "Payment not found" });
      }

      // Fetch order + verify ownership
      const [order] = await db
        .select({
          id: orders.id,
          userId: orders.userId,
          orderNumber: orders.orderNumber,
          totalAmount: orders.totalAmount,
          currency: orders.currency,
          status: orders.status,
        })
        .from(orders)
        .where(eq(orders.id, payment.orderId))
        .limit(1);

      if (!order || order.userId !== userId) {
        return reply.status(403).send({ success: false, error: "Access denied" });
      }

      let orderStatus = order.status;
      let paymentData = payment;
      let justTransitionedToPaid = false;
      let verifyRegCode = "";

      // If still pending, verify with Stripe API
      if (payment.status === "pending") {
        try {
          const pi = await stripe.paymentIntents.retrieve(piId);
          fastify.log.info(`[VERIFY] pi.status=${pi.status} for ${piId}`);

          if (pi.status === "succeeded") {
            let receiptUrl: string | null = null;
            if (pi.latest_charge) {
              try {
                const charge = await stripe.charges.retrieve(pi.latest_charge as string);
                receiptUrl = charge.receipt_url || null;
              } catch { /* non-critical */ }
            }

            // Read workshopSessionId from metadata
            const workshopSessionId = pi.metadata.workshopSessionId
              ? parseInt(pi.metadata.workshopSessionId)
              : null;

            const verifyPaymentChannel = pi.payment_method_types?.[0] || "card";

            // Process payment: create registrations for ALL items + update soldCount
            const verifyResult = await processSuccessfulPayment(
              fastify,
              order.id,
              piId,
              workshopSessionId,
              receiptUrl,
              verifyPaymentChannel,
            );

            if (verifyResult) {
              orderStatus = "paid";
              paymentData = { ...paymentData, status: "paid", paymentChannel: verifyPaymentChannel, stripeReceiptUrl: receiptUrl, paidAt: new Date() };
              justTransitionedToPaid = true;
              verifyRegCode = verifyResult.regCode;
              fastify.log.info(`[VERIFY] Updated order ${order.id} to paid`);
            }
          } else if (pi.status === "canceled" || pi.status === "requires_payment_method") {
            await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, order.id));
            await db.update(payments).set({ status: "failed" }).where(eq(payments.stripeSessionId, piId));
            orderStatus = "cancelled";
            paymentData = { ...paymentData, status: "failed" };
          }
        } catch (err) {
          fastify.log.error(`[VERIFY] Stripe API error: ${err}`);
        }
      }

      // Fetch order items with ticket names
      const items = await db
        .select({
          itemType: orderItems.itemType,
          price: orderItems.price,
          quantity: orderItems.quantity,
          ticketName: ticketTypes.name,
          ticketCategory: ticketTypes.category,
        })
        .from(orderItems)
        .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
        .where(eq(orderItems.orderId, order.id));

      // Calculate subtotal (sum of items) and fee
      const subtotal = items.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
      const totalPaid = Number(paymentData.amount);
      const fee = Math.round((totalPaid - subtotal) * 100) / 100;

      // Generate receipt download URL for paid orders
      let receiptDownloadUrl: string | null = null;
      if (orderStatus === "paid") {
        const receiptToken = generateReceiptToken(order.id);
        const apiBaseUrl = process.env.API_BASE_URL || "http://localhost:3002";
        receiptDownloadUrl = `${apiBaseUrl}/api/payments/receipt/${receiptToken}`;
      }

      // Send receipt email if verify endpoint just transitioned the order to paid
      if (justTransitionedToPaid) {
        const [verifyUser] = await db
          .select({
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(users)
          .where(eq(users.id, order.userId))
          .limit(1);

        if (verifyUser && receiptDownloadUrl) {
          // Fire-and-forget: don't block the response
          (async () => {
            try {
              await sendPaymentReceiptEmail(
                verifyUser.email,
                verifyUser.firstName,
                verifyUser.lastName,
                order.orderNumber,
                new Date(),
                paymentData.paymentChannel || "card",
                items.map((i) => ({
                  name: i.ticketName,
                  type: i.itemType,
                  price: Number(i.price),
                })),
                subtotal,
                fee > 0 ? fee : 0,
                totalPaid,
                order.currency,
                receiptDownloadUrl!,
                verifyRegCode
              );

            } catch (emailErr) {
              fastify.log.error(`[VERIFY] Failed to send receipt email for order ${order.id}: ${emailErr}`);
            }
          })();
        }
      }

      return reply.send({
        success: true,
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          orderStatus,
          payment: {
            status: paymentData.status,
            amount: paymentData.amount,
            paidAt: paymentData.paidAt,
            stripeReceiptUrl: paymentData.stripeReceiptUrl,
            paymentChannel: paymentData.paymentChannel,
          },
          receiptDownloadUrl,
          items: items.map(item => ({
            type: item.itemType,
            name: item.ticketName,
            category: item.ticketCategory,
            price: item.price,
            quantity: item.quantity,
          })),
          subtotal: String(subtotal),
          fee: fee > 0 ? String(fee) : "0",
        },
      });
    }
  );

  // ─────────────────────────────────────────────────────
  // GET /payments/:orderId/status (JWT protected + ownership check)
  // ─────────────────────────────────────────────────────
  fastify.get(
    "/:orderId/status",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { orderId } = request.params as { orderId: string };
      const userId = request.user.id;

      // Fetch order + verify ownership
      const [order] = await db
        .select({
          id: orders.id,
          userId: orders.userId,
          orderNumber: orders.orderNumber,
          status: orders.status,
        })
        .from(orders)
        .where(eq(orders.id, parseInt(orderId)))
        .limit(1);

      if (!order) {
        return reply
          .status(404)
          .send({ success: false, error: "Order not found" });
      }

      if (order.userId !== userId) {
        return reply
          .status(403)
          .send({ success: false, error: "Access denied" });
      }

      let orderStatus = order.status;

      let [payment] = await db
        .select({
          status: payments.status,
          amount: payments.amount,
          paidAt: payments.paidAt,
          stripeReceiptUrl: payments.stripeReceiptUrl,
          paymentChannel: payments.paymentChannel,
          stripeSessionId: payments.stripeSessionId,
        })
        .from(payments)
        .where(eq(payments.orderId, parseInt(orderId)))
        .limit(1);

      // Stripe API fallback: if DB still "pending", check Stripe directly
      fastify.log.info(`[STATUS] Order ${orderId} — DB order.status=${orderStatus}, payment.status=${payment?.status}, stripeSessionId=${payment?.stripeSessionId}`);
      if (payment && payment.status === "pending" && payment.stripeSessionId) {
        try {
          fastify.log.info(`[STATUS] Calling Stripe API for PaymentIntent: ${payment.stripeSessionId}`);
          const pi = await stripe.paymentIntents.retrieve(payment.stripeSessionId);
          fastify.log.info(`[STATUS] Stripe says: pi.status=${pi.status}`);

          if (pi.status === "succeeded") {
            // Get receipt URL
            let receiptUrl: string | null = null;
            if (pi.latest_charge) {
              try {
                const charge = await stripe.charges.retrieve(pi.latest_charge as string);
                receiptUrl = charge.receipt_url || null;
              } catch { /* non-critical */ }
            }

            // Read workshopSessionId from metadata
            const wsSessionId = pi.metadata.workshopSessionId
              ? parseInt(pi.metadata.workshopSessionId)
              : null;
            const statusPaymentChannel = pi.payment_method_types?.[0] || "card";

            // Process payment: create registrations + update soldCount
            await processSuccessfulPayment(
              fastify,
              order.id,
              payment.stripeSessionId!,
              wsSessionId,
              receiptUrl,
              statusPaymentChannel,
            );

            // Refresh response data
            orderStatus = "paid";
            payment = { ...payment, status: "paid", paymentChannel: statusPaymentChannel, stripeReceiptUrl: receiptUrl, paidAt: new Date() };

            fastify.log.info(`Fallback: updated order ${order.id} to paid via Stripe API check`);
          } else if (pi.status === "canceled") {
            await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, order.id));
            await db.update(payments).set({ status: "cancelled" }).where(eq(payments.stripeSessionId, payment.stripeSessionId));
            orderStatus = "cancelled";
            payment = { ...payment, status: "cancelled" };
          }
        } catch (err) {
          fastify.log.error(`Stripe API fallback error for order ${order.id}: ${err}`);
        }
      }

      return reply.send({
        success: true,
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          orderStatus,
          payment: payment ? {
            status: payment.status,
            amount: payment.amount,
            paidAt: payment.paidAt,
            stripeReceiptUrl: payment.stripeReceiptUrl,
            paymentChannel: payment.paymentChannel,
          } : null,
        },
      });
    }
  );

  // ─────────────────────────────────────────────────────
  // GET /payments/receipt/:token (NO JWT — signed token auth)
  // Downloads a PDF receipt generated on-the-fly
  // ─────────────────────────────────────────────────────
  fastify.get(
    "/receipt/:token",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { token } = request.params as { token: string };

      // 1. Verify signed token
      const orderId = verifyReceiptToken(token);
      if (orderId === null) {
        return reply.status(401).send({
          success: false,
          error: "Invalid or malformed receipt token",
        });
      }

      try {
        // 2. Fetch order
        const [order] = await db
          .select({
            id: orders.id,
            orderNumber: orders.orderNumber,
            totalAmount: orders.totalAmount,
            currency: orders.currency,
            status: orders.status,
            userId: orders.userId,
          })
          .from(orders)
          .where(eq(orders.id, orderId))
          .limit(1);

        if (!order) {
          return reply.status(404).send({
            success: false,
            error: "Order not found",
          });
        }

        if (order.status !== "paid") {
          return reply.status(400).send({
            success: false,
            error: "Receipt is only available for paid orders",
          });
        }

        // 3. Fetch payment info
        const [payment] = await db
          .select({
            paidAt: payments.paidAt,
            paymentChannel: payments.paymentChannel,
          })
          .from(payments)
          .where(eq(payments.orderId, orderId))
          .limit(1);

        // 4. Fetch user info
        const [user] = await db
          .select({
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(users)
          .where(eq(users.id, order.userId))
          .limit(1);

        if (!user) {
          return reply.status(404).send({
            success: false,
            error: "User not found",
          });
        }

        // 5. Fetch order items with ticket names
        const items = await db
          .select({
            name: ticketTypes.name,
            type: orderItems.itemType,
            price: orderItems.price,
            quantity: orderItems.quantity,
          })
          .from(orderItems)
          .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
          .where(eq(orderItems.orderId, orderId));

        // 6. Calculate fee
        const subtotal = items.reduce(
          (sum, item) => sum + Number(item.price) * item.quantity, 0
        );
        const total = Number(order.totalAmount);
        const fee = Math.round((total - subtotal) * 100) / 100;

        // 7. Generate PDF
        const pdfStream = generateReceiptPdf({
          orderNumber: order.orderNumber,
          paidAt: payment?.paidAt || new Date(),
          paymentChannel: payment?.paymentChannel || "card",
          currency: order.currency,
          items: items.map((i) => ({
            name: i.name,
            type: i.type as "ticket" | "addon",
            price: Number(i.price),
            quantity: i.quantity,
          })),
          subtotal,
          fee: fee > 0 ? fee : 0,
          total,
          customerName: `${user.firstName} ${user.lastName}`,
          customerEmail: user.email,
        });

        // 8. Stream PDF response
        const filename = `ACCP2026-receipt-${order.orderNumber}.pdf`;
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", `attachment; filename="${filename}"`);
        reply.header("Cache-Control", "private, max-age=3600");

        return reply.send(pdfStream);
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: "Failed to generate receipt",
        });
      }
    }
  );
}
