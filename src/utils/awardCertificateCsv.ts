/** Parse 2-column CSV (Fullname + Email) for award certificate manual email. */

export interface AwardCertificateCsvRow {
  id: number;
  fullName: string;
  email: string;
}

const FULLNAME_HEADERS = new Set([
  "fullname",
  "full_name",
  "full name",
  "name",
  "ชื่อ",
  "ชื่อเต็ม",
  "ชื่อ-นามสกุล",
]);

const EMAIL_HEADERS = new Set([
  "email",
  "e-mail",
  "e_mail",
  "mail",
  "อีเมล",
  "email address",
]);

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[_\s]+/g, " ");
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
    } else if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function parseAwardCertificateCsv(content: string): {
  recipients: AwardCertificateCsvRow[];
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
  const fullNameIndex = headers.findIndex((h) => FULLNAME_HEADERS.has(h));
  const emailIndex = headers.findIndex((h) => EMAIL_HEADERS.has(h));

  if (fullNameIndex < 0) {
    return {
      recipients: [],
      errors: [{ row: 1, field: "fullname", message: "Missing Fullname column (e.g. Fullname, Name)" }],
      warnings: [],
    };
  }
  if (emailIndex < 0) {
    return {
      recipients: [],
      errors: [{ row: 1, field: "email", message: "Missing Email column" }],
      warnings: [],
    };
  }

  const recipients: AwardCertificateCsvRow[] = [];
  const errors: Array<{ row: number; field?: string; message: string }> = [];
  const warnings: Array<{ row: number; code: string; message: string }> = [];

  for (let i = 1; i < lines.length; i++) {
    const rowNumber = i + 1;
    const values = parseCsvLine(lines[i]);
    const fullName = values[fullNameIndex]?.trim() ?? "";
    const email = values[emailIndex]?.trim() ?? "";

    if (!fullName) {
      errors.push({ row: rowNumber, field: "fullname", message: "Fullname is required" });
      continue;
    }
    if (!email) {
      errors.push({ row: rowNumber, field: "email", message: "Email is required" });
      continue;
    }
    if (!isValidEmail(email)) {
      errors.push({ row: rowNumber, field: "email", message: `Invalid email: ${email}` });
      continue;
    }

    recipients.push({
      id: recipients.length + 1,
      fullName,
      email,
    });
  }

  const seenEmail = new Map<string, number>();
  recipients.forEach((r) => {
    const key = r.email.toLowerCase();
    if (seenEmail.has(key)) {
      warnings.push({
        row: r.id + 1,
        code: "DUPLICATE_EMAIL",
        message: `Duplicate email of row ${seenEmail.get(key)}`,
      });
    } else {
      seenEmail.set(key, r.id + 1);
    }
  });

  return { recipients, errors, warnings };
}

export function toAwardCertificateNameParts(fullName: string) {
  return {
    titlePrefix: "",
    firstName: "",
    middleName: null as string | null,
    lastName: "",
    certificateNameOverride: fullName.trim(),
  };
}
