/**
 * Invitation Letter Generator
 *
 * Renders the ACCP 2026 invitation letter (.docx template) with paid-user data
 * and optionally converts it to PDF via LibreOffice.
 *
 * Template path: src/templates/accp-letter-template.docx
 *
 * Placeholders supported:
 *   {participantName}  → e.g. "Mr. Somchai Jaidee, Pharmacist"
 *   {issueDate}        → e.g. "April 21, 2026" (English long format)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import * as libre from "libreoffice-convert";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In dev (tsx) __dirname = src/services, in prod __dirname = dist/services
// Templates live at src/templates/ in dev OR dist/templates/ in prod (after copy)
function resolveTemplatePath(filename: string): string {
  const candidates = [
    path.resolve(__dirname, "..", "templates", filename),
    path.resolve(__dirname, "..", "..", "src", "templates", filename),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(
    `Template not found (${filename}). Looked in:\n${candidates.join("\n")}`
  );
}

/** Generic .docx template renderer using docxtemplater. */
async function renderDocxTemplate(
  templateFilename: string,
  data: Record<string, string>
): Promise<Buffer> {
  const templatePath = resolveTemplatePath(templateFilename);
  const content = fs.readFileSync(templatePath);
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });
  doc.render(data);
  return doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

/** Convert a .docx buffer to PDF via LibreOffice. */
async function docxBufferToPdf(docxBuf: Buffer): Promise<Buffer> {
  const sofficePaths = process.env.LIBREOFFICE_PATH
    ? [process.env.LIBREOFFICE_PATH]
    : undefined;
  return new Promise<Buffer>((resolve, reject) => {
    libre.convertWithOptions(
      docxBuf,
      ".pdf",
      undefined,
      { sofficeBinaryPaths: sofficePaths },
      (err, pdfBuf) => {
        if (err) reject(err);
        else resolve(pdfBuf);
      }
    );
  });
}

export interface LetterData {
  /** Full display name to insert, e.g. "Mr. Somchai Jaidee, Pharmacist" */
  participantName: string;
  /** Issue date string, e.g. "April 21, 2026" */
  issueDate: string;
}

/**
 * Render the invitation letter .docx with the supplied data.
 */
export async function renderLetterDocx(data: LetterData): Promise<Buffer> {
  return renderDocxTemplate("accp-letter-template.docx", {
    participantName: data.participantName,
    issueDate: data.issueDate,
  });
}

/**
 * Render the invitation letter and convert to PDF via LibreOffice.
 * Requires `libreoffice` binary on PATH (configurable via LIBREOFFICE_PATH).
 */
export async function renderLetterPdf(data: LetterData): Promise<Buffer> {
  return docxBufferToPdf(await renderLetterDocx(data));
}

export interface AbstractAcceptData {
  /** Participant full name, e.g. "Somchai Jaidee" */
  participantName: string;
  /** Acceptance date, e.g. "April 23, 2026" */
  acceptDate: string;
  /** "Oral" or "Poster" (title-cased) */
  presentationType: string;
  /** Abstract paper title */
  abstractTitle: string;
}

/** Render the abstract-accepted letter .docx (works for both Oral and Poster). */
export async function renderAbstractAcceptDocx(
  data: AbstractAcceptData
): Promise<Buffer> {
  return renderDocxTemplate("accp-abstract-accept-template.docx", {
    participantName: data.participantName,
    acceptDate: data.acceptDate,
    presentationType: data.presentationType,
    abstractTitle: data.abstractTitle,
  });
}

/** Render the abstract-accepted letter and convert to PDF via LibreOffice. */
export async function renderAbstractAcceptPdf(
  data: AbstractAcceptData
): Promise<Buffer> {
  return docxBufferToPdf(await renderAbstractAcceptDocx(data));
}

/** Capitalise the first letter ("oral" → "Oral"). */
export function titleCasePresentationType(t: string): string {
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/**
 * Build a participant display name (full name only, no institution).
 */
export function buildParticipantName(parts: {
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
}): string {
  const name = [parts.firstName, parts.middleName, parts.lastName]
    .filter((s) => s && s.trim().length > 0)
    .join(" ")
    .trim();
  return name || "[Participant]";
}

/** Format a Date as "April 21, 2026" (English long form). */
export function formatIssueDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
