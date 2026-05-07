/**
 * Invitation Letter route
 *
 * GET /api/backoffice/orders/:orderId/invitation-letter.pdf
 * GET /api/backoffice/orders/:orderId/invitation-letter.docx
 *   ?name=...       override participant display name (optional)
 *   &date=YYYY-MM-DD override issue date (optional; defaults to paidAt or today)
 *
 * Only returns a letter for paid orders. Uses the registration name if present,
 * otherwise falls back to the user's profile name.
 */
import { FastifyInstance } from "fastify";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  orders,
  payments,
  users,
  registrations,
  staffEventAssignments,
} from "../../database/schema.js";
import {
  renderLetterDocx,
  renderLetterPdf,
  buildParticipantName,
  formatIssueDate,
  type LetterData,
} from "../../services/letter.service.js";

export default async function (fastify: FastifyInstance) {
  async function loadOrderAndBuildData(
    orderId: number,
    staff: { id: number; role: string } | undefined,
    overrideName?: string,
    overrideDateStr?: string
  ): Promise<
    | { ok: true; data: LetterData; filenameBase: string }
    | { ok: false; status: number; body: object }
  > {
    // Event scoping for non-admin staff
    if (staff && staff.role !== "admin") {
      const assignments = await db
        .select({ eventId: staffEventAssignments.eventId })
        .from(staffEventAssignments)
        .where(eq(staffEventAssignments.staffId, staff.id));
      const assignedIds = assignments.map((a) => a.eventId);
      if (assignedIds.length === 0) {
        return {
          ok: false,
          status: 403,
          body: { success: false, code: "FORBIDDEN", error: "No assigned events" },
        };
      }
      const [row] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.id, orderId), inArray(orders.eventId, assignedIds)))
        .limit(1);
      if (!row) {
        return {
          ok: false,
          status: 404,
          body: { success: false, code: "ORDER_NOT_FOUND", error: "Order not found" },
        };
      }
    }

    const [order] = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        userFirstName: users.firstName,
        userMiddleName: users.middleName,
        userLastName: users.lastName,
      })
      .from(orders)
      .innerJoin(users, eq(orders.userId, users.id))
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) {
      return {
        ok: false,
        status: 404,
        body: { success: false, code: "ORDER_NOT_FOUND", error: "Order not found" },
      };
    }

    if (order.status !== "paid") {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          code: "ORDER_NOT_PAID",
          error: "Invitation letter is only available for paid orders",
        },
      };
    }

    // Prefer registration's name (may differ from user profile)
    const [reg] = await db
      .select({
        firstName: registrations.firstName,
        middleName: registrations.middleName,
        lastName: registrations.lastName,
      })
      .from(registrations)
      .where(
        and(
          eq(registrations.orderId, orderId),
          eq(registrations.status, "confirmed")
        )
      )
      .limit(1);

    const [pay] = await db
      .select({ paidAt: payments.paidAt })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
      .limit(1);

    const participantName =
      overrideName && overrideName.trim().length > 0
        ? overrideName.trim()
        : buildParticipantName({
            firstName: reg?.firstName ?? order.userFirstName,
            middleName: reg?.middleName ?? order.userMiddleName,
            lastName: reg?.lastName ?? order.userLastName,
          });

    let issueDate: Date;
    if (overrideDateStr) {
      const d = new Date(overrideDateStr);
      issueDate = isNaN(d.getTime()) ? new Date() : d;
    } else if (pay?.paidAt) {
      issueDate = pay.paidAt;
    } else {
      issueDate = new Date();
    }

    return {
      ok: true,
      data: {
        participantName,
        issueDate: formatIssueDate(issueDate),
      },
      filenameBase: `ACCP2026-Invitation-${order.orderNumber || orderId}`,
    };
  }

  // ── PDF ─────────────────────────────────────────────────────────
  fastify.get<{
    Params: { orderId: string };
    Querystring: { name?: string; date?: string };
  }>("/:orderId/invitation-letter.pdf", async (request, reply) => {
    const orderId = Number(request.params.orderId);
    if (!orderId || isNaN(orderId)) {
      return reply
        .status(400)
        .send({ success: false, code: "INVALID_ORDER_ID", error: "Invalid order id" });
    }
    const staff = (request as { user?: { id: number; role: string } }).user;

    const result = await loadOrderAndBuildData(
      orderId,
      staff,
      request.query.name,
      request.query.date
    );
    if (!result.ok) return reply.status(result.status).send(result.body);

    try {
      const pdf = await renderLetterPdf(result.data);
      return reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `inline; filename="${result.filenameBase}.pdf"`
        )
        .send(pdf);
    } catch (err) {
      fastify.log.error({ err }, "Failed to render invitation letter PDF");
      return reply.status(500).send({
        success: false,
        code: "LETTER_RENDER_FAILED",
        error:
          "Failed to render invitation letter. Ensure LibreOffice is installed on the server.",
      });
    }
  });

  // ── DOCX (no LibreOffice needed) ────────────────────────────────
  fastify.get<{
    Params: { orderId: string };
    Querystring: { name?: string; date?: string };
  }>("/:orderId/invitation-letter.docx", async (request, reply) => {
    const orderId = Number(request.params.orderId);
    if (!orderId || isNaN(orderId)) {
      return reply
        .status(400)
        .send({ success: false, code: "INVALID_ORDER_ID", error: "Invalid order id" });
    }
    const staff = (request as { user?: { id: number; role: string } }).user;

    const result = await loadOrderAndBuildData(
      orderId,
      staff,
      request.query.name,
      request.query.date
    );
    if (!result.ok) return reply.status(result.status).send(result.body);

    try {
      const docx = renderLetterDocx(result.data);
      return reply
        .header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        )
        .header(
          "Content-Disposition",
          `attachment; filename="${result.filenameBase}.docx"`
        )
        .send(docx);
    } catch (err) {
      fastify.log.error({ err }, "Failed to render invitation letter DOCX");
      return reply.status(500).send({
        success: false,
        code: "LETTER_RENDER_FAILED",
        error: "Failed to render invitation letter",
      });
    }
  });
}
