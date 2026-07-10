import { eq, and } from "drizzle-orm";
import { db } from "../database/index.js";
import {
  orders,
  orderItems,
  payments,
  users,
  ticketTypes,
  registrations,
} from "../database/schema.js";
import { sendPaymentReceiptEmail } from "./emailService.js";
import { generateReceiptToken } from "../utils/receiptToken.js";
import { buildChargeNote, resolveChargeDisplay } from "../utils/alipayCharge.js";

export type OfflinePaymentChannel = "card" | "alipay" | "promptpay";

/** Manual/offline payments are always recorded in THB. */
export const OFFLINE_PAYMENT_CURRENCY = "THB" as const;

export interface OfflinePaymentInput {
  channel: OfflinePaymentChannel;
  amount: number;
  paidAt?: Date;
  sendReceipt?: boolean;
}

export interface ManualOrderTicketLine {
  ticketTypeId: number;
  itemType: "ticket" | "addon";
  price: string;
  currency: string;
}

function generateOrderNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ACCP2026-${ts}-${rand}`;
}

function getPublicApiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL || "http://localhost:3002")
    .trim()
    .replace(/^['"]|['"]$/g, "");
  return raw.replace(/\/+$/, "");
}

function sortPrimaryFirst<T extends { type: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.type === "ticket" && b.type !== "ticket") return -1;
    if (a.type !== "ticket" && b.type === "ticket") return 1;
    return 0;
  });
}

export function buildReceiptUrl(orderId: number): string {
  const token = generateReceiptToken(orderId);
  return `${getPublicApiBaseUrl()}/api/payments/receipt/${token}`;
}

/**
 * Create a paid order + payment record for offline/manual registration.
 * Must be called inside an existing DB transaction.
 */
export async function createManualOfflineOrder(
  tx: any,
  params: {
    userId: number;
    eventId: number;
    items: ManualOrderTicketLine[];
    offlinePayment: OfflinePaymentInput;
    staffId: number;
    note?: string | null;
  },
): Promise<{ orderId: number; orderNumber: string; receiptUrl: string; totalAmount: number; currency: string }> {
  const { userId, eventId, items, offlinePayment, staffId, note } = params;

  if (items.length === 0) {
    throw new Error("OFFLINE_PAYMENT_NO_ITEMS");
  }

  const currency = OFFLINE_PAYMENT_CURRENCY;
  const totalAmount = offlinePayment.amount;
  if (!Number.isFinite(totalAmount) || totalAmount < 0) {
    throw new Error("INVALID_OFFLINE_PAYMENT_AMOUNT");
  }

  const thbCatalogSubtotal = items
    .filter((item) => item.currency === OFFLINE_PAYMENT_CURRENCY)
    .reduce((sum, item) => sum + Number(item.price), 0);

  const hasOnlyNonThbTickets = thbCatalogSubtotal === 0;
  const catalogSubtotal = hasOnlyNonThbTickets ? totalAmount : thbCatalogSubtotal;
  const discountAmount = hasOnlyNonThbTickets
    ? 0
    : Math.max(0, thbCatalogSubtotal - totalAmount);

  const orderNumber = generateOrderNumber();
  const paidAt = offlinePayment.paidAt ?? new Date();

  const [order] = await tx
    .insert(orders)
    .values({
      userId,
      eventId,
      orderNumber,
      subtotalAmount: String(catalogSubtotal),
      discountAmount: String(discountAmount),
      totalAmount: String(totalAmount),
      currency,
      status: "paid",
    })
    .returning();

  const primaryItem = items.find((item) => item.itemType === "ticket") ?? items[0];
  for (const item of items) {
    let linePrice = item.currency === OFFLINE_PAYMENT_CURRENCY ? item.price : "0";
    if (hasOnlyNonThbTickets && item === primaryItem) {
      linePrice = String(totalAmount);
    }

    await tx.insert(orderItems).values({
      orderId: order.id,
      itemType: item.itemType,
      ticketTypeId: item.ticketTypeId,
      price: linePrice,
      quantity: 1,
    });
  }

  await tx.insert(payments).values({
    orderId: order.id,
    amount: String(totalAmount),
    status: "paid",
    paymentChannel: offlinePayment.channel,
    paymentProvider: "manual",
    providerRef: `MANUAL-${order.orderNumber}`,
    providerStatus: "PAID",
    paidAt,
    paymentDetails: {
      source: "manual_registration",
      addedBy: staffId,
      note: note || null,
      catalogSubtotal: thbCatalogSubtotal || totalAmount,
      manualAmount: totalAmount,
      manualCurrency: OFFLINE_PAYMENT_CURRENCY,
    },
  });

  return {
    orderId: order.id,
    orderNumber,
    receiptUrl: buildReceiptUrl(order.id),
    totalAmount,
    currency,
  };
}

/** Link order to registration when registration has no order yet. */
export async function linkOrderToRegistration(
  tx: any,
  registrationId: number,
  orderId: number,
): Promise<void> {
  const [reg] = await tx
    .select({ orderId: registrations.orderId })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);

  if (reg && reg.orderId == null) {
    await tx
      .update(registrations)
      .set({ orderId })
      .where(eq(registrations.id, registrationId));
  }
}

export async function sendOrderReceiptEmail(
  orderId: number,
  regCode?: string | null,
): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new Error("Order not found");

  const [user] = await db
    .select({
      email: users.email,
      firstName: users.firstName,
      middleName: users.middleName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.id, order.userId))
    .limit(1);
  if (!user) throw new Error("User not found");

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

  const [payment] = await db
    .select({
      paidAt: payments.paidAt,
      paymentChannel: payments.paymentChannel,
      paymentDetails: payments.paymentDetails,
    })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
    .limit(1);

  let resolvedRegCode = regCode;
  if (!resolvedRegCode) {
    const [reg] = await db
      .select({ regCode: registrations.regCode })
      .from(registrations)
      .where(eq(registrations.orderId, orderId))
      .limit(1);
    resolvedRegCode = reg?.regCode;
  }

  const sorted = sortPrimaryFirst(emailItems);
  const subtotal = sorted.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
  const discount = Number(order.discountAmount || 0);
  const chargeDisplay = resolveChargeDisplay(
    order.currency ?? "THB",
    order.totalAmount,
    subtotal - discount,
    payment?.paymentDetails,
  );
  const total = chargeDisplay.totalPaid;
  const fee = chargeDisplay.fee;
  const receiptDownloadUrl = buildReceiptUrl(orderId);

  await sendPaymentReceiptEmail(
    user.email,
    user.firstName,
    user.middleName,
    user.lastName,
    order.orderNumber,
    payment?.paidAt ?? new Date(),
    payment?.paymentChannel ?? "card",
    sorted.map((i) => ({ name: i.name, type: i.type, price: Number(i.price) })),
    subtotal,
    fee,
    total,
    order.currency ?? "THB",
    receiptDownloadUrl,
    order.needTaxInvoice
      ? { taxName: order.taxName, taxId: order.taxId, taxFullAddress: order.taxFullAddress }
      : undefined,
    resolvedRegCode,
    buildChargeNote(chargeDisplay),
  );
}
