/**
 * Retroactive Email Resend Script
 *
 * PURPOSE:
 *   Re-send emails that failed during the NipaMail token expiry window:
 *   2026-04-22T12:38:20Z → 2026-04-23T06:33:46Z (~18 hours)
 *
 * USAGE:
 *   npx tsx src/scripts/retrosend-emails.ts [--dry-run] [--type=all|payment|signup|abstract-submission|abstract-status]
 *
 * FLAGS:
 *   --dry-run            Print what WOULD be sent without actually sending
 *   --type=<type>        Only run a specific category (default: all)
 *   --abstract-ids=1,2,3 Comma-separated abstract IDs for status emails (required for abstract-status)
 *
 * CATEGORIES HANDLED:
 *   payment              6 known orders: #207, #208, #213, #214, #219, #222
 *   signup               Users registered in window who needed welcome / pending-approval email
 *   abstract-submission  Abstracts submitted in window (3 cases)
 *   abstract-status      Accepted/Rejected notification — requires manual --abstract-ids list
 *
 * RUN FROM: accp-api/ directory
 */

import * as dotenv from "dotenv";
dotenv.config();

import { db } from "../database/index.js";
import {
  users,
  orders,
  orderItems,
  payments,
  ticketTypes,
  registrations,
  abstracts,
  abstractCoAuthors,
} from "../database/schema.js";
import { eq, and, gte, lte, inArray, or } from "drizzle-orm";
import {
  sendSignupNotificationEmail,
  sendPendingApprovalEmail,
  sendPaymentReceiptEmail,
  sendAbstractSubmissionEmail,
  sendAbstractAcceptedPosterEmail,
  sendAbstractAcceptedOralEmail,
  sendAbstractRejectedEmail,
  sendCoAuthorNotificationEmail,
} from "../services/emailService.js";
import { generateReceiptToken } from "../utils/receiptToken.js";
import { getFullName } from "../utils/name.js";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

/** Exact window when NipaMail token was expired (UTC) */
const FAILURE_START = new Date("2026-04-22T12:38:00Z");
const FAILURE_END = new Date("2026-04-23T06:34:00Z");

/** Payment orders confirmed to have failed from production logs */
const FAILED_PAYMENT_ORDER_IDS = [207, 208, 213, 214, 219, 222];

function getPublicApiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL || "http://localhost:3002").trim().replace(/\/$/, "");
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
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const typeArg = args.find((a) => a.startsWith("--type="))?.replace("--type=", "") ?? "all";
const abstractIdsArg = args.find((a) => a.startsWith("--abstract-ids="))?.replace("--abstract-ids=", "");
const MANUAL_ABSTRACT_IDS: number[] = abstractIdsArg
  ? abstractIdsArg.split(",").map(Number).filter((n) => !isNaN(n) && n > 0)
  : [];

const RUN_ALL = typeArg === "all";
const RUN_PAYMENT = RUN_ALL || typeArg === "payment";
const RUN_SIGNUP = RUN_ALL || typeArg === "signup";
const RUN_ABSTRACT_SUBMISSION = RUN_ALL || typeArg === "abstract-submission";
const RUN_ABSTRACT_STATUS = typeArg === "abstract-status";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

let sent = 0;
let failed = 0;
let skipped = 0;

async function trySend(label: string, fn: () => Promise<void>) {
  if (DRY_RUN) {
    console.log(`  [DRY-RUN] Would send: ${label}`);
    skipped++;
    return;
  }
  try {
    await fn();
    console.log(`  [OK] Sent: ${label}`);
    sent++;
  } catch (err) {
    console.error(`  [FAIL] ${label} — ${err}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PAYMENT RECEIPT EMAILS
// ─────────────────────────────────────────────────────────────────────────────

async function resendPaymentReceipts() {
  console.log("\n════════════════════════════════════════");
  console.log("  PAYMENT RECEIPT EMAILS");
  console.log("  Orders:", FAILED_PAYMENT_ORDER_IDS.join(", "));
  console.log("════════════════════════════════════════");

  for (const orderId of FAILED_PAYMENT_ORDER_IDS) {
    console.log(`\n[Order #${orderId}]`);

    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) {
      console.warn(`  SKIP — Order #${orderId} not found in DB`);
      skipped++;
      continue;
    }

    if (order.status !== "paid") {
      console.warn(`  SKIP — Order #${orderId} status="${order.status}" (not paid)`);
      skipped++;
      continue;
    }

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
      console.warn(`  SKIP — User not found for order #${orderId}`);
      skipped++;
      continue;
    }

    const [payment] = await db
      .select({
        paidAt: payments.paidAt,
        paymentChannel: payments.paymentChannel,
      })
      .from(payments)
      .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
      .limit(1);

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
    const apiBaseUrl = getPublicApiBaseUrl();
    const receiptDownloadUrl = `${apiBaseUrl}/api/payments/receipt/${receiptToken}`;

    const paidAt = payment?.paidAt ?? new Date(order.createdAt);
    const paymentChannel = payment?.paymentChannel ?? "card";
    const regCode = registration?.regCode;

    console.log(`  To: ${user.email} | Name: ${getFullName(user.firstName, user.middleName, user.lastName)}`);
    console.log(`  Order: ${order.orderNumber} | Total: ${order.totalAmount} ${order.currency} | RegCode: ${regCode ?? "—"}`);

    await trySend(`Payment receipt for order #${orderId} → ${user.email}`, () =>
      sendPaymentReceiptEmail(
        user.email,
        user.firstName,
        user.middleName,
        user.lastName,
        order.orderNumber,
        paidAt,
        paymentChannel,
        sortedItems.map((i) => ({ name: i.name, type: i.type, price: Number(i.price) })),
        emailSubtotal,
        emailFee,
        emailTotal,
        order.currency,
        receiptDownloadUrl,
        order.needTaxInvoice
          ? { taxName: order.taxName, taxId: order.taxId, taxFullAddress: order.taxFullAddress }
          : undefined,
        regCode,
      )
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SIGNUP & PENDING APPROVAL EMAILS
// ─────────────────────────────────────────────────────────────────────────────

async function resendSignupEmails() {
  console.log("\n════════════════════════════════════════");
  console.log("  SIGNUP / PENDING-APPROVAL EMAILS");
  console.log(`  Window: ${FAILURE_START.toISOString()} → ${FAILURE_END.toISOString()}`);
  console.log("════════════════════════════════════════");

  const windowUsers = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      middleName: users.middleName,
      lastName: users.lastName,
      role: users.role,
      status: users.status,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(gte(users.createdAt, FAILURE_START), lte(users.createdAt, FAILURE_END)));

  if (windowUsers.length === 0) {
    console.log("  No users found in failure window.");
    return;
  }

  console.log(`  Found ${windowUsers.length} user(s) registered in window\n`);

  for (const u of windowUsers) {
    console.log(`\n[User #${u.id}] ${u.email} | role=${u.role} | status=${u.status} | created=${u.createdAt.toISOString()}`);

    // Auto-approved roles → signup notification
    // Pending roles → pending approval email
    const isAutoApproved = ["thpro", "interpro", "general"].includes(u.role);

    if (isAutoApproved || u.status === "active") {
      await trySend(`Signup notification → ${u.email}`, () =>
        sendSignupNotificationEmail(u.email, u.firstName, u.middleName ?? null, u.lastName)
      );
    } else if (u.status === "pending_approval") {
      await trySend(`Pending approval → ${u.email}`, () =>
        sendPendingApprovalEmail(u.email, u.firstName, u.middleName ?? null, u.lastName)
      );
    } else {
      console.log(`  SKIP — Unexpected status "${u.status}", may have been processed already`);
      skipped++;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ABSTRACT SUBMISSION EMAILS
// ─────────────────────────────────────────────────────────────────────────────

async function resendAbstractSubmissionEmails() {
  console.log("\n════════════════════════════════════════");
  console.log("  ABSTRACT SUBMISSION EMAILS");
  console.log(`  Window: ${FAILURE_START.toISOString()} → ${FAILURE_END.toISOString()}`);
  console.log("════════════════════════════════════════");

  const windowAbstracts = await db
    .select({
      id: abstracts.id,
      trackingId: abstracts.trackingId,
      title: abstracts.title,
      userId: abstracts.userId,
      createdAt: abstracts.createdAt,
    })
    .from(abstracts)
    .where(and(gte(abstracts.createdAt, FAILURE_START), lte(abstracts.createdAt, FAILURE_END)));

  if (windowAbstracts.length === 0) {
    console.log("  No abstracts submitted in failure window.");
    return;
  }

  console.log(`  Found ${windowAbstracts.length} abstract(s) submitted in window\n`);

  for (const ab of windowAbstracts) {
    console.log(`\n[Abstract #${ab.id}] trackingId=${ab.trackingId ?? "—"} | "${ab.title.substring(0, 60)}..."`);

    if (!ab.userId) {
      console.warn("  SKIP — Abstract has no linked userId");
      skipped++;
      continue;
    }

    const [author] = await db
      .select({
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(eq(users.id, ab.userId))
      .limit(1);

    if (!author) {
      console.warn("  SKIP — Author user not found");
      skipped++;
      continue;
    }

    console.log(`  Author: ${author.email} | TrackingID: ${ab.trackingId ?? "N/A"}`);

    await trySend(`Abstract submission confirmation → ${author.email} (trackingId=${ab.trackingId})`, () =>
      sendAbstractSubmissionEmail(
        author.email,
        author.firstName,
        author.lastName,
        ab.trackingId ?? "N/A",
        ab.title,
      )
    );

    // Also resend co-author notifications
    const coAuthors = await db
      .select()
      .from(abstractCoAuthors)
      .where(eq(abstractCoAuthors.abstractId, ab.id));

    for (const co of coAuthors) {
      const authorFullName = getFullName(author.firstName, null, author.lastName);
      await trySend(`Co-author notification → ${co.email} (for abstract ${ab.trackingId})`, () =>
        sendCoAuthorNotificationEmail(
          co.email,
          co.firstName,
          co.middleName ?? null,
          co.lastName,
          authorFullName,
          ab.trackingId ?? "N/A",
          ab.title,
        )
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ABSTRACT STATUS EMAILS (accepted / rejected)
//    Requires --abstract-ids=<id1>,<id2>,... from manual identification
// ─────────────────────────────────────────────────────────────────────────────

async function resendAbstractStatusEmails() {
  console.log("\n════════════════════════════════════════");
  console.log("  ABSTRACT STATUS EMAILS (accepted/rejected)");
  console.log("════════════════════════════════════════");

  if (MANUAL_ABSTRACT_IDS.length === 0) {
    console.log(`
  ⚠  MANUAL IDENTIFICATION REQUIRED

  The 'abstracts' table has no 'updatedAt' column, so it is impossible to
  query which abstracts were accepted/rejected during the failure window by
  timestamp alone.

  From the logs, 12 status-change emails failed on 2026-04-22 between
  14:04 UTC and 15:50 UTC (21:04–22:50 Bangkok time):
    - abstract accepted poster : 7 failures
    - abstract accepted oral   : 2 failures
    - abstract rejected        : 3 failures

  ACTION REQUIRED:
  1. Open the backoffice and filter abstracts by status = accepted / rejected
  2. Identify those that were reviewed by staff on Apr 22 (21:00–23:00 BKK)
  3. Note their IDs, then re-run this script with:

     npx tsx src/scripts/retrosend-emails.ts --type=abstract-status --abstract-ids=101,102,103,...

  LONG-TERM FIX:
  Add an 'updatedAt' column to the 'abstracts' table (see migration note at
  the bottom of this file).
`);
    return;
  }

  const rows = await db
    .select({
      id: abstracts.id,
      trackingId: abstracts.trackingId,
      title: abstracts.title,
      status: abstracts.status,
      presentationType: abstracts.presentationType,
      userId: abstracts.userId,
    })
    .from(abstracts)
    .where(inArray(abstracts.id, MANUAL_ABSTRACT_IDS));

  for (const ab of rows) {
    console.log(`\n[Abstract #${ab.id}] trackingId=${ab.trackingId} | status=${ab.status} | type=${ab.presentationType}`);

    if (!ab.userId) {
      console.warn("  SKIP — No linked userId");
      skipped++;
      continue;
    }

    const [author] = await db
      .select({
        email: users.email,
        firstName: users.firstName,
        middleName: users.middleName,
        lastName: users.lastName,
      })
      .from(users)
      .where(eq(users.id, ab.userId))
      .limit(1);

    if (!author) {
      console.warn("  SKIP — Author user not found");
      skipped++;
      continue;
    }

    console.log(`  Author: ${author.email}`);

    if (ab.status === "accepted") {
      if (ab.presentationType === "poster") {
        await trySend(`Abstract accepted (poster) → ${author.email} (#${ab.id})`, () =>
          sendAbstractAcceptedPosterEmail(
            author.email,
            author.firstName,
            author.middleName ?? null,
            author.lastName,
            ab.title,
          )
        );
      } else if (ab.presentationType === "oral") {
        await trySend(`Abstract accepted (oral) → ${author.email} (#${ab.id})`, () =>
          sendAbstractAcceptedOralEmail(
            author.email,
            author.firstName,
            author.middleName ?? null,
            author.lastName,
            ab.title,
          )
        );
      }
    } else if (ab.status === "rejected") {
      await trySend(`Abstract rejected → ${author.email} (#${ab.id})`, () =>
        sendAbstractRejectedEmail(
          author.email,
          author.firstName,
          author.middleName ?? null,
          author.lastName,
          ab.title,
        )
      );
    } else {
      console.warn(`  SKIP — Status is "${ab.status}", expected accepted or rejected`);
      skipped++;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║   ACCP Email Retrosend Script                ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`Mode    : ${DRY_RUN ? "DRY-RUN (no emails sent)" : "LIVE (emails WILL be sent)"}`);
  console.log(`Type    : ${typeArg}`);
  console.log(`Window  : ${FAILURE_START.toISOString()} → ${FAILURE_END.toISOString()}`);

  if (!DRY_RUN) {
    console.log("\n⚠  LIVE MODE — emails will be sent to real recipients.");
    console.log("   Run with --dry-run first to preview recipients.\n");
  }

  if (RUN_PAYMENT) await resendPaymentReceipts();
  if (RUN_SIGNUP) await resendSignupEmails();
  if (RUN_ABSTRACT_SUBMISSION) await resendAbstractSubmissionEmails();
  if (RUN_ABSTRACT_STATUS) await resendAbstractStatusEmails();

  console.log("\n╔══════════════════════════════════════════════╗");
  console.log("║   Summary                                    ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Sent    : ${sent}`);
  console.log(`  Failed  : ${failed}`);
  console.log(`  Skipped : ${skipped}`);

  if (failed > 0) {
    console.error("\n⚠  Some emails failed. Re-run after fixing the issue.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(99);
});

/*
 * ─────────────────────────────────────────────────────────────────────────────
 * LONG-TERM FIX: Add updatedAt to abstracts table
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Run this migration in the DB to enable future time-window queries on
 * abstract status changes:
 *
 *   ALTER TABLE abstracts ADD COLUMN updated_at TIMESTAMP NOT NULL DEFAULT NOW();
 *
 * Then add a trigger (or update the PATCH route) to set updated_at on every
 * status update:
 *
 *   -- In src/database/schema.ts:
 *   updatedAt: timestamp("updated_at").notNull().defaultNow()
 *
 *   -- In backoffice/abstracts.ts PATCH /:id/status:
 *   .set({ status, updatedAt: new Date() })
 *
 * This makes future retroactive recovery trivial:
 *   WHERE status IN ('accepted','rejected') AND updated_at BETWEEN $1 AND $2
 */
