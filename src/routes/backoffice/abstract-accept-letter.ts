/**
 * Abstract Acceptance Letter route
 *
 * GET /api/backoffice/abstracts/:id/accept-letter.pdf
 * GET /api/backoffice/abstracts/:id/accept-letter.docx
 *   ?name=...         override participant display name (optional)
 *   &date=YYYY-MM-DD  override acceptance date (optional; defaults to the
 *                     abstract row's updatedAt — which is bumped whenever
 *                     admin changes the status to 'accepted')
 *   &type=oral|poster override presentation type (optional; defaults to the
 *                     value stored on the abstract)
 *
 * Only returns a letter for abstracts with status='accepted'. Reviewers may
 * only download letters for abstracts within their assigned categories /
 * presentation types.
 */
import { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../../database/index.js";
import { abstracts, users } from "../../database/schema.js";
import {
  renderAbstractAcceptDocx,
  renderAbstractAcceptPdf,
  buildParticipantName,
  formatIssueDate,
  titleCasePresentationType,
  type AbstractAcceptData,
} from "../../services/letter.service.js";

type StaffUser = {
  id: number;
  role: string;
  assignedCategories?: string[];
  assignedPresentationTypes?: string[];
};

export default async function (fastify: FastifyInstance) {
  async function loadAbstractAndBuildData(
    abstractId: number,
    staff: StaffUser | undefined,
    overrides: { name?: string; date?: string; type?: string }
  ): Promise<
    | { ok: true; data: AbstractAcceptData; filenameBase: string }
    | { ok: false; status: number; body: object }
  > {
    const [row] = await db
      .select({
        id: abstracts.id,
        trackingId: abstracts.trackingId,
        title: abstracts.title,
        category: abstracts.category,
        presentationType: abstracts.presentationType,
        status: abstracts.status,
        updatedAt: abstracts.updatedAt,
        userId: abstracts.userId,
        userFirstName: users.firstName,
        userMiddleName: users.middleName,
        userLastName: users.lastName,
      })
      .from(abstracts)
      .leftJoin(users, eq(abstracts.userId, users.id))
      .where(eq(abstracts.id, abstractId))
      .limit(1);

    if (!row) {
      return {
        ok: false,
        status: 404,
        body: {
          success: false,
          code: "ABSTRACT_NOT_FOUND",
          error: "Abstract not found",
        },
      };
    }

    if (row.status !== "accepted") {
      return {
        ok: false,
        status: 400,
        body: {
          success: false,
          code: "ABSTRACT_NOT_ACCEPTED",
          error:
            "Acceptance letter is only available for accepted abstracts",
        },
      };
    }

    // Reviewer access control: mirror the list endpoint's category / type scoping.
    if (staff && staff.role === "reviewer") {
      const cats = staff.assignedCategories ?? [];
      if (cats.length > 0 && !cats.includes(row.category)) {
        return {
          ok: false,
          status: 403,
          body: {
            success: false,
            code: "FORBIDDEN",
            error: "Abstract is outside your assigned categories",
          },
        };
      }
      const types = staff.assignedPresentationTypes ?? [];
      if (types.length > 0 && !types.includes(row.presentationType)) {
        return {
          ok: false,
          status: 403,
          body: {
            success: false,
            code: "FORBIDDEN",
            error: "Abstract is outside your assigned presentation types",
          },
        };
      }
    }

    // Default acceptance date = abstracts.updatedAt (bumped whenever admin
    // changes the status). Falls back to today if no override is supplied
    // and the row predates the updatedAt column.
    let acceptDate: Date;
    if (overrides.date) {
      const d = new Date(overrides.date);
      acceptDate = isNaN(d.getTime()) ? new Date() : d;
    } else if (row.updatedAt) {
      acceptDate = row.updatedAt;
    } else {
      acceptDate = new Date();
    }

    // Participant name: override > user profile name > placeholder.
    const participantName =
      overrides.name && overrides.name.trim().length > 0
        ? overrides.name.trim()
        : buildParticipantName({
            firstName: row.userFirstName,
            middleName: row.userMiddleName,
            lastName: row.userLastName,
          });

    // Presentation type: override > stored value; always title-cased.
    const rawType =
      overrides.type && overrides.type.trim().length > 0
        ? overrides.type.trim().toLowerCase()
        : row.presentationType;
    const presentationType = titleCasePresentationType(rawType);

    return {
      ok: true,
      data: {
        participantName,
        acceptDate: formatIssueDate(acceptDate),
        presentationType,
        abstractTitle: row.title,
      },
      filenameBase: `ACCP2026-Accept-${row.trackingId || row.id}`,
    };
  }

  // ── PDF ────────────────────────────────────────────────────────────
  fastify.get<{
    Params: { id: string };
    Querystring: { name?: string; date?: string; type?: string };
  }>("/:id/accept-letter.pdf", async (request, reply) => {
    const abstractId = Number(request.params.id);
    if (!abstractId || isNaN(abstractId)) {
      return reply.status(400).send({
        success: false,
        code: "INVALID_ABSTRACT_ID",
        error: "Invalid abstract id",
      });
    }
    const staff = (request as { user?: StaffUser }).user;

    const result = await loadAbstractAndBuildData(abstractId, staff, {
      name: request.query.name,
      date: request.query.date,
      type: request.query.type,
    });
    if (!result.ok) return reply.status(result.status).send(result.body);

    try {
      const pdf = await renderAbstractAcceptPdf(result.data);
      return reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `inline; filename="${result.filenameBase}.pdf"`
        )
        .send(pdf);
    } catch (err) {
      fastify.log.error({ err }, "Failed to render abstract-accept PDF");
      return reply.status(500).send({
        success: false,
        code: "LETTER_RENDER_FAILED",
        error:
          "Failed to render acceptance letter. Ensure LibreOffice is installed on the server.",
      });
    }
  });

  // ── DOCX (no LibreOffice needed) ────────────────────────────────
  fastify.get<{
    Params: { id: string };
    Querystring: { name?: string; date?: string; type?: string };
  }>("/:id/accept-letter.docx", async (request, reply) => {
    const abstractId = Number(request.params.id);
    if (!abstractId || isNaN(abstractId)) {
      return reply.status(400).send({
        success: false,
        code: "INVALID_ABSTRACT_ID",
        error: "Invalid abstract id",
      });
    }
    const staff = (request as { user?: StaffUser }).user;

    const result = await loadAbstractAndBuildData(abstractId, staff, {
      name: request.query.name,
      date: request.query.date,
      type: request.query.type,
    });
    if (!result.ok) return reply.status(result.status).send(result.body);

    try {
      const docx = await renderAbstractAcceptDocx(result.data);
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
      fastify.log.error({ err }, "Failed to render abstract-accept DOCX");
      return reply.status(500).send({
        success: false,
        code: "LETTER_RENDER_FAILED",
        error: "Failed to render acceptance letter",
      });
    }
  });
}
