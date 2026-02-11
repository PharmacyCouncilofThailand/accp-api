import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { ticketTypes, events } from "../../database/schema.js";
import { eq, and, or, isNull, gt, sql } from "drizzle-orm";

// Query params interface
interface TicketQuery {
    role?: string;
}

// Ticket group interface
interface TicketGroup {
    groupId: string;
    groupName: string;
    category: 'primary' | 'addon';
    tickets: TicketWithAvailability[];
}

// Ticket with computed fields
interface TicketWithAvailability {
    id: number;
    eventId: number;
    category: 'primary' | 'addon';
    priority: string;
    groupName: string | null;
    name: string;
    description: string | null;
    price: string;
    originalPrice: string | null;
    currency: string;
    features: string[];
    badgeText: string | null;
    displayOrder: number;
    allowedRoles: string | null;
    quota: number;
    soldCount: number;
    isAvailable: boolean;
    saleStartDate: string | null;
    saleEndDate: string | null;
}

export default async function publicTicketsRoutes(fastify: FastifyInstance) {
    // List all public tickets for published events
    fastify.get("", async (request, reply) => {
        try {
            const { role } = request.query as TicketQuery;
            const now = new Date();

            // Build conditions
            const conditions = [
                eq(events.status, "published"),
                eq(ticketTypes.isActive, true),
            ];

            // Filter by role if provided
            // DB stores allowedRoles as CSV ('thstd,thpro') or JSON ('["thstd"]')
            if (role) {
                conditions.push(
                    or(
                        isNull(ticketTypes.allowedRoles),
                        eq(ticketTypes.allowedRoles, role),
                        sql`${ticketTypes.allowedRoles} LIKE ${role + ',%'}`,
                        sql`${ticketTypes.allowedRoles} LIKE ${'%,' + role + ',%'}`,
                        sql`${ticketTypes.allowedRoles} LIKE ${'%,' + role}`,
                        sql`${ticketTypes.allowedRoles} LIKE ${`%"${role}"%`}`
                    ) as any
                );
            }

            const tickets = await db
                .select({
                    id: ticketTypes.id,
                    eventId: ticketTypes.eventId,
                    category: ticketTypes.category,
                    priority: ticketTypes.priority,
                    groupName: ticketTypes.groupName,
                    name: ticketTypes.name,
                    description: ticketTypes.description,
                    price: ticketTypes.price,
                    originalPrice: ticketTypes.originalPrice,
                    currency: ticketTypes.currency,
                    features: ticketTypes.features,
                    badgeText: ticketTypes.badgeText,
                    displayOrder: ticketTypes.displayOrder,
                    allowedRoles: ticketTypes.allowedRoles,
                    quota: ticketTypes.quota,
                    soldCount: ticketTypes.soldCount,
                    saleStartDate: ticketTypes.saleStartDate,
                    saleEndDate: ticketTypes.saleEndDate,
                })
                .from(ticketTypes)
                .innerJoin(events, eq(ticketTypes.eventId, events.id))
                .where(and(...conditions))
                .orderBy(ticketTypes.displayOrder);

            // Compute availability and format response
            const formattedTickets: TicketWithAvailability[] = tickets.map(ticket => {
                const saleStart = ticket.saleStartDate ? new Date(ticket.saleStartDate) : null;
                const saleEnd = ticket.saleEndDate ? new Date(ticket.saleEndDate) : null;
                
                // Check if ticket is available
                const isInSalePeriod = (!saleStart || now >= saleStart) && (!saleEnd || now <= saleEnd);
                const hasQuota = ticket.quota > ticket.soldCount;
                const isAvailable = isInSalePeriod && hasQuota;

                return {
                    ...ticket,
                    displayOrder: ticket.displayOrder ?? 0,
                    features: ticket.features || [],
                    isAvailable,
                    saleStartDate: ticket.saleStartDate?.toISOString() || null,
                    saleEndDate: ticket.saleEndDate?.toISOString() || null,
                };
            });

            // ✅ Phase 1: Filter out tickets that have ended (past saleEndDate)
            const filteredTickets = formattedTickets.filter(t => {
                const saleEnd = t.saleEndDate ? new Date(t.saleEndDate) : null;
                const isEnded = saleEnd ? now > saleEnd : false;
                return !isEnded; // Keep only tickets that haven't ended
            });

            // Group tickets by groupName
            const groups = groupTicketsByGroup(filteredTickets);

            return reply.send({ 
                tickets: filteredTickets,
                ticketGroups: groups 
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch tickets" });
        }
    });
}

/**
 * Group tickets by their groupName
 */
function groupTicketsByGroup(tickets: TicketWithAvailability[]): TicketGroup[] {
    const groupMap = new Map<string, TicketGroup>();

    for (const ticket of tickets) {
        const groupId = ticket.groupName || 'other';
        const existingGroup = groupMap.get(groupId);

        if (existingGroup) {
            existingGroup.tickets.push(ticket);
        } else {
            groupMap.set(groupId, {
                groupId,
                groupName: formatGroupName(groupId),
                category: ticket.category,
                tickets: [ticket],
            });
        }
    }

    // Convert map to array and sort by display order of first ticket in each group
    return Array.from(groupMap.values()).sort((a, b) => {
        const aOrder = a.tickets[0]?.displayOrder || 0;
        const bOrder = b.tickets[0]?.displayOrder || 0;
        return aOrder - bOrder;
    });
}

/**
 * Format group ID to readable name
 */
function formatGroupName(groupId: string): string {
    const nameMap: Record<string, string> = {
        'conference': 'Conference Registration',
        'workshop': 'Pre-Conference Workshop',
        'gala': 'Gala Dinner',
        'other': 'Other Tickets',
    };
    return nameMap[groupId] || groupId.charAt(0).toUpperCase() + groupId.slice(1);
}
