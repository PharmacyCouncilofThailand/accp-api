export interface CertificateNameParts {
  titlePrefix: string;
  firstName: string;
  middleName?: string | null;
  lastName: string;
  certificateNameOverride?: string | null;
}

/** Uppercase Latin letters only; preserve Thai/CJK/Korean and other scripts. */
export function applyCertificateCasing(text: string): string {
  return [...text]
    .map((ch) => (/[a-zA-Z]/.test(ch) ? ch.toUpperCase() : ch))
    .join("");
}

export function formatCertificateName(parts: CertificateNameParts): string {
  if (parts.certificateNameOverride?.trim()) {
    return applyCertificateCasing(parts.certificateNameOverride.trim());
  }

  const raw = [
    parts.titlePrefix,
    parts.firstName,
    parts.middleName,
    parts.lastName,
  ]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(" ");

  return applyCertificateCasing(raw);
}

export function sanitizeCertificateFilenamePart(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "recipient";
}

export function buildCertificateFilename(
  templateCode: string,
  parts: CertificateNameParts,
): string {
  const last = sanitizeCertificateFilenamePart(parts.lastName);
  const first = sanitizeCertificateFilenamePart(parts.firstName);
  return `${templateCode}_${last}_${first}.pdf`;
}
