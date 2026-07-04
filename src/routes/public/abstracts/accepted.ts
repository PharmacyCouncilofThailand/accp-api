import { FastifyInstance } from "fastify";
import { asc, and, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../../database/index.js";
import { abstracts, users } from "../../../database/schema.js";
import { buildAbstractScheduleResponse, hasScheduledLocation } from "../../../utils/abstractSchedule.js";

type AcceptedAbstractQuery = {
  search?: string;
  presentationType?: "oral" | "poster";
  scheduledOnly?: string;
};

const toPresenterName = (author: {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
} | null) =>
  [author?.firstName, author?.middleName, author?.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

export default async function acceptedAbstractsRoutes(fastify: FastifyInstance) {
  fastify.get("/accepted", async (request, reply) => {
    const query = request.query as AcceptedAbstractQuery;
    const search = query.search?.trim();
    const conditions = [eq(abstracts.status, "accepted")];

    if (query.presentationType) {
      conditions.push(eq(abstracts.presentationType, query.presentationType));
    }

    if (search) {
      conditions.push(
        or(
          ilike(abstracts.trackingId, `%${search}%`),
          ilike(abstracts.title, `%${search}%`),
          ilike(users.firstName, `%${search}%`),
          ilike(users.middleName, `%${search}%`),
          ilike(users.lastName, `%${search}%`),
          sql`concat_ws(' ', ${users.firstName}, ${users.middleName}, ${users.lastName}) ILIKE ${`%${search}%`}`,
        )!,
      );
    }

    try {
      const acceptedAbstracts = await db
        .select({
          id: abstracts.id,
          trackingId: abstracts.trackingId,
          title: abstracts.title,
          category: abstracts.category,
          presentationType: abstracts.presentationType,
          createdAt: abstracts.createdAt,
          presentationDate: abstracts.presentationDate,
          presentationRoom: abstracts.presentationRoom,
          presentationStartTime: abstracts.presentationStartTime,
          presentationEndTime: abstracts.presentationEndTime,
          posterBoardNumber: abstracts.posterBoardNumber,
          posterInstallationStart: abstracts.posterInstallationStart,
          posterInstallationEnd: abstracts.posterInstallationEnd,
          posterRemovalStart: abstracts.posterRemovalStart,
          posterRemovalEnd: abstracts.posterRemovalEnd,
          author: {
            firstName: users.firstName,
            middleName: users.middleName,
            lastName: users.lastName,
            institution: users.institution,
            country: users.country,
          },
        })
        .from(abstracts)
        .leftJoin(users, eq(abstracts.userId, users.id))
        .where(and(...conditions))
        .orderBy(
          sql`CASE WHEN ${abstracts.presentationType} = 'oral' THEN 0 ELSE 1 END`,
          asc(abstracts.trackingId),
          asc(abstracts.createdAt),
        );

      const items = acceptedAbstracts.map((item) => ({
        id: item.id,
        trackingId: item.trackingId,
        title: item.title,
        category: item.category,
        presentationType: item.presentationType,
        presenterName: toPresenterName(item.author),
        institution: item.author?.institution || null,
        country: item.author?.country || null,
        schedule: buildAbstractScheduleResponse(item),
      }));

      const scheduledOnly = query.scheduledOnly === "true" || query.scheduledOnly === "1";
      const visibleItems = scheduledOnly
        ? items.filter((item) =>
            hasScheduledLocation(item.presentationType, item.schedule),
          )
        : items;

      return reply.send({
        success: true,
        abstracts: visibleItems,
        total: visibleItems.length,
        counts: {
          oral: visibleItems.filter((item) => item.presentationType === "oral").length,
          poster: visibleItems.filter((item) => item.presentationType === "poster").length,
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to fetch accepted abstracts",
      });
    }
  });
}
