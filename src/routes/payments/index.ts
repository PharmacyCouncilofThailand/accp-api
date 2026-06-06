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
  promoCodes,
  promoCodeUsages,
  events,
} from "../../database/schema.js";
import { eq, and, sql, inArray, count, desc } from "drizzle-orm";
import { createPaymentIntentSchema } from "../../schemas/payment.schema.js";
import type Stripe from "stripe";
import {
  createFormSubmitPayload,
  inquiryPayment,
  isPaySolutionsFailedStatus,
  isPaySolutionsPaidStatus,
  isPaySolutionsRefundStatus,
  normalizePaySolutionsChannel,
  normalizePaySolutionsPayload,
  verifyPaySolutionsPostback,
} from "../../services/paySolutions.js";
import {
  createKtbFormPayload,
  generateKtbOrderRef,
  isKtbFastpayConfigured,
  isKtbPaymentCancelled,
  isKtbPaymentFailed,
  isKtbPaymentSuccess,
  mapRequestedPaymentMethodToKtb,
  normalizeKtbDataFeedPayload,
  normalizeKtbLang,
  normalizeKtbPayMethod,
  verifyKtbDataFeedSecurityKey,
} from "../../services/ktbFastpay.js";
import {
  calculatePaySolutionsFeeExact,
  resolvePaySolutionsChannel,
  resolvePaySolutionsFeeMethod,
} from "../../utils/paySolutionsFee.js";
import { generateReceiptToken, verifyReceiptToken } from "../../utils/receiptToken.js";
import { generateReceiptPdf } from "../../services/receiptPdf.js";
import { sendPaymentReceiptEmail } from "../../services/emailService.js";
import { getFullName } from "../../utils/name.js";
import { validatePromoCode, reservePromoUsage, settlePromoUsageSuccess, cancelPromoUsage } from "../../utils/promoEngine.js";

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

const PAY_SOLUTIONS_REFNO_PROD_MIN = 300000000001;
const PAY_SOLUTIONS_REFNO_PROD_MAX = 399999999999;

async function generatePaySolutionsRefno(): Promise<string> {
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction) {
    // Production range: 300000000001 - 399999999999
    await db.execute(sql`
      CREATE SEQUENCE IF NOT EXISTS pay_solutions_refno_seq
      START WITH 300000000001 INCREMENT BY 1 MINVALUE 300000000001 NO MAXVALUE CACHE 1
    `);

    // Ensure next generated value starts at least from 300000000001
    await db.execute(sql`
      SELECT setval('pay_solutions_refno_seq',
        GREATEST(last_value, 300000000000), true)
      FROM pay_solutions_refno_seq
    `);
  } else {
    // Ensure sequence exists (safe for new environments / DB resets)
    await db.execute(sql`
      CREATE SEQUENCE IF NOT EXISTS pay_solutions_refno_seq
      START WITH 10001 INCREMENT BY 1 MINVALUE 10001 NO MAXVALUE CACHE 1
    `);

    // Bump sequence to at least 10001 if it was created with a lower start
    // (prevents collision with any refno <= 10000 used in Pay Solutions panel)
    await db.execute(sql`
      SELECT setval('pay_solutions_refno_seq',
        GREATEST(last_value, 10001), true)
      FROM pay_solutions_refno_seq
    `);
  }

  const rows = await db.execute(sql`
    SELECT lpad(nextval('pay_solutions_refno_seq')::text, 12, '0') AS refno
  `);

  const refno = String((rows as unknown as Array<{ refno: string }>)[0]?.refno || "");
  if (!/^\d{12}$/.test(refno)) {
    throw new Error("Failed to generate Pay Solutions refno");
  }

  if (isProduction) {
    const numericRefno = Number(refno);
    if (numericRefno < PAY_SOLUTIONS_REFNO_PROD_MIN || numericRefno > PAY_SOLUTIONS_REFNO_PROD_MAX) {
      throw new Error("Generated Pay Solutions refno is outside production range");
    }
  }

  return refno;
}

function getPublicApiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL || "http://localhost:3002")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\/$/, "");

  const isLocalHost = (value: string): boolean =>
    value.includes("localhost") || value.includes("127.0.0.1") || value.includes("0.0.0.0");

  // If scheme is missing (e.g. accp-api-production-xxx.up.railway.app), add one.
  let normalized = /^https?:\/\//i.test(raw)
    ? raw
    : `${isLocalHost(raw) ? "http" : "https"}://${raw}`;

  // Railway/email clients may block insecure downloads. If API_BASE_URL is
  // accidentally configured as http in production, force https for non-local hosts.
  if (normalized.startsWith("http://") && !isLocalHost(normalized)) {
    normalized = `https://${normalized.slice("http://".length)}`;
  }

  return normalized;
}

function getConferenceWebBaseUrl(): string {
  const raw = (process.env.CONFERENCE_WEB_URL || "http://localhost:3003")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\/$/, "");

  const isLocalHost = (value: string): boolean =>
    value.includes("localhost") || value.includes("127.0.0.1") || value.includes("0.0.0.0");

  let normalized = /^https?:\/\//i.test(raw)
    ? raw
    : `${isLocalHost(raw) ? "http" : "https"}://${raw}`;

  if (normalized.startsWith("http://") && !isLocalHost(normalized)) {
    normalized = `https://${normalized.slice("http://".length)}`;
  }

  return normalized;
}

function toPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function mergeKtbPaymentDetails(
  existing: unknown,
  updates: Record<string, unknown>
): Record<string, unknown> {
  const base = toPlainObject(existing);
  const ktb = toPlainObject(base.ktb);

  return {
    ...base,
    ktb: {
      ...ktb,
      ...updates,
    },
  };
}

function getRequestedKtbLang(request: FastifyRequest): "T" | "E" {
  const requestedLocale = String(request.headers["accept-language"] || "").toLowerCase();
  const referer = String(request.headers.referer || "").toLowerCase();

  if (requestedLocale.startsWith("th") || referer.includes("/th/")) {
    return "T";
  }

  return normalizeKtbLang(requestedLocale || referer);
}

function mapGatewayFromPaymentProvider(paymentProvider?: string | null): "ktb" | "pay_solutions" | "stripe" {
  switch (paymentProvider) {
    case "ktb_fastpay":
      return "ktb";
    case "pay_solutions":
      return "pay_solutions";
    default:
      return "stripe";
  }
}

function parsePostbackBody(body: unknown): Record<string, unknown> {
  if (!body) return {};
  if (typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }

  if (typeof body === "string") {
    const trimmed = body.trim();
    if (!trimmed) return {};

    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to URL encoded parsing
    }

    const params = new URLSearchParams(trimmed);
    const obj: Record<string, unknown> = {};
    for (const [key, value] of params.entries()) {
      obj[key] = value;
    }
    return obj;
  }

  return {};
}

function parseWorkshopSessionIdFromDetails(details: unknown): number | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }

  const raw = (details as Record<string, unknown>).workshopSessionId;
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }

  const parsed = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sortOrderItemsPrimaryFirst<T extends { itemType?: string; type?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aRank = (a.itemType ?? a.type) === "ticket" ? 0 : 1;
    const bRank = (b.itemType ?? b.type) === "ticket" ? 0 : 1;
    return aRank - bRank;
  });
}

interface TaxInvoiceInfo {
  needTaxInvoice: boolean;
  taxName: string | null;
  taxId: string | null;
  taxAddress: string | null;
  taxSubDistrict: string | null;
  taxDistrict: string | null;
  taxProvince: string | null;
  taxPostalCode: string | null;
  taxFullAddress: string | null;
}

function normalizeOptionalText(value?: string | null): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildTaxFullAddress(parts: {
  taxAddress: string | null;
  taxSubDistrict: string | null;
  taxDistrict: string | null;
  taxProvince: string | null;
  taxPostalCode: string | null;
}): string | null {
  const values = [
    parts.taxAddress,
    parts.taxSubDistrict,
    parts.taxDistrict,
    parts.taxProvince,
    parts.taxPostalCode,
  ].filter((value): value is string => Boolean(value));

  return values.length > 0 ? values.join(" ") : null;
}

function buildTaxInvoiceInfo(data: {
  needTaxInvoice: boolean;
  taxName?: string;
  taxId?: string;
  taxAddress?: string;
  taxSubDistrict?: string;
  taxDistrict?: string;
  taxProvince?: string;
  taxPostalCode?: string;
}): TaxInvoiceInfo {
  if (!data.needTaxInvoice) {
    return {
      needTaxInvoice: false,
      taxName: null,
      taxId: null,
      taxAddress: null,
      taxSubDistrict: null,
      taxDistrict: null,
      taxProvince: null,
      taxPostalCode: null,
      taxFullAddress: null,
    };
  }

  const taxAddress = normalizeOptionalText(data.taxAddress);
  const taxSubDistrict = normalizeOptionalText(data.taxSubDistrict);
  const taxDistrict = normalizeOptionalText(data.taxDistrict);
  const taxProvince = normalizeOptionalText(data.taxProvince);
  const taxPostalCode = normalizeOptionalText(data.taxPostalCode);

  return {
    needTaxInvoice: true,
    taxName: normalizeOptionalText(data.taxName),
    taxId: normalizeOptionalText(data.taxId),
    taxAddress,
    taxSubDistrict,
    taxDistrict,
    taxProvince,
    taxPostalCode,
    taxFullAddress: buildTaxFullAddress({
      taxAddress,
      taxSubDistrict,
      taxDistrict,
      taxProvince,
      taxPostalCode,
    }),
  };
}

/**
 * Resolve a frontend package/addon string ID + currency to the actual DB ticketType.
 * Frontend uses "student"/"professional" for packages, "workshop"/"gala" for addons.
 * Each ticket in DB has one currency, so we match by event + groupName/allowedRoles + currency.
 */
type ResolvedTicket = { id: number; price: string; eventId: number };

async function resolveTicketId(
  packageId: string,
  eventId: number,
  currency: string,
  category: "primary" | "addon"
): Promise<ResolvedTicket | null> {
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
      saleStartDate: ticketTypes.saleStartDate,
      saleEndDate: ticketTypes.saleEndDate,
    })
    .from(ticketTypes)
    .where(
      and(
        eq(ticketTypes.eventId, eventId),
        eq(ticketTypes.currency, currency),
        eq(ticketTypes.category, category)
      )
    );

  const now = new Date();
  const active = allTickets.filter((t) => {
    if (t.isActive === false) return false;
    // Filter out tickets not within their sale period
    const saleStart = t.saleStartDate ? new Date(t.saleStartDate) : null;
    const saleEnd = t.saleEndDate ? new Date(t.saleEndDate) : null;
    if (saleStart && now < saleStart) return false;
    if (saleEnd && now > saleEnd) return false;
    return true;
  });

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

interface PurchaseSnapshot {
  hasPrimaryTicket: boolean;
  primaryTicketName: string | null;
  regCode: string | null;
  purchasedAddOns: string[];
}

function normalizeAddonGroupNames(
  rows: Array<{ groupName: string | null }>
): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row.groupName?.trim().toLowerCase())
        .filter((groupName): groupName is string => Boolean(groupName))
    ),
  ];
}

function parsePositiveEventId(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function getPaidPurchaseSnapshot(userId: number, eventId?: number): Promise<PurchaseSnapshot> {
  const orderConditions = [eq(orders.userId, userId), eq(orders.status, "paid")];
  if (typeof eventId === "number") {
    orderConditions.push(eq(orders.eventId, eventId));
  }

  const paidOrders = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(...orderConditions));

  // Check registrations table first (covers manual backoffice registrations without orders)
  const registrationConditions = [
    eq(registrations.userId, userId),
    eq(registrations.status, "confirmed"),
  ];
  if (typeof eventId === "number") {
    registrationConditions.push(eq(registrations.eventId, eventId));
  }

  const [registration] = await db
    .select({
      regCode: registrations.regCode,
      ticketName: ticketTypes.name,
    })
    .from(registrations)
    .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
    .where(and(...registrationConditions))
    .orderBy(desc(registrations.id))
    .limit(1);

  const registrationAddonConditions = [
    eq(registrations.userId, userId),
    eq(registrations.status, "confirmed"),
    eq(ticketTypes.category, "addon"),
  ];
  if (typeof eventId === "number") {
    registrationAddonConditions.push(eq(registrations.eventId, eventId));
  }

  const registrationAddonRows = await db
    .select({ groupName: ticketTypes.groupName })
    .from(registrationSessions)
    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
    .innerJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
    .where(and(...registrationAddonConditions));

  const registeredAddOns = normalizeAddonGroupNames(registrationAddonRows);

  if (paidOrders.length === 0) {
    // No paid orders — but if a confirmed registration exists (e.g. manual/backoffice),
    // treat as having a primary ticket so the user can buy add-ons
    return {
      hasPrimaryTicket: !!registration,
      primaryTicketName: registration?.ticketName || null,
      regCode: registration?.regCode || null,
      purchasedAddOns: registeredAddOns,
    };
  }

  const paidOrderIds = paidOrders.map((order) => order.id);
  const allItems = await db
    .select({
      ticketName: ticketTypes.name,
      groupName: ticketTypes.groupName,
      category: ticketTypes.category,
    })
    .from(orderItems)
    .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
    .where(inArray(orderItems.orderId, paidOrderIds));

  let hasPrimaryTicket = allItems.some((item) => item.category === "primary");
  const primaryItem = allItems.find((item) => item.category === "primary");

  const purchasedAddOns = [
    ...new Set([
      ...normalizeAddonGroupNames(
        allItems.filter((item) => item.category === "addon")
      ),
      ...registeredAddOns,
    ]),
  ];

  const regCode = registration?.regCode || null;

  // If no paid primary ticket found but a confirmed registration exists,
  // treat as having a primary ticket so the user can buy add-ons
  if (!hasPrimaryTicket && registration) {
    hasPrimaryTicket = true;
  }

  return {
    hasPrimaryTicket,
    primaryTicketName: primaryItem?.ticketName || registration?.ticketName || null,
    regCode,
    purchasedAddOns,
  };
}

async function findConfirmedRegistrationForEvent(
  tx: any,
  userId: number,
  eventId: number,
  logger?: { warn?: (...args: any[]) => void }
) {
  const existingRegistrations = await tx
    .select({
      id: registrations.id,
      regCode: registrations.regCode,
      eventId: registrations.eventId,
    })
    .from(registrations)
    .where(
      and(
        eq(registrations.userId, userId),
        eq(registrations.eventId, eventId),
        eq(registrations.status, "confirmed")
      )
    )
    .orderBy(desc(registrations.id))
    .limit(2);

  if (existingRegistrations.length > 1) {
    logger?.warn?.(
      `[PAYMENTS] Multiple confirmed registrations found for user=${userId}, event=${eventId}; using latest registrationId=${existingRegistrations[0].id}`
    );
  }

  return existingRegistrations[0] || null;
}

async function resolveOrderEventId(tx: any, order: { id: number; eventId: number | null }) {
  if (order.eventId) {
    return order.eventId;
  }

  const [primaryTicket] = await tx
    .select({ eventId: ticketTypes.eventId })
    .from(orderItems)
    .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
    .where(and(eq(orderItems.orderId, order.id), eq(orderItems.itemType, "ticket")))
    .limit(1);

  if (primaryTicket?.eventId) {
    return primaryTicket.eventId;
  }

  const [registrationEvent] = await tx
    .select({ eventId: registrations.eventId })
    .from(registrations)
    .where(eq(registrations.orderId, order.id))
    .orderBy(desc(registrations.id))
    .limit(1);

  if (registrationEvent?.eventId) {
    return registrationEvent.eventId;
  }

  const legacyOrderEvents = await tx
    .select({ eventId: ticketTypes.eventId })
    .from(orderItems)
    .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
    .where(eq(orderItems.orderId, order.id))
    .groupBy(ticketTypes.eventId)
    .limit(2);

  return legacyOrderEvents.length === 1 ? legacyOrderEvents[0].eventId : null;
}

async function countConfirmedWorkshopEnrollments(eventId: number, sessionId: number) {
  const [row] = await db
    .select({ count: count() })
    .from(registrationSessions)
    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
    .where(
      and(
        eq(registrationSessions.sessionId, sessionId),
        eq(registrations.eventId, eventId),
        eq(registrations.status, "confirmed")
      )
    );

  let enrolled = row?.count ?? 0;

  // Retrieve the session code to check if it matches WORKSHOP-04 (or ID 11)
  const [session] = await db
    .select({ sessionCode: sessions.sessionCode })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (session && (session.sessionCode === "WORKSHOP-04" || sessionId === 11)) {
    enrolled += 20;
  }

  return enrolled;
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
  fastify: {
    log: {
      info: (...args: any[]) => void;
      error: (...args: any[]) => void;
      warn?: (...args: any[]) => void;
    };
  },
  orderId: number,
  providerRef: string,
  workshopSessionId: number | null,
  receiptUrl: string | null,
  paymentChannel: string,
  paymentProvider: "stripe" | "pay_solutions" | "ktb_fastpay" = "stripe",
  providerStatus: string = "PAID",
  paymentDetails: Record<string, unknown> | null = null,
): Promise<{
  order: {
    id: number;
    userId: number;
    orderNumber: string;
    totalAmount: string;
    currency: string;
    status: string;
    discountAmount: string | null;
    promoCode: string | null;
    needTaxInvoice: boolean;
    taxName: string | null;
    taxId: string | null;
    taxAddress: string | null;
    taxSubDistrict: string | null;
    taxDistrict: string | null;
    taxProvince: string | null;
    taxPostalCode: string | null;
    taxFullAddress: string | null;
  };
  user: { email: string; firstName: string; middleName: string | null; lastName: string };
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
        paymentProvider,
        providerRef,
        providerStatus,
        paySolutionsChannel: paymentProvider === "pay_solutions" ? paymentChannel : undefined,
        stripeReceiptUrl: paymentProvider === "stripe" ? receiptUrl : null,
        paymentDetails: paymentDetails || undefined,
        paidAt: new Date(),
      })
      .where(eq(payments.orderId, orderId));

    // Get user info
    const [user] = await tx
      .select({
        email: users.email,
        firstName: users.firstName,
        middleName: users.middleName,
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

    const orderEventId = await resolveOrderEventId(tx, order);
    if (!orderEventId) {
      fastify.log.error(`Unable to resolve event scope for order ${orderId}`);
      return null;
    }

    if (!order.eventId) {
      fastify.log.warn?.(
        `Order ${orderId} is missing eventId; using derived eventId=${orderEventId} for legacy compatibility`
      );
    }

    // Find primary (ticket) item to determine whether this is a full order or addon-only order
    const primaryItem = items.find(i => i.itemType === "ticket");
    const isAddonOnlyOrder = !primaryItem;

    let registration: { id: number };
    let regCode: string;

    if (isAddonOnlyOrder) {
      // ── Addon-only order: use existing registration ────
      const existingReg = await findConfirmedRegistrationForEvent(
        tx,
        order.userId,
        orderEventId,
        fastify.log
      );

      if (!existingReg) {
        fastify.log.error(
          `Addon-only order ${orderId} but no confirmed registration exists for user ${order.userId} in event ${orderEventId}`
        );
        return null;
      }

      registration = { id: existingReg.id };
      regCode = existingReg.regCode;
      fastify.log.info(`Addon-only order ${orderId}: using existing registration ${existingReg.id}`);
    } else {
      // ── Full order: create new registration ────────────
      const [primaryTicket] = await tx
        .select({ eventId: ticketTypes.eventId })
        .from(ticketTypes)
        .where(eq(ticketTypes.id, primaryItem.ticketTypeId))
        .limit(1);

      if (!primaryTicket?.eventId || primaryTicket.eventId !== orderEventId) {
        fastify.log.error(
          `Primary ticket event mismatch for order ${orderId}: orderEventId=${orderEventId}, ticketEventId=${primaryTicket?.eventId ?? "null"}`
        );
        return null;
      }

      regCode = generateRegCode();
      const [newReg] = await tx.insert(registrations).values({
        regCode,
        orderId,
        eventId: orderEventId,
        ticketTypeId: primaryItem.ticketTypeId,
        userId: order.userId,
        email: user.email,
        firstName: user.firstName,
        middleName: user.middleName,
        lastName: user.lastName,
        status: "confirmed",
      }).returning();

      registration = { id: newReg.id };
    }

    // Create registration_sessions for each order item
    let totalSessionLinks = 0;
    for (const item of items) {
      const [ticket] = await tx
        .select({ groupName: ticketTypes.groupName, eventId: ticketTypes.eventId })
        .from(ticketTypes)
        .where(eq(ticketTypes.id, item.ticketTypeId))
        .limit(1);

      if (!ticket || ticket.eventId !== orderEventId) {
        fastify.log.error(
          `[PROCESS-PAYMENT] Skipping item: ticket ${item.ticketTypeId} is outside order event scope (order ${orderId}, orderEventId=${orderEventId}, ticketEventId=${ticket?.eventId ?? "null"})`
        );
        continue;
      }

      // Determine which session(s) to link
      let sessionIdsToLink: number[] = [];

      // Check if this addon item is THE workshop the user chose.
      // Use ticketSessions junction as source of truth (more reliable than groupName string match).
      let isUserChosenWorkshop = false;
      if (item.itemType === "addon" && workshopSessionId) {
        const [linkedWorkshop] = await tx
          .select({ id: ticketSessions.id })
          .from(ticketSessions)
          .innerJoin(sessions, eq(ticketSessions.sessionId, sessions.id))
          .where(
            and(
              eq(ticketSessions.ticketTypeId, item.ticketTypeId),
              eq(ticketSessions.sessionId, workshopSessionId),
              eq(sessions.eventId, orderEventId)
            )
          )
          .limit(1);
        isUserChosenWorkshop = !!linkedWorkshop;
      }

      if (isUserChosenWorkshop) {
        // User explicitly chose this workshop session at checkout
        sessionIdsToLink = [workshopSessionId!];
        fastify.log.info(
          `[PROCESS-PAYMENT] Order ${orderId} item ${item.id} (ticket ${item.ticketTypeId}) → linking user-chosen workshop session ${workshopSessionId}`
        );
      } else {
        // Primary or other addon → lookup sessions from ticketSessions junction
        const linkedSessions = await tx
          .select({ sessionId: ticketSessions.sessionId })
          .from(ticketSessions)
          .innerJoin(sessions, eq(ticketSessions.sessionId, sessions.id))
          .where(
            and(
              eq(ticketSessions.ticketTypeId, item.ticketTypeId),
              eq(sessions.eventId, orderEventId)
            )
          );

        sessionIdsToLink = linkedSessions.map(ls => ls.sessionId);

        // Fallback for primary tickets: if no ticket_sessions rows, auto-link to main session(s)
        if (sessionIdsToLink.length === 0 && item.itemType === "ticket") {
          const mainSessions = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                eq(sessions.eventId, orderEventId),
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
  // GET /payments/browser-return (NO AUTH — Pay Solutions redirect landing)
  // Pay Solutions redirects the user's browser here after payment.
  // We look up the event from refno and HTTP 302 to the correct frontend.
  // ─────────────────────────────────────────────────────
  fastify.get(
    "/browser-return",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, string>;
      const refno = query.Refno || query.refno || "";

      const CONFERENCE_WEB_URL = (
        process.env.CONFERENCE_WEB_URL || "http://localhost:3003"
      ).replace(/\/$/, "");

      const defaultResultUrl = `${CONFERENCE_WEB_URL}/checkout/payment/result`;

      if (!refno) {
        fastify.log.warn("[BROWSER-RETURN] No refno in query, redirecting to default");
        return reply.code(302).redirect(`${defaultResultUrl}?refno=`);
      }

      try {
        // Find payment → order → event
        const [payment] = await db
          .select({ orderId: payments.orderId })
          .from(payments)
          .where(eq(payments.paySolutionsRefno, refno))
          .limit(1);

        if (!payment) {
          fastify.log.warn(`[BROWSER-RETURN] Payment not found for refno=${refno}, redirecting to default`);
          return reply.code(302).redirect(`${defaultResultUrl}?refno=${encodeURIComponent(refno)}`);
        }

        const [order] = await db
          .select({ eventId: orders.eventId })
          .from(orders)
          .where(eq(orders.id, payment.orderId))
          .limit(1);

        const eventId = order?.eventId ?? null;

        if (!eventId) {
          fastify.log.warn(
            `[BROWSER-RETURN] Missing eventId on orderId=${payment.orderId}, redirecting to default`
          );
          return reply.code(302).redirect(`${defaultResultUrl}?refno=${encodeURIComponent(refno)}`);
        }

        // Check if event has a dedicated website URL
        const [event] = await db
          .select({
            websiteUrl: events.websiteUrl,
          })
          .from(events)
          .where(eq(events.id, eventId))
          .limit(1);

        if (event?.websiteUrl) {
          const targetUrl = event.websiteUrl.replace(/\/$/, "");
          fastify.log.info(`[BROWSER-RETURN] Event has websiteUrl, redirecting to ${targetUrl}`);
          return reply.code(302).redirect(`${targetUrl}/en/checkout/payment/result?refno=${encodeURIComponent(refno)}`);
        }

        // Default: redirect to conference-web
        fastify.log.info(`[BROWSER-RETURN] Default redirect to conference-web`);
        return reply.code(302).redirect(`${defaultResultUrl}?refno=${encodeURIComponent(refno)}`);
      } catch (error) {
        fastify.log.error(error, "[BROWSER-RETURN] Error looking up refno");
        return reply.code(302).redirect(`${defaultResultUrl}?refno=${encodeURIComponent(refno)}`);
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // GET /payments/my-purchases (JWT protected)
  // Returns what the current user has already purchased
  // ─────────────────────────────────────────────────────
  fastify.post(
    "/ktb/datafeed",
    {
      config: {
        rateLimit: false,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const payload = normalizeKtbDataFeedPayload(toPlainObject(request.body));

      reply.type("text/plain").send("OK");

      setImmediate(async () => {
        try {
          if (!payload.orderRef) {
            fastify.log.warn("[KTB-DATAFEED] Missing orderRef");
            return;
          }

          const secureHashKey = process.env.KTB_SECURE_HASH_KEY?.trim() || "";
          if (!secureHashKey) {
            fastify.log.error(
              `[KTB-DATAFEED] KTB_SECURE_HASH_KEY is missing; ignoring orderRef=${payload.orderRef}`
            );
            return;
          }

          if (!verifyKtbDataFeedSecurityKey(payload, secureHashKey)) {
            fastify.log.warn(
              `[KTB-DATAFEED] Invalid securityKey for orderRef=${payload.orderRef}, successcode=${payload.successcode}`
            );
            return;
          }

          const [payment] = await db
            .select({
              id: payments.id,
              orderId: payments.orderId,
              status: payments.status,
              providerRef: payments.providerRef,
              paymentChannel: payments.paymentChannel,
              paymentDetails: payments.paymentDetails,
            })
            .from(payments)
            .where(
              and(
                eq(payments.paymentProvider, "ktb_fastpay"),
                eq(payments.providerRef, payload.orderRef)
              )
            )
            .limit(1);

          if (!payment) {
            fastify.log.warn(`[KTB-DATAFEED] Payment not found for orderRef=${payload.orderRef}`);
            return;
          }

          if (payment.status === "paid") {
            fastify.log.info(`[KTB-DATAFEED] Duplicate callback ignored for paid orderRef=${payload.orderRef}`);
            return;
          }

          const resolvedChannel = normalizeKtbPayMethod(payload.payMethod) || payment.paymentChannel || "card";
          const mergedDetails = mergeKtbPaymentDetails(payment.paymentDetails, {
            payRef: payload.payRef,
            ord: payload.ord,
            authId: payload.authId,
            eci: payload.eci,
            payMethod: payload.payMethod,
            payerAuth: payload.payerAuth,
            sourceIp: payload.sourceIp,
            ipCountry: payload.ipCountry,
            cardNo: payload.cardNo,
            payTime: payload.payTime,
            lastDataFeed: payload.raw,
          });

          if (isKtbPaymentSuccess(payload.successcode)) {
            const workshopSessionId = parseWorkshopSessionIdFromDetails(payment.paymentDetails);
            const txResult = await processSuccessfulPayment(
              fastify,
              payment.orderId,
              payment.providerRef || payload.orderRef,
              workshopSessionId,
              null,
              resolvedChannel,
              "ktb_fastpay",
              "SUCCESS",
              mergedDetails,
            );

            if (txResult) {
              await settlePromoUsageSuccess(payment.orderId);

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
                  .where(eq(orderItems.orderId, payment.orderId));

                const sortedEmailItems = sortOrderItemsPrimaryFirst(emailItems);
                const emailSubtotal = sortedEmailItems.reduce(
                  (sum, item) => sum + Number(item.price) * item.quantity,
                  0
                );
                const emailDiscount = Number(order.discountAmount || 0);
                const emailNetAmount = emailSubtotal - emailDiscount;
                const emailTotal = Number(order.totalAmount);
                const emailFee = Math.round((emailTotal - emailNetAmount) * 100) / 100;
                const receiptToken = generateReceiptToken(payment.orderId);
                const receiptDownloadUrl = `${getPublicApiBaseUrl()}/api/payments/receipt/${receiptToken}`;

                await sendPaymentReceiptEmail(
                  user.email,
                  user.firstName,
                  user.middleName,
                  user.lastName,
                  order.orderNumber,
                  new Date(),
                  resolvedChannel,
                  sortedEmailItems.map((item) => ({
                    name: item.name,
                    type: item.type,
                    price: Number(item.price),
                  })),
                  emailSubtotal,
                  emailFee,
                  emailTotal,
                  order.currency,
                  receiptDownloadUrl,
                  order.needTaxInvoice
                    ? {
                      taxName: order.taxName,
                      taxId: order.taxId,
                      taxFullAddress: order.taxFullAddress,
                    }
                    : undefined,
                  regCode
                );
              } catch (emailErr) {
                fastify.log.error(
                  `[KTB-DATAFEED] Failed to send receipt email for order ${payment.orderId}: ${emailErr}`
                );
              }
            }

            fastify.log.info(`[KTB-DATAFEED] Marked paid for orderRef=${payload.orderRef}`);
            return;
          }

          if (isKtbPaymentFailed(payload.successcode) || isKtbPaymentCancelled(payload.successcode)) {
            const nextStatus = isKtbPaymentCancelled(payload.successcode) ? "cancelled" : "failed";
            const nextProviderStatus = isKtbPaymentCancelled(payload.successcode)
              ? "CANCELLED"
              : "FAILED";

            await db
              .update(payments)
              .set({
                status: nextStatus,
                providerStatus: nextProviderStatus,
                paymentChannel: resolvedChannel,
                paymentDetails: mergedDetails,
              })
              .where(eq(payments.id, payment.id));

            await db
              .update(orders)
              .set({ status: "cancelled" })
              .where(eq(orders.id, payment.orderId));

            await cancelPromoUsage(payment.orderId);

            fastify.log.info(
              `[KTB-DATAFEED] Marked ${nextStatus} for orderRef=${payload.orderRef}, successcode=${payload.successcode}`
            );
            return;
          }

          await db
            .update(payments)
            .set({
              providerStatus: "UNKNOWN",
              paymentChannel: resolvedChannel,
              paymentDetails: mergedDetails,
            })
            .where(eq(payments.id, payment.id));

          fastify.log.warn(
            `[KTB-DATAFEED] Unknown successcode=${payload.successcode} for orderRef=${payload.orderRef}`
          );
        } catch (error) {
          fastify.log.error(error, `[KTB-DATAFEED] Background processing failed for orderRef=${payload.orderRef}`);
        }
      });

      return reply;
    }
  );

  fastify.get(
    "/ktb/return",
    {
      config: {
        rateLimit: false,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as Record<string, string | undefined>;
      const orderRef = query.Ref || query.orderRef || "";
      const result = query.result || "unknown";
      const targetUrl = `${getConferenceWebBaseUrl()}/checkout/payment/result?gateway=ktb&orderRef=${encodeURIComponent(orderRef)}&result=${encodeURIComponent(result)}`;
      return reply.code(302).redirect(targetUrl);
    }
  );

  fastify.get(
    "/my-purchases",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = request.user.id;
      const query = request.query as { eventId?: string };
      const eventId = query.eventId ? parsePositiveEventId(query.eventId) : null;

      if (query.eventId && !eventId) {
        return reply.status(400).send({
          success: false,
          code: "INVALID_EVENT_ID",
          error: "Event is invalid",
        });
      }

      try {
        const snapshot = await getPaidPurchaseSnapshot(userId, eventId ?? undefined);

        return reply.send({
          success: true,
          data: {
            hasPrimaryTicket: snapshot.hasPrimaryTicket,
            primaryTicketName: snapshot.primaryTicketName,
            regCode: snapshot.regCode,
            purchasedAddOns: snapshot.purchasedAddOns,
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
      const query = request.query as { eventId?: string };
      const eventId = query.eventId ? parsePositiveEventId(query.eventId) : null;

      if (query.eventId && !eventId) {
        return reply.status(400).send({
          success: false,
          code: "INVALID_EVENT_ID",
          error: "Event is invalid",
        });
      }

      try {
        const registrationConditions: any[] = [
          eq(registrations.userId, userId),
          eq(registrations.status, "confirmed"),
        ];

        if (eventId) {
          registrationConditions.push(eq(registrations.eventId, eventId));
        }

        const allRegistrations = await db
          .select({
            registrationId: registrations.id,
            regCode: registrations.regCode,
            eventId: registrations.eventId,
            status: registrations.status,
            dietaryRequirements: registrations.dietaryRequirements,
            purchasedAt: registrations.createdAt,
            eventCode: events.eventCode,
            eventName: events.eventName,
            eventStartDate: events.startDate,
            eventEndDate: events.endDate,
            eventLocation: events.location,
            eventImageUrl: events.imageUrl,
            eventWebsiteUrl: events.websiteUrl,
            ticketName: ticketTypes.name,
            ticketPriority: ticketTypes.priority,
            ticketPrice: ticketTypes.price,
            ticketCurrency: ticketTypes.currency,
            ticketFeatures: ticketTypes.features,
            ticketTypeId: ticketTypes.id,
            orderId: orders.id,
            orderStatus: orders.status,
          })
          .from(registrations)
          .innerJoin(events, eq(registrations.eventId, events.id))
          .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
          .leftJoin(orders, eq(registrations.orderId, orders.id))
          .where(and(...registrationConditions))
          .orderBy(desc(registrations.createdAt));

        if (allRegistrations.length === 0) {
          return reply.send({ success: true, data: [] });
        }

        const apiBaseUrl = getPublicApiBaseUrl();
        const result = await Promise.all(
          allRegistrations.map(async (reg) => {
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
                  eq(registrationSessions.registrationId, reg.registrationId),
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

            let receiptUrl: string | null = null;
            if (reg.orderStatus === "paid" && reg.orderId) {
              const receiptToken = generateReceiptToken(reg.orderId);
              receiptUrl = `${apiBaseUrl}/api/payments/receipt/${receiptToken}`;
            }

            // Fetch all paid orders for this user+event (initial + addon purchases)
            const paidOrdersRaw = await db
              .select({
                id: orders.id,
                orderNumber: orders.orderNumber,
                totalAmount: orders.totalAmount,
                currency: orders.currency,
                createdAt: orders.createdAt,
                paidAt: payments.paidAt,
              })
              .from(orders)
              .leftJoin(payments, eq(payments.orderId, orders.id))
              .where(
                and(
                  eq(orders.userId, userId),
                  eq(orders.eventId, reg.eventId),
                  eq(orders.status, "paid")
                )
              )
              .orderBy(desc(orders.createdAt));

            // Deduplicate by orderId (in case of multiple payment rows per order)
            const orderSeen = new Set<number>();
            const receipts = paidOrdersRaw
              .filter((o) => {
                if (orderSeen.has(o.id)) return false;
                orderSeen.add(o.id);
                return true;
              })
              .map((o) => ({
                orderId: o.id,
                orderNumber: o.orderNumber,
                totalAmount: o.totalAmount,
                currency: o.currency,
                purchasedAt: o.createdAt?.toISOString() || null,
                paidAt: o.paidAt?.toISOString() || null,
                receiptUrl: `${apiBaseUrl}/api/payments/receipt/${generateReceiptToken(o.id)}`,
              }));

            return {
              regCode: reg.regCode,
              eventId: reg.eventId,
              eventCode: reg.eventCode,
              eventName: reg.eventName,
              eventStartDate: reg.eventStartDate?.toISOString() || null,
              eventEndDate: reg.eventEndDate?.toISOString() || null,
              eventLocation: reg.eventLocation,
              eventImageUrl: reg.eventImageUrl,
              websiteUrl: reg.eventWebsiteUrl,
              status: reg.status,
              ticketName: reg.ticketName,
              ticketTypeId: reg.ticketTypeId,
              priority: reg.ticketPriority,
              purchasedAt: reg.purchasedAt?.toISOString() || null,
              amount: reg.ticketPrice,
              currency: reg.ticketCurrency,
              includes: Array.isArray(reg.ticketFeatures) ? reg.ticketFeatures : [],
              receiptUrl,
              receipts,
              galaTicket: galaRow
                ? {
                    id: `${reg.regCode}-GALA`,
                    status: reg.status,
                    name: galaRow.ticketName,
                    purchasedAt: galaRow.linkedAt?.toISOString() || null,
                    amount: galaRow.ticketPrice,
                    currency: galaRow.ticketCurrency,
                    dateTimeStart: galaRow.sessionStartTime?.toISOString() || null,
                    dateTimeEnd: galaRow.sessionEndTime?.toISOString() || null,
                    venue: galaRow.sessionRoom,
                    dietary: reg.dietaryRequirements || null,
                  }
                : null,
              workshops: workshopRows.map((row) => ({
                id: `${reg.regCode}-WS-${row.sessionId}`,
                sessionId: row.sessionId,
                status: reg.status,
                name: row.sessionName || row.ticketName,
                purchasedAt: row.linkedAt?.toISOString() || null,
                amount: row.ticketPrice,
                currency: row.ticketCurrency,
                dateTimeStart: row.sessionStartTime?.toISOString() || null,
                dateTimeEnd: row.sessionEndTime?.toISOString() || null,
                venue: row.sessionRoom,
              })),
            };
          })
        );

        return reply.send({ success: true, data: result });
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
  // POST /payments/preview (JWT protected)
  // Validates promo code and returns pricing breakdown
  // without creating any order or reservation
  // ─────────────────────────────────────────────────────
  fastify.post(
    "/preview",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawBody = parsePostbackBody(request.body);
      if (parsePositiveEventId(rawBody.eventId) === null) {
        return reply.status(400).send({
          success: false,
          code: "MISSING_EVENT_ID",
          error: "Event is required",
        });
      }

      const parsed = createPaymentIntentSchema.safeParse(rawBody);
      if (!parsed.success) {
        return reply.status(400).send({ success: false, error: "Invalid input", details: parsed.error.flatten() });
      }

      const { eventId, packageId, addOnIds, currency, paymentMethod, promoCode } = parsed.data;
      const userId = request.user.id;
      const isAddonOnly = !packageId || packageId === "";

      try {
        // Resolve primary ticket
        let primaryTicket: ResolvedTicket | null = null;
        if (!isAddonOnly) {
          primaryTicket = await resolveTicketId(packageId, eventId, currency, "primary");
        }

        // Resolve add-ons
        let subtotal = primaryTicket ? Number(primaryTicket.price) : 0;
        const resolvedAddOns: ResolvedTicket[] = [];
        for (const addOnId of addOnIds) {
          const addon = await resolveTicketId(addOnId, eventId, currency, "addon");
          if (addon) {
            subtotal += Number(addon.price);
            resolvedAddOns.push(addon);
          }
        }

        // Collect all selected ticket type IDs for rule-set validation
        const selectedTicketTypeIds = [
          ...(primaryTicket ? [primaryTicket.id] : []),
          ...resolvedAddOns.map(a => a.id),
        ];

        let discountAmount = 0;
        let discountType: string | null = null;
        let discountValue: number | null = null;
        let promoError: string | null = null;
        let promoValid = false;

        if (promoCode && promoCode.trim()) {
          const result = await validatePromoCode(
            promoCode.trim(),
            userId,
            currency,
            subtotal,
            selectedTicketTypeIds,
          );

          if (result.valid) {
            promoValid = true;
            discountAmount = result.discountAmount!;
            discountType = result.discountType!;
            discountValue = result.discountValue!;
          } else {
            promoError = result.error || "Invalid promo code";
          }
        }

        const netAmount = Math.round((subtotal - discountAmount) * 100) / 100;
        const feeMethod = resolvePaySolutionsFeeMethod(paymentMethod, currency);
        const feeBreakdown = netAmount > 0
          ? calculatePaySolutionsFeeExact(netAmount, feeMethod)
          : { fee: 0, total: 0 };

        return reply.send({
          success: true,
          data: {
            subtotal,
            discountAmount,
            discountType,
            discountValue,
            netAmount,
            fee: feeBreakdown.fee,
            total: feeBreakdown.total,
            currency,
            feeMethod,
            promoValid,
            promoError,
          },
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ success: false, error: "Failed to preview pricing" });
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
      const rawBody = parsePostbackBody(request.body);
      if (parsePositiveEventId(rawBody.eventId) === null) {
        return reply.status(400).send({
          success: false,
          code: "MISSING_EVENT_ID",
          error: "Event is required",
        });
      }

      const parsed = createPaymentIntentSchema.safeParse(rawBody);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: "Invalid input",
          details: parsed.error.flatten(),
        });
      }

      const {
        eventId,
        packageId,
        addOnIds,
        currency,
        paymentMethod,
        promoCode,
        workshopSessionId,
        needTaxInvoice,
        taxName,
        taxId,
        taxAddress,
        taxSubDistrict,
        taxDistrict,
        taxProvince,
        taxPostalCode,
      } = parsed.data;
      const userId = request.user.id;
      const isAddonOnly = !packageId || packageId === "";
      const taxInvoice = buildTaxInvoiceInfo({
        needTaxInvoice,
        taxName,
        taxId,
        taxAddress,
        taxSubDistrict,
        taxDistrict,
        taxProvince,
        taxPostalCode,
      });

      fastify.log.info(
        `[CREATE-INTENT] eventId=${eventId}, paymentMethod=${paymentMethod}, currency=${currency}, packageId=${packageId || "(addon-only)"}, isAddonOnly=${isAddonOnly}`
      );

      try {
        // ── Duplicate / addon-only guard ─────────────────────
        const purchaseSnapshot = await getPaidPurchaseSnapshot(userId, eventId);
        const userHasPrimary = purchaseSnapshot.hasPrimaryTicket;
        const userPurchasedAddOns = purchaseSnapshot.purchasedAddOns;

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

        // Block purchasing workshop addon if user already has a confirmed workshop session
        if (addOnIds.some((id) => id.toLowerCase() === "workshop")) {
          const existingWorkshopSession = await db
            .select({ id: registrationSessions.id })
            .from(registrationSessions)
            .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
            .innerJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
            .innerJoin(orders, eq(registrations.orderId, orders.id))
            .innerJoin(payments, eq(payments.orderId, orders.id))
            .where(
              and(
                eq(registrations.userId, userId),
                eq(registrations.eventId, eventId),
                eq(registrations.status, "confirmed"),
                sql`LOWER(${ticketTypes.groupName}) = 'workshop'`,
                eq(payments.status, "paid")
              )
            )
            .limit(1);

          if (existingWorkshopSession.length > 0) {
            return reply.status(400).send({
              success: false,
              error: "You have already registered for a workshop session. Only one workshop session is allowed per registration.",
              code: "DUPLICATE_WORKSHOP_SESSION",
            });
          }
        }

        // ── Resolve primary ticket (if not addon-only) ──────
        let primaryTicket: ResolvedTicket | null = null;
        if (!isAddonOnly) {
          primaryTicket = await resolveTicketId(packageId, eventId, currency, "primary");
          if (!primaryTicket) {
            return reply.status(404).send({
              success: false,
              code: "EVENT_TICKET_MISMATCH",
              error: `No ${currency} ticket found for package "${packageId}" in event ${eventId}`,
            });
          }

          // Check availability and sale period
          const [currentTicket] = await db
            .select({
              quota: ticketTypes.quota,
              soldCount: ticketTypes.soldCount,
              saleStartDate: ticketTypes.saleStartDate,
              saleEndDate: ticketTypes.saleEndDate,
            })
            .from(ticketTypes)
            .where(eq(ticketTypes.id, primaryTicket.id))
            .limit(1);

          if (currentTicket) {
            const now = new Date();
            const saleStart = currentTicket.saleStartDate ? new Date(currentTicket.saleStartDate) : null;
            const saleEnd = currentTicket.saleEndDate ? new Date(currentTicket.saleEndDate) : null;

            if (saleStart && now < saleStart) {
              return reply.status(400).send({
                success: false,
                error: "Ticket sales have not started yet",
                code: "SALE_NOT_STARTED",
                saleStartDate: saleStart.toISOString(),
              });
            }

            if (saleEnd && now > saleEnd) {
              return reply.status(400).send({
                success: false,
                error: "Ticket sales have ended",
                code: "SALE_ENDED",
              });
            }

            if (currentTicket.quota > 0 && currentTicket.soldCount >= currentTicket.quota) {
              return reply.status(400).send({
                success: false,
                error: "Ticket sold out",
              });
            }
          }
        }

        // ── Resolve add-ons ─────────────────────────────────
        let totalAmount = primaryTicket ? Number(primaryTicket.price) : 0;
        const resolvedAddOns: ResolvedTicket[] = [];

        for (const addOnId of addOnIds) {
          const addon = await resolveTicketId(addOnId, eventId, currency, "addon");
          if (addon) {
            totalAmount += Number(addon.price);
            resolvedAddOns.push(addon);
            fastify.log.info(`[CREATE-INTENT] Resolved addon "${addOnId}" → ticketTypeId=${addon.id}, price=${addon.price}`);
          } else {
            return reply.status(400).send({
              success: false,
              code: "EVENT_TICKET_MISMATCH",
              error: `Add-on "${addOnId}" is not available for event ${eventId}`,
            });
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
                  eq(sessions.eventId, eventId),
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
            const [sessionData] = await db
              .select({ maxCapacity: sessions.maxCapacity, eventId: sessions.eventId })
              .from(sessions)
              .where(eq(sessions.id, workshopSessionId))
              .limit(1);

            if (!sessionData || sessionData.eventId !== eventId) {
              return reply.status(400).send({
                success: false,
                code: "EVENT_SESSION_MISMATCH",
                error: "Selected workshop session does not belong to this event",
              });
            }

            const enrollCount = await countConfirmedWorkshopEnrollments(eventId, workshopSessionId);

            if (sessionData.maxCapacity && enrollCount >= sessionData.maxCapacity) {
              return reply.status(400).send({
                success: false,
                error: "Selected workshop session is full",
              });
            }
          }
        }

        if (taxInvoice.needTaxInvoice) {
          if (!taxInvoice.taxId) {
            return reply.status(400).send({
              success: false,
              code: "INVALID_TAX_ID",
              error: "Tax ID / VAT number is required",
            });
          }

          if (
            !taxInvoice.taxName ||
            !taxInvoice.taxAddress ||
            !taxInvoice.taxSubDistrict ||
            !taxInvoice.taxDistrict ||
            !taxInvoice.taxProvince ||
            !taxInvoice.taxPostalCode
          ) {
            return reply.status(400).send({
              success: false,
              code: "MISSING_TAX_ADDRESS",
              error: "Complete tax invoice address is required",
            });
          }
        }

        // 5. Apply promo code (if any)
        const subtotalBeforeDiscount = totalAmount;
        let discountAmount = 0;
        let promoResult: { promoCodeId?: number; discountType?: string; discountValue?: number; discountAmount?: number } = {};

        const selectedTicketTypeIds = [
          ...(primaryTicket ? [primaryTicket.id] : []),
          ...resolvedAddOns.map(a => a.id),
        ];

        if (promoCode && promoCode.trim()) {
          const validation = await validatePromoCode(
            promoCode.trim(),
            userId,
            currency,
            subtotalBeforeDiscount,
            selectedTicketTypeIds,
          );

          if (!validation.valid) {
            return reply.status(400).send({
              success: false,
              error: validation.error || "Invalid promo code",
              code: "INVALID_PROMO",
            });
          }

          discountAmount = validation.discountAmount!;
          totalAmount = validation.netAmount!;
          promoResult = {
            promoCodeId: validation.promoCodeId,
            discountType: validation.discountType,
            discountValue: validation.discountValue,
            discountAmount: validation.discountAmount,
          };
          fastify.log.info(`[CREATE-INTENT] Promo "${promoCode}" applied: discount=${discountAmount}, net=${totalAmount}`);
        }

        // 6. Calculate Pay Solutions fee (pass-through to buyer)
        const feeMethod = resolvePaySolutionsFeeMethod(paymentMethod, currency);
        const feeBreakdown = totalAmount > 0
          ? calculatePaySolutionsFeeExact(totalAmount, feeMethod)
          : { fee: 0, total: 0, processingFee: 0, processingVat: 0 };
        const chargeAmount = feeBreakdown.total;

        // 7. Create Order record (with orderNumber + promo info)
        const orderNumber = generateOrderNumber();
        const [order] = await db
          .insert(orders)
          .values({
            userId,
            eventId,
            orderNumber,
            subtotalAmount: String(subtotalBeforeDiscount),
            discountAmount: String(discountAmount),
            promoCodeId: promoResult.promoCodeId || null,
            promoCode: promoCode ? promoCode.trim().toUpperCase() : null,
            promoDiscountType: promoResult.discountType || null,
            promoDiscountValue: promoResult.discountValue != null ? String(promoResult.discountValue) : null,
            totalAmount: String(chargeAmount),
            currency,
            status: "pending",
            needTaxInvoice: taxInvoice.needTaxInvoice,
            taxName: taxInvoice.taxName,
            taxId: taxInvoice.taxId,
            taxAddress: taxInvoice.taxAddress,
            taxSubDistrict: taxInvoice.taxSubDistrict,
            taxDistrict: taxInvoice.taxDistrict,
            taxProvince: taxInvoice.taxProvince,
            taxPostalCode: taxInvoice.taxPostalCode,
            taxFullAddress: taxInvoice.taxFullAddress,
            taxCreatedAt: taxInvoice.needTaxInvoice ? new Date() : null,
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

        // ── FREE REGISTRATION PATH ──────────────────────────
        // If chargeAmount is 0 (free ticket or 100% promo), process immediately
        if (chargeAmount === 0) {
          fastify.log.info(`[CREATE-INTENT] chargeAmount=0, processing free registration for order ${order.id}`);

          // Mark order as paid immediately
          await db.update(orders).set({ status: "paid" }).where(eq(orders.id, order.id));

          // Create a payment record for auditing
          await db.insert(payments).values({
            orderId: order.id,
            amount: "0",
            status: "paid",
            paymentChannel: "free",
            paymentProvider: "pay_solutions",
            providerRef: `FREE-${order.orderNumber}`,
            providerStatus: "PAID",
            paySolutionsRefno: null,
            paySolutionsChannel: null,
            paymentDetails: {
              requestedMethod: "free",
              workshopSessionId: workshopSessionId || null,
              processingFee: 0,
              processingVat: 0,
              freeReason: discountAmount > 0 ? "promo_100_percent" : "free_ticket",
            },
          });

          // Settle promo usage
          if (promoResult.promoCodeId) {
            await reservePromoUsage(promoResult.promoCodeId, userId, order.id, discountAmount);
            await settlePromoUsageSuccess(order.id);
            fastify.log.info(`[CREATE-INTENT] Promo settled for free order ${order.id}`);
          }

          // Process registration (reuse shared helper)
          const result = await processSuccessfulPayment(
            fastify,
            order.id,
            `FREE-${order.orderNumber}`,
            workshopSessionId || null,
            null,
            "free",
            "pay_solutions",
            "PAID",
            { freeRegistration: true },
          );

          const regCode = result?.regCode || "";

          // Send confirmation email
          if (result) {
            try {
              const apiBaseUrl = getPublicApiBaseUrl();
              const receiptToken = generateReceiptToken(order.id);
              const receiptDownloadUrl = `${apiBaseUrl}/api/payments/receipt/${receiptToken}`;

              const items = await db
                .select({
                  name: ticketTypes.name,
                  price: ticketTypes.price,
                  category: ticketTypes.category,
                })
                .from(orderItems)
                .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
                .where(eq(orderItems.orderId, order.id));

              await sendPaymentReceiptEmail(
                result.user.email,
                result.user.firstName,
                result.user.middleName,
                result.user.lastName,
                order.orderNumber,
                new Date(),
                "free",
                items.map((i) => ({
                  name: i.name,
                  type: i.category,
                  price: Number(i.price),
                })),
                subtotalBeforeDiscount,
                0,
                0,
                currency,
                receiptDownloadUrl,
                order.needTaxInvoice
                  ? {
                      taxName: order.taxName || "",
                      taxId: order.taxId || "",
                      taxFullAddress: order.taxFullAddress || "",
                    }
                  : undefined,
                regCode,
              );
            } catch (emailErr) {
              fastify.log.error(emailErr, "[CREATE-INTENT] Failed to send free registration email");
            }
          }

          return reply.send({
            success: true,
            data: {
              free: true,
              gateway: null,
              redirectForm: null,
              refno: null,
              orderRef: null,
              orderId: order.id,
              orderNumber,
              regCode,
              subtotal: subtotalBeforeDiscount,
              discountAmount,
              discountType: promoResult.discountType || null,
              discountValue: promoResult.discountValue || null,
              netAmount: 0,
              fee: 0,
              total: 0,
              currency,
              feeMethod: null,
              paymentChannel: "free",
            },
          });
        }

        // ── PAID FLOW (chargeAmount > 0) ─────────────────────

        // Build order detail for Pay Solutions redirect
        const ticketIds = [
          ...(primaryTicket ? [primaryTicket.id] : []),
          ...resolvedAddOns.map((a) => a.id),
        ];
        const ticketNames = ticketIds.length > 0
          ? await db
            .select({ id: ticketTypes.id, name: ticketTypes.name })
            .from(ticketTypes)
            .where(sql`${ticketTypes.id} IN (${sql.join(ticketIds.map((id) => sql`${id}`), sql`, `)})`)
          : [];
        const nameMap = new Map(ticketNames.map((t) => [t.id, t.name]));

        const descLines = [`ACCP2026 ${orderNumber}${isAddonOnly ? " Add-on" : ""}`];
        if (primaryTicket) {
          descLines.push(`${nameMap.get(primaryTicket.id) || packageId}: ${currency === "THB" ? "THB" : "USD"} ${Number(primaryTicket.price).toLocaleString()}`);
        }
        for (const addon of resolvedAddOns) {
          descLines.push(`${nameMap.get(addon.id) || "Add-on"}: ${currency === "THB" ? "THB" : "USD"} ${Number(addon.price).toLocaleString()}`);
        }
        if (discountAmount > 0) {
          descLines.push(`Discount ${currency === "THB" ? "THB" : "USD"} ${discountAmount.toLocaleString()}`);
        }
        if (feeBreakdown.fee > 0) {
          descLines.push(`Fee ${currency === "THB" ? "THB" : "USD"} ${feeBreakdown.fee.toLocaleString()}`);
        }

        const [buyer] = await db
          .select({
            email: users.email,
            phone: users.phone,
            firstName: users.firstName,
            middleName: users.middleName,
            lastName: users.lastName,
          })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1);

        if (!buyer) {
          return reply.status(404).send({ success: false, error: "User not found" });
        }

        const requestedLocale = String(request.headers["accept-language"] || request.headers["x-locale"] || "").toLowerCase();
        const referer = String(request.headers.referer || "").toLowerCase();
        const paySolutionsLang: "TH" | "EN" =
          requestedLocale.startsWith("th") || referer.includes("/th/") ? "TH" : "EN";

        const secureOrderDetail = descLines.join(" | ").slice(0, 255);
        const customerFullName = `${buyer.firstName || ""} ${buyer.lastName || ""}`.trim();

        const sourceApp = String(request.headers["x-source-app"] || "").toLowerCase();
        const shouldUseKtbGateway =
          sourceApp === "conference-web" &&
          currency === "THB" &&
          isKtbFastpayConfigured();

        if (sourceApp === "conference-web" && currency === "THB" && !shouldUseKtbGateway) {
          fastify.log.warn("[CREATE-INTENT] KTB FASTPAY not configured, falling back to Pay Solutions");
        }

        if (shouldUseKtbGateway) {
          const ktbOrderRef = generateKtbOrderRef(order.id);
          const ktbPayMethod = mapRequestedPaymentMethodToKtb(paymentMethod);
          const apiBaseUrl = getPublicApiBaseUrl();
          const ktbPayload = createKtbFormPayload({
            orderRef: ktbOrderRef,
            amount: chargeAmount,
            successUrl: `${apiBaseUrl}/api/payments/ktb/return?result=success`,
            failUrl: `${apiBaseUrl}/api/payments/ktb/return?result=fail`,
            cancelUrl: `${apiBaseUrl}/api/payments/ktb/return?result=cancel`,
            payType: "N",
            lang: getRequestedKtbLang(request),
            payMethod: ktbPayMethod,
            customerEmail: buyer.email,
            remark: secureOrderDetail,
            orderRef1: String(order.id),
            orderRef2: orderNumber,
          });

          await db.insert(payments).values({
            orderId: order.id,
            amount: String(chargeAmount),
            status: "pending",
            paymentChannel: paymentMethod === "qr" ? "qr" : "card",
            paymentProvider: "ktb_fastpay",
            providerRef: ktbOrderRef,
            providerStatus: "PENDING",
            paymentDetails: {
              requestedMethod: paymentMethod,
              workshopSessionId: workshopSessionId || null,
              processingFee: feeBreakdown.processingFee,
              processingVat: feeBreakdown.processingVat,
              ktb: {
                request: ktbPayload.fields,
                actionUrl: ktbPayload.actionUrl,
                orderRef: ktbOrderRef,
              },
            },
          });

          if (promoResult.promoCodeId) {
            await reservePromoUsage(promoResult.promoCodeId, userId, order.id, discountAmount);
            fastify.log.info(`[CREATE-INTENT] Reserved promo usage for order ${order.id}, promoId=${promoResult.promoCodeId}`);
          }

          fastify.log.info(
            `[CREATE-INTENT] flow=ktb_fastpay actionUrl=${ktbPayload.actionUrl}, amount=${chargeAmount}, orderRef=${ktbOrderRef}, payMethod=${ktbPayMethod || "auto"}`
          );

          return reply.send({
            success: true,
            data: {
              free: false,
              gateway: "ktb",
              redirectForm: ktbPayload,
              refno: ktbOrderRef,
              orderRef: ktbOrderRef,
              orderId: order.id,
              orderNumber,
              subtotal: subtotalBeforeDiscount,
              discountAmount,
              discountType: promoResult.discountType || null,
              discountValue: promoResult.discountValue || null,
              netAmount: totalAmount,
              fee: feeBreakdown.fee,
              total: chargeAmount,
              currency,
              feeMethod,
              paymentChannel: paymentMethod === "qr" ? "qr" : "card",
            },
          });
        }

        const paySolutionsChannel = resolvePaySolutionsChannel(paymentMethod, currency);
        const paySolutionsRefno = await generatePaySolutionsRefno();
        let formSubmitPayload: ReturnType<typeof createFormSubmitPayload> | null = null;

        try {
          formSubmitPayload = createFormSubmitPayload({
            amount: chargeAmount,
            orderDetail: secureOrderDetail,
            refNo: paySolutionsRefno,
            userEmail: buyer.email,
            customerName: customerFullName || undefined,
            channel: paySolutionsChannel,
            currency,
            lang: paySolutionsLang,
          });

          fastify.log.info(
            `[CREATE-INTENT] flow=form_submit actionUrl=${formSubmitPayload.actionUrl}, channel=${paySolutionsChannel}, amount=${chargeAmount}, refno=${paySolutionsRefno}, customerName="${customerFullName}", fields=${JSON.stringify(Object.keys(formSubmitPayload.fields))}`
          );
        } catch (formSubmitErr) {
          await db
            .update(orders)
            .set({ status: "cancelled" })
            .where(eq(orders.id, order.id));
          throw formSubmitErr;
        }

        if (!formSubmitPayload) {
          throw new Error("Failed to build Pay Solutions form payload");
        }

        // 9. Create Payment record
        await db.insert(payments).values({
          orderId: order.id,
          amount: String(chargeAmount),
          status: "pending",
          paymentChannel: paySolutionsChannel,
          paymentProvider: "pay_solutions",
          providerRef: paySolutionsRefno,
          providerStatus: "PENDING",
          paySolutionsRefno,
          paySolutionsChannel,
          paymentDetails: {
            requestedMethod: paymentMethod,
            workshopSessionId: workshopSessionId || null,
            processingFee: feeBreakdown.processingFee,
            processingVat: feeBreakdown.processingVat,
            formSubmitActionUrl: formSubmitPayload.actionUrl,
            formSubmitFields: formSubmitPayload.fields,
          },
        });

        // 10. Reserve promo usage (pending) if promo was applied
        if (promoResult.promoCodeId) {
          await reservePromoUsage(promoResult.promoCodeId, userId, order.id, discountAmount);
          fastify.log.info(`[CREATE-INTENT] Reserved promo usage for order ${order.id}, promoId=${promoResult.promoCodeId}`);
        }

        // 11. Return form-submit payload + fee breakdown + discount info
        return reply.send({
          success: true,
          data: {
            free: false,
            gateway: "pay_solutions",
            redirectForm: formSubmitPayload,
            refno: paySolutionsRefno,
            orderRef: null,
            orderId: order.id,
            orderNumber,
            subtotal: subtotalBeforeDiscount,
            discountAmount,
            discountType: promoResult.discountType || null,
            discountValue: promoResult.discountValue || null,
            netAmount: totalAmount,
            fee: feeBreakdown.fee,
            total: chargeAmount,
            currency,
            feeMethod,
            paymentChannel: paySolutionsChannel,
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

        // Find payment record
        const [payment] = await db
          .select()
          .from(payments)
          .where(eq(payments.orderId, orderId))
          .limit(1);

        if (payment?.paymentProvider === "stripe" && payment.stripeSessionId) {
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
            .set({
              status: "cancelled",
              providerStatus: "CANCELLED",
            })
            .where(eq(payments.id, payment.id));
        }

        // Cancel promo usage reservation
        await cancelPromoUsage(orderId);

        fastify.log.info(`[CANCEL-INTENT] Order ${orderId} cancelled by user ${userId}`);

        return reply.send({ success: true, data: { orderId, status: "cancelled" } });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({ success: false, error: "Failed to cancel payment" });
      }
    }
  );

  // ─────────────────────────────────────────────────────
  // POST /payments/paysolutions/postback (NO JWT)
  // Receives asynchronous payment notifications from Pay Solutions
  // ─────────────────────────────────────────────────────
  fastify.post(
    "/paysolutions/postback",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const parsedBody = parsePostbackBody(request.body);
        const rawPayload = Object.keys(parsedBody).length > 0
          ? parsedBody
          : ((request.query as Record<string, unknown>) || {});
        const normalized = normalizePaySolutionsPayload(rawPayload);

        if (!verifyPaySolutionsPostback(normalized)) {
          return reply.status(400).send({
            success: false,
            error: "Invalid Pay Solutions postback payload",
          });
        }

        if (!normalized.referenceNo) {
          return reply.status(400).send({
            success: false,
            error: "Missing ReferenceNo",
          });
        }

        const [payment] = await db
          .select({
            id: payments.id,
            orderId: payments.orderId,
            status: payments.status,
            paymentChannel: payments.paymentChannel,
            paymentDetails: payments.paymentDetails,
            paySolutionsChannel: payments.paySolutionsChannel,
          })
          .from(payments)
          .where(eq(payments.paySolutionsRefno, normalized.referenceNo))
          .limit(1);

        if (!payment) {
          fastify.log.warn(`[PAYSOLUTIONS-POSTBACK] Unknown refno: ${normalized.referenceNo}`);
          return reply.send({ received: true, ignored: true });
        }

        const postbackChannel = normalizePaySolutionsChannel(
          normalized.cardType,
          payment.paySolutionsChannel || payment.paymentChannel
        );

        const mergedDetails: Record<string, unknown> = {
          ...(payment.paymentDetails && typeof payment.paymentDetails === "object" && !Array.isArray(payment.paymentDetails)
            ? (payment.paymentDetails as Record<string, unknown>)
            : {}),
          postbackRaw: normalized.raw,
          latestStatus: normalized.status,
          latestStatusName: normalized.statusName,
        };

        // Handle refund events even if payment is already paid
        if (isPaySolutionsRefundStatus(normalized.status, normalized.statusName)) {
          const refundProviderStatus = normalized.status || normalized.statusName || "RF";
          await db
            .update(payments)
            .set({
              status: "refunded",
              providerStatus: refundProviderStatus,
              paymentDetails: mergedDetails,
            })
            .where(eq(payments.id, payment.id));

          // orders.status enum only allows pending/paid/cancelled — use cancelled for refunds
          await db
            .update(orders)
            .set({ status: "cancelled" })
            .where(eq(orders.id, payment.orderId));

          fastify.log.info(`[PAYSOLUTIONS-POSTBACK] Refund processed for refno=${normalized.referenceNo}, status=${refundProviderStatus}`);
          return reply.send({ received: true, status: "refunded" });
        }

        // Skip duplicate paid postbacks (non-refund)
        if (payment.status === "paid") {
          return reply.send({ received: true, duplicate: true });
        }

        const workshopSessionId = parseWorkshopSessionIdFromDetails(payment.paymentDetails);

        if (isPaySolutionsPaidStatus(normalized.status, normalized.statusName)) {
          const txResult = await processSuccessfulPayment(
            fastify,
            payment.orderId,
            normalized.orderNo || normalized.referenceNo,
            workshopSessionId,
            null,
            postbackChannel,
            "pay_solutions",
            normalized.status || normalized.statusName || "CP",
            mergedDetails,
          );

          if (txResult) {
            await settlePromoUsageSuccess(payment.orderId);

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
                .where(eq(orderItems.orderId, payment.orderId));

              const sortedEmailItems = sortOrderItemsPrimaryFirst(emailItems);
              const emailSubtotal = sortedEmailItems.reduce(
                (sum, item) => sum + Number(item.price) * item.quantity,
                0
              );
              const emailDiscount = Number(order.discountAmount || 0);
              const emailNetAmount = emailSubtotal - emailDiscount;
              const emailTotal = Number(order.totalAmount);
              const emailFee = Math.round((emailTotal - emailNetAmount) * 100) / 100;

              const receiptToken = generateReceiptToken(payment.orderId);
              const apiBaseUrl = getPublicApiBaseUrl();
              const receiptDownloadUrl = `${apiBaseUrl}/api/payments/receipt/${receiptToken}`;

              await sendPaymentReceiptEmail(
                user.email,
                user.firstName,
                user.middleName,
                user.lastName,
                order.orderNumber,
                new Date(),
                postbackChannel,
                sortedEmailItems.map((i) => ({
                  name: i.name,
                  type: i.type,
                  price: Number(i.price),
                })),
                emailSubtotal,
                emailFee,
                emailTotal,
                order.currency,
                receiptDownloadUrl,
                order.needTaxInvoice
                  ? {
                    taxName: order.taxName,
                    taxId: order.taxId,
                    taxFullAddress: order.taxFullAddress,
                  }
                  : undefined,
                regCode
              );
            } catch (emailErr) {
              fastify.log.error(`[PAYSOLUTIONS-POSTBACK] Failed to send receipt email for order ${payment.orderId}: ${emailErr}`);
            }
          }

          return reply.send({ received: true, status: "paid" });
        }

        if (isPaySolutionsFailedStatus(normalized.status, normalized.statusName)) {
          await db
            .update(orders)
            .set({ status: "cancelled" })
            .where(eq(orders.id, payment.orderId));

          await db
            .update(payments)
            .set({
              status: "failed",
              providerStatus: normalized.status || normalized.statusName || "FAILED",
              paymentChannel: postbackChannel,
              paymentDetails: mergedDetails,
            })
            .where(eq(payments.id, payment.id));

          await cancelPromoUsage(payment.orderId);

          return reply.send({ received: true, status: "failed" });
        }

        await db
          .update(payments)
          .set({
            paymentChannel: postbackChannel,
            providerStatus: normalized.status || normalized.statusName || "PENDING",
            paySolutionsOrderNo: normalized.orderNo || undefined,
            paymentDetails: mergedDetails,
          })
          .where(eq(payments.id, payment.id));

        return reply.send({ received: true, status: "pending" });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          error: "Failed to process Pay Solutions postback",
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

          // Settle promo usage on success
          if (txResult) {
            await settlePromoUsageSuccess(orderId);
          }

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

              const sortedEmailItems = sortOrderItemsPrimaryFirst(emailItems);

              const emailSubtotal = sortedEmailItems.reduce(
                (sum, item) => sum + Number(item.price) * item.quantity, 0
              );
              const emailDiscount = Number(order.discountAmount || 0);
              const emailNetAmount = emailSubtotal - emailDiscount;
              const emailTotal = Number(order.totalAmount);
              const emailFee = Math.round((emailTotal - emailNetAmount) * 100) / 100;

              const receiptToken = generateReceiptToken(orderId);
              const apiBaseUrl = getPublicApiBaseUrl();
              const receiptDownloadUrl = `${apiBaseUrl}/api/payments/receipt/${receiptToken}`;

              await sendPaymentReceiptEmail(
                user.email,
                user.firstName,
                user.middleName,
                user.lastName,
                order.orderNumber,
                new Date(),
                paymentChannel,
                sortedEmailItems.map((i) => ({
                  name: i.name,
                  type: i.type,
                  price: Number(i.price),
                })),
                emailSubtotal,
                emailFee,
                emailTotal,
                order.currency,
                receiptDownloadUrl,
                order.needTaxInvoice
                  ? {
                    taxName: order.taxName,
                    taxId: order.taxId,
                    taxFullAddress: order.taxFullAddress,
                  }
                  : undefined,
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

          await cancelPromoUsage(orderId);

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

          await cancelPromoUsage(orderId);

          fastify.log.info(`Payment canceled for order ${orderId}`);
          break;
        }
      }

      return reply.send({ received: true });
    }
  );

  // ─────────────────────────────────────────────────────
  // GET /payments/verify?refno=xxxx or ?payment_intent=pi_xxx (JWT protected)
  // Used by result page after gateway redirect
  // ─────────────────────────────────────────────────────
  fastify.get(
    "/verify",
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { payment_intent: piId, refno, orderRef } = request.query as {
        payment_intent?: string;
        refno?: string;
        orderRef?: string;
      };
      const userId = request.user.id;

      if (!piId && !refno && !orderRef) {
        return reply.status(400).send({ success: false, error: "Missing refno, orderRef, or payment_intent parameter" });
      }

      const paymentWhere = orderRef
        ? and(eq(payments.paymentProvider, "ktb_fastpay"), eq(payments.providerRef, orderRef))
        : refno
          ? eq(payments.paySolutionsRefno, refno)
          : eq(payments.stripeSessionId, piId || "");

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
          paymentProvider: payments.paymentProvider,
          providerRef: payments.providerRef,
          providerStatus: payments.providerStatus,
          paySolutionsRefno: payments.paySolutionsRefno,
          paySolutionsOrderNo: payments.paySolutionsOrderNo,
          paySolutionsChannel: payments.paySolutionsChannel,
          paymentDetails: payments.paymentDetails,
        })
        .from(payments)
        .where(paymentWhere)
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
          discountAmount: orders.discountAmount,
          promoCode: orders.promoCode,
          needTaxInvoice: orders.needTaxInvoice,
          taxName: orders.taxName,
          taxId: orders.taxId,
          taxFullAddress: orders.taxFullAddress,
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

      // If still pending, verify from provider
      if (payment.status === "pending") {
        if (payment.paymentProvider === "stripe" && payment.stripeSessionId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(payment.stripeSessionId);
            fastify.log.info(`[VERIFY] stripe pi.status=${pi.status} for ${payment.stripeSessionId}`);

            if (pi.status === "succeeded") {
              let receiptUrl: string | null = null;
              if (pi.latest_charge) {
                try {
                  const charge = await stripe.charges.retrieve(pi.latest_charge as string);
                  receiptUrl = charge.receipt_url || null;
                } catch {
                  // non-critical
                }
              }

              const workshopSessionId = pi.metadata.workshopSessionId
                ? parseInt(pi.metadata.workshopSessionId)
                : null;
              const verifyPaymentChannel = pi.payment_method_types?.[0] || "card";

              const verifyResult = await processSuccessfulPayment(
                fastify,
                order.id,
                payment.stripeSessionId,
                workshopSessionId,
                receiptUrl,
                verifyPaymentChannel,
              );

              if (verifyResult) {
                orderStatus = "paid";
                paymentData = {
                  ...paymentData,
                  status: "paid",
                  paymentChannel: verifyPaymentChannel,
                  stripeReceiptUrl: receiptUrl,
                  paidAt: new Date(),
                  providerStatus: "PAID",
                };
                justTransitionedToPaid = true;
                verifyRegCode = verifyResult.regCode;
                await settlePromoUsageSuccess(order.id);
              }
            } else if (pi.status === "canceled" || pi.status === "requires_payment_method") {
              await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, order.id));
              await db.update(payments).set({ status: "failed" }).where(eq(payments.id, payment.id));
              await cancelPromoUsage(order.id);
              orderStatus = "cancelled";
              paymentData = { ...paymentData, status: "failed", providerStatus: "FAILED" };
            }
          } catch (err) {
            fastify.log.error(`[VERIFY] Stripe API error: ${err}`);
          }
        } else if (payment.paymentProvider === "pay_solutions" && payment.paySolutionsRefno) {
          try {
            const inquiry = await inquiryPayment(payment.paySolutionsRefno);
            if (inquiry) {
              const normalized = normalizePaySolutionsPayload(inquiry as Record<string, unknown>);
              const verifyChannel = normalizePaySolutionsChannel(
                normalized.cardType,
                payment.paySolutionsChannel || payment.paymentChannel
              );

              const mergedDetails: Record<string, unknown> = {
                ...(payment.paymentDetails && typeof payment.paymentDetails === "object" && !Array.isArray(payment.paymentDetails)
                  ? (payment.paymentDetails as Record<string, unknown>)
                  : {}),
                inquiryRaw: normalized.raw,
                latestStatus: normalized.status,
                latestStatusName: normalized.statusName,
              };

              const workshopSessionId = parseWorkshopSessionIdFromDetails(payment.paymentDetails);

              if (isPaySolutionsPaidStatus(normalized.status, normalized.statusName)) {
                const verifyResult = await processSuccessfulPayment(
                  fastify,
                  order.id,
                  normalized.orderNo || normalized.referenceNo || payment.paySolutionsRefno,
                  workshopSessionId,
                  null,
                  verifyChannel,
                  "pay_solutions",
                  normalized.status || normalized.statusName || "CP",
                  mergedDetails,
                );

                if (verifyResult) {
                  orderStatus = "paid";
                  paymentData = {
                    ...paymentData,
                    status: "paid",
                    paymentChannel: verifyChannel,
                    providerStatus: normalized.status || normalized.statusName || "CP",
                    paidAt: new Date(),
                  };
                  justTransitionedToPaid = true;
                  verifyRegCode = verifyResult.regCode;
                  await settlePromoUsageSuccess(order.id);
                }
              } else if (isPaySolutionsFailedStatus(normalized.status, normalized.statusName)) {
                await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, order.id));
                await db.update(payments).set({
                  status: "failed",
                  providerStatus: normalized.status || normalized.statusName || "FAILED",
                  paymentChannel: verifyChannel,
                  paymentDetails: mergedDetails,
                }).where(eq(payments.id, payment.id));
                await cancelPromoUsage(order.id);
                orderStatus = "cancelled";
                paymentData = {
                  ...paymentData,
                  status: "failed",
                  providerStatus: normalized.status || normalized.statusName || "FAILED",
                  paymentChannel: verifyChannel,
                };
              } else if (isPaySolutionsRefundStatus(normalized.status, normalized.statusName)) {
                const refundProviderStatus = normalized.status || normalized.statusName || "RF";
                await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, order.id));
                await db.update(payments).set({
                  status: "refunded",
                  providerStatus: refundProviderStatus,
                  paymentChannel: verifyChannel,
                  paymentDetails: mergedDetails,
                }).where(eq(payments.id, payment.id));
                orderStatus = "cancelled";
                paymentData = {
                  ...paymentData,
                  status: "refunded",
                  providerStatus: refundProviderStatus,
                  paymentChannel: verifyChannel,
                };
              } else {
                await db.update(payments).set({
                  providerStatus: normalized.status || normalized.statusName || "PENDING",
                  paySolutionsOrderNo: normalized.orderNo || undefined,
                  paymentChannel: verifyChannel,
                  paymentDetails: mergedDetails,
                }).where(eq(payments.id, payment.id));
              }
            }
          } catch (err) {
            fastify.log.error(`[VERIFY] Pay Solutions inquiry error: ${err}`);
          }
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

      const sortedItems = sortOrderItemsPrimaryFirst(items);
      const subtotal = sortedItems.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
      const totalPaid = Number(paymentData.amount);
      const verifyDiscount = Number(order.discountAmount || 0);
      const verifyNetAmount = subtotal - verifyDiscount;
      const fee = Math.round((totalPaid - verifyNetAmount) * 100) / 100;

      // Generate receipt download URL for paid orders
      let receiptDownloadUrl: string | null = null;
      if (orderStatus === "paid") {
        const receiptToken = generateReceiptToken(order.id);
        const apiBaseUrl = getPublicApiBaseUrl();
        receiptDownloadUrl = `${apiBaseUrl}/api/payments/receipt/${receiptToken}`;
      }

      // Send receipt email if verify endpoint just transitioned the order to paid
      if (justTransitionedToPaid) {
        const [verifyUser] = await db
          .select({
            email: users.email,
            firstName: users.firstName,
            middleName: users.middleName,
            lastName: users.lastName,
          })
          .from(users)
          .where(eq(users.id, order.userId))
          .limit(1);

        if (verifyUser && receiptDownloadUrl) {
          (async () => {
            try {
              await sendPaymentReceiptEmail(
                verifyUser.email,
                verifyUser.firstName,
                verifyUser.middleName,
                verifyUser.lastName,
                order.orderNumber,
                new Date(),
                paymentData.paymentChannel || "card",
                sortedItems.map((i) => ({
                  name: i.ticketName,
                  type: i.itemType,
                  price: Number(i.price),
                })),
                subtotal,
                fee > 0 ? fee : 0,
                totalPaid,
                order.currency,
                receiptDownloadUrl,
                order.needTaxInvoice
                  ? {
                    taxName: order.taxName,
                    taxId: order.taxId,
                    taxFullAddress: order.taxFullAddress,
                  }
                  : undefined,
                verifyRegCode
              );
            } catch (emailErr) {
              fastify.log.error(`[VERIFY] Failed to send receipt email for order ${order.id}: ${emailErr}`);
            }
          })();
        }
      }

      if (!verifyRegCode) {
        const [registration] = await db
          .select({ regCode: registrations.regCode })
          .from(registrations)
          .where(
            and(
              eq(registrations.userId, order.userId),
              eq(registrations.status, "confirmed")
            )
          )
          .orderBy(desc(registrations.id))
          .limit(1);

        verifyRegCode = registration?.regCode || "";
      }

      return reply.send({
        success: true,
        data: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          orderStatus,
          gateway: mapGatewayFromPaymentProvider(paymentData.paymentProvider),
          regCode: verifyRegCode || null,
          currency: order.currency,
          payment: {
            status: paymentData.status,
            amount: paymentData.amount,
            paidAt: paymentData.paidAt,
            stripeReceiptUrl: paymentData.stripeReceiptUrl,
            paymentChannel: paymentData.paymentChannel,
            paymentProvider: paymentData.paymentProvider,
            providerStatus: paymentData.providerStatus,
            providerRef: paymentData.providerRef,
          },
          receiptDownloadUrl,
          items: sortedItems.map(item => ({
            type: item.itemType,
            name: item.ticketName,
            category: item.ticketCategory,
            price: item.price,
            quantity: item.quantity,
          })),
          subtotal: String(subtotal),
          discount: String(verifyDiscount),
          promoCode: order.promoCode || null,
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
          id: payments.id,
          status: payments.status,
          amount: payments.amount,
          paidAt: payments.paidAt,
          stripeReceiptUrl: payments.stripeReceiptUrl,
          paymentChannel: payments.paymentChannel,
          stripeSessionId: payments.stripeSessionId,
          paymentProvider: payments.paymentProvider,
          providerStatus: payments.providerStatus,
          paySolutionsRefno: payments.paySolutionsRefno,
          paySolutionsOrderNo: payments.paySolutionsOrderNo,
          paySolutionsChannel: payments.paySolutionsChannel,
          paymentDetails: payments.paymentDetails,
        })
        .from(payments)
        .where(eq(payments.orderId, parseInt(orderId)))
        .limit(1);

      // Provider fallback: if DB still "pending", check payment provider directly
      fastify.log.info(`[STATUS] Order ${orderId} — DB order.status=${orderStatus}, payment.status=${payment?.status}, provider=${payment?.paymentProvider}`);
      if (payment && payment.status === "pending") {
        if (payment.paymentProvider === "stripe" && payment.stripeSessionId) {
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
                } catch {
                  // non-critical
                }
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
                payment.stripeSessionId,
                wsSessionId,
                receiptUrl,
                statusPaymentChannel,
              );

              // Refresh response data
              orderStatus = "paid";
              payment = {
                ...payment,
                status: "paid",
                paymentChannel: statusPaymentChannel,
                stripeReceiptUrl: receiptUrl,
                paidAt: new Date(),
                providerStatus: "PAID",
              };

              await settlePromoUsageSuccess(order.id);
              fastify.log.info(`Fallback: updated order ${order.id} to paid via Stripe API check`);
            } else if (pi.status === "canceled" || pi.status === "requires_payment_method") {
              await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, order.id));
              await db.update(payments).set({ status: "failed" }).where(eq(payments.id, payment.id));
              await cancelPromoUsage(order.id);
              orderStatus = "cancelled";
              payment = { ...payment, status: "failed", providerStatus: "FAILED" };
            }
          } catch (err) {
            fastify.log.error(`Stripe API fallback error for order ${order.id}: ${err}`);
          }
        } else if (payment.paymentProvider === "pay_solutions" && payment.paySolutionsRefno) {
          try {
            const inquiry = await inquiryPayment(payment.paySolutionsRefno);
            if (inquiry) {
              const normalized = normalizePaySolutionsPayload(inquiry as Record<string, unknown>);
              const statusPaymentChannel = normalizePaySolutionsChannel(
                normalized.cardType,
                payment.paySolutionsChannel || payment.paymentChannel
              );

              const mergedDetails: Record<string, unknown> = {
                ...(payment.paymentDetails && typeof payment.paymentDetails === "object" && !Array.isArray(payment.paymentDetails)
                  ? (payment.paymentDetails as Record<string, unknown>)
                  : {}),
                inquiryRaw: normalized.raw,
                latestStatus: normalized.status,
                latestStatusName: normalized.statusName,
              };

              const wsSessionId = parseWorkshopSessionIdFromDetails(payment.paymentDetails);

              if (isPaySolutionsPaidStatus(normalized.status, normalized.statusName)) {
                await processSuccessfulPayment(
                  fastify,
                  order.id,
                  normalized.orderNo || normalized.referenceNo || payment.paySolutionsRefno,
                  wsSessionId,
                  null,
                  statusPaymentChannel,
                  "pay_solutions",
                  normalized.status || normalized.statusName || "CP",
                  mergedDetails,
                );

                orderStatus = "paid";
                payment = {
                  ...payment,
                  status: "paid",
                  paymentChannel: statusPaymentChannel,
                  providerStatus: normalized.status || normalized.statusName || "CP",
                  paidAt: new Date(),
                  paySolutionsOrderNo: normalized.orderNo || payment.paySolutionsOrderNo,
                };

                await settlePromoUsageSuccess(order.id);
                fastify.log.info(`Fallback: updated order ${order.id} to paid via Pay Solutions inquiry`);
              } else if (isPaySolutionsFailedStatus(normalized.status, normalized.statusName)) {
                await db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, order.id));
                await db.update(payments).set({
                  status: "failed",
                  providerStatus: normalized.status || normalized.statusName || "FAILED",
                  paymentChannel: statusPaymentChannel,
                  paymentDetails: mergedDetails,
                }).where(eq(payments.id, payment.id));
                await cancelPromoUsage(order.id);
                orderStatus = "cancelled";
                payment = {
                  ...payment,
                  status: "failed",
                  providerStatus: normalized.status || normalized.statusName || "FAILED",
                  paymentChannel: statusPaymentChannel,
                };
              } else {
                await db.update(payments).set({
                  providerStatus: normalized.status || normalized.statusName || "PENDING",
                  paymentChannel: statusPaymentChannel,
                  paySolutionsOrderNo: normalized.orderNo || undefined,
                  paymentDetails: mergedDetails,
                }).where(eq(payments.id, payment.id));
              }
            }
          } catch (err) {
            fastify.log.error(`Pay Solutions inquiry fallback error for order ${order.id}: ${err}`);
          }
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
            paymentProvider: payment.paymentProvider,
            providerStatus: payment.providerStatus,
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
            discountAmount: orders.discountAmount,
            promoCode: orders.promoCode,
            currency: orders.currency,
            status: orders.status,
            userId: orders.userId,
            needTaxInvoice: orders.needTaxInvoice,
            taxName: orders.taxName,
            taxId: orders.taxId,
            taxFullAddress: orders.taxFullAddress,
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
            middleName: users.middleName,
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

        const sortedItems = sortOrderItemsPrimaryFirst(items);

        // 6. Calculate fee (accounting for discount)
        const subtotal = sortedItems.reduce(
          (sum, item) => sum + Number(item.price) * item.quantity, 0
        );
        const receiptDiscount = Number(order.discountAmount || 0);
        const receiptNetAmount = subtotal - receiptDiscount;
        const total = Number(order.totalAmount);
        const fee = Math.round((total - receiptNetAmount) * 100) / 100;

        // Get event name from registrations
        const [reg] = await db
          .select({ eventId: registrations.eventId })
          .from(registrations)
          .where(eq(registrations.orderId, order.id))
          .limit(1);

        const [event] = reg
          ? await db.select({ eventName: events.eventName }).from(events).where(eq(events.id, reg.eventId)).limit(1)
          : [];

        // 7. Generate PDF
        const pdfStream = await generateReceiptPdf({
          orderNumber: order.orderNumber,
          paidAt: payment?.paidAt || new Date(),
          paymentChannel: (payment?.paymentChannel === "promptpay" ? "promptpay" : "card") as "promptpay" | "card",
          currency: order.currency,
          eventName: event?.eventName || undefined,
          items: sortedItems.map((i) => ({
            name: i.name,
            type: i.type as "ticket" | "addon",
            price: Number(i.price),
            quantity: i.quantity,
          })),
          subtotal,
          discount: receiptDiscount,
          promoCode: order.promoCode,
          fee: fee > 0 ? fee : 0,
          total,
          customerName: getFullName(user.firstName, user.middleName, user.lastName),
          customerEmail: user.email,
          taxInvoice: order.needTaxInvoice
            ? {
              taxName: order.taxName,
              taxId: order.taxId,
              taxFullAddress: order.taxFullAddress,
            }
            : undefined,
        });

        // 8. Stream PDF response
        const filename = `ACCP2026-receipt-${order.orderNumber}.pdf`;
        reply.header("Content-Type", "application/pdf");
        reply.header("Content-Disposition", `attachment; filename="${filename}"`);
        // Always regenerate latest version (avoid stale cached PDF after template updates)
        reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        reply.header("Pragma", "no-cache");
        reply.header("Expires", "0");

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
