import { db } from "../database/index.js";
import {
    checkInScanLogs,
    registrationSessions,
} from "../database/schema.js";
import { and, count, eq } from "drizzle-orm";
import type { FastifyReply } from "fastify";

type RegSessionRow = {
    id: number;
    sessionId: number;
    checkedInAt: Date | null;
    session?: { sessionName?: string } | null;
    ticketType?: { name?: string } | null;
};

type RegistrationRow = {
    id: number;
    eventId: number;
    regCode: string;
    firstName: string;
    middleName?: string | null;
    lastName: string;
    ticketType?: { name?: string } | null;
    event?: { eventName?: string } | null;
};

export async function logCheckInScan(
    regSession: RegSessionRow,
    registration: RegistrationRow,
    staffUserId: number | undefined,
    isDuplicate: boolean
) {
    await db.insert(checkInScanLogs).values({
        registrationSessionId: regSession.id,
        registrationId: registration.id,
        eventId: registration.eventId,
        sessionId: regSession.sessionId,
        isDuplicate,
        scannedBy: staffUserId ?? null,
    });
}

export async function getDuplicateCountForSession(registrationSessionId: number): Promise<number> {
    const [{ total }] = await db
        .select({ total: count() })
        .from(checkInScanLogs)
        .where(
            and(
                eq(checkInScanLogs.registrationSessionId, registrationSessionId),
                eq(checkInScanLogs.isDuplicate, true)
            )
        );
    return Number(total);
}

export async function getDuplicateCountForEvent(eventId: number): Promise<number> {
    const [{ total }] = await db
        .select({ total: count() })
        .from(checkInScanLogs)
        .where(and(eq(checkInScanLogs.eventId, eventId), eq(checkInScanLogs.isDuplicate, true)));
    return Number(total);
}

export function registrationPayload(registration: RegistrationRow) {
    return {
        regCode: registration.regCode,
        firstName: registration.firstName,
        middleName: registration.middleName ?? null,
        lastName: registration.lastName,
        ticketName: registration.ticketType?.name,
        eventName: registration.event?.eventName,
    };
}

export async function respondAlreadyCheckedIn(
    reply: FastifyReply,
    regSession: RegSessionRow,
    registration: RegistrationRow,
    staffUserId: number | undefined,
    message = "Already checked in"
) {
    await logCheckInScan(regSession, registration, staffUserId, true);
    const duplicateCount = await getDuplicateCountForSession(regSession.id);

    return reply.status(409).send({
        error: message,
        code: "ALREADY_CHECKED_IN",
        duplicateCount,
        checkedInAt: regSession.checkedInAt,
        sessionName: regSession.session?.sessionName,
        registration: registrationPayload(registration),
    });
}

export async function completeCheckIn(
    regSession: RegSessionRow,
    registration: RegistrationRow,
    staffUserId: number | undefined
) {
    await db
        .update(registrationSessions)
        .set({ checkedInAt: new Date(), checkedInBy: staffUserId })
        .where(eq(registrationSessions.id, regSession.id));

    await logCheckInScan(regSession, registration, staffUserId, false);
}
