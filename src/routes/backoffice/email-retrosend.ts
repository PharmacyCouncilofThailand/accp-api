import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  users,
  orders,
  orderItems,
  payments,
  ticketTypes,
  registrations,
  abstracts,
  abstractCoAuthors,
} from "../../database/schema.js";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import {
  sendSignupNotificationEmail,
  sendPendingApprovalEmail,
  sendPaymentReceiptEmail,
  sendAbstractSubmissionEmail,
  sendAbstractAcceptedPosterEmail,
  sendAbstractAcceptedOralEmail,
  sendAbstractRejectedEmail,
  sendCoAuthorNotificationEmail,
  buildSignupNotificationEmailContent,
  buildPendingApprovalEmailContent,
  buildAbstractSubmissionEmailContent,
  buildAbstractAcceptedPosterEmailContent,
  buildAbstractAcceptedOralEmailContent,
  buildAbstractRejectedEmailContent,
  buildPaymentReceiptEmailContent,
} from "../../services/emailService.js";
import { generateReceiptToken } from "../../utils/receiptToken.js";
import { getFullName } from "../../utils/name.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type RetrosendType =
  | "payment"
  | "signup"
  | "abstract-submission"
  | "abstract-status";

export interface EmailPreviewField {
  label: string;
  value: string;
}

export interface RetrosendResult {
  id: number | string;
  email: string;
  name: string;
  type: string;
  status: "sent" | "skipped" | "failed" | "pending";
  reason?: string;
  preview?: {
    subject: string;
    fields: EmailPreviewField[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getPublicApiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL || "http://localhost:3002")
    .trim()
    .replace(/\/$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function sortOrderItemsPrimaryFirst<T extends { type: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.type === "ticket" && b.type !== "ticket") return -1;
    if (a.type !== "ticket" && b.type === "ticket") return 1;
    return 0;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Core logic functions (shared between preview and send)
// ─────────────────────────────────────────────────────────────────────────────

async function buildPaymentResults(
  orderIds: number[],
  dryRun: boolean,
): Promise<RetrosendResult[]> {
  const results: RetrosendResult[] = [];

  for (const orderId of orderIds) {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) {
      results.push({ id: orderId, email: "—", name: "—", type: "payment-receipt", status: "skipped", reason: `Order #${orderId} not found` });
      continue;
    }

    if (order.status !== "paid") {
      results.push({ id: orderId, email: "—", name: "—", type: "payment-receipt", status: "skipped", reason: `Order status is "${order.status}" (not paid)` });
      continue;
    }

    const [user] = await db
      .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, order.userId))
      .limit(1);

    if (!user) {
      results.push({ id: orderId, email: "—", name: "—", type: "payment-receipt", status: "skipped", reason: "User not found" });
      continue;
    }

    // Always fetch details for preview (used in dryRun and shown after send)
    const previewItems = await db
      .select({ name: ticketTypes.name, type: orderItems.itemType, price: orderItems.price, quantity: orderItems.quantity })
      .from(orderItems)
      .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
      .where(eq(orderItems.orderId, orderId));

    const [previewPayment] = await db
      .select({ paidAt: payments.paidAt, paymentChannel: payments.paymentChannel })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
      .limit(1);

    const [previewReg] = await db
      .select({ regCode: registrations.regCode })
      .from(registrations)
      .where(eq(registrations.orderId, orderId))
      .limit(1);

    const sortedPreviewItems = sortOrderItemsPrimaryFirst(previewItems);
    const previewSubtotal = sortedPreviewItems.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
    const previewDiscount = Number(order.discountAmount || 0);
    const previewTotal = Number(order.totalAmount);
    const previewFee = Math.round((previewTotal - (previewSubtotal - previewDiscount)) * 100) / 100;

    const emailPreview = {
      subject: `Payment Receipt - ${order.orderNumber} | 25th ACCP 2026`,
      fields: [
        { label: "ชื่อผู้รับ", value: getFullName(user.firstName, user.middleName, user.lastName) },
        { label: "Email", value: user.email },
        { label: "Order Number", value: order.orderNumber ?? `#${orderId}` },
        { label: "สินค้า", value: sortedPreviewItems.map((i) => `${i.name} × ${i.quantity} (${Number(i.price).toLocaleString()} THB)`).join("\n") },
        { label: "Subtotal", value: `${previewSubtotal.toLocaleString()} THB` },
        ...(previewFee > 0 ? [{ label: "Fee", value: `${previewFee.toLocaleString()} THB` }] : []),
        ...(previewDiscount > 0 ? [{ label: "Discount", value: `-${previewDiscount.toLocaleString()} THB` }] : []),
        { label: "Total", value: `${previewTotal.toLocaleString()} ${order.currency ?? "THB"}` },
        { label: "Payment Method", value: previewPayment?.paymentChannel ?? "—" },
        { label: "Paid At", value: previewPayment?.paidAt ? new Date(previewPayment.paidAt).toLocaleString("th-TH") : "—" },
        { label: "Reg Code", value: previewReg?.regCode ?? "—" },
      ] as EmailPreviewField[],
    };

    if (dryRun) {
      results.push({ id: orderId, email: user.email, name: getFullName(user.firstName, user.middleName, user.lastName), type: "payment-receipt", status: "pending", reason: `Order ${order.orderNumber}`, preview: emailPreview });
      continue;
    }

    try {
      const [payment] = await db
        .select({ paidAt: payments.paidAt, paymentChannel: payments.paymentChannel })
        .from(payments)
        .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
        .limit(1);

      const emailItems = await db
        .select({ name: ticketTypes.name, type: orderItems.itemType, price: orderItems.price, quantity: orderItems.quantity })
        .from(orderItems)
        .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
        .where(eq(orderItems.orderId, orderId));

      const [registration] = await db
        .select({ regCode: registrations.regCode })
        .from(registrations)
        .where(eq(registrations.orderId, orderId))
        .limit(1);

      const sortedItems = sortOrderItemsPrimaryFirst(emailItems);
      const emailSubtotal = sortedItems.reduce((sum, i) => sum + Number(i.price) * i.quantity, 0);
      const emailDiscount = Number(order.discountAmount || 0);
      const emailNetAmount = emailSubtotal - emailDiscount;
      const emailTotal = Number(order.totalAmount);
      const emailFee = Math.round((emailTotal - emailNetAmount) * 100) / 100;

      const receiptToken = generateReceiptToken(orderId);
      const receiptDownloadUrl = `${getPublicApiBaseUrl()}/api/payments/receipt/${receiptToken}`;

      await sendPaymentReceiptEmail(
        user.email,
        user.firstName,
        user.middleName,
        user.lastName,
        order.orderNumber,
        payment?.paidAt ?? new Date(),
        payment?.paymentChannel ?? "card",
        sortedItems.map((i) => ({ name: i.name, type: i.type, price: Number(i.price) })),
        emailSubtotal,
        emailFee,
        emailTotal,
        order.currency,
        receiptDownloadUrl,
        order.needTaxInvoice ? { taxName: order.taxName, taxId: order.taxId, taxFullAddress: order.taxFullAddress } : undefined,
        registration?.regCode,
      );

      results.push({ id: orderId, email: user.email, name: getFullName(user.firstName, user.middleName, user.lastName), type: "payment-receipt", status: "sent", reason: `Order ${order.orderNumber}` });
    } catch (err) {
      results.push({ id: orderId, email: user.email, name: getFullName(user.firstName, user.middleName, user.lastName), type: "payment-receipt", status: "failed", reason: String(err) });
    }
  }

  return results;
}

async function buildSignupResults(
  fromDate: Date,
  toDate: Date,
  dryRun: boolean,
  filterUserIds?: number[],
): Promise<RetrosendResult[]> {
  const results: RetrosendResult[] = [];

  const windowUsers = await db
    .select({ id: users.id, email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName, role: users.role, status: users.status })
    .from(users)
    .where(filterUserIds && filterUserIds.length > 0
      ? inArray(users.id, filterUserIds)
      : and(gte(users.createdAt, fromDate), lte(users.createdAt, toDate)));

  for (const u of windowUsers) {
    const isAutoApproved = ["thpro", "interpro", "general"].includes(u.role);
    const emailType = (isAutoApproved || u.status === "active") ? "signup-notification" : "pending-approval";

    if (u.status !== "active" && u.status !== "pending_approval") {
      results.push({ id: u.id, email: u.email, name: getFullName(u.firstName, u.middleName, u.lastName), type: emailType, status: "skipped", reason: `Unexpected status: ${u.status}` });
      continue;
    }

    const signupPreview = {
      subject: emailType === "signup-notification"
        ? "Welcome to 25th ACCP Annual Conference 2026"
        : "Your Registration is Pending Approval",
      fields: [
        { label: "ชื่อผู้รับ", value: getFullName(u.firstName, u.middleName, u.lastName) },
        { label: "Email", value: u.email },
        { label: "Role", value: u.role },
        { label: "Account Status", value: u.status },
        { label: "Email Type", value: emailType === "signup-notification" ? "Signup Welcome" : "Pending Approval (manual review needed)" },
      ] as EmailPreviewField[],
    };

    if (dryRun) {
      results.push({ id: u.id, email: u.email, name: getFullName(u.firstName, u.middleName, u.lastName), type: emailType, status: "pending", preview: signupPreview });
      continue;
    }

    try {
      if (emailType === "signup-notification") {
        await sendSignupNotificationEmail(u.email, u.firstName, u.middleName ?? null, u.lastName);
      } else {
        await sendPendingApprovalEmail(u.email, u.firstName, u.middleName ?? null, u.lastName);
      }
      results.push({ id: u.id, email: u.email, name: getFullName(u.firstName, u.middleName, u.lastName), type: emailType, status: "sent" });
    } catch (err) {
      results.push({ id: u.id, email: u.email, name: getFullName(u.firstName, u.middleName, u.lastName), type: emailType, status: "failed", reason: String(err) });
    }
  }

  return results;
}

async function buildAbstractSubmissionResults(
  fromDate: Date,
  toDate: Date,
  dryRun: boolean,
  filterAbstractIds?: number[],
): Promise<RetrosendResult[]> {
  const results: RetrosendResult[] = [];

  const windowAbstracts = await db
    .select({ id: abstracts.id, trackingId: abstracts.trackingId, title: abstracts.title, userId: abstracts.userId })
    .from(abstracts)
    .where(filterAbstractIds && filterAbstractIds.length > 0
      ? inArray(abstracts.id, filterAbstractIds)
      : and(gte(abstracts.createdAt, fromDate), lte(abstracts.createdAt, toDate)));

  for (const ab of windowAbstracts) {
    if (!ab.userId) {
      results.push({ id: ab.id, email: "—", name: "—", type: "abstract-submission", status: "skipped", reason: "No linked user" });
      continue;
    }

    const [author] = await db
      .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, ab.userId))
      .limit(1);

    if (!author) {
      results.push({ id: ab.id, email: "—", name: "—", type: "abstract-submission", status: "skipped", reason: "Author not found" });
      continue;
    }

    const coAuthorsPreview = await db
      .select({ firstName: abstractCoAuthors.firstName, middleName: abstractCoAuthors.middleName, lastName: abstractCoAuthors.lastName, email: abstractCoAuthors.email })
      .from(abstractCoAuthors)
      .where(eq(abstractCoAuthors.abstractId, ab.id));

    const submissionPreview = {
      subject: `Abstract Submission Confirmed - ${ab.trackingId} | 25th ACCP 2026`,
      fields: [
        { label: "ชื่อผู้รับ", value: `${author.firstName} ${author.lastName}` },
        { label: "Email", value: author.email },
        { label: "Tracking ID", value: ab.trackingId ?? "—" },
        { label: "Title", value: ab.title },
        { label: "Co-authors", value: coAuthorsPreview.length > 0 ? coAuthorsPreview.map((c) => `${getFullName(c.firstName, c.middleName, c.lastName)} <${c.email}>`).join("\n") : "—" },
      ] as EmailPreviewField[],
    };

    if (dryRun) {
      results.push({ id: ab.id, email: author.email, name: `${author.firstName} ${author.lastName}`, type: "abstract-submission", status: "pending", reason: `TrackingID: ${ab.trackingId}`, preview: submissionPreview });
      continue;
    }

    try {
      await sendAbstractSubmissionEmail(author.email, author.firstName, author.lastName, ab.trackingId ?? "N/A", ab.title);

      const coAuthors = await db.select().from(abstractCoAuthors).where(eq(abstractCoAuthors.abstractId, ab.id));
      for (const co of coAuthors) {
        await sendCoAuthorNotificationEmail(
          co.email,
          co.firstName,
          co.middleName ?? null,
          co.lastName,
          getFullName(author.firstName, null, author.lastName),
          ab.trackingId ?? "N/A",
          ab.title,
        );
      }

      results.push({ id: ab.id, email: author.email, name: `${author.firstName} ${author.lastName}`, type: "abstract-submission", status: "sent", reason: `TrackingID: ${ab.trackingId}` });
    } catch (err) {
      results.push({ id: ab.id, email: author.email, name: `${author.firstName} ${author.lastName}`, type: "abstract-submission", status: "failed", reason: String(err) });
    }
  }

  return results;
}

async function buildAbstractStatusResults(
  abstractIds: number[],
  dryRun: boolean,
): Promise<RetrosendResult[]> {
  const results: RetrosendResult[] = [];

  const rows = await db
    .select({ id: abstracts.id, trackingId: abstracts.trackingId, title: abstracts.title, status: abstracts.status, presentationType: abstracts.presentationType, userId: abstracts.userId })
    .from(abstracts)
    .where(inArray(abstracts.id, abstractIds));

  for (const ab of rows) {
    if (!ab.userId) {
      results.push({ id: ab.id, email: "—", name: "—", type: `abstract-${ab.status}`, status: "skipped", reason: "No linked user" });
      continue;
    }

    const [author] = await db
      .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, ab.userId))
      .limit(1);

    if (!author) {
      results.push({ id: ab.id, email: "—", name: "—", type: `abstract-${ab.status}`, status: "skipped", reason: "Author not found" });
      continue;
    }

    const emailType = ab.status === "accepted"
      ? ab.presentationType === "oral" ? "abstract-accepted-oral" : "abstract-accepted-poster"
      : "abstract-rejected";

    if (ab.status !== "accepted" && ab.status !== "rejected") {
      results.push({ id: ab.id, email: author.email, name: getFullName(author.firstName, author.middleName, author.lastName), type: emailType, status: "skipped", reason: `Status is "${ab.status}", expected accepted or rejected` });
      continue;
    }

    const statusPreview = {
      subject: emailType === "abstract-rejected"
        ? `Abstract Decision - ${ab.trackingId} | 25th ACCP 2026`
        : `Abstract Accepted - ${ab.trackingId} | 25th ACCP 2026`,
      fields: [
        { label: "ชื่อผู้รับ", value: getFullName(author.firstName, author.middleName, author.lastName) },
        { label: "Email", value: author.email },
        { label: "Tracking ID", value: ab.trackingId ?? "—" },
        { label: "Title", value: ab.title },
        { label: "สถานะ", value: ab.status },
        { label: "Presentation Type", value: ab.presentationType ?? "—" },
        { label: "Email Type", value: emailType },
      ] as EmailPreviewField[],
    };

    if (dryRun) {
      results.push({ id: ab.id, email: author.email, name: getFullName(author.firstName, author.middleName, author.lastName), type: emailType, status: "pending", reason: `TrackingID: ${ab.trackingId}`, preview: statusPreview });
      continue;
    }

    try {
      if (ab.status === "accepted") {
        if (ab.presentationType === "poster") {
          await sendAbstractAcceptedPosterEmail(author.email, author.firstName, author.middleName ?? null, author.lastName, ab.title);
        } else {
          await sendAbstractAcceptedOralEmail(author.email, author.firstName, author.middleName ?? null, author.lastName, ab.title);
        }
      } else {
        await sendAbstractRejectedEmail(author.email, author.firstName, author.middleName ?? null, author.lastName, ab.title);
      }
      results.push({ id: ab.id, email: author.email, name: getFullName(author.firstName, author.middleName, author.lastName), type: emailType, status: "sent", reason: `TrackingID: ${ab.trackingId}` });
    } catch (err) {
      results.push({ id: ab.id, email: author.email, name: getFullName(author.firstName, author.middleName, author.lastName), type: emailType, status: "failed", reason: String(err) });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

export default async function (fastify: FastifyInstance) {
  /**
   * POST /api/backoffice/email-retrosend
   *
   * Body:
   *   type: "payment" | "signup" | "abstract-submission" | "abstract-status"
   *   dryRun: boolean
   *   orderIds?: number[]          (for type=payment)
   *   fromDate?: string            (ISO, for type=signup | abstract-submission)
   *   toDate?: string              (ISO, for type=signup | abstract-submission)
   *   abstractIds?: number[]       (for type=abstract-status)
   */
  fastify.post("", async (request, reply) => {
    const body = request.body as {
      type: RetrosendType;
      dryRun?: boolean;
      orderIds?: number[];
      fromDate?: string;
      toDate?: string;
      abstractIds?: number[];
      userIds?: number[];
    };

    const { type, dryRun = true } = body;


    if (!["payment", "signup", "abstract-submission", "abstract-status"].includes(type)) {
      return reply.status(400).send({ success: false, error: "Invalid type. Must be: payment | signup | abstract-submission | abstract-status" });
    }

    let results: RetrosendResult[] = [];

    try {
      if (type === "payment") {
        const orderIds = body.orderIds ?? [207, 208, 213, 214, 219, 222];
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
          return reply.status(400).send({ success: false, error: "orderIds must be a non-empty array" });
        }
        results = await buildPaymentResults(orderIds, dryRun);

      } else if (type === "signup") {
        const from = body.fromDate ? new Date(body.fromDate) : new Date("2026-04-22T12:38:00Z");
        const to = body.toDate ? new Date(body.toDate) : new Date("2026-04-23T06:34:00Z");
        // If userIds provided, only send to those specific users (selective send)
        results = await buildSignupResults(from, to, dryRun, body.userIds);

      } else if (type === "abstract-submission") {
        const from = body.fromDate ? new Date(body.fromDate) : new Date("2026-04-22T12:38:00Z");
        const to = body.toDate ? new Date(body.toDate) : new Date("2026-04-23T06:34:00Z");
        // If abstractIds provided, only send to those specific abstracts (selective send)
        results = await buildAbstractSubmissionResults(from, to, dryRun, body.abstractIds);

      } else if (type === "abstract-status") {
        const abstractIds = body.abstractIds ?? [];
        if (!Array.isArray(abstractIds) || abstractIds.length === 0) {
          return reply.status(400).send({ success: false, error: "abstractIds must be a non-empty array" });
        }
        results = await buildAbstractStatusResults(abstractIds, dryRun);
      }

      const summary = {
        sent: results.filter((r) => r.status === "sent").length,
        pending: results.filter((r) => r.status === "pending").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length,
      };

      return reply.send({ success: true, dryRun, type, results, summary });
    } catch (err) {
      fastify.log.error(err, "email-retrosend error");
      return reply.status(500).send({ success: false, error: "Internal error during retrosend" });
    }
  });

  /**
   * GET /api/backoffice/email-retrosend/render?type=payment&id=207
   * Returns rendered email HTML for preview (does NOT send any email)
   */
  fastify.get("/render", async (request, reply) => {
    const { type, id } = request.query as { type: string; id: string };
    const numId = parseInt(id);

    if (!type || !id || isNaN(numId)) {
      return reply.status(400).send({ success: false, error: "type and id are required" });
    }

    try {
      if (type === "payment" || type === "payment-receipt") {
        const [order] = await db.select().from(orders).where(eq(orders.id, numId)).limit(1);
        if (!order) return reply.status(404).send({ success: false, error: "Order not found" });

        const [user] = await db.select().from(users).where(eq(users.id, order.userId)).limit(1);
        if (!user) return reply.status(404).send({ success: false, error: "User not found" });

        const emailItems = await db
          .select({ name: ticketTypes.name, type: orderItems.itemType, price: orderItems.price, quantity: orderItems.quantity })
          .from(orderItems).innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
          .where(eq(orderItems.orderId, numId));

        const [payment] = await db
          .select({ paidAt: payments.paidAt, paymentChannel: payments.paymentChannel })
          .from(payments).where(and(eq(payments.orderId, numId), eq(payments.status, "paid"))).limit(1);

        const [reg] = await db
          .select({ regCode: registrations.regCode })
          .from(registrations).where(eq(registrations.orderId, numId)).limit(1);

        const sorted = sortOrderItemsPrimaryFirst(emailItems);
        const subtotal = sorted.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
        const discount = Number(order.discountAmount || 0);
        const total = Number(order.totalAmount);
        const fee = Math.round((total - (subtotal - discount)) * 100) / 100;
        const receiptToken = generateReceiptToken(numId);
        const receiptDownloadUrl = `${getPublicApiBaseUrl()}/api/payments/receipt/${receiptToken}`;

        const content = buildPaymentReceiptEmailContent(
          user.firstName, user.middleName, user.lastName,
          order.orderNumber, payment?.paidAt ?? new Date(), payment?.paymentChannel ?? "card",
          sorted.map((i) => ({ name: i.name, type: i.type, price: Number(i.price) })),
          subtotal, fee, total, order.currency ?? "THB", receiptDownloadUrl,
          order.needTaxInvoice ? { taxName: order.taxName, taxId: order.taxId, taxFullAddress: order.taxFullAddress } : undefined,
          reg?.regCode,
        );
        return reply.send({ success: true, to: user.email, ...content });

      } else if (type === "signup" || type === "signup-notification" || type === "pending-approval") {
        const [user] = await db
          .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName, role: users.role, status: users.status })
          .from(users).where(eq(users.id, numId)).limit(1);
        if (!user) return reply.status(404).send({ success: false, error: "User not found" });

        const isAutoApproved = ["thpro", "interpro", "general"].includes(user.role);
        const emailType = (isAutoApproved || user.status === "active") ? "signup-notification" : "pending-approval";
        const content = emailType === "signup-notification"
          ? buildSignupNotificationEmailContent(user.firstName, user.middleName, user.lastName)
          : buildPendingApprovalEmailContent(user.firstName, user.middleName, user.lastName);
        return reply.send({ success: true, to: user.email, ...content });

      } else if (type === "abstract-submission") {
        const [ab] = await db
          .select({ id: abstracts.id, trackingId: abstracts.trackingId, title: abstracts.title, userId: abstracts.userId })
          .from(abstracts).where(eq(abstracts.id, numId)).limit(1);
        if (!ab) return reply.status(404).send({ success: false, error: "Abstract not found" });

        const [author] = await db
          .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
          .from(users).where(eq(users.id, ab.userId!)).limit(1);
        if (!author) return reply.status(404).send({ success: false, error: "Author not found" });

        const content = buildAbstractSubmissionEmailContent(author.firstName, author.lastName, ab.trackingId ?? "N/A", ab.title);
        return reply.send({ success: true, to: author.email, ...content });

      } else if (type === "abstract-status" || type.startsWith("abstract-accepted") || type === "abstract-rejected") {
        const [ab] = await db
          .select({ id: abstracts.id, trackingId: abstracts.trackingId, title: abstracts.title, status: abstracts.status, presentationType: abstracts.presentationType, userId: abstracts.userId })
          .from(abstracts).where(eq(abstracts.id, numId)).limit(1);
        if (!ab) return reply.status(404).send({ success: false, error: "Abstract not found" });

        const [author] = await db
          .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
          .from(users).where(eq(users.id, ab.userId!)).limit(1);
        if (!author) return reply.status(404).send({ success: false, error: "Author not found" });

        let content: { subject: string; html: string };
        if (ab.status === "accepted" && ab.presentationType === "oral") {
          content = buildAbstractAcceptedOralEmailContent(author.firstName, author.middleName, author.lastName, ab.title);
        } else if (ab.status === "accepted") {
          content = buildAbstractAcceptedPosterEmailContent(author.firstName, author.middleName, author.lastName, ab.title);
        } else {
          content = buildAbstractRejectedEmailContent(author.firstName, author.middleName, author.lastName, ab.title);
        }
        return reply.send({ success: true, to: author.email, ...content });

      } else {
        return reply.status(400).send({ success: false, error: `Unknown type: ${type}` });
      }
    } catch (err) {
      fastify.log.error(err, "email-retrosend render error");
      return reply.status(500).send({ success: false, error: "Internal error during render" });
    }
  });
}
