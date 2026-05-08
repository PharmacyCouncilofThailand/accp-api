import { and, eq } from "drizzle-orm";
import { db } from "../database/index.js";
import {
  orders,
  payments,
  users,
  registrations,
} from "../database/schema.js";
import {
  renderLetterPdf,
  buildParticipantName,
  formatIssueDate,
} from "./letter.service.js";

/**
 * Build an invitation letter PDF for a paid order.
 *
 * - Uses the registration's name if present, otherwise falls back to the
 *   user's profile name (matches the behaviour of the backoffice download
 *   route at `/api/backoffice/orders/:orderId/invitation-letter.pdf`).
 * - Uses `payments.paidAt` as the issue date, falling back to the current
 *   date if the payment record is missing (e.g. free registrations).
 *
 * Returns `{ pdf, fileName }` ready for email attachment, or `null` when the
 * order cannot be found.
 */
export async function buildInvitationLetterPdfForOrder(
  orderId: number,
): Promise<{ pdf: Buffer; fileName: string } | null> {
  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      userId: orders.userId,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return null;

  const [user] = await db
    .select({
      firstName: users.firstName,
      middleName: users.middleName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.id, order.userId))
    .limit(1);

  if (!user) return null;

  // Prefer a confirmed registration, but fall back to any registration on the
  // order (webhooks may run before the registration transitions to confirmed).
  const [regConfirmed] = await db
    .select({
      firstName: registrations.firstName,
      middleName: registrations.middleName,
      lastName: registrations.lastName,
    })
    .from(registrations)
    .where(
      and(
        eq(registrations.orderId, orderId),
        eq(registrations.status, "confirmed"),
      ),
    )
    .limit(1);

  const reg =
    regConfirmed ??
    (
      await db
        .select({
          firstName: registrations.firstName,
          middleName: registrations.middleName,
          lastName: registrations.lastName,
        })
        .from(registrations)
        .where(eq(registrations.orderId, orderId))
        .limit(1)
    )[0];

  const [pay] = await db
    .select({ paidAt: payments.paidAt })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
    .limit(1);

  const participantName = buildParticipantName({
    firstName: reg?.firstName ?? user.firstName,
    middleName: reg?.middleName ?? user.middleName,
    lastName: reg?.lastName ?? user.lastName,
  });

  const issueDate = pay?.paidAt ?? new Date();

  const pdf = await renderLetterPdf({
    participantName,
    issueDate: formatIssueDate(issueDate),
  });

  return {
    pdf,
    fileName: `ACCP2026-Invitation-${order.orderNumber || orderId}.pdf`,
  };
}
