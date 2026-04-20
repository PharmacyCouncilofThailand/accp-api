import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  orders,
  payments,
  users,
  events,
  orderItems,
  ticketTypes,
  registrations,
  registrationSessions,
  sessions,
  staffEventAssignments,
} from "../../database/schema.js";
import { orderListQuerySchema } from "../../schemas/orders.schema.js";
import { generateReceiptToken } from "../../utils/receiptToken.js";
import { eq, desc, and, or, ilike, count, sql, inArray } from "drizzle-orm";

function getPublicApiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL || "http://localhost:3002")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  return raw.replace(/\/+$/, "");
}

export default async function (fastify: FastifyInstance) {
  // ── List Paid Orders ───────────────────────────────────
  fastify.get("", async (request, reply) => {
    const queryResult = orderListQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply
        .status(400)
        .send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const { page, limit, search } = queryResult.data;
    const offset = (page - 1) * limit;
    const staff = (request as any).user;

    try {
      // Always show only paid orders
      const conditions: any[] = [eq(orders.status, "paid")];

      // ── Event scoping for non-admin ──
      if (staff && staff.role !== "admin") {
        const assignments = await db
          .select({ eventId: staffEventAssignments.eventId })
          .from(staffEventAssignments)
          .where(eq(staffEventAssignments.staffId, staff.id));

        const assignedEventIds = assignments.map((a) => a.eventId);

        if (assignedEventIds.length === 0) {
          return reply.send({
            orders: [],
            pagination: { page, limit, total: 0, totalPages: 0 },
            stats: { successCount: 0, totalCount: 0 },
          });
        }

        conditions.push(inArray(orders.eventId, assignedEventIds));
      }

      // ── Global stats (unaffected by search) ──
      const baseWhereClause = and(...conditions);
      const [{ globalCount }] = await db
        .select({ globalCount: count() })
        .from(orders)
        .where(baseWhereClause);

      // ── Search by order ID from payment postback ──
      // Searches: paySolutionsOrderNo, providerRef, and inside payment_details JSONB
      if (search) {
        const matchedPayments = await db
          .select({ orderId: payments.orderId })
          .from(payments)
          .where(
            or(
              ilike(payments.paySolutionsOrderNo, `%${search}%`),
              ilike(payments.providerRef, `%${search}%`),
              ilike(payments.paySolutionsRefno, `%${search}%`),
              sql`CAST(${payments.paymentDetails} AS TEXT) ILIKE ${"%" + search + "%"}`
            )
          );

        const searchOrderIds = matchedPayments.map((p) => p.orderId);
        if (searchOrderIds.length === 0) {
          return reply.send({
            orders: [],
            pagination: { page, limit, total: 0, totalPages: 0 },
            stats: { successCount: globalCount, totalCount: globalCount },
          });
        }
        conditions.push(inArray(orders.id, searchOrderIds));
      }

      const whereClause = and(...conditions);

      // ── Count (filtered) ──
      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(orders)
        .where(whereClause);

      // ── Fetch orders ──
      const orderList = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          totalAmount: orders.totalAmount,
          subtotalAmount: orders.subtotalAmount,
          discountAmount: orders.discountAmount,
          promoCode: orders.promoCode,
          currency: orders.currency,
          status: orders.status,
          needTaxInvoice: orders.needTaxInvoice,
          createdAt: orders.createdAt,
          // User
          userId: users.id,
          userEmail: users.email,
          userFirstName: users.firstName,
          userLastName: users.lastName,
          userPhone: users.phone,
          userRole: users.role,
          userInstitution: users.institution,
          userCountry: users.country,
          // Event
          eventId: events.id,
          eventName: events.eventName,
          eventCode: events.eventCode,
        })
        .from(orders)
        .innerJoin(users, eq(orders.userId, users.id))
        .leftJoin(events, eq(orders.eventId, events.id))
        .where(whereClause)
        .orderBy(desc(orders.createdAt))
        .limit(limit)
        .offset(offset);

      const orderIds = orderList.map((o) => o.id);

      let paymentMap: Record<number, {
        status: string;
        paymentChannel: string | null;
        paymentProvider: string;
        paidAt: Date | null;
        paymentDetails: unknown;
      }> = {};
      let itemsMap: Record<number, { ticketName: string; category: string; price: string; quantity: number; groupName: string | null }[]> = {};
      let regCodeMap: Record<number, string> = {};
      let addonSessionMap: Record<number, { sessionName: string; sessionCode: string; sessionType: string; room: string | null; startTime: Date; endTime: Date }[]> = {};

      if (orderIds.length > 0) {
        // ── Payments: prefer 'paid' row, else latest ──
        const paymentRows = await db
          .select({
            orderId: payments.orderId,
            status: payments.status,
            paymentChannel: payments.paymentChannel,
            paymentProvider: payments.paymentProvider,
            paidAt: payments.paidAt,
            paymentDetails: payments.paymentDetails,
          })
          .from(payments)
          .where(inArray(payments.orderId, orderIds));

        for (const p of paymentRows) {
          if (!paymentMap[p.orderId] || p.status === "paid") {
            paymentMap[p.orderId] = p;
          }
        }

        // ── Order items ──
        const itemRows = await db
          .select({
            orderId: orderItems.orderId,
            ticketName: ticketTypes.name,
            ticketCategory: ticketTypes.category,
            groupName: ticketTypes.groupName,
            price: orderItems.price,
            quantity: orderItems.quantity,
          })
          .from(orderItems)
          .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
          .where(inArray(orderItems.orderId, orderIds));

        for (const item of itemRows) {
          if (!itemsMap[item.orderId]) itemsMap[item.orderId] = [];
          itemsMap[item.orderId].push({
            ticketName: item.ticketName,
            category: item.ticketCategory,
            groupName: item.groupName,
            price: item.price,
            quantity: item.quantity,
          });
        }

        // ── Registration codes ──
        const regRows = await db
          .select({
            orderId: registrations.orderId,
            regCode: registrations.regCode,
          })
          .from(registrations)
          .where(
            and(
              inArray(registrations.orderId, orderIds),
              eq(registrations.status, "confirmed")
            )
          );

        for (const reg of regRows) {
          if (reg.orderId) regCodeMap[reg.orderId] = reg.regCode;
        }

        // ── Addon (non-main) sessions per order ──
        // Strategy 1: registrations → registrationSessions → sessions (non-main)
        const addonSessionRows = await db
          .select({
            orderId: registrations.orderId,
            sessionName: sessions.sessionName,
            sessionCode: sessions.sessionCode,
            sessionType: sessions.sessionType,
            room: sessions.room,
            startTime: sessions.startTime,
            endTime: sessions.endTime,
          })
          .from(registrationSessions)
          .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
          .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
          .where(
            and(
              inArray(registrations.orderId, orderIds),
              eq(sessions.isMainSession, false)
            )
          );

        for (const ws of addonSessionRows) {
          if (ws.orderId) {
            if (!addonSessionMap[ws.orderId]) addonSessionMap[ws.orderId] = [];
            addonSessionMap[ws.orderId].push({
              sessionName: ws.sessionName,
              sessionCode: ws.sessionCode,
              sessionType: ws.sessionType || "other",
              room: ws.room,
              startTime: ws.startTime,
              endTime: ws.endTime,
            });
          }
        }

        // Strategy 2 (fallback): read workshopSessionId from payments.paymentDetails JSONB
        // for orders that have workshop items but no registrationSessions match above
        const ordersWithWorkshopItem = orderIds.filter((oid) => {
          const items = itemsMap[oid] || [];
          const hasWorkshop = items.some((i) => i.groupName?.toLowerCase() === "workshop");
          const alreadyHasWorkshop = (addonSessionMap[oid] || []).some(
            (s) => s.sessionType === "workshop"
          );
          return hasWorkshop && !alreadyHasWorkshop;
        });

        if (ordersWithWorkshopItem.length > 0) {
          for (const oid of ordersWithWorkshopItem) {
            const pd = paymentMap[oid]?.paymentDetails;
            if (!pd || typeof pd !== "object" || Array.isArray(pd)) continue;
            const wsId = (pd as Record<string, unknown>).workshopSessionId;
            const sessionId = typeof wsId === "number" ? wsId : parseInt(String(wsId || ""), 10);
            if (!sessionId || isNaN(sessionId) || sessionId <= 0) continue;

            const [session] = await db
              .select({
                sessionName: sessions.sessionName,
                sessionCode: sessions.sessionCode,
                sessionType: sessions.sessionType,
                room: sessions.room,
                startTime: sessions.startTime,
                endTime: sessions.endTime,
              })
              .from(sessions)
              .where(eq(sessions.id, sessionId))
              .limit(1);

            if (session) {
              if (!addonSessionMap[oid]) addonSessionMap[oid] = [];
              addonSessionMap[oid].push({
                sessionName: session.sessionName,
                sessionCode: session.sessionCode,
                sessionType: session.sessionType || "workshop",
                room: session.room,
                startTime: session.startTime,
                endTime: session.endTime,
              });
            }
          }
        }
      }

      // ── Assemble response ──
      const result = orderList.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        totalAmount: o.totalAmount,
        subtotalAmount: o.subtotalAmount,
        discountAmount: o.discountAmount,
        promoCode: o.promoCode,
        currency: o.currency,
        status: o.status,
        needTaxInvoice: o.needTaxInvoice,
        createdAt: o.createdAt,
        user: {
          id: o.userId,
          email: o.userEmail,
          firstName: o.userFirstName,
          lastName: o.userLastName,
          phone: o.userPhone,
          role: o.userRole,
          institution: o.userInstitution,
          country: o.userCountry,
        },
        event: o.eventId
          ? {
              id: o.eventId,
              name: o.eventName,
              code: o.eventCode,
            }
          : null,
        payment: paymentMap[o.id]
          ? {
              status: paymentMap[o.id].status,
              channel: paymentMap[o.id].paymentChannel,
              provider: paymentMap[o.id].paymentProvider,
              paidAt: paymentMap[o.id].paidAt,
            }
          : null,
        items: (itemsMap[o.id] || []).map((item) => ({
          ticketName: item.ticketName,
          category: item.category,
          price: item.price,
          quantity: item.quantity,
          groupName: item.groupName,
        })),
        regCode: regCodeMap[o.id] || null,
        addonSessions: addonSessionMap[o.id] || [],
        receiptUrl: (() => {
          const token = generateReceiptToken(o.id);
          return `${getPublicApiBaseUrl()}/api/payments/receipt/${token}`;
        })(),
      }));

      return reply.send({
        orders: result,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
        stats: {
          successCount: globalCount,
          totalCount: globalCount,
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch orders" });
    }
  });
}
