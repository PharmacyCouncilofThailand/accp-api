import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  registrations,
  registrationSessions,
  ticketSessions,
  ticketTypes,
  sessions,
  orderItems,
} from "./schema.js";
import { config } from "dotenv";
import { eq, and, isNotNull, isNull, sql } from "drizzle-orm";

// Load .env from root
config({ path: "./.env" });

const run = async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined");
  }

  console.log("🔄 Migrating registrations → registration_sessions...\n");

  const client = postgres(process.env.DATABASE_URL);
  const db = drizzle(client);

  try {
    // ──────────────────────────────────────────────
    // Step 1: Migrate registrations that have sessionId (workshop addons)
    // ──────────────────────────────────────────────
    console.log("Step 1: Migrate registrations with sessionId...");

    const regsWithSession = await db
      .select({
        id: registrations.id,
        sessionId: registrations.sessionId,
        ticketTypeId: registrations.ticketTypeId,
      })
      .from(registrations)
      .where(isNotNull(registrations.sessionId));

    let step1Count = 0;
    for (const reg of regsWithSession) {
      // Check if already migrated
      const existing = await db
        .select({ id: registrationSessions.id })
        .from(registrationSessions)
        .where(
          sql`${registrationSessions.registrationId} = ${reg.id} AND ${registrationSessions.sessionId} = ${reg.sessionId}`
        )
        .limit(1);

      if (existing.length === 0 && reg.sessionId !== null) {
        await db.insert(registrationSessions).values({
          registrationId: reg.id,
          sessionId: reg.sessionId,
          ticketTypeId: reg.ticketTypeId,
        });
        step1Count++;
      }
    }
    console.log(`   ✅ ${step1Count} registration_sessions created from sessionId\n`);

    // ──────────────────────────────────────────────
    // Step 2: Migrate registrations WITHOUT sessionId (primary, gala, etc.)
    //         → lookup sessions from ticket_sessions junction
    // ──────────────────────────────────────────────
    console.log("Step 2: Migrate registrations without sessionId (via ticket_sessions)...");

    const regsWithoutSession = await db
      .select({
        id: registrations.id,
        ticketTypeId: registrations.ticketTypeId,
      })
      .from(registrations)
      .where(isNull(registrations.sessionId));

    let step2Count = 0;
    for (const reg of regsWithoutSession) {
      // Find linked sessions from ticket_sessions
      const linkedSessions = await db
        .select({ sessionId: ticketSessions.sessionId })
        .from(ticketSessions)
        .where(eq(ticketSessions.ticketTypeId, reg.ticketTypeId));

      for (const ls of linkedSessions) {
        // Check if already exists
        const existing = await db
          .select({ id: registrationSessions.id })
          .from(registrationSessions)
          .where(
            sql`${registrationSessions.registrationId} = ${reg.id} AND ${registrationSessions.sessionId} = ${ls.sessionId}`
          )
          .limit(1);

        if (existing.length === 0) {
          await db.insert(registrationSessions).values({
            registrationId: reg.id,
            sessionId: ls.sessionId,
            ticketTypeId: reg.ticketTypeId,
          });
          step2Count++;
        }
      }
    }
    console.log(`   ✅ ${step2Count} registration_sessions created from ticket_sessions\n`);

    // ──────────────────────────────────────────────
    // Step 3: Backfill orderId in registrations
    // ──────────────────────────────────────────────
    console.log("Step 3: Backfill orderId in registrations...");

    const regsNoOrder = await db
      .select({
        id: registrations.id,
      })
      .from(registrations)
      .where(isNull(registrations.orderId));

    let step3Count = 0;
    for (const reg of regsNoOrder) {
      // Find order via order_items.registration_id
      const [oi] = await db
        .select({ orderId: orderItems.orderId })
        .from(orderItems)
        .where(eq(orderItems.registrationId, reg.id))
        .limit(1);

      if (oi) {
        await db
          .update(registrations)
          .set({ orderId: oi.orderId })
          .where(eq(registrations.id, reg.id));
        step3Count++;
      }
    }
    console.log(`   ✅ ${step3Count} registrations backfilled with orderId\n`);

    // ──────────────────────────────────────────────
    // Step 4: Backfill ticket_sessions for primary tickets
    //         that are missing links to main sessions
    // ──────────────────────────────────────────────
    console.log("Step 4: Backfill ticket_sessions for primary tickets...");

    const primaryTickets = await db
      .select({ id: ticketTypes.id, eventId: ticketTypes.eventId })
      .from(ticketTypes)
      .where(eq(ticketTypes.category, "primary"));

    let step4Count = 0;
    for (const pt of primaryTickets) {
      // Check if ticket_sessions already has rows for this ticket
      const existingLinks = await db
        .select({ id: ticketSessions.id })
        .from(ticketSessions)
        .where(eq(ticketSessions.ticketTypeId, pt.id))
        .limit(1);

      if (existingLinks.length === 0) {
        // Find main sessions for this event
        const mainSessions = await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.eventId, pt.eventId),
              eq(sessions.isMainSession, true)
            )
          );

        for (const ms of mainSessions) {
          await db.insert(ticketSessions).values({
            ticketTypeId: pt.id,
            sessionId: ms.id,
          });
          step4Count++;
        }
      }
    }
    console.log(`   ✅ ${step4Count} ticket_sessions created for primary tickets\n`);

    // ──────────────────────────────────────────────
    // Summary
    // ──────────────────────────────────────────────
    const totalRegSessions = await db
      .select({ count: sql<number>`count(*)` })
      .from(registrationSessions);

    const totalRegs = await db
      .select({ count: sql<number>`count(*)` })
      .from(registrations);

    console.log("═══════════════════════════════════════");
    console.log(`📊 Summary:`);
    console.log(`   Total registrations:          ${totalRegs[0].count}`);
    console.log(`   Total registration_sessions:  ${totalRegSessions[0].count}`);
    console.log("═══════════════════════════════════════");

  } catch (error) {
    console.error("❌ Migration error:", error);
  } finally {
    await client.end();
    console.log("\n✅ Migration complete");
  }
};

run().catch((err) => {
  console.error("❌ Migration failed:", err);
  process.exit(1);
});
