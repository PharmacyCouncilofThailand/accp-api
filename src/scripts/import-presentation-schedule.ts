import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { abstracts } from "../database/schema.js";
import {
  normalizeTime,
  normalizeTrackingId,
  parseTimeRange,
} from "../utils/abstractSchedule.js";

config({ path: "./.env" });

const ORAL_DATE = "2026-07-11";

type OralEntry = {
  trackingId: string;
  room: string;
  startTime: string;
  endTime: string;
  presentationDate: string;
};

type PosterEntry = {
  trackingId: string;
  boardNumber: string;
  presentationDate: string;
  presentationStartTime: string;
  presentationEndTime: string;
  posterInstallationStart: string;
  posterInstallationEnd: string;
  posterRemovalStart: string;
  posterRemovalEnd: string;
};

const POSTER_GROUP_A = {
  min: 5,
  max: 207,
  presentationDate: "2026-07-10",
  installation: { start: "09:45", end: "10:15" },
  presentation: { start: "13:10", end: "14:10" },
  removal: { start: "16:15", end: "16:45" },
};

const POSTER_GROUP_B = {
  min: 208,
  max: 340,
  presentationDate: "2026-07-11",
  installation: { start: "16:45", end: "17:15" },
  presentation: { start: "09:00", end: "10:00" },
  removal: { start: "14:00", end: "14:30" },
};

function extractRoomName(line: string): string | null {
  const match = line.match(/^## \*\*(.+?) — Oral Presentation Room \d+\*\*/);
  return match?.[1]?.trim() ?? null;
}

function parseOralSchedule(content: string): OralEntry[] {
  const entries: OralEntry[] = [];
  let currentRoom: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const room = extractRoomName(line);
    if (room) {
      currentRoom = room;
      continue;
    }

    if (!currentRoom || !line.startsWith("|")) continue;
    if (line.includes("---") || line.includes("Time")) continue;

    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) continue;

    const timeRange = parseTimeRange(cells[0]);
    const trackingId = normalizeTrackingId(cells[1]);
    if (!timeRange || !trackingId) continue;

    entries.push({
      trackingId,
      room: currentRoom,
      startTime: timeRange.start,
      endTime: timeRange.end,
      presentationDate: ORAL_DATE,
    });
  }

  return entries;
}

function extractPosterTrackingId(raw: string): string | null {
  const cleaned = raw.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ");
  const match = cleaned.match(/ACCP2026\s*-?\s*P\s*\d+/i);
  if (!match) return null;
  return normalizeTrackingId(match[0]);
}

function posterNumberFromTrackingId(trackingId: string): number | null {
  const match = trackingId.match(/^ACCP2026-P(\d+)$/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

function posterTimingForTrackingId(trackingId: string) {
  const posterNum = posterNumberFromTrackingId(trackingId);
  if (posterNum == null) return null;
  if (posterNum >= POSTER_GROUP_A.min && posterNum <= POSTER_GROUP_A.max) {
    return POSTER_GROUP_A;
  }
  if (posterNum >= POSTER_GROUP_B.min && posterNum <= POSTER_GROUP_B.max) {
    return POSTER_GROUP_B;
  }
  return null;
}

function parsePosterSchedule(content: string): PosterEntry[] {
  const entries: PosterEntry[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    if (line.includes("---") || line.includes("Poster")) continue;

    const cells = line.split("|").map((cell) => cell.replace(/\*\*/g, "").trim()).filter(Boolean);
    if (cells.length < 2) continue;

    const boardNumber = cells[0].replace(/\D/g, "").padStart(3, "0");
    const trackingId = extractPosterTrackingId(cells[1]);
    if (!trackingId || !boardNumber) continue;

    const timing = posterTimingForTrackingId(trackingId);
    if (!timing) continue;

    entries.push({
      trackingId,
      boardNumber,
      presentationDate: timing.presentationDate,
      presentationStartTime: timing.presentation.start,
      presentationEndTime: timing.presentation.end,
      posterInstallationStart: timing.installation.start,
      posterInstallationEnd: timing.installation.end,
      posterRemovalStart: timing.removal.start,
      posterRemovalEnd: timing.removal.end,
    });
  }

  return entries;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined");
  }

  const oralPath =
    process.argv[2] ??
    resolve(
      process.cwd(),
      "data/schedules/oral-presentation-schedule-accp2026.md",
    );
  const posterPath =
    process.argv[3] ??
    resolve(
      process.cwd(),
      "data/schedules/poster-presentation-schedule-accp2026.md",
    );

  const oralContent = readFileSync(oralPath, "utf8");
  const posterContent = readFileSync(posterPath, "utf8");
  const oralEntries = parseOralSchedule(oralContent);
  const posterEntries = parsePosterSchedule(posterContent);

  console.log(`Parsed ${oralEntries.length} oral entries`);
  console.log(`Parsed ${posterEntries.length} poster entries`);

  const client = postgres(process.env.DATABASE_URL);
  const db = drizzle(client);

  const allAbstracts = await db
    .select({ id: abstracts.id, trackingId: abstracts.trackingId })
    .from(abstracts);

  const trackingMap = new Map<string, number>();
  for (const row of allAbstracts) {
    if (!row.trackingId) continue;
    const normalized = normalizeTrackingId(row.trackingId);
    if (normalized) trackingMap.set(normalized, row.id);
  }

  let oralUpdated = 0;
  let oralMissing = 0;
  for (const entry of oralEntries) {
    const abstractId = trackingMap.get(entry.trackingId);
    if (!abstractId) {
      oralMissing += 1;
      console.warn(`Oral not found in DB: ${entry.trackingId}`);
      continue;
    }

    await db
      .update(abstracts)
      .set({
        presentationDate: entry.presentationDate,
        presentationRoom: entry.room,
        presentationStartTime: entry.startTime,
        presentationEndTime: entry.endTime,
        updatedAt: new Date(),
      })
      .where(eq(abstracts.id, abstractId));

    oralUpdated += 1;
  }

  let posterUpdated = 0;
  let posterMissing = 0;
  for (const entry of posterEntries) {
    const abstractId = trackingMap.get(entry.trackingId);
    if (!abstractId) {
      posterMissing += 1;
      console.warn(`Poster not found in DB: ${entry.trackingId}`);
      continue;
    }

    await db
      .update(abstracts)
      .set({
        presentationDate: entry.presentationDate,
        posterBoardNumber: entry.boardNumber,
        presentationStartTime: entry.presentationStartTime,
        presentationEndTime: entry.presentationEndTime,
        posterInstallationStart: entry.posterInstallationStart,
        posterInstallationEnd: entry.posterInstallationEnd,
        posterRemovalStart: entry.posterRemovalStart,
        posterRemovalEnd: entry.posterRemovalEnd,
        updatedAt: new Date(),
      })
      .where(eq(abstracts.id, abstractId));

    posterUpdated += 1;
  }

  await client.end();

  console.log(`Oral updated: ${oralUpdated}, missing: ${oralMissing}`);
  console.log(`Poster updated: ${posterUpdated}, missing: ${posterMissing}`);
  console.log("Import complete");
}

main().catch((error) => {
  console.error("Import failed:", error);
  process.exit(1);
});
