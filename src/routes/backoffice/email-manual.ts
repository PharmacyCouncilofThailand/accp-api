import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  users,
  orders,
  orderItems,
  payments,
  ticketTypes,
  registrations,
  registrationSessions,
  sessions,
  events,
  abstracts,
} from "../../database/schema.js";
import { eq, and, ilike, or, inArray, desc } from "drizzle-orm";
import {
  sendSignupNotificationEmail,
  sendPendingApprovalEmail,
  sendPaymentReceiptEmail,
  sendAbstractSubmissionEmail,
  sendAbstractAcceptedPosterEmail,
  sendAbstractAcceptedOralEmail,
  sendAbstractRejectedEmail,
  sendManualRegistrationEmail,
  sendApprovalRequestEmail,
  sendAcademicAcceptanceEmail,
  buildSignupNotificationEmailContent,
  buildPendingApprovalEmailContent,
  buildPaymentReceiptEmailContent,
  buildAbstractSubmissionEmailContent,
  buildAbstractAcceptedPosterEmailContent,
  buildAbstractAcceptedOralEmailContent,
  buildAbstractRejectedEmailContent,
  buildApprovalRequestEmailContent,
  buildAcademicAcceptanceEmailContent,
  buildEmailHtmlFromText,
} from "../../services/emailService.js";
import { generateReceiptToken } from "../../utils/receiptToken.js";
import { getFullName } from "../../utils/name.js";
import { buildInvitationLetterPdfForOrder } from "../../services/invitationLetterBuilder.js";
import {
  renderAbstractAcceptPdf,
  buildParticipantName,
  formatIssueDate,
  titleCasePresentationType,
} from "../../services/letter.service.js";

// ─────────────────────────────────────────────────────────────────────────────
// Template configuration
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE_CONFIG = {
  "signup-notification": {
    label: "Signup Notification",
    recipientType: "user" as const,
    requiresComment: false,
    description: "Welcome email for confirmed / active users",
  },
  "pending-approval": {
    label: "Pending Approval",
    recipientType: "user" as const,
    requiresComment: false,
    description: "Document verification pending notification",
  },
  "payment-receipt": {
    label: "Payment Receipt",
    recipientType: "order" as const,
    requiresComment: false,
    description: "Payment receipt with order summary and QR code",
  },
  "abstract-submission": {
    label: "Abstract Submission Received",
    recipientType: "abstract" as const,
    requiresComment: false,
    description: "Abstract received confirmation email",
  },
  "abstract-accepted-poster": {
    label: "Abstract Accepted (Poster)",
    recipientType: "abstract" as const,
    requiresComment: true,
    description: "Congratulations — accepted as poster presentation",
  },
  "abstract-accepted-oral": {
    label: "Abstract Accepted (Oral)",
    recipientType: "abstract" as const,
    requiresComment: true,
    description: "Congratulations — accepted as oral presentation",
  },
  "abstract-rejected": {
    label: "Abstract Rejected",
    recipientType: "abstract" as const,
    requiresComment: true,
    description: "Abstract not accepted notification",
  },
  "manual-registration": {
    label: "Registration Confirmation",
    recipientType: "registration" as const,
    requiresComment: false,
    description: "Registration confirmed with QR code for check-in",
  },
  "approval-request": {
    label: "Approval Request Letter",
    recipientType: "order" as const,
    requiresComment: false,
    description: "Approval letter for paid attendees (with invitation letter PDF)",
  },
  "academic-acceptance": {
    label: "Letter of Acceptance for Academic Paper",
    recipientType: "abstract" as const,
    requiresComment: false,
    description: "Acceptance letter for accepted abstracts (with type-specific letter PDF)",
  },
} as const;

type TemplateId = keyof typeof TEMPLATE_CONFIG;

export interface ManualEmailResult {
  id: number;
  email: string;
  name: string;
  type: string;
  status: "pending" | "sent" | "failed" | "skipped";
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper utilities
// ─────────────────────────────────────────────────────────────────────────────

function getPublicApiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL || "http://localhost:3002").trim().replace(/\/$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function sortPrimaryFirst<T extends { type: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.type === "ticket" && b.type !== "ticket") return -1;
    if (a.type !== "ticket" && b.type === "ticket") return 1;
    return 0;
  });
}

function buildManualRegistrationEmailContent(
  firstName: string,
  middleName: string | null,
  lastName: string,
  regCode: string,
  eventName: string,
  ticketName: string,
  regSessions: { sessionName: string; startTime: Date; endTime: Date }[],
): { subject: string; html: string } {
  const websiteUrl = process.env.WEBSITE_URL || process.env.NEXT_PUBLIC_WEBSITE_URL || "https://accp2026.com";
  const sessionLines =
    regSessions.length > 0
      ? regSessions
          .map((s) => {
            const date = s.startTime.toLocaleDateString("en-US", {
              month: "long", day: "numeric", year: "numeric", timeZone: "Asia/Bangkok",
            });
            const from = s.startTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
            const to = s.endTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
            return `  - ${s.sessionName} (${date}, ${from} - ${to})`;
          })
          .join("\n")
      : "  - (No sessions)";

  const plainText = [
    `Dear ${getFullName(firstName, middleName, lastName)},`,
    ``,
    `Your registration for the ${eventName} has been confirmed by the conference team.`,
    ``,
    `Registration Code: ${regCode}`,
    `Ticket: ${ticketName}`,
    ``,
    `Registered Sessions:`,
    sessionLines,
    ``,
    `Please present this registration code (or scan the QR code below) at the registration desk on the day of the event.`,
    ``,
    `For more information, visit ${websiteUrl}`,
    ``,
    `Sincerely,`,
    `The Conference Team`,
  ].join("\n");

  let html = buildEmailHtmlFromText(plainText);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(regCode)}`;
  const qrBlock = `<br><div style="text-align:center;margin:20px 0;"><img src="${qrUrl}" alt="QR: ${regCode}" width="200" height="200" style="display:block;margin:0 auto;" /><p style="font-size:13px;color:#6b7280;margin-top:8px;">Scan this QR code at the registration desk for fast check-in</p></div>`;
  html = html.replace(
    `Registration Code: ${regCode}`,
    `Registration Code: <strong>${regCode}</strong>${qrBlock}`,
  );

  return { subject: `Registration Confirmed - ${regCode} | ${eventName}`, html };
}

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

export default async function emailManualRoutes(fastify: FastifyInstance) {

  // GET /templates — list all templates with metadata
  fastify.get("/templates", async (_request, reply) => {
    return reply.send({
      success: true,
      templates: Object.entries(TEMPLATE_CONFIG).map(([id, cfg]) => ({ id, ...cfg })),
    });
  });

  // GET /search?type=user|order|registration|abstract&q=<search>
  fastify.get("/search", async (request, reply) => {
    const { type, q } = request.query as { type?: string; q?: string };
    const term = (q ?? "").trim();
    if (!type || term.length < 1) {
      return reply.status(400).send({ success: false, error: "type and q are required" });
    }

    try {
      if (type === "user") {
        const rows = await db
          .select({
            id: users.id, email: users.email,
            firstName: users.firstName, middleName: users.middleName, lastName: users.lastName,
            role: users.role, status: users.status,
          })
          .from(users)
          .where(or(
            ilike(users.email, `%${term}%`),
            ilike(users.firstName, `%${term}%`),
            ilike(users.lastName, `%${term}%`),
          ))
          .limit(20);

        return reply.send({
          success: true,
          results: rows.map((u) => ({
            id: u.id,
            label: getFullName(u.firstName, u.middleName, u.lastName),
            sublabel: u.email,
            tag: `${u.role} · ${u.status}`,
          })),
        });

      } else if (type === "order") {
        const rows = await db
          .select({
            id: orders.id, orderNumber: orders.orderNumber,
            status: orders.status, totalAmount: orders.totalAmount, currency: orders.currency,
            firstName: users.firstName, middleName: users.middleName, lastName: users.lastName, email: users.email,
          })
          .from(orders)
          .innerJoin(users, eq(orders.userId, users.id))
          .where(or(
            ilike(orders.orderNumber, `%${term}%`),
            ilike(users.email, `%${term}%`),
            ilike(users.firstName, `%${term}%`),
            ilike(users.lastName, `%${term}%`),
          ))
          .limit(20);

        return reply.send({
          success: true,
          results: rows.map((o) => ({
            id: o.id,
            label: o.orderNumber,
            sublabel: `${getFullName(o.firstName, o.middleName, o.lastName)} <${o.email}>`,
            tag: `${o.status} · ${Number(o.totalAmount).toLocaleString()} ${o.currency}`,
          })),
        });

      } else if (type === "registration") {
        const rows = await db
          .select({
            id: registrations.id, regCode: registrations.regCode,
            firstName: registrations.firstName, middleName: registrations.middleName, lastName: registrations.lastName,
            email: registrations.email, status: registrations.status,
          })
          .from(registrations)
          .where(or(
            ilike(registrations.regCode, `%${term}%`),
            ilike(registrations.email, `%${term}%`),
            ilike(registrations.firstName, `%${term}%`),
            ilike(registrations.lastName, `%${term}%`),
          ))
          .limit(20);

        return reply.send({
          success: true,
          results: rows.map((r) => ({
            id: r.id,
            label: r.regCode,
            sublabel: `${getFullName(r.firstName, r.middleName, r.lastName)} <${r.email}>`,
            tag: r.status,
          })),
        });

      } else if (type === "abstract") {
        const rows = await db
          .select({
            id: abstracts.id, trackingId: abstracts.trackingId,
            title: abstracts.title, status: abstracts.status, presentationType: abstracts.presentationType,
            firstName: users.firstName, middleName: users.middleName, lastName: users.lastName, email: users.email,
          })
          .from(abstracts)
          .leftJoin(users, eq(abstracts.userId, users.id))
          .where(or(
            ilike(abstracts.trackingId, `%${term}%`),
            ilike(abstracts.title, `%${term}%`),
            ilike(users.email, `%${term}%`),
            ilike(users.firstName, `%${term}%`),
            ilike(users.lastName, `%${term}%`),
          ))
          .limit(20);

        return reply.send({
          success: true,
          results: rows.map((a) => ({
            id: a.id,
            label: a.trackingId ?? `#${a.id}`,
            sublabel: a.title.length > 65 ? a.title.slice(0, 65) + "…" : a.title,
            tag: `${a.status} · ${a.presentationType}`,
            extra: a.email
              ? `${getFullName(a.firstName ?? "", a.middleName, a.lastName ?? "")} <${a.email}>`
              : undefined,
          })),
        });

      } else {
        return reply.status(400).send({ success: false, error: `Unknown search type: ${type}` });
      }
    } catch (err) {
      fastify.log.error(err, "email-manual search error");
      return reply.status(500).send({ success: false, error: "Search failed" });
    }
  });

  // GET /recipients?template=...&q=...
  // Returns all recipients pre-filtered for the given template (up to 500 rows)
  fastify.get("/recipients", async (request, reply) => {
    const { template, q } = request.query as { template?: string; q?: string };
    if (!template) return reply.status(400).send({ success: false, error: "template is required" });
    const cfg = TEMPLATE_CONFIG[template as TemplateId];
    if (!cfg) return reply.status(400).send({ success: false, error: `Unknown template: ${template}` });

    const search = (q ?? "").trim();
    const MAX = 500;

    try {
      type RecRow = { id: number; label: string; email: string; detail: string; tag: string };
      let recipients: RecRow[] = [];

      if (cfg.recipientType === "user") {
        const statusCond =
          template === "pending-approval"
            ? eq(users.status, "pending_approval" as any)
            : eq(users.status, "active" as any);

        const rows = await db
          .select({
            id: users.id, email: users.email,
            firstName: users.firstName, middleName: users.middleName, lastName: users.lastName,
            role: users.role, status: users.status,
          })
          .from(users)
          .where(and(statusCond, search ? or(
            ilike(users.email, `%${search}%`),
            ilike(users.firstName, `%${search}%`),
            ilike(users.lastName, `%${search}%`),
          ) : undefined))
          .limit(MAX);

        recipients = rows.map((u) => ({
          id: u.id,
          label: getFullName(u.firstName, u.middleName, u.lastName),
          email: u.email,
          detail: u.role as string,
          tag: u.status as string,
        }));

      } else if (cfg.recipientType === "order") {
        // approval-request — เฉพาะ order ที่มี primary ticket (itemType="ticket")
        // เพื่อกันการส่งซ้ำตอนลูกค้าซื้อ add-on เพิ่มภายหลัง
        const primaryTicketCond = template === "approval-request"
          ? inArray(
              orders.id,
              db
                .select({ id: orderItems.orderId })
                .from(orderItems)
                .where(eq(orderItems.itemType, "ticket" as any)),
            )
          : undefined;

        const rows = await db
          .select({
            id: orders.id, orderNumber: orders.orderNumber,
            totalAmount: orders.totalAmount, currency: orders.currency,
            firstName: users.firstName, middleName: users.middleName, lastName: users.lastName, email: users.email,
          })
          .from(orders)
          .innerJoin(users, eq(orders.userId, users.id))
          .where(and(
            eq(orders.status, "paid" as any),
            primaryTicketCond,
            search ? or(
              ilike(orders.orderNumber, `%${search}%`),
              ilike(users.email, `%${search}%`),
              ilike(users.firstName, `%${search}%`),
              ilike(users.lastName, `%${search}%`),
            ) : undefined,
          ))
          .limit(MAX);

        recipients = rows.map((o) => ({
          id: o.id,
          label: o.orderNumber,
          email: o.email,
          detail: getFullName(o.firstName, o.middleName, o.lastName),
          tag: `${Number(o.totalAmount).toLocaleString()} ${o.currency ?? "THB"}`,
        }));

      } else if (cfg.recipientType === "abstract") {
        let statusCond: ReturnType<typeof and> | ReturnType<typeof eq> | undefined;
        if (template === "abstract-accepted-poster") {
          statusCond = and(eq(abstracts.status, "accepted" as any), eq(abstracts.presentationType, "poster" as any));
        } else if (template === "abstract-accepted-oral") {
          statusCond = and(eq(abstracts.status, "accepted" as any), eq(abstracts.presentationType, "oral" as any));
        } else if (template === "abstract-rejected") {
          statusCond = eq(abstracts.status, "rejected" as any);
        } else if (template === "academic-acceptance") {
          statusCond = eq(abstracts.status, "accepted" as any);
        }
        // abstract-submission: no status filter — all abstracts

        const rows = await db
          .select({
            id: abstracts.id, trackingId: abstracts.trackingId,
            title: abstracts.title, status: abstracts.status, presentationType: abstracts.presentationType,
            firstName: users.firstName, middleName: users.middleName, lastName: users.lastName, email: users.email,
          })
          .from(abstracts)
          .leftJoin(users, eq(abstracts.userId, users.id))
          .where(and(statusCond, search ? or(
            ilike(abstracts.trackingId, `%${search}%`),
            ilike(abstracts.title, `%${search}%`),
            ilike(users.email, `%${search}%`),
            ilike(users.firstName, `%${search}%`),
          ) : undefined))
          .orderBy(desc(abstracts.updatedAt))
          .limit(MAX);

        recipients = rows.map((a) => ({
          id: a.id,
          label: a.trackingId ?? `#${a.id}`,
          email: a.email ?? "",
          detail: a.title.length > 70 ? a.title.slice(0, 70) + "…" : a.title,
          tag: `${a.status as string}${a.presentationType ? ` · ${a.presentationType as string}` : ""}`,
        }));

      } else if (cfg.recipientType === "registration") {
        const rows = await db
          .select({
            id: registrations.id, regCode: registrations.regCode,
            firstName: registrations.firstName, middleName: registrations.middleName, lastName: registrations.lastName,
            email: registrations.email, status: registrations.status,
          })
          .from(registrations)
          .where(search ? or(
            ilike(registrations.regCode, `%${search}%`),
            ilike(registrations.email, `%${search}%`),
            ilike(registrations.firstName, `%${search}%`),
            ilike(registrations.lastName, `%${search}%`),
          ) : undefined)
          .limit(MAX);

        recipients = rows.map((r) => ({
          id: r.id,
          label: r.regCode,
          email: r.email,
          detail: getFullName(r.firstName, r.middleName, r.lastName),
          tag: r.status as string,
        }));
      }

      return reply.send({ success: true, recipients, total: recipients.length });
    } catch (err) {
      fastify.log.error(err, "email-manual recipients error");
      return reply.status(500).send({ success: false, error: "Failed to load recipients" });
    }
  });

  // GET /render?template=...&id=...&comment=...
  fastify.get("/render", async (request, reply) => {
    const { template, id, comment } = request.query as { template?: string; id?: string; comment?: string };
    const numId = parseInt(id ?? "");
    if (!template || !id || isNaN(numId)) {
      return reply.status(400).send({ success: false, error: "template and id are required" });
    }

    const cfg = TEMPLATE_CONFIG[template as TemplateId];
    if (!cfg) return reply.status(400).send({ success: false, error: `Unknown template: ${template}` });

    try {
      if (template === "signup-notification" || template === "pending-approval") {
        const [user] = await db
          .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
          .from(users).where(eq(users.id, numId)).limit(1);
        if (!user) return reply.status(404).send({ success: false, error: "User not found" });

        const content = template === "signup-notification"
          ? buildSignupNotificationEmailContent(user.firstName, user.middleName, user.lastName)
          : buildPendingApprovalEmailContent(user.firstName, user.middleName, user.lastName);
        return reply.send({ success: true, to: user.email, ...content });

      } else if (template === "payment-receipt") {
        const [order] = await db.select().from(orders).where(eq(orders.id, numId)).limit(1);
        if (!order) return reply.status(404).send({ success: false, error: "Order not found" });
        const [user] = await db
          .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
          .from(users).where(eq(users.id, order.userId)).limit(1);
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

        const sorted = sortPrimaryFirst(emailItems);
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

      } else if (template === "approval-request") {
        const [order] = await db.select().from(orders).where(eq(orders.id, numId)).limit(1);
        if (!order) return reply.status(404).send({ success: false, error: "Order not found" });
        if (order.status !== "paid") {
          return reply.status(400).send({ success: false, error: "Approval letter is only available for paid orders" });
        }
        const [user] = await db
          .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
          .from(users).where(eq(users.id, order.userId)).limit(1);
        if (!user) return reply.status(404).send({ success: false, error: "User not found" });

        const content = buildApprovalRequestEmailContent(user.firstName, user.middleName, user.lastName);
        return reply.send({
          success: true,
          to: user.email,
          ...content,
          attachment: {
            fileName: `ACCP2026-Invitation-${order.orderNumber || numId}.pdf`,
            downloadUrl: `${getPublicApiBaseUrl()}/api/backoffice/orders/${numId}/invitation-letter.pdf`,
          },
        });

      } else if (template === "academic-acceptance") {
        const [ab] = await db
          .select({
            trackingId: abstracts.trackingId,
            title: abstracts.title,
            userId: abstracts.userId,
            status: abstracts.status,
            presentationType: abstracts.presentationType,
          })
          .from(abstracts).where(eq(abstracts.id, numId)).limit(1);
        if (!ab) return reply.status(404).send({ success: false, error: "Abstract not found" });
        if (ab.status !== "accepted") {
          return reply.status(400).send({ success: false, error: "Acceptance letter is only available for accepted abstracts" });
        }
        if (!ab.userId) return reply.status(400).send({ success: false, error: "Abstract has no author" });
        const [author] = await db
          .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
          .from(users).where(eq(users.id, ab.userId)).limit(1);
        if (!author) return reply.status(404).send({ success: false, error: "Author not found" });

        const content = buildAcademicAcceptanceEmailContent(author.firstName, author.middleName, author.lastName, ab.presentationType);
        return reply.send({
          success: true,
          to: author.email,
          ...content,
          attachment: {
            fileName: `ACCP2026-Accept-${ab.trackingId || numId}.pdf`,
            downloadUrl: `${getPublicApiBaseUrl()}/api/backoffice/abstracts/${numId}/accept-letter.pdf`,
          },
        });

      } else if (template === "abstract-submission") {
        const [ab] = await db
          .select({ trackingId: abstracts.trackingId, title: abstracts.title, userId: abstracts.userId })
          .from(abstracts).where(eq(abstracts.id, numId)).limit(1);
        if (!ab) return reply.status(404).send({ success: false, error: "Abstract not found" });
        if (!ab.userId) return reply.status(400).send({ success: false, error: "Abstract has no author" });
        const [author] = await db
          .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
          .from(users).where(eq(users.id, ab.userId)).limit(1);
        if (!author) return reply.status(404).send({ success: false, error: "Author not found" });

        const content = buildAbstractSubmissionEmailContent(author.firstName, author.lastName, ab.trackingId ?? "N/A", ab.title);
        return reply.send({ success: true, to: author.email, ...content });

      } else if (
        template === "abstract-accepted-poster" ||
        template === "abstract-accepted-oral" ||
        template === "abstract-rejected"
      ) {
        const [ab] = await db
          .select({ trackingId: abstracts.trackingId, title: abstracts.title, userId: abstracts.userId })
          .from(abstracts).where(eq(abstracts.id, numId)).limit(1);
        if (!ab) return reply.status(404).send({ success: false, error: "Abstract not found" });
        if (!ab.userId) return reply.status(400).send({ success: false, error: "Abstract has no author" });
        const [author] = await db
          .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
          .from(users).where(eq(users.id, ab.userId)).limit(1);
        if (!author) return reply.status(404).send({ success: false, error: "Author not found" });

        let content: { subject: string; html: string };
        if (template === "abstract-accepted-poster") {
          content = buildAbstractAcceptedPosterEmailContent(author.firstName, author.middleName, author.lastName, ab.title, comment);
        } else if (template === "abstract-accepted-oral") {
          content = buildAbstractAcceptedOralEmailContent(author.firstName, author.middleName, author.lastName, ab.title, comment);
        } else {
          content = buildAbstractRejectedEmailContent(author.firstName, author.middleName, author.lastName, ab.title, comment);
        }
        return reply.send({ success: true, to: author.email, ...content });

      } else if (template === "manual-registration") {
        const [reg] = await db
          .select({
            regCode: registrations.regCode,
            firstName: registrations.firstName, middleName: registrations.middleName, lastName: registrations.lastName,
            email: registrations.email, ticketTypeId: registrations.ticketTypeId, eventId: registrations.eventId,
          })
          .from(registrations).where(eq(registrations.id, numId)).limit(1);
        if (!reg) return reply.status(404).send({ success: false, error: "Registration not found" });

        const [ticket] = await db.select({ name: ticketTypes.name }).from(ticketTypes).where(eq(ticketTypes.id, reg.ticketTypeId)).limit(1);
        const [event] = await db.select({ eventName: events.eventName }).from(events).where(eq(events.id, reg.eventId)).limit(1);
        const regSessionRows = await db
          .select({ sessionName: sessions.sessionName, startTime: sessions.startTime, endTime: sessions.endTime })
          .from(registrationSessions)
          .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
          .where(eq(registrationSessions.registrationId, numId));

        const content = buildManualRegistrationEmailContent(
          reg.firstName, reg.middleName, reg.lastName, reg.regCode,
          event?.eventName ?? "Conference", ticket?.name ?? "Ticket",
          regSessionRows.map((s) => ({ sessionName: s.sessionName, startTime: s.startTime, endTime: s.endTime })),
        );
        return reply.send({ success: true, to: reg.email, ...content });

      } else {
        return reply.status(400).send({ success: false, error: `Unknown template: ${template}` });
      }
    } catch (err) {
      fastify.log.error(err, "email-manual render error");
      return reply.status(500).send({ success: false, error: "Render failed" });
    }
  });

  // POST / — { template, recipientIds, dryRun, comment? }
  fastify.post("/", async (request, reply) => {
    const body = request.body as {
      template: string;
      recipientIds: number[];
      dryRun: boolean;
      comment?: string;
    };

    const { template, recipientIds, dryRun, comment } = body;

    if (!template || !Array.isArray(recipientIds) || recipientIds.length === 0) {
      return reply.status(400).send({ success: false, error: "template and recipientIds are required" });
    }

    const cfg = TEMPLATE_CONFIG[template as TemplateId];
    if (!cfg) return reply.status(400).send({ success: false, error: `Unknown template: ${template}` });

    const uniqueIds = [...new Set(recipientIds.map(Number))];
    const results: ManualEmailResult[] = [];

    try {
      for (const id of uniqueIds) {

        // ── User-based templates ─────────────────────────────────────────────
        if (cfg.recipientType === "user") {
          const [user] = await db
            .select({ id: users.id, email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
            .from(users).where(eq(users.id, id)).limit(1);

          if (!user) {
            results.push({ id, email: "—", name: "—", type: template, status: "skipped", reason: `User #${id} not found` });
            continue;
          }

          const fullName = getFullName(user.firstName, user.middleName, user.lastName);

          if (dryRun) {
            results.push({ id: user.id, email: user.email, name: fullName, type: template, status: "pending" });
            continue;
          }

          try {
            if (template === "signup-notification") {
              await sendSignupNotificationEmail(user.email, user.firstName, user.middleName, user.lastName);
            } else {
              await sendPendingApprovalEmail(user.email, user.firstName, user.middleName, user.lastName);
            }
            results.push({ id: user.id, email: user.email, name: fullName, type: template, status: "sent" });
          } catch (err) {
            fastify.log.error(err, `email-manual: failed to send ${template} to user ${id}`);
            results.push({ id: user.id, email: user.email, name: fullName, type: template, status: "failed", reason: String(err) });
          }

        // ── Order-based templates ────────────────────────────────────────────
        } else if (cfg.recipientType === "order") {
          const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
          if (!order) {
            results.push({ id, email: "—", name: "—", type: template, status: "skipped", reason: `Order #${id} not found` });
            continue;
          }
          if (order.status !== "paid") {
            results.push({ id, email: "—", name: "—", type: template, status: "skipped", reason: `Order status is "${order.status}" (only paid orders can receive receipts)` });
            continue;
          }
          const [user] = await db
            .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
            .from(users).where(eq(users.id, order.userId)).limit(1);
          if (!user) {
            results.push({ id, email: "—", name: "—", type: template, status: "skipped", reason: "User not found" });
            continue;
          }

          const fullName = getFullName(user.firstName, user.middleName, user.lastName);

          if (dryRun) {
            results.push({ id, email: user.email, name: fullName, type: template, status: "pending", reason: `Order ${order.orderNumber}` });
            continue;
          }

          try {
            if (template === "approval-request") {
              // Defensive: skip orders that have no primary ticket (add-ons only).
              const [hasPrimary] = await db
                .select({ id: orderItems.id })
                .from(orderItems)
                .where(and(eq(orderItems.orderId, id), eq(orderItems.itemType, "ticket" as any)))
                .limit(1);
              if (!hasPrimary) {
                results.push({
                  id, email: user.email, name: fullName, type: template,
                  status: "skipped", reason: "Order has no primary ticket (add-on only)",
                });
                continue;
              }

              // Render the invitation letter PDF inline. Failure must NOT block —
              // fall back to sending without attachment.
              let attachment: { pdf: Buffer; fileName: string } | undefined;
              try {
                attachment = (await buildInvitationLetterPdfForOrder(id)) ?? undefined;
              } catch (pdfErr) {
                fastify.log.warn(
                  { err: pdfErr },
                  `email-manual: failed to render invitation letter PDF for order ${id}; sending without attachment`,
                );
              }
              await sendApprovalRequestEmail(
                user.email, user.firstName, user.middleName, user.lastName, attachment,
              );
              results.push({ id, email: user.email, name: fullName, type: template, status: "sent" });
            } else {
              const emailItems = await db
                .select({ name: ticketTypes.name, type: orderItems.itemType, price: orderItems.price, quantity: orderItems.quantity })
                .from(orderItems).innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
                .where(eq(orderItems.orderId, id));
              const [payment] = await db
                .select({ paidAt: payments.paidAt, paymentChannel: payments.paymentChannel })
                .from(payments).where(and(eq(payments.orderId, id), eq(payments.status, "paid"))).limit(1);
              const [reg] = await db
                .select({ regCode: registrations.regCode })
                .from(registrations).where(eq(registrations.orderId, id)).limit(1);

              const sorted = sortPrimaryFirst(emailItems);
              const subtotal = sorted.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
              const discount = Number(order.discountAmount || 0);
              const total = Number(order.totalAmount);
              const fee = Math.round((total - (subtotal - discount)) * 100) / 100;
              const receiptToken = generateReceiptToken(id);
              const receiptDownloadUrl = `${getPublicApiBaseUrl()}/api/payments/receipt/${receiptToken}`;

              await sendPaymentReceiptEmail(
                user.email, user.firstName, user.middleName, user.lastName,
                order.orderNumber, payment?.paidAt ?? new Date(), payment?.paymentChannel ?? "card",
                sorted.map((i) => ({ name: i.name, type: i.type, price: Number(i.price) })),
                subtotal, fee, total, order.currency ?? "THB", receiptDownloadUrl,
                order.needTaxInvoice ? { taxName: order.taxName, taxId: order.taxId, taxFullAddress: order.taxFullAddress } : undefined,
                reg?.regCode,
              );
              results.push({ id, email: user.email, name: fullName, type: template, status: "sent" });
            }
          } catch (err) {
            fastify.log.error(err, `email-manual: failed to send ${template} for order ${id}`);
            results.push({ id, email: user.email, name: fullName, type: template, status: "failed", reason: String(err) });
          }

        // ── Abstract-based templates ─────────────────────────────────────────
        } else if (cfg.recipientType === "abstract") {
          const [ab] = await db
            .select({
              id: abstracts.id,
              trackingId: abstracts.trackingId,
              title: abstracts.title,
              userId: abstracts.userId,
              status: abstracts.status,
              presentationType: abstracts.presentationType,
              updatedAt: abstracts.updatedAt,
            })
            .from(abstracts).where(eq(abstracts.id, id)).limit(1);
          if (!ab) {
            results.push({ id, email: "—", name: "—", type: template, status: "skipped", reason: `Abstract #${id} not found` });
            continue;
          }
          if (!ab.userId) {
            results.push({ id, email: "—", name: "—", type: template, status: "skipped", reason: "Abstract has no linked author" });
            continue;
          }
          const [author] = await db
            .select({ email: users.email, firstName: users.firstName, middleName: users.middleName, lastName: users.lastName })
            .from(users).where(eq(users.id, ab.userId)).limit(1);
          if (!author) {
            results.push({ id, email: "—", name: "—", type: template, status: "skipped", reason: "Author not found" });
            continue;
          }

          const fullName = getFullName(author.firstName, author.middleName, author.lastName);

          if (dryRun) {
            results.push({ id, email: author.email, name: fullName, type: template, status: "pending", reason: ab.trackingId ?? `#${id}` });
            continue;
          }

          try {
            if (template === "abstract-submission") {
              await sendAbstractSubmissionEmail(author.email, author.firstName, author.lastName, ab.trackingId ?? "N/A", ab.title);
            } else if (template === "abstract-accepted-poster") {
              await sendAbstractAcceptedPosterEmail(author.email, author.firstName, author.middleName, author.lastName, ab.title, comment);
            } else if (template === "abstract-accepted-oral") {
              await sendAbstractAcceptedOralEmail(author.email, author.firstName, author.middleName, author.lastName, ab.title, comment);
            } else if (template === "abstract-rejected") {
              await sendAbstractRejectedEmail(author.email, author.firstName, author.middleName, author.lastName, ab.title, comment);
            } else if (template === "academic-acceptance") {
              if (ab.status !== "accepted") {
                results.push({ id, email: author.email, name: fullName, type: template, status: "skipped", reason: `Abstract status is "${ab.status}" (must be accepted)` });
                continue;
              }
              // Render the type-specific acceptance letter PDF. Failure must NOT
              // block sending the email — fall back to no attachment.
              let attachment: { pdf: Buffer; fileName: string } | undefined;
              try {
                const pdf = await renderAbstractAcceptPdf({
                  participantName: buildParticipantName({
                    firstName: author.firstName,
                    middleName: author.middleName,
                    lastName: author.lastName,
                  }),
                  acceptDate: formatIssueDate(ab.updatedAt ?? new Date()),
                  presentationType: titleCasePresentationType(ab.presentationType),
                  abstractTitle: ab.title,
                });
                attachment = {
                  pdf,
                  fileName: `ACCP2026-Accept-${ab.trackingId || ab.id}.pdf`,
                };
              } catch (pdfErr) {
                fastify.log.warn(
                  { err: pdfErr },
                  `email-manual: failed to render acceptance letter PDF for abstract ${id}; sending without attachment`,
                );
              }
              await sendAcademicAcceptanceEmail(
                author.email, author.firstName, author.middleName, author.lastName, ab.presentationType, attachment,
              );
            }
            results.push({ id, email: author.email, name: fullName, type: template, status: "sent" });
          } catch (err) {
            fastify.log.error(err, `email-manual: failed to send ${template} for abstract ${id}`);
            results.push({ id, email: author.email, name: fullName, type: template, status: "failed", reason: String(err) });
          }

        // ── Registration-based templates ─────────────────────────────────────
        } else if (cfg.recipientType === "registration") {
          const [reg] = await db
            .select({
              id: registrations.id, regCode: registrations.regCode,
              firstName: registrations.firstName, middleName: registrations.middleName, lastName: registrations.lastName,
              email: registrations.email, ticketTypeId: registrations.ticketTypeId, eventId: registrations.eventId,
            })
            .from(registrations).where(eq(registrations.id, id)).limit(1);

          if (!reg) {
            results.push({ id, email: "—", name: "—", type: template, status: "skipped", reason: `Registration #${id} not found` });
            continue;
          }

          const fullName = getFullName(reg.firstName, reg.middleName, reg.lastName);

          if (dryRun) {
            results.push({ id, email: reg.email, name: fullName, type: template, status: "pending", reason: reg.regCode });
            continue;
          }

          try {
            const [ticket] = await db.select({ name: ticketTypes.name }).from(ticketTypes).where(eq(ticketTypes.id, reg.ticketTypeId)).limit(1);
            const [event] = await db.select({ eventName: events.eventName }).from(events).where(eq(events.id, reg.eventId)).limit(1);
            const regSessionRows = await db
              .select({ sessionName: sessions.sessionName, startTime: sessions.startTime, endTime: sessions.endTime })
              .from(registrationSessions)
              .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
              .where(eq(registrationSessions.registrationId, id));

            await sendManualRegistrationEmail(
              reg.email, reg.firstName, reg.middleName, reg.lastName, reg.regCode,
              event?.eventName ?? "Conference", ticket?.name ?? "Ticket",
              regSessionRows.map((s) => ({ sessionName: s.sessionName, startTime: s.startTime, endTime: s.endTime })),
            );
            results.push({ id, email: reg.email, name: fullName, type: template, status: "sent" });
          } catch (err) {
            fastify.log.error(err, `email-manual: failed to send manual-registration for reg ${id}`);
            results.push({ id, email: reg.email, name: fullName, type: template, status: "failed", reason: String(err) });
          }
        }
      }

      const summary = {
        pending: results.filter((r) => r.status === "pending").length,
        sent: results.filter((r) => r.status === "sent").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length,
      };

      return reply.send({ success: true, dryRun, template, results, summary });
    } catch (err) {
      fastify.log.error(err, "email-manual error");
      return reply.status(500).send({ success: false, error: "Internal error during email-manual" });
    }
  });
}
