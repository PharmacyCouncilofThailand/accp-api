/**
 * Latin / English-looking personal names for certificate email eligibility.
 * Allows letters, spaces, periods, apostrophes, and hyphens
 * (e.g. "D.", "Li-Chao-Yue") — kept as-is on the certificate.
 */
const LATIN_NAME_RE = /^[A-Za-z][A-Za-z\s.'-]*$/;

export function isEnglishLatinNamePart(value: string | null | undefined): boolean {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return false;
  return LATIN_NAME_RE.test(trimmed);
}

/** middleName may be empty; firstName and lastName are required English Latin. */
export function isEnglishLatinRegistrationName(
  firstName: string | null | undefined,
  middleName: string | null | undefined,
  lastName: string | null | undefined,
): boolean {
  if (!isEnglishLatinNamePart(firstName) || !isEnglishLatinNamePart(lastName)) {
    return false;
  }
  const middle = (middleName ?? "").trim();
  if (!middle) return true;
  return isEnglishLatinNamePart(middle);
}

/** Trim only — keep `.` and `-` for the certificate name. */
export function toParticipationCertificateNameParts(parts: {
  firstName: string;
  middleName?: string | null;
  lastName: string;
}): {
  titlePrefix: "";
  firstName: string;
  middleName: string | null;
  lastName: string;
} {
  const middleRaw = (parts.middleName ?? "").trim();
  return {
    titlePrefix: "",
    firstName: parts.firstName.trim(),
    middleName: middleRaw || null,
    lastName: parts.lastName.trim(),
  };
}
