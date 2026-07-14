import { db } from "../database/index.js";
import {
  registrations,
  registrationSessions,
  users,
  abstracts,
  backofficeUsers,
  speakers,
  eventSpeakers,
} from "../database/schema.js";
import { and, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { formatCertificateName } from "../utils/certificateName.js";
import { getCertificateTemplate } from "./certificatePdf.service.js";
import type { CertificateRecipientInput } from "../schemas/certificates.schema.js";
import type { z } from "zod";
import type { certificateDatabaseFilterSchema } from "../schemas/certificates.schema.js";

type DbFilter = z.infer<typeof certificateDatabaseFilterSchema>;

export interface ResolvedCertificateRecipient extends CertificateRecipientInput {
  certificateName: string;
  warnings: string[];
}

const HEADER_ALIASES: Record<string, keyof CertificateRecipientInput> = {
  title_prefix: "titlePrefix",
  title: "titlePrefix",
  prefix: "titlePrefix",
  honorific: "titlePrefix",
  first_name: "firstName",
  firstname: "firstName",
  first: "firstName",
  middle_name: "middleName",
  middlename: "middleName",
  middle: "middleName",
  last_name: "lastName",
  lastname: "lastName",
  last: "lastName",
  surname: "lastName",
  email: "email",
  institution: "institution",
  certificate_name: "certificateNameOverride",
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, "_");
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current);
  return values.map((v) => v.trim());
}

export function parseCertificateCsv(content: string): {
  recipients: CertificateRecipientInput[];
  errors: Array<{ row: number; field?: string; message: string }>;
  warnings: Array<{ row: number; code: string; message: string }>;
} {
  const lines = content
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return {
      recipients: [],
      errors: [{ row: 0, message: "File is empty" }],
      warnings: [],
    };
  }

  const headers = parseCsvLine(lines[0]).map(normalizeHeader);
  const recipients: CertificateRecipientInput[] = [];
  const errors: Array<{ row: number; field?: string; message: string }> = [];
  const warnings: Array<{ row: number; code: string; message: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const rowNumber = i + 1;
    const values = parseCsvLine(lines[i]);
    const row: Partial<CertificateRecipientInput> = {
      sourceType: "upload",
    };

    headers.forEach((header, index) => {
      const field = HEADER_ALIASES[header];
      if (!field) return;
      const value = values[index]?.trim() ?? "";
      if (!value) return;
      (row as Record<string, string>)[field] = value;
    });

    if (!row.titlePrefix) {
      errors.push({
        row: rowNumber,
        field: "title_prefix",
        message: "title_prefix is required",
      });
      continue;
    }
    if (!row.firstName) {
      errors.push({
        row: rowNumber,
        field: "first_name",
        message: "first_name is required",
      });
      continue;
    }
    if (!row.lastName) {
      errors.push({
        row: rowNumber,
        field: "last_name",
        message: "last_name is required",
      });
      continue;
    }

    recipients.push(row as CertificateRecipientInput);
  }

  const seen = new Map<string, number>();
  recipients.forEach((recipient, index) => {
    const key = formatCertificateName(recipient).toLowerCase();
    if (seen.has(key)) {
      warnings.push({
        row: index + 2,
        code: "DUPLICATE_NAME",
        message: `Duplicate of row ${seen.get(key)}`,
      });
    } else {
      seen.set(key, index + 2);
    }
  });

  return { recipients, errors, warnings };
}

function enrichRecipient(
  recipient: CertificateRecipientInput,
): ResolvedCertificateRecipient {
  const warnings: string[] = [];
  if (!recipient.titlePrefix?.trim()) {
    warnings.push("missing_title_prefix");
  }
  const certificateName = formatCertificateName(recipient);
  return {
    ...recipient,
    titlePrefix: recipient.titlePrefix?.trim() ?? "",
    firstName: recipient.firstName?.trim() ?? "",
    middleName: recipient.middleName?.trim() || null,
    lastName: recipient.lastName?.trim() ?? "",
    email: recipient.email?.trim() || null,
    institution: recipient.institution?.trim() || null,
    certificateName,
    warnings,
  };
}

async function resolveRegistrations(
  filter: DbFilter,
): Promise<CertificateRecipientInput[]> {
  const conditions = [eq(registrations.status, "confirmed")];

  if (filter.eventId) {
    conditions.push(eq(registrations.eventId, filter.eventId));
  }
  if (filter.checkedIn) {
    conditions.push(isNotNull(registrationSessions.checkedInAt));
  }
  if (filter.search?.trim()) {
    const q = `%${filter.search.trim()}%`;
    conditions.push(
      or(
        ilike(registrations.firstName, q),
        ilike(registrations.lastName, q),
        ilike(registrations.email, q),
        ilike(users.firstName, q),
        ilike(users.lastName, q),
        ilike(users.email, q),
      )!,
    );
  }

  const rows = await db
    .select({
      id: registrations.id,
      firstName: sql<string>`COALESCE(NULLIF(${registrations.firstName}, ''), ${users.firstName})`,
      middleName: sql<string | null>`COALESCE(NULLIF(${registrations.middleName}, ''), ${users.middleName})`,
      lastName: sql<string>`COALESCE(NULLIF(${registrations.lastName}, ''), ${users.lastName})`,
      email: sql<string | null>`COALESCE(NULLIF(${registrations.email}, ''), ${users.email})`,
      institution: users.institution,
    })
    .from(registrations)
    .leftJoin(users, eq(registrations.userId, users.id))
    .leftJoin(
      registrationSessions,
      eq(registrationSessions.registrationId, registrations.id),
    )
    .where(and(...conditions))
    .groupBy(
      registrations.id,
      registrations.firstName,
      registrations.middleName,
      registrations.lastName,
      registrations.email,
      users.firstName,
      users.middleName,
      users.lastName,
      users.email,
      users.institution,
    );

  return rows.map((row) => ({
    sourceType: "registration" as const,
    sourceId: row.id,
    titlePrefix: "",
    firstName: row.firstName,
    middleName: row.middleName,
    lastName: row.lastName,
    email: row.email,
    institution: row.institution,
  }));
}

async function resolveAbstracts(
  filter: DbFilter,
): Promise<CertificateRecipientInput[]> {
  const conditions = [eq(abstracts.status, "accepted"), isNotNull(abstracts.userId)];

  if (filter.presentationType) {
    conditions.push(eq(abstracts.presentationType, filter.presentationType));
  }
  if (filter.search?.trim()) {
    const q = `%${filter.search.trim()}%`;
    conditions.push(
      or(
        ilike(users.firstName, q),
        ilike(users.lastName, q),
        ilike(users.email, q),
        ilike(abstracts.trackingId, q),
      )!,
    );
  }

  const rows = await db
    .select({
      id: abstracts.id,
      firstName: users.firstName,
      middleName: users.middleName,
      lastName: users.lastName,
      email: users.email,
      institution: users.institution,
    })
    .from(abstracts)
    .innerJoin(users, eq(abstracts.userId, users.id))
    .where(and(...conditions));

  return rows.map((row) => ({
    sourceType: "abstract" as const,
    sourceId: row.id,
    titlePrefix: "",
    firstName: row.firstName,
    middleName: row.middleName,
    lastName: row.lastName,
    email: row.email,
    institution: row.institution,
  }));
}

async function resolveReviewers(filter: DbFilter): Promise<CertificateRecipientInput[]> {
  const conditions = [eq(backofficeUsers.role, "reviewer")];
  if (filter.search?.trim()) {
    const q = `%${filter.search.trim()}%`;
    conditions.push(
      or(
        ilike(backofficeUsers.firstName, q),
        ilike(backofficeUsers.lastName, q),
        ilike(backofficeUsers.email, q),
      )!,
    );
  }

  const rows = await db
    .select({
      id: backofficeUsers.id,
      firstName: backofficeUsers.firstName,
      lastName: backofficeUsers.lastName,
      email: backofficeUsers.email,
    })
    .from(backofficeUsers)
    .where(and(...conditions));

  return rows.map((row) => ({
    sourceType: "reviewer" as const,
    sourceId: row.id,
    titlePrefix: "",
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
  }));
}

async function resolveSpeakers(filter: DbFilter): Promise<CertificateRecipientInput[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (filter.eventId) {
    conditions.push(eq(eventSpeakers.eventId, filter.eventId));
  }
  if (filter.search?.trim()) {
    const q = `%${filter.search.trim()}%`;
    conditions.push(
      or(
        ilike(speakers.firstName, q),
        ilike(speakers.lastName, q),
        ilike(speakers.organization, q),
      )!,
    );
  }

  const rows = await db
    .select({
      id: speakers.id,
      firstName: speakers.firstName,
      lastName: speakers.lastName,
      institution: speakers.organization,
    })
    .from(speakers)
    .innerJoin(eventSpeakers, eq(eventSpeakers.speakerId, speakers.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(speakers.id, speakers.firstName, speakers.lastName, speakers.organization);

  return rows.map((row) => ({
    sourceType: "speaker" as const,
    sourceId: row.id,
    titlePrefix: "",
    firstName: row.firstName,
    lastName: row.lastName,
    institution: row.institution,
  }));
}

export async function resolveDatabaseRecipients(
  templateCode: string,
  filter: DbFilter = {},
): Promise<CertificateRecipientInput[]> {
  const template = getCertificateTemplate(templateCode);
  if (!template?.dbSource?.enabled) {
    return [];
  }

  switch (template.dbSource.sourceType) {
    case "registration":
      return resolveRegistrations({
        ...template.dbSource.defaultFilters,
        ...filter,
        checkedIn:
          filter.checkedIn ??
          (template.dbSource.defaultFilters?.checkedIn as boolean | undefined),
      });
    case "abstract":
      return resolveAbstracts({
        ...template.dbSource.defaultFilters,
        ...filter,
        presentationType:
          filter.presentationType ??
          (template.dbSource.defaultFilters?.presentationType as
            | "oral"
            | "poster"
            | undefined),
      });
    case "reviewer":
      return resolveReviewers(filter);
    case "speaker":
      return resolveSpeakers(filter);
    default:
      return [];
  }
}

export function deduplicateRecipients(
  recipients: CertificateRecipientInput[],
  deduplicateBy: "email" | "name" | "none",
): { recipients: CertificateRecipientInput[]; duplicatesRemoved: number } {
  if (deduplicateBy === "none") {
    return { recipients, duplicatesRemoved: 0 };
  }

  const seen = new Set<string>();
  const result: CertificateRecipientInput[] = [];
  let duplicatesRemoved = 0;

  for (const recipient of recipients) {
    const key =
      deduplicateBy === "email"
        ? (recipient.email?.trim().toLowerCase() ||
            formatCertificateName(recipient).toLowerCase())
        : formatCertificateName(recipient).toLowerCase();

    if (seen.has(key)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(key);
    result.push(recipient);
  }

  return { recipients: result, duplicatesRemoved };
}

export function finalizeRecipients(
  recipients: CertificateRecipientInput[],
): ResolvedCertificateRecipient[] {
  return recipients.map(enrichRecipient);
}
