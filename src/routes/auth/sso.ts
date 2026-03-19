import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { ssoTokens, users, events } from "../../database/schema.js";
import { eq, and, gt, lt } from "drizzle-orm";
import { randomUUID } from "crypto";
import { JWT_EXPIRY } from "../../constants/auth.js";

const SSO_TOKEN_EXPIRY_MS = 60_000; // 60 seconds

// Default fallback URL (conference-web เป็น main hub)
const DEFAULT_TARGET_URL = process.env.CONFERENCE_WEB_URL || "http://localhost:3003";

export default async function (fastify: FastifyInstance) {

  // ─── POST /auth/sso-token ─── สร้าง OTT (ต้อง auth)
  // Query params: ?eventId=123 (optional)
  // Body: { targetApp?: string }
  // Returns: { success, ssoToken, targetUrl }
  fastify.post("/sso-token", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const body = request.body as { targetApp?: string } | undefined;
    const query = request.query as { eventId?: string };
    const eventId = query.eventId ? parseInt(query.eventId, 10) : null;

    const sourceApp = String(
      Array.isArray(request.headers["x-source-app"])
        ? request.headers["x-source-app"][0]
        : request.headers["x-source-app"] || "unknown"
    );

    // Auto-cleanup: ลบ expired tokens ก่อนสร้างใหม่ (ป้องกัน DB บวม)
    try {
      await db
        .delete(ssoTokens)
        .where(lt(ssoTokens.expiresAt, new Date()));
    } catch (cleanupErr) {
      fastify.log.warn({ err: cleanupErr }, "SSO token cleanup failed (non-fatal)");
    }

    // ดึง websiteUrl จาก event (ถ้ามี eventId)
    let targetUrl = DEFAULT_TARGET_URL;
    let targetApp = body?.targetApp || null;

    if (eventId && !isNaN(eventId)) {
      const [event] = await db
        .select({ websiteUrl: events.websiteUrl, eventName: events.eventName })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);

      if (event?.websiteUrl) {
        targetUrl = event.websiteUrl;
        targetApp = targetApp || event.eventName || `event-${eventId}`;
      }
    }

    const token = randomUUID();
    const expiresAt = new Date(Date.now() + SSO_TOKEN_EXPIRY_MS);

    await db.insert(ssoTokens).values({
      token,
      userId: request.user.id,
      eventId: eventId && !isNaN(eventId) ? eventId : null,
      expiresAt,
      sourceApp,
      targetApp,
    });

    return { success: true, ssoToken: token, targetUrl };
  });

  // ─── POST /auth/sso-verify ─── แลก OTT → JWT (ไม่ต้อง auth)
  fastify.post("/sso-verify", async (request, reply) => {
    const { ssoToken } = request.body as { ssoToken?: string };

    if (!ssoToken || typeof ssoToken !== "string") {
      return reply.status(400).send({
        success: false,
        error: "SSO token is required",
      });
    }

    // ★ Atomic: UPDATE ... WHERE used=false ... RETURNING
    // ป้องกัน race condition — ถ้า 2 requests มาพร้อมกัน มีแค่ 1 ที่ได้ row
    const claimedRows = await db
      .update(ssoTokens)
      .set({ used: true })
      .where(
        and(
          eq(ssoTokens.token, ssoToken),
          eq(ssoTokens.used, false),
          gt(ssoTokens.expiresAt, new Date()),
        )
      )
      .returning({ userId: ssoTokens.userId });

    if (claimedRows.length === 0) {
      return reply.status(401).send({
        success: false,
        error: "Invalid or expired SSO token",
      });
    }

    const { userId } = claimedRows[0];

    // Get user data + ★ check account status
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        status: users.status,
        firstName: users.firstName,
        lastName: users.lastName,
        country: users.country,
        phone: users.phone,
        pharmacyLicenseId: users.pharmacyLicenseId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) {
      return reply.status(404).send({
        success: false,
        error: "User not found",
      });
    }

    // ★ Reject inactive accounts
    if (user.status !== "active") {
      return reply.status(403).send({
        success: false,
        error: user.status === "pending_approval" ? "ACCOUNT_PENDING" : "ACCOUNT_REJECTED",
      });
    }

    // Map delegate type (same logic as login.ts)
    let delegateType = "";
    let isThai = false;

    switch (user.role) {
      case "thstd":
        delegateType = "thai_student";
        isThai = true;
        break;
      case "interstd":
        delegateType = "international_student";
        isThai = false;
        break;
      case "thpro":
        delegateType = "thai_pharmacist";
        isThai = true;
        break;
      case "interpro":
        delegateType = "international_pharmacist";
        isThai = false;
        break;
      default:
        delegateType = "unknown";
    }

    // Sign JWT
    const jwt = fastify.jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      { expiresIn: JWT_EXPIRY }
    );

    return {
      success: true,
      token: jwt,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        country: user.country,
        delegateType,
        isThai,
        phone: user.phone,
        pharmacyLicenseId: user.pharmacyLicenseId,
        name: `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email,
      },
    };
  });
}
