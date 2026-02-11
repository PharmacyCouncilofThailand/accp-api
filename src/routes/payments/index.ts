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
  users,
} from "../../database/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { createPaymentIntentSchema } from "../../schemas/payment.schema.js";
import type Stripe from "stripe";
import { calculateStripeFee, resolveFeeMethod } from "../../utils/stripeFee.js";

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
// Routes
// ─────────────────────────────────────────────────────

export default async function paymentRoutes(fastify: FastifyInstance) {
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

      const { packageId, addOnIds, currency, paymentMethod, promoCode } = parsed.data;
      const userId = request.user.id;

      fastify.log.info(`[CREATE-INTENT] paymentMethod=${paymentMethod}, currency=${currency}, packageId=${packageId}`);

      try {
        // 2. Resolve primary ticket
        const primaryTicket = await resolveTicketId(packageId, currency, "primary");
        if (!primaryTicket) {
          return reply.status(404).send({
            success: false,
            error: `No ${currency} ticket found for package "${packageId}"`,
          });
        }

        // 3. Check availability
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

        // 4. Calculate total
        let totalAmount = Number(primaryTicket.price);
        const resolvedAddOns: { id: number; price: string; eventId: number }[] = [];

        for (const addOnId of addOnIds) {
          const addon = await resolveTicketId(addOnId, currency, "addon");
          if (addon) {
            totalAmount += Number(addon.price);
            resolvedAddOns.push(addon);
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
        await db.insert(orderItems).values({
          orderId: order.id,
          itemType: "ticket",
          ticketTypeId: primaryTicket.id,
          price: primaryTicket.price,
          quantity: 1,
        });

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
        const ticketIds = [primaryTicket.id, ...resolvedAddOns.map(a => a.id)];
        const ticketNames = await db
          .select({ id: ticketTypes.id, name: ticketTypes.name })
          .from(ticketTypes)
          .where(sql`${ticketTypes.id} IN (${sql.join(ticketIds.map(id => sql`${id}`), sql`, `)})`);
        const nameMap = new Map(ticketNames.map(t => [t.id, t.name]));

        const descLines = [`ACCP2026 - Order ${orderNumber}`];
        descLines.push(`• ${nameMap.get(primaryTicket.id) || packageId}: ${currency === "THB" ? "฿" : "$"}${Number(primaryTicket.price).toLocaleString()}`);
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
              packageId,
              addOnIds: addOnIds.join(",") || "",
              netAmount: String(totalAmount),
              fee: String(feeBreakdown.fee),
              feeMethod,
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

          await db.transaction(async (tx) => {
            // Update order status
            await tx
              .update(orders)
              .set({ status: "paid" })
              .where(eq(orders.id, orderId));

            // Update payment record
            await tx
              .update(payments)
              .set({
                status: "paid",
                paymentChannel:
                  paymentIntent.payment_method_types?.[0] || "card",
                stripeReceiptUrl: receiptUrl,
                paidAt: new Date(),
              })
              .where(eq(payments.stripeSessionId, paymentIntent.id));

            // Get order + user for registration
            const [order] = await tx
              .select()
              .from(orders)
              .where(eq(orders.id, orderId))
              .limit(1);

            if (!order) return;

            const [user] = await tx
              .select({
                email: users.email,
                firstName: users.firstName,
                lastName: users.lastName,
              })
              .from(users)
              .where(eq(users.id, order.userId))
              .limit(1);

            if (!user) return;

            // Get order items
            const items = await tx
              .select()
              .from(orderItems)
              .where(eq(orderItems.orderId, orderId));

            // Create registration for primary ticket
            const primaryItem = items.find((i) => i.itemType === "ticket");
            if (primaryItem) {
              // Get eventId from ticket
              const [ticket] = await tx
                .select({ eventId: ticketTypes.eventId })
                .from(ticketTypes)
                .where(eq(ticketTypes.id, primaryItem.ticketTypeId))
                .limit(1);

              const regCode = generateRegCode();

              await tx.insert(registrations).values({
                regCode,
                eventId: ticket?.eventId || 1,
                ticketTypeId: primaryItem.ticketTypeId,
                userId: order.userId,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                status: "confirmed",
              });
            }

            // Update soldCount for all ticket types
            for (const item of items) {
              await tx
                .update(ticketTypes)
                .set({
                  soldCount: sql`${ticketTypes.soldCount} + ${item.quantity}`,
                })
                .where(eq(ticketTypes.id, item.ticketTypeId));
            }
          });

          // TODO: Send confirmation email via NipaMail (emailService.ts)
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

            await db.update(orders).set({ status: "paid" }).where(eq(orders.id, order.id));
            await db.update(payments).set({
              status: "paid",
              paymentChannel: pi.payment_method_types?.[0] || "card",
              stripeReceiptUrl: receiptUrl,
              paidAt: new Date(),
            }).where(eq(payments.stripeSessionId, piId));

            orderStatus = "paid";
            paymentData = { ...paymentData, status: "paid", paymentChannel: pi.payment_method_types?.[0] || "card", stripeReceiptUrl: receiptUrl, paidAt: new Date() };

            fastify.log.info(`[VERIFY] Updated order ${order.id} to paid`);
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

            // Update DB
            await db.update(orders).set({ status: "paid" }).where(eq(orders.id, order.id));
            await db.update(payments).set({
              status: "paid",
              paymentChannel: pi.payment_method_types?.[0] || "card",
              stripeReceiptUrl: receiptUrl,
              paidAt: new Date(),
            }).where(eq(payments.stripeSessionId, payment.stripeSessionId));

            // Refresh response data
            orderStatus = "paid";
            payment = { ...payment, status: "paid", paymentChannel: pi.payment_method_types?.[0] || "card", stripeReceiptUrl: receiptUrl, paidAt: new Date() };

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
}
