import type { abstracts } from "../database/schema.js";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { abstracts as abstractsTable } from "../database/schema.js";

type AbstractScheduleRow = Pick<
  typeof abstracts.$inferSelect,
  | "presentationType"
  | "presentationDate"
  | "presentationRoom"
  | "presentationStartTime"
  | "presentationEndTime"
  | "posterBoardNumber"
  | "posterInstallationStart"
  | "posterInstallationEnd"
  | "posterRemovalStart"
  | "posterRemovalEnd"
>;

export type TimeRange = { start: string; end: string };

export type AbstractScheduleResponse = {
  date: string | null;
  room: string | null;
  startTime: string | null;
  endTime: string | null;
  boardNumber: string | null;
  installation: TimeRange | null;
  presentation: TimeRange | null;
  removal: TimeRange | null;
};

const toTimeRange = (
  start: string | null | undefined,
  end: string | null | undefined,
): TimeRange | null => {
  if (!start || !end) return null;
  return { start, end };
};

export const formatScheduleDate = (value: string | Date | null | undefined): string | null => {
  if (!value) return null;
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value;
};

export const buildAbstractScheduleResponse = (
  row: AbstractScheduleRow,
): AbstractScheduleResponse | null => {
  const date = formatScheduleDate(row.presentationDate);
  const presentation = toTimeRange(row.presentationStartTime, row.presentationEndTime);
  const installation = toTimeRange(row.posterInstallationStart, row.posterInstallationEnd);
  const removal = toTimeRange(row.posterRemovalStart, row.posterRemovalEnd);

  if (row.presentationType === "oral") {
    if (!row.presentationRoom && !presentation && !date) return null;
    return {
      date,
      room: row.presentationRoom ?? null,
      startTime: row.presentationStartTime ?? null,
      endTime: row.presentationEndTime ?? null,
      boardNumber: null,
      installation: null,
      presentation,
      removal: null,
    };
  }

  if (
    !row.posterBoardNumber &&
    !presentation &&
    !date &&
    !installation &&
    !removal
  ) {
    return null;
  }

  return {
    date,
    room: null,
    startTime: row.presentationStartTime ?? null,
    endTime: row.presentationEndTime ?? null,
    boardNumber: row.posterBoardNumber ?? null,
    installation,
    presentation,
    removal,
  };
};

export const normalizeTrackingId = (raw: string): string | null => {
  const cleaned = raw.replace(/<br\s*\/?>/gi, "").replace(/\s+/g, "").toUpperCase();
  const match = cleaned.match(/^(ACCP2026)-(O|P)(\d+)$/);
  if (!match) return null;
  const num = parseInt(match[3], 10);
  return `${match[1]}-${match[2]}${String(num).padStart(3, "0")}`;
};

export const normalizeTime = (value: string): string => {
  const trimmed = value.trim().replace(/\./g, ":");
  const match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return trimmed;
  return `${match[1].padStart(2, "0")}:${match[2]}`;
};

export const parseTimeRange = (value: string): { start: string; end: string } | null => {
  const parts = value.split("-").map((part) => part.trim());
  if (parts.length !== 2) return null;
  return {
    start: normalizeTime(parts[0]),
    end: normalizeTime(parts[1]),
  };
};

export const hasScheduledLocation = (
  presentationType: "oral" | "poster",
  schedule: AbstractScheduleResponse | null,
): boolean => {
  if (!schedule) return false;
  if (presentationType === "oral") {
    return Boolean(schedule.room?.trim());
  }
  return Boolean(schedule.boardNumber?.trim());
};

export const scheduledAbstractLocationCondition = () =>
  and(
    eq(abstractsTable.status, "accepted"),
    or(
      and(
        eq(abstractsTable.presentationType, "oral"),
        isNotNull(abstractsTable.presentationRoom),
        sql`trim(${abstractsTable.presentationRoom}) <> ''`,
      ),
      and(
        eq(abstractsTable.presentationType, "poster"),
        isNotNull(abstractsTable.posterBoardNumber),
        sql`trim(${abstractsTable.posterBoardNumber}) <> ''`,
      ),
    ),
  );

export const formatScheduleDisplayDate = (
  value: string | Date | null | undefined,
): string | null => {
  const iso = formatScheduleDate(value);
  if (!iso) return null;
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Bangkok",
  });
};

export const buildScheduleDetailLines = (
  row: AbstractScheduleRow,
): string[] => {
  const schedule = buildAbstractScheduleResponse(row);
  if (!schedule) return [];

  const lines: string[] = [];
  if (row.presentationType === "oral") {
    if (schedule.room) lines.push(`Room: ${schedule.room}`);
    const date = formatScheduleDisplayDate(schedule.date);
    if (date) lines.push(`Date: ${date}`);
    if (schedule.presentation) {
      lines.push(`Time: ${schedule.presentation.start} – ${schedule.presentation.end}`);
    }
    return lines;
  }

  if (schedule.boardNumber) lines.push(`Poster Board: #${schedule.boardNumber}`);
  const date = formatScheduleDisplayDate(schedule.date);
  if (date) lines.push(`Presentation Date: ${date}`);
  if (schedule.presentation) {
    lines.push(
      `Presentation Time: ${schedule.presentation.start} – ${schedule.presentation.end}`,
    );
  }
  if (schedule.installation) {
    lines.push(
      `Installation: ${schedule.installation.start} – ${schedule.installation.end}`,
    );
  }
  if (schedule.removal) {
    lines.push(`Removal: ${schedule.removal.start} – ${schedule.removal.end}`);
  }
  return lines;
};
