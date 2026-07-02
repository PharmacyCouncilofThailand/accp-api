import { FastifyInstance, FastifyReply } from "fastify";
import { db } from "../../database/index.js";
import {
    users,
    orders,
    orderItems,
    payments,
    registrations,
    registrationSessions,
    sessions,
    events,
    ticketTypes,
    abstracts,
    backofficeUsers,
    staffEventAssignments,
} from "../../database/schema.js";
import {
    reportsEventQuerySchema,
    reportsTrendQuerySchema,
    reportsExportQuerySchema,
    reportsExportTypeSchema,
} from "../../schemas/reports.schema.js";
import {
    eq,
    and,
    count,
    desc,
    asc,
    sql,
    inArray,
    isNotNull,
    exists,
    notExists,
} from "drizzle-orm";
import { getFullName } from "../../utils/name.js";
import { getDuplicateCountForEvent } from "../../services/checkInScanLog.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function csvEscape(v: string | number | null | undefined): string {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
}

function sendCsv(
    reply: FastifyReply,
    filename: string,
    headers: string[],
    rows: (string | number | null | undefined)[][]
) {
    const lines = [
        headers.join(","),
        ...rows.map((r) => r.map(csvEscape).join(",")),
    ];
    const csv = "\uFEFF" + lines.join("\r\n");
    return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(csv);
}

async function getAssignedEventIds(staffId: number): Promise<number[]> {
    const assignments = await db
        .select({ eventId: staffEventAssignments.eventId })
        .from(staffEventAssignments)
        .where(eq(staffEventAssignments.staffId, staffId));
    return assignments.map((a) => a.eventId);
}

async function assertEventAccess(
    staff: { id: number; role: string } | undefined,
    eventId: number
): Promise<boolean> {
    if (!staff || staff.role === "admin") return true;
    const assigned = await getAssignedEventIds(staff.id);
    return assigned.includes(eventId);
}

async function fetchCountryStats(eventId: number) {
    const rows = await db
        .select({ country: users.country, count: count() })
        .from(registrations)
        .leftJoin(users, eq(registrations.userId, users.id))
        .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "confirmed")))
        .groupBy(users.country)
        .orderBy(desc(count()));

    let total = 0;
    let unknown = 0;
    const byCountry: { country: string; count: number }[] = [];

    for (const row of rows) {
        const c = Number(row.count);
        total += c;
        if (!row.country || row.country.trim() === "") {
            unknown += c;
        } else {
            byCountry.push({ country: row.country, count: c });
        }
    }

    return { total, withCountry: total - unknown, unknown, byCountry };
}

async function fetchAddonStats(eventId: number) {
    const hasAddonGroup = (groupNameLower: string) =>
        exists(
            db
                .select({ id: registrationSessions.id })
                .from(registrationSessions)
                .innerJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
                .where(
                    and(
                        eq(registrationSessions.registrationId, registrations.id),
                        eq(ticketTypes.category, "addon"),
                        sql`LOWER(${ticketTypes.groupName}) = ${groupNameLower}`
                    )
                )
        );

    const hasNoAddon = notExists(
        db
            .select({ id: registrationSessions.id })
            .from(registrationSessions)
            .innerJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
            .where(
                and(
                    eq(registrationSessions.registrationId, registrations.id),
                    eq(ticketTypes.category, "addon")
                )
            )
    );

    const baseWhere = and(
        eq(registrations.eventId, eventId),
        eq(registrations.status, "confirmed")
    );

    const [totalRow, galaRow, workshopRow, ticketOnlyRow] = await Promise.all([
        db.select({ c: count() }).from(registrations).where(baseWhere),
        db.select({ c: count() }).from(registrations).where(and(baseWhere, hasAddonGroup("gala"))),
        db.select({ c: count() }).from(registrations).where(and(baseWhere, hasAddonGroup("workshop"))),
        db.select({ c: count() }).from(registrations).where(and(baseWhere, hasNoAddon)),
    ]);

    return {
        total: Number(totalRow[0]?.c ?? 0),
        gala: Number(galaRow[0]?.c ?? 0),
        workshop: Number(workshopRow[0]?.c ?? 0),
        ticketOnly: Number(ticketOnlyRow[0]?.c ?? 0),
    };
}

async function fetchCheckinStats(eventId: number) {
    const conditions = [
        eq(registrations.eventId, eventId),
        eq(registrations.status, "confirmed"),
    ];
    const whereClause = and(...conditions);

    const [{ total }] = await db
        .select({ total: count() })
        .from(registrationSessions)
        .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
        .where(whereClause);

    const [{ checkedIn }] = await db
        .select({ checkedIn: count() })
        .from(registrationSessions)
        .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
        .where(and(...conditions, isNotNull(registrationSessions.checkedInAt)));

    const breakdown = await db
        .select({
            sessionId: sessions.id,
            sessionName: sessions.sessionName,
            sessionType: sessions.sessionType,
            room: sessions.room,
            startTime: sessions.startTime,
            endTime: sessions.endTime,
            total: count(),
            checkedIn: sql<number>`count(case when ${registrationSessions.checkedInAt} is not null then 1 end)`,
        })
        .from(registrationSessions)
        .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
        .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
        .where(and(eq(registrations.eventId, eventId), eq(registrations.status, "confirmed")))
        .groupBy(
            sessions.id,
            sessions.sessionName,
            sessions.sessionType,
            sessions.room,
            sessions.startTime,
            sessions.endTime
        )
        .orderBy(sessions.startTime);

    const sessionBreakdown = breakdown.map((s) => ({
        sessionId: s.sessionId,
        sessionName: s.sessionName,
        sessionType: s.sessionType,
        room: s.room,
        startTime: s.startTime,
        endTime: s.endTime,
        total: s.total,
        checkedIn: Number(s.checkedIn),
        remaining: s.total - Number(s.checkedIn),
        percentage: s.total > 0 ? Math.round((Number(s.checkedIn) / s.total) * 100) : 0,
    }));

    const checkedInNum = Number(checkedIn);
    const totalNum = Number(total);
    const duplicateScans = await getDuplicateCountForEvent(eventId);

    return {
        total: totalNum,
        checkedIn: checkedInNum,
        remaining: totalNum - checkedInNum,
        percentage: totalNum > 0 ? Math.round((checkedInNum / totalNum) * 100) : 0,
        duplicateScans,
        sessionBreakdown,
    };
}

async function fetchMemberStats() {
    const statusStats = await db
        .select({ status: users.status, count: count() })
        .from(users)
        .groupBy(users.status);

    const [{ total }] = await db.select({ total: count() }).from(users);

    return {
        total: Number(total),
        active: Number(statusStats.find((s) => s.status === "active")?.count ?? 0),
        pending: Number(statusStats.find((s) => s.status === "pending_approval")?.count ?? 0),
        rejected: Number(statusStats.find((s) => s.status === "rejected")?.count ?? 0),
    };
}

async function fetchAbstractStats(eventId: number) {
    const statusRows = await db
        .select({ status: abstracts.status, count: count() })
        .from(abstracts)
        .where(eq(abstracts.eventId, eventId))
        .groupBy(abstracts.status);

    const total = statusRows.reduce((sum, r) => sum + Number(r.count), 0);

    return {
        total,
        pending: Number(statusRows.find((r) => r.status === "pending")?.count ?? 0),
        accepted: Number(statusRows.find((r) => r.status === "accepted")?.count ?? 0),
        rejected: Number(statusRows.find((r) => r.status === "rejected")?.count ?? 0),
    };
}

async function fetchFinanceStats(eventId: number) {
    const paidOrders = await db
        .select({
            id: orders.id,
            totalAmount: orders.totalAmount,
            currency: orders.currency,
        })
        .from(orders)
        .where(and(eq(orders.eventId, eventId), eq(orders.status, "paid")));

    if (paidOrders.length === 0) {
        return { totalRevenue: 0, orderCount: 0, currency: "THB", byTicket: [] as { ticketName: string; count: number; amount: number }[] };
    }

    const orderIds = paidOrders.map((o) => o.id);
    const itemRows = await db
        .select({
            ticketName: ticketTypes.name,
            price: orderItems.price,
            quantity: orderItems.quantity,
        })
        .from(orderItems)
        .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
        .where(inArray(orderItems.orderId, orderIds));

    const ticketMap = new Map<string, { count: number; amount: number }>();
    let totalRevenue = 0;

    for (const order of paidOrders) {
        totalRevenue += parseFloat(order.totalAmount) || 0;
    }

    for (const item of itemRows) {
        const key = item.ticketName;
        const existing = ticketMap.get(key) || { count: 0, amount: 0 };
        const itemAmount = (parseFloat(item.price) || 0) * item.quantity;
        ticketMap.set(key, {
            count: existing.count + item.quantity,
            amount: existing.amount + itemAmount,
        });
    }

    return {
        totalRevenue,
        orderCount: paidOrders.length,
        currency: paidOrders[0]?.currency || "THB",
        byTicket: Array.from(ticketMap.entries())
            .map(([ticketName, data]) => ({ ticketName, ...data }))
            .sort((a, b) => b.amount - a.amount),
    };
}

async function fetchRegistrationTrend(eventId: number, from?: Date, to?: Date) {
    const conditions = [
        eq(registrations.eventId, eventId),
        eq(registrations.status, "confirmed"),
    ];

    if (from) {
        conditions.push(sql`${registrations.createdAt} >= ${from}`);
    }
    if (to) {
        conditions.push(sql`${registrations.createdAt} <= ${to}`);
    }

    const rows = await db
        .select({
            date: sql<string>`to_char(date_trunc('day', ${registrations.createdAt} AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD')`,
            count: count(),
        })
        .from(registrations)
        .where(and(...conditions))
        .groupBy(sql`date_trunc('day', ${registrations.createdAt} AT TIME ZONE 'Asia/Bangkok')`)
        .orderBy(asc(sql`date_trunc('day', ${registrations.createdAt} AT TIME ZONE 'Asia/Bangkok')`));

    return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

// ── Routes ─────────────────────────────────────────────────────────────────

export default async function (fastify: FastifyInstance) {
    // GET /reports/overview?eventId=
    fastify.get("/overview", async (request, reply) => {
        const queryResult = reportsEventQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { eventId } = queryResult.data;
        const staff = (request as any).user;

        if (!(await assertEventAccess(staff, eventId))) {
            return reply.status(403).send({ error: "Access denied for this event" });
        }

        try {
            const [countryStats, addonStats, checkinStats, memberStats, abstractStats, financeStats, registrationTrend] =
                await Promise.all([
                    fetchCountryStats(eventId),
                    fetchAddonStats(eventId),
                    fetchCheckinStats(eventId),
                    fetchMemberStats(),
                    fetchAbstractStats(eventId),
                    fetchFinanceStats(eventId),
                    fetchRegistrationTrend(eventId),
                ]);

            return reply.send({
                success: true,
                data: {
                    generatedAt: new Date().toISOString(),
                    eventId,
                    countryStats,
                    addonStats,
                    checkinStats,
                    memberStats,
                    abstractStats,
                    financeStats,
                    registrationTrend: { points: registrationTrend },
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch report overview" });
        }
    });

    // GET /reports/revenue/by-ticket?eventId=
    fastify.get("/revenue/by-ticket", async (request, reply) => {
        const queryResult = reportsEventQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { eventId } = queryResult.data;
        const staff = (request as any).user;

        if (!(await assertEventAccess(staff, eventId))) {
            return reply.status(403).send({ error: "Access denied for this event" });
        }

        try {
            const financeStats = await fetchFinanceStats(eventId);
            return reply.send({
                success: true,
                data: {
                    eventId,
                    total: financeStats.totalRevenue,
                    currency: financeStats.currency,
                    byTicket: financeStats.byTicket,
                },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch revenue stats" });
        }
    });

    // GET /reports/registrations/trend?eventId=&from=&to=
    fastify.get("/registrations/trend", async (request, reply) => {
        const queryResult = reportsTrendQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { eventId, from, to } = queryResult.data;
        const staff = (request as any).user;

        if (!(await assertEventAccess(staff, eventId))) {
            return reply.status(403).send({ error: "Access denied for this event" });
        }

        try {
            const points = await fetchRegistrationTrend(
                eventId,
                from ? new Date(from) : undefined,
                to ? new Date(to) : undefined
            );

            return reply.send({
                success: true,
                data: { eventId, points },
            });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch registration trend" });
        }
    });

    // GET /reports/exports/:type?eventId=&sessionId=&format=csv
    fastify.get("/exports/:type", async (request, reply) => {
        const typeResult = reportsExportTypeSchema.safeParse(
            (request.params as { type: string }).type
        );
        if (!typeResult.success) {
            return reply.status(400).send({ error: "Invalid export type" });
        }

        const queryResult = reportsExportQuerySchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const exportType = typeResult.data;
        const { eventId, sessionId, format, status, presentationType } = queryResult.data;
        const staff = (request as any).user;

        if (format !== "csv") {
            return reply.status(400).send({ error: "Only csv format is supported" });
        }

        if (presentationType && status !== "accepted") {
            return reply.status(400).send({
                error: "presentationType filter is only available when status=accepted",
            });
        }

        if (exportType !== "members" && !eventId) {
            return reply.status(400).send({ error: "eventId is required for this export" });
        }

        if (exportType === "sessions" && !sessionId) {
            return reply.status(400).send({ error: "sessionId is required for session export" });
        }

        if (eventId && !(await assertEventAccess(staff, eventId))) {
            return reply.status(403).send({ error: "Access denied for this event" });
        }

        try {
            switch (exportType) {
                case "registrations": {
                    const rows = await db
                        .select({
                            regCode: registrations.regCode,
                            firstName: registrations.firstName,
                            middleName: registrations.middleName,
                            lastName: registrations.lastName,
                            email: registrations.email,
                            country: users.country,
                            ticketName: ticketTypes.name,
                            status: registrations.status,
                            source: registrations.source,
                            addedNote: registrations.addedNote,
                            addedByFirstName: backofficeUsers.firstName,
                            addedByLastName: backofficeUsers.lastName,
                            createdAt: registrations.createdAt,
                        })
                        .from(registrations)
                        .leftJoin(users, eq(registrations.userId, users.id))
                        .leftJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
                        .leftJoin(backofficeUsers, eq(registrations.addedBy, backofficeUsers.id))
                        .where(
                            and(
                                eq(registrations.eventId, eventId!),
                                eq(registrations.status, "confirmed")
                            )
                        )
                        .orderBy(desc(registrations.createdAt));

                    const [event] = await db
                        .select({ eventCode: events.eventCode })
                        .from(events)
                        .where(eq(events.id, eventId!))
                        .limit(1);

                    return sendCsv(
                        reply,
                        `registrations_${event?.eventCode || eventId}.csv`,
                        [
                            "Reg Code", "First Name", "Middle Name", "Last Name", "Email",
                            "Country", "Ticket", "Status", "Source", "Note", "Added By", "Created At",
                        ],
                        rows.map((r) => [
                            r.regCode,
                            r.firstName,
                            r.middleName,
                            r.lastName,
                            r.email,
                            r.country,
                            r.ticketName,
                            r.status,
                            r.source,
                            r.addedNote,
                            r.addedByFirstName
                                ? getFullName(r.addedByFirstName, null, r.addedByLastName || '')
                                : "",
                            new Date(r.createdAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
                        ])
                    );
                }

                case "orders": {
                    const orderRows = await db
                        .select({
                            orderNumber: orders.orderNumber,
                            totalAmount: orders.totalAmount,
                            currency: orders.currency,
                            status: orders.status,
                            promoCode: orders.promoCode,
                            createdAt: orders.createdAt,
                            userEmail: users.email,
                            userFirstName: users.firstName,
                            userMiddleName: users.middleName,
                            userLastName: users.lastName,
                            userCountry: users.country,
                            userInstitution: users.institution,
                            orderId: orders.id,
                        })
                        .from(orders)
                        .innerJoin(users, eq(orders.userId, users.id))
                        .where(and(eq(orders.eventId, eventId!), eq(orders.status, "paid")))
                        .orderBy(desc(orders.createdAt));

                    const orderIds = orderRows.map((o) => o.orderId);
                    let paymentMap: Record<number, { channel: string | null; paidAt: Date | null }> = {};
                    let itemsMap: Record<number, string> = {};

                    if (orderIds.length > 0) {
                        const paymentRows = await db
                            .select({
                                orderId: payments.orderId,
                                channel: payments.paymentChannel,
                                paidAt: payments.paidAt,
                                status: payments.status,
                            })
                            .from(payments)
                            .where(inArray(payments.orderId, orderIds));

                        for (const p of paymentRows) {
                            if (!paymentMap[p.orderId] || p.status === "paid") {
                                paymentMap[p.orderId] = { channel: p.channel, paidAt: p.paidAt };
                            }
                        }

                        const itemRows = await db
                            .select({
                                orderId: orderItems.orderId,
                                ticketName: ticketTypes.name,
                                quantity: orderItems.quantity,
                            })
                            .from(orderItems)
                            .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
                            .where(inArray(orderItems.orderId, orderIds));

                        for (const item of itemRows) {
                            const part = `${item.ticketName} x${item.quantity}`;
                            itemsMap[item.orderId] = itemsMap[item.orderId]
                                ? `${itemsMap[item.orderId]}; ${part}`
                                : part;
                        }
                    }

                    const [event] = await db
                        .select({ eventCode: events.eventCode })
                        .from(events)
                        .where(eq(events.id, eventId!))
                        .limit(1);

                    return sendCsv(
                        reply,
                        `orders_${event?.eventCode || eventId}.csv`,
                        [
                            "Order Number", "Total Amount", "Currency", "Status", "Promo Code",
                            "User Name", "Email", "Country", "Institution",
                            "Payment Channel", "Paid At", "Items", "Created At",
                        ],
                        orderRows.map((o) => [
                            o.orderNumber,
                            o.totalAmount,
                            o.currency,
                            o.status,
                            o.promoCode,
                            getFullName(o.userFirstName, o.userMiddleName, o.userLastName),
                            o.userEmail,
                            o.userCountry,
                            o.userInstitution,
                            paymentMap[o.orderId]?.channel,
                            paymentMap[o.orderId]?.paidAt
                                ? new Date(paymentMap[o.orderId].paidAt!).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })
                                : "",
                            itemsMap[o.orderId] || "",
                            new Date(o.createdAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
                        ])
                    );
                }

                case "members": {
                    const memberRows = await db
                        .select({
                            email: users.email,
                            firstName: users.firstName,
                            middleName: users.middleName,
                            lastName: users.lastName,
                            role: users.role,
                            status: users.status,
                            phone: users.phone,
                            country: users.country,
                            institution: users.institution,
                            createdAt: users.createdAt,
                        })
                        .from(users)
                        .orderBy(desc(users.createdAt));

                    return sendCsv(
                        reply,
                        "members.csv",
                        [
                            "Email", "First Name", "Middle Name", "Last Name",
                            "Role", "Status", "Phone", "Country", "Institution", "Created At",
                        ],
                        memberRows.map((m) => [
                            m.email,
                            m.firstName,
                            m.middleName,
                            m.lastName,
                            m.role,
                            m.status,
                            m.phone,
                            m.country,
                            m.institution,
                            new Date(m.createdAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
                        ])
                    );
                }

                case "checkins": {
                    const checkinRows = await db
                        .select({
                            regCode: registrations.regCode,
                            firstName: registrations.firstName,
                            middleName: registrations.middleName,
                            lastName: registrations.lastName,
                            email: registrations.email,
                            ticketName: ticketTypes.name,
                            sessionName: sessions.sessionName,
                            eventName: events.eventName,
                            scannedAt: registrationSessions.checkedInAt,
                            scannerFirstName: backofficeUsers.firstName,
                            scannerLastName: backofficeUsers.lastName,
                        })
                        .from(registrationSessions)
                        .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                        .leftJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
                        .leftJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
                        .leftJoin(events, eq(registrations.eventId, events.id))
                        .leftJoin(backofficeUsers, eq(registrationSessions.checkedInBy, backofficeUsers.id))
                        .where(
                            and(
                                eq(registrations.eventId, eventId!),
                                isNotNull(registrationSessions.checkedInAt)
                            )
                        )
                        .orderBy(desc(registrationSessions.checkedInAt));

                    const [event] = await db
                        .select({ eventCode: events.eventCode })
                        .from(events)
                        .where(eq(events.id, eventId!))
                        .limit(1);

                    return sendCsv(
                        reply,
                        `checkins_${event?.eventCode || eventId}.csv`,
                        [
                            "Reg Code", "First Name", "Middle Name", "Last Name", "Email",
                            "Ticket", "Session", "Event", "Scanned At", "Scanned By",
                        ],
                        checkinRows.map((c) => [
                            c.regCode,
                            c.firstName,
                            c.middleName,
                            c.lastName,
                            c.email,
                            c.ticketName,
                            c.sessionName,
                            c.eventName,
                            c.scannedAt
                                ? new Date(c.scannedAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })
                                : "",
                            c.scannerFirstName
                                ? getFullName(c.scannerFirstName, null, c.scannerLastName || '')
                                : "",
                        ])
                    );
                }

                case "abstracts": {
                    const abstractConditions = [eq(abstracts.eventId, eventId!)];
                    if (status) abstractConditions.push(eq(abstracts.status, status));
                    if (presentationType) abstractConditions.push(eq(abstracts.presentationType, presentationType));

                    const abstractRows = await db
                        .select({
                            trackingId: abstracts.trackingId,
                            title: abstracts.title,
                            category: abstracts.category,
                            presentationType: abstracts.presentationType,
                            status: abstracts.status,
                            keywords: abstracts.keywords,
                            createdAt: abstracts.createdAt,
                            authorFirstName: users.firstName,
                            authorMiddleName: users.middleName,
                            authorLastName: users.lastName,
                            authorEmail: users.email,
                            authorInstitution: users.institution,
                            authorCountry: users.country,
                        })
                        .from(abstracts)
                        .leftJoin(users, eq(abstracts.userId, users.id))
                        .where(and(...abstractConditions))
                        .orderBy(desc(abstracts.createdAt));

                    const [event] = await db
                        .select({ eventCode: events.eventCode })
                        .from(events)
                        .where(eq(events.id, eventId!))
                        .limit(1);

                    const suffix = [
                        status || "all",
                        presentationType || "",
                    ].filter(Boolean).join("_");

                    return sendCsv(
                        reply,
                        `abstracts_${event?.eventCode || eventId}_${suffix}.csv`,
                        [
                            "Tracking ID", "Title", "Category", "Presentation Type", "Status",
                            "Author First Name", "Author Middle Name", "Author Last Name",
                            "Author Email", "Author Institution", "Author Country",
                            "Keywords", "Submitted At",
                        ],
                        abstractRows.map((a) => [
                            a.trackingId,
                            a.title,
                            a.category,
                            a.presentationType,
                            a.status,
                            a.authorFirstName,
                            a.authorMiddleName,
                            a.authorLastName,
                            a.authorEmail,
                            a.authorInstitution,
                            a.authorCountry,
                            a.keywords,
                            new Date(a.createdAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
                        ])
                    );
                }

                case "sessions": {
                    const [session] = await db
                        .select({ sessionCode: sessions.sessionCode })
                        .from(sessions)
                        .where(eq(sessions.id, sessionId!))
                        .limit(1);

                    if (!session) {
                        return reply.status(404).send({ error: "Session not found" });
                    }

                    const participantRows = await db
                        .select({
                            regCode: registrations.regCode,
                            firstName: registrations.firstName,
                            middleName: registrations.middleName,
                            lastName: registrations.lastName,
                            email: registrations.email,
                            phone: users.phone,
                            institution: users.institution,
                            ticketName: ticketTypes.name,
                            regStatus: registrations.status,
                            checkedInAt: registrationSessions.checkedInAt,
                            createdAt: registrations.createdAt,
                        })
                        .from(registrationSessions)
                        .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                        .leftJoin(users, eq(registrations.userId, users.id))
                        .leftJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
                        .where(
                            and(
                                eq(registrationSessions.sessionId, sessionId!),
                                eq(registrations.status, "confirmed")
                            )
                        )
                        .orderBy(registrations.lastName, registrations.firstName);

                    return sendCsv(
                        reply,
                        `session_${session.sessionCode}_participants.csv`,
                        [
                            "Reg Code", "First Name", "Middle Name", "Last Name", "Email",
                            "Phone", "Institution", "Ticket", "Status", "Checked In At", "Registered At",
                        ],
                        participantRows.map((r) => [
                            r.regCode,
                            r.firstName,
                            r.middleName,
                            r.lastName,
                            r.email,
                            r.phone,
                            r.institution,
                            r.ticketName,
                            r.regStatus,
                            r.checkedInAt
                                ? new Date(r.checkedInAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" })
                                : "",
                            new Date(r.createdAt).toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }),
                        ])
                    );
                }

                default:
                    return reply.status(400).send({ error: "Unknown export type" });
            }
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to generate export" });
        }
    });
}
