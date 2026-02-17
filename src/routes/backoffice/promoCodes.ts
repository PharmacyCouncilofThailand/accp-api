import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { promoCodes, events, staffEventAssignments, promoCodeRuleSets, promoCodeRuleItems, ticketTypes } from "../../database/schema.js";
import { eq, desc, ilike, and, count, inArray, or } from "drizzle-orm";
import { z } from "zod";

const promoQuerySchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(100).default(20),
    search: z.string().optional(),
    eventId: z.coerce.number().optional(),
    status: z.enum(['active', 'inactive', 'expired']).optional(),
});

const ruleSetSchema = z.object({
    matchType: z.enum(['all', 'any', 'only']).default('all'),
    ticketTypeIds: z.array(z.number().int().positive()).min(1),
});

const createPromoSchema = z.object({
    eventId: z.number().nullable().optional(),
    code: z.string().min(1).max(50),
    description: z.string().optional(),
    discountType: z.enum(['percentage', 'fixed']),
    discountValue: z.number().min(0).default(0),
    fixedValueThb: z.number().min(0).nullable().optional(),
    fixedValueUsd: z.number().min(0).nullable().optional(),
    minPurchase: z.number().min(0).default(0),
    maxDiscount: z.number().nullable().optional(),
    maxUses: z.number().min(1).default(100),
    maxUsesPerUser: z.number().min(1).default(1),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
    isActive: z.boolean().default(true),
    ruleSets: z.array(ruleSetSchema).optional(),
});

const updatePromoSchema = createPromoSchema.partial();

export default async function (fastify: FastifyInstance) {
    // List All Promo Codes
    fastify.get("", async (request, reply) => {
        const queryResult = promoQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId, status } = queryResult.data;
        const offset = (page - 1) * limit;

        const user = (request as any).user;

        try {
            const conditions = [];

            // If user is not admin, filter by assigned events only
            if (user && user.role !== 'admin') {
                const assignments = await db
                    .select({ eventId: staffEventAssignments.eventId })
                    .from(staffEventAssignments)
                    .where(eq(staffEventAssignments.staffId, user.id));

                const assignedEventIds = assignments.map(a => a.eventId);

                if (assignedEventIds.length === 0) {
                    return reply.send({
                        promoCodes: [],
                        pagination: { page, limit, total: 0, totalPages: 0 },
                    });
                }

                conditions.push(inArray(promoCodes.eventId, assignedEventIds));
            }

            if (eventId) conditions.push(eq(promoCodes.eventId, eventId));
            if (search) {
                conditions.push(
                    or(
                        ilike(promoCodes.code, `%${search}%`),
                        ilike(promoCodes.description, `%${search}%`)
                    )
                );
            }

            // Status filter based on isActive and dates
            if (status === 'active') {
                conditions.push(eq(promoCodes.isActive, true));
            } else if (status === 'inactive') {
                conditions.push(eq(promoCodes.isActive, false));
            }

            const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

            // Count total
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(promoCodes)
                .where(whereClause);

            // Fetch promo codes with event info
            const promoList = await db
                .select({
                    id: promoCodes.id,
                    eventId: promoCodes.eventId,
                    code: promoCodes.code,
                    description: promoCodes.description,
                    discountType: promoCodes.discountType,
                    discountValue: promoCodes.discountValue,
                    fixedValueThb: promoCodes.fixedValueThb,
                    fixedValueUsd: promoCodes.fixedValueUsd,
                    minPurchase: promoCodes.minPurchase,
                    maxDiscount: promoCodes.maxDiscount,
                    maxUses: promoCodes.maxUses,
                    maxUsesPerUser: promoCodes.maxUsesPerUser,
                    usedCount: promoCodes.usedCount,
                    validFrom: promoCodes.validFrom,
                    validUntil: promoCodes.validUntil,
                    isActive: promoCodes.isActive,
                    createdAt: promoCodes.createdAt,
                    eventCode: events.eventCode,
                    eventName: events.eventName,
                })
                .from(promoCodes)
                .leftJoin(events, eq(promoCodes.eventId, events.id))
                .where(whereClause)
                .orderBy(desc(promoCodes.createdAt))
                .limit(limit)
                .offset(offset);

            // Calculate status for each promo code
            const now = new Date();
            const promoCodesWithStatus = promoList.map(promo => {
                let status = 'active';
                if (!promo.isActive) {
                    status = 'inactive';
                } else if (promo.validUntil && new Date(promo.validUntil) < now) {
                    status = 'expired';
                } else if (promo.usedCount >= promo.maxUses) {
                    status = 'expired';
                }
                return { ...promo, status };
            });

            return reply.send({
                promoCodes: promoCodesWithStatus,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    totalPages: Math.ceil(totalCount / limit),
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch promo codes" });
        }
    });

    // Get Single Promo Code (with rule sets)
    fastify.get("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            const [promo] = await db
                .select()
                .from(promoCodes)
                .where(eq(promoCodes.id, parseInt(id)));

            if (!promo) {
                return reply.status(404).send({ error: "Promo code not found" });
            }

            // Fetch rule sets with their items
            const ruleSetsRows = await db
                .select()
                .from(promoCodeRuleSets)
                .where(eq(promoCodeRuleSets.promoCodeId, promo.id));

            const ruleSets = [];
            for (const rs of ruleSetsRows) {
                const items = await db
                    .select({
                        id: promoCodeRuleItems.id,
                        ticketTypeId: promoCodeRuleItems.ticketTypeId,
                        ticketName: ticketTypes.name,
                    })
                    .from(promoCodeRuleItems)
                    .leftJoin(ticketTypes, eq(promoCodeRuleItems.ticketTypeId, ticketTypes.id))
                    .where(eq(promoCodeRuleItems.ruleSetId, rs.id));

                ruleSets.push({
                    id: rs.id,
                    matchType: rs.matchType,
                    items,
                });
            }

            return reply.send({ promoCode: { ...promo, ruleSets } });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch promo code" });
        }
    });

    // Create Promo Code
    fastify.post("", async (request, reply) => {
        const parseResult = createPromoSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: "Invalid data", details: parseResult.error.flatten() });
        }

        const data = parseResult.data;

        try {
            // Check if code already exists
            const [existing] = await db
                .select()
                .from(promoCodes)
                .where(eq(promoCodes.code, data.code.toUpperCase()));

            if (existing) {
                return reply.status(400).send({ error: "Promo code already exists" });
            }

            const [newPromo] = await db.insert(promoCodes).values({
                eventId: data.eventId || null,
                code: data.code.toUpperCase(),
                description: data.description || null,
                discountType: data.discountType,
                discountValue: data.discountValue.toString(),
                fixedValueThb: data.fixedValueThb != null ? data.fixedValueThb.toString() : null,
                fixedValueUsd: data.fixedValueUsd != null ? data.fixedValueUsd.toString() : null,
                minPurchase: data.minPurchase.toString(),
                maxDiscount: data.maxDiscount != null ? data.maxDiscount.toString() : null,
                maxUses: data.maxUses,
                maxUsesPerUser: data.maxUsesPerUser,
                usedCount: 0,
                validFrom: data.validFrom ? new Date(data.validFrom) : null,
                validUntil: data.validUntil ? new Date(data.validUntil) : null,
                isActive: data.isActive,
            }).returning();

            // Create rule sets if provided
            if (data.ruleSets && data.ruleSets.length > 0) {
                for (const rs of data.ruleSets) {
                    const [ruleSet] = await db.insert(promoCodeRuleSets).values({
                        promoCodeId: newPromo.id,
                        matchType: rs.matchType,
                    }).returning();

                    await db.insert(promoCodeRuleItems).values(
                        rs.ticketTypeIds.map(tid => ({
                            ruleSetId: ruleSet.id,
                            ticketTypeId: tid,
                        }))
                    );
                }
            }

            return reply.status(201).send({ promoCode: newPromo });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to create promo code" });
        }
    });

    // Update Promo Code
    fastify.put("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };
        const parseResult = updatePromoSchema.safeParse(request.body);
        if (!parseResult.success) {
            return reply.status(400).send({ error: "Invalid data", details: parseResult.error.flatten() });
        }

        const data = parseResult.data;

        try {
            const [existing] = await db
                .select()
                .from(promoCodes)
                .where(eq(promoCodes.id, parseInt(id)));

            if (!existing) {
                return reply.status(404).send({ error: "Promo code not found" });
            }

            // Build update object
            const updates: any = {};
            if (data.eventId !== undefined) updates.eventId = data.eventId;
            if (data.code) updates.code = data.code.toUpperCase();
            if (data.description !== undefined) updates.description = data.description;
            if (data.discountType) updates.discountType = data.discountType;
            if (data.discountValue !== undefined) updates.discountValue = data.discountValue.toString();
            if (data.fixedValueThb !== undefined) updates.fixedValueThb = data.fixedValueThb != null ? data.fixedValueThb.toString() : null;
            if (data.fixedValueUsd !== undefined) updates.fixedValueUsd = data.fixedValueUsd != null ? data.fixedValueUsd.toString() : null;
            if (data.minPurchase !== undefined) updates.minPurchase = data.minPurchase.toString();
            if (data.maxDiscount !== undefined) updates.maxDiscount = data.maxDiscount != null ? data.maxDiscount.toString() : null;
            if (data.maxUses !== undefined) updates.maxUses = data.maxUses;
            if (data.maxUsesPerUser !== undefined) updates.maxUsesPerUser = data.maxUsesPerUser;
            if (data.validFrom !== undefined) updates.validFrom = data.validFrom ? new Date(data.validFrom) : null;
            if (data.validUntil !== undefined) updates.validUntil = data.validUntil ? new Date(data.validUntil) : null;
            if (data.isActive !== undefined) updates.isActive = data.isActive;

            const [updatedPromo] = await db
                .update(promoCodes)
                .set(updates)
                .where(eq(promoCodes.id, parseInt(id)))
                .returning();

            // Update rule sets if provided
            if (data.ruleSets !== undefined) {
                // Delete existing rule sets (cascade deletes items)
                await db.delete(promoCodeRuleSets)
                    .where(eq(promoCodeRuleSets.promoCodeId, parseInt(id)));

                // Re-create rule sets
                if (data.ruleSets && data.ruleSets.length > 0) {
                    for (const rs of data.ruleSets) {
                        const [ruleSet] = await db.insert(promoCodeRuleSets).values({
                            promoCodeId: parseInt(id),
                            matchType: rs.matchType,
                        }).returning();

                        await db.insert(promoCodeRuleItems).values(
                            rs.ticketTypeIds.map(tid => ({
                                ruleSetId: ruleSet.id,
                                ticketTypeId: tid,
                            }))
                        );
                    }
                }
            }

            return reply.send({ promoCode: updatedPromo });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to update promo code" });
        }
    });

    // Delete Promo Code
    fastify.delete("/:id", async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            const [existing] = await db
                .select()
                .from(promoCodes)
                .where(eq(promoCodes.id, parseInt(id)));

            if (!existing) {
                return reply.status(404).send({ error: "Promo code not found" });
            }

            // Check if promo code has been used
            if (existing.usedCount > 0) {
                return reply.status(400).send({
                    error: "Cannot delete promo code that has been used. Consider deactivating instead."
                });
            }

            await db.delete(promoCodes).where(eq(promoCodes.id, parseInt(id)));

            return reply.send({ success: true, message: "Promo code deleted" });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to delete promo code" });
        }
    });

    // Toggle Active Status
    fastify.patch("/:id/toggle", async (request, reply) => {
        const { id } = request.params as { id: string };

        try {
            const [existing] = await db
                .select()
                .from(promoCodes)
                .where(eq(promoCodes.id, parseInt(id)));

            if (!existing) {
                return reply.status(404).send({ error: "Promo code not found" });
            }

            const [updatedPromo] = await db
                .update(promoCodes)
                .set({ isActive: !existing.isActive })
                .where(eq(promoCodes.id, parseInt(id)))
                .returning();

            return reply.send({ promoCode: updatedPromo });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to toggle promo code status" });
        }
    });
}
