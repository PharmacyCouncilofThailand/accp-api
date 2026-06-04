import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
  abstracts,
  abstractCoAuthors,
  events,
  users,
} from "../../database/schema.js";
import {
  abstractListSchema,
  updateAbstractStatusSchema,
} from "../../schemas/abstracts.schema.js";
import { eq, desc, ilike, and, or, count, inArray } from "drizzle-orm";
import {
  sendAbstractAcceptedPosterEmail,
  sendAbstractAcceptedOralEmail,
  sendAbstractRejectedEmail,
} from "../../services/emailService.js";
import {
  buildParticipantName,
  formatIssueDate,
  renderAbstractAcceptPdf,
  titleCasePresentationType,
} from "../../services/letter.service.js";

export default async function (fastify: FastifyInstance) {
  // List Abstracts
  fastify.get("", async (request, reply) => {
    const queryResult = abstractListSchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply
        .status(400)
        .send({ error: "Invalid query", details: queryResult.error.flatten() });
    }

    const { page, limit, search, eventId, status, category, presentationType } =
      queryResult.data;
    const offset = (page - 1) * limit;

    // Get user info from JWT
    const user = request.user;

    try {
      const conditions = [];

      // Category-based access control for reviewers
      // Admin sees all, Reviewer sees only assigned categories
      if (user.role === "reviewer") {
        const assignedCategories = user.assignedCategories || [];
        if (assignedCategories.length > 0) {
          // Reviewer can only see abstracts in their assigned categories
          // Cast to enum type for TypeScript compatibility
          type CategoryType =
            | "clinical_pharmacy"
            | "social_administrative"
            | "community_pharmacy"
            | "pharmacology_toxicology"
            | "pharmacy_education"
            | "digital_pharmacy";
          const validCategories = assignedCategories.filter(
            (cat): cat is CategoryType =>
              [
                "clinical_pharmacy",
                "social_administrative",
                "community_pharmacy",
                "pharmacology_toxicology",
                "pharmacy_education",
                "digital_pharmacy",
              ].includes(cat),
          );
          if (validCategories.length > 0) {
            conditions.push(inArray(abstracts.category, validCategories));
          } else {
            // No valid categories assigned
            return reply.send({
              abstracts: [],
              pagination: { page, limit, total: 0, totalPages: 0 },
            });
          }
        } else {
          // Reviewer with no assigned categories sees nothing
          return reply.send({
            abstracts: [],
            pagination: { page, limit, total: 0, totalPages: 0 },
          });
        }

        // Presentation type filtering for reviewers
        const assignedPresentationTypes = user.assignedPresentationTypes || [];
        if (assignedPresentationTypes.length > 0) {
          // Reviewer can only see abstracts with their assigned presentation types
          type PresentationType = "poster" | "oral";
          const validPresentationTypes = assignedPresentationTypes.filter(
            (type): type is PresentationType =>
              ["poster", "oral"].includes(type),
          );
          if (validPresentationTypes.length > 0) {
            conditions.push(
              inArray(abstracts.presentationType, validPresentationTypes),
            );
          } else {
            // No valid presentation types assigned
            return reply.send({
              abstracts: [],
              pagination: { page, limit, total: 0, totalPages: 0 },
            });
          }
        }
        // If no presentation types assigned, reviewer can see all presentation types
      }
      // Admin and other roles see all abstracts (no category filter applied)

      if (eventId) conditions.push(eq(abstracts.eventId, eventId));
      if (status) conditions.push(eq(abstracts.status, status));
      if (category) conditions.push(eq(abstracts.category, category));
      if (presentationType)
        conditions.push(eq(abstracts.presentationType, presentationType));
      if (search) {
        conditions.push(
          or(
            ilike(abstracts.title, `%${search}%`),
            ilike(users.firstName, `%${search}%`),
            ilike(users.middleName, `%${search}%`),
            ilike(users.lastName, `%${search}%`),
            ilike(users.email, `%${search}%`),
          ),
        );
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      // Count total
      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(abstracts)
        .leftJoin(users, eq(abstracts.userId, users.id))
        .where(whereClause);

      // Fetch data
      const abstractList = await db
        .select({
          id: abstracts.id,
          trackingId: abstracts.trackingId,
          title: abstracts.title,
          category: abstracts.category,
          presentationType: abstracts.presentationType,
          keywords: abstracts.keywords,
          background: abstracts.background,
          objective: abstracts.objective,
          methods: abstracts.methods,
          results: abstracts.results,
          conclusion: abstracts.conclusion,
          status: abstracts.status,
          fullPaperUrl: abstracts.fullPaperUrl,
          createdAt: abstracts.createdAt,
          author: {
            firstName: users.firstName,
            middleName: users.middleName,
            lastName: users.lastName,
            email: users.email,
            phone: users.phone,
            country: users.country,
            institution: users.institution,
          },
          event: {
            name: events.eventName,
            code: events.eventCode,
          },
        })
        .from(abstracts)
        .leftJoin(users, eq(abstracts.userId, users.id))
        .leftJoin(events, eq(abstracts.eventId, events.id))
        .where(whereClause)
        .orderBy(desc(abstracts.createdAt))
        .limit(limit)
        .offset(offset);

      // Fetch co-authors for each abstract (using inArray for efficiency)
      const abstractIds = abstractList.map((a) => a.id);
      const coAuthorsList =
        abstractIds.length > 0
          ? await db
              .select()
              .from(abstractCoAuthors)
              .where(inArray(abstractCoAuthors.abstractId, abstractIds))
          : [];

      // Merge co-authors with abstracts
      const abstractsWithCoAuthors = abstractList.map((abs) => ({
        ...abs,
        coAuthors: coAuthorsList.filter((ca) => ca.abstractId === abs.id),
      }));

      return reply.send({
        abstracts: abstractsWithCoAuthors,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch abstracts" });
    }
  });

  // Get Single Abstract by ID
  fastify.get("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const [abstractData] = await db
        .select({
          id: abstracts.id,
          trackingId: abstracts.trackingId,
          title: abstracts.title,
          category: abstracts.category,
          presentationType: abstracts.presentationType,
          keywords: abstracts.keywords,
          background: abstracts.background,
          objective: abstracts.objective,
          methods: abstracts.methods,
          results: abstracts.results,
          conclusion: abstracts.conclusion,
          status: abstracts.status,
          fullPaperUrl: abstracts.fullPaperUrl,
          createdAt: abstracts.createdAt,
          author: {
            firstName: users.firstName,
            middleName: users.middleName,
            lastName: users.lastName,
            email: users.email,
            phone: users.phone,
            country: users.country,
            institution: users.institution,
          },
          event: {
            name: events.eventName,
            code: events.eventCode,
          },
        })
        .from(abstracts)
        .leftJoin(users, eq(abstracts.userId, users.id))
        .leftJoin(events, eq(abstracts.eventId, events.id))
        .where(eq(abstracts.id, parseInt(id)));

      if (!abstractData) {
        return reply.status(404).send({ error: "Abstract not found" });
      }

      // Fetch co-authors for this abstract
      const coAuthors = await db
        .select()
        .from(abstractCoAuthors)
        .where(eq(abstractCoAuthors.abstractId, parseInt(id)));

      return reply.send({
        abstract: {
          ...abstractData,
          coAuthors,
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch abstract" });
    }
  });

  // Update Abstract Status
  fastify.patch("/:id/status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = updateAbstractStatusSchema.safeParse(request.body);

    if (!result.success) {
      return reply
        .status(400)
        .send({ error: "Invalid input", details: result.error.flatten() });
    }

    const { status, comment } = result.data;

    try {
      const [updatedAbstract] = await db
        .update(abstracts)
        .set({ status, updatedAt: new Date() })
        .where(eq(abstracts.id, parseInt(id)))
        .returning();

      if (!updatedAbstract)
        return reply.status(404).send({ error: "Abstract not found" });

      // Get author information for email (skip if no userId)
      let author = null;
      if (updatedAbstract.userId) {
        const [authorResult] = await db
          .select({
            firstName: users.firstName,
            middleName: users.middleName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(eq(users.id, updatedAbstract.userId))
          .limit(1);
        author = authorResult;
      }

      // Send email notification based on status
      if (author) {
        try {
          if (status === "accepted") {
            let acceptanceAttachment: { pdf: Buffer; fileName: string } | undefined;
            const presentationType = titleCasePresentationType(
              updatedAbstract.presentationType,
            );
            const fileName = `ACCP2026-Accept-${updatedAbstract.trackingId || updatedAbstract.id}.pdf`;
            for (let attempt = 1; attempt <= 3; attempt++) {
              fastify.log.info(
                `Generating abstract acceptance letter PDF for abstract ${id} (${updatedAbstract.trackingId || "no-tracking-id"}): ${fileName} - attempt ${attempt}/3`,
              );
              try {
                const pdf = await renderAbstractAcceptPdf({
                  participantName: buildParticipantName({
                    firstName: author.firstName,
                    middleName: author.middleName,
                    lastName: author.lastName,
                  }),
                  acceptDate: formatIssueDate(updatedAbstract.updatedAt || new Date()),
                  presentationType,
                  abstractTitle: updatedAbstract.title,
                });
                acceptanceAttachment = {
                  pdf,
                  fileName,
                };
                fastify.log.info(
                  `Abstract acceptance letter PDF generated for abstract ${id} (${updatedAbstract.trackingId || "no-tracking-id"}): ${fileName} (${pdf.length} bytes) on attempt ${attempt}/3`,
                );
                break;
              } catch (letterError) {
                fastify.log.error(
                  { err: letterError },
                  `Failed to render abstract acceptance letter PDF for abstract ${id} (${updatedAbstract.trackingId || "no-tracking-id"}) on attempt ${attempt}/3`,
                );
              }
            }

            if (!acceptanceAttachment) {
              fastify.log.error(
                `Abstract acceptance letter PDF could not be generated for abstract ${id} (${updatedAbstract.trackingId || "no-tracking-id"}) after 3 attempts; sending abstract accepted email without attachment`,
              );
            }

            // Check presentationType to determine poster or oral email
            if (updatedAbstract.presentationType === "poster") {
              await sendAbstractAcceptedPosterEmail(
                author.email,
                author.firstName,
                author.middleName,
                author.lastName,
                updatedAbstract.title,
                comment,
                acceptanceAttachment,
              );
              fastify.log.info(
                `Abstract accepted (poster) email sent to ${author.email}`,
              );
            } else if (updatedAbstract.presentationType === "oral") {
              await sendAbstractAcceptedOralEmail(
                author.email,
                author.firstName,
                author.middleName,
                author.lastName,
                updatedAbstract.title,
                comment,
                acceptanceAttachment,
              );
              fastify.log.info(
                `Abstract accepted (oral) email sent to ${author.email}`,
              );
            }
          } else if (status === "rejected") {
            await sendAbstractRejectedEmail(
              author.email,
              author.firstName,
              author.middleName,
              author.lastName,
              updatedAbstract.title,
              comment,
            );
            fastify.log.info(`Abstract rejected email sent to ${author.email}`);
          }
        } catch (emailError) {
          fastify.log.error(
            { err: emailError },
            `Failed to send abstract status email for abstract ${id} (${updatedAbstract.trackingId})`,
          );
        }
      }

      return reply.send({ abstract: updatedAbstract });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to update abstract" });
    }
  });
}
