import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEDULE_FILES = {
  oral: {
    fileName: "oral presentation schedule ACCP 2026.pdf",
    attachmentName: "ACCP2026-Oral-Presentation-Schedule.pdf",
  },
  poster: {
    fileName: "poster presentation schedule ACCP 2026.pdf",
    attachmentName: "ACCP2026-Poster-Presentation-Schedule.pdf",
  },
} as const;

function resolveSchedulePdfPath(type: "oral" | "poster"): string | null {
  const { fileName } = SCHEDULE_FILES[type];
  const candidates = [
    process.env[`${type.toUpperCase()}_SCHEDULE_PDF_PATH`],
    join(process.cwd(), "public/documents/schedule", fileName),
    join(process.cwd(), "assets/documents/schedule", fileName),
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadPresentationSchedulePdf(type: "oral" | "poster"): {
  pdf: Buffer;
  fileName: string;
} | null {
  const filePath = resolveSchedulePdfPath(type);
  if (!filePath) return null;

  return {
    pdf: readFileSync(filePath),
    fileName: SCHEDULE_FILES[type].attachmentName,
  };
}

export function getPresentationSchedulePdfPreviewUrl(type: "oral" | "poster"): string {
  return `/public/documents/schedule/${encodeURIComponent(SCHEDULE_FILES[type].fileName)}`;
}
