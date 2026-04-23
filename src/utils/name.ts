/**
 * Format a person's full name, including optional middle name.
 * Trims whitespace and skips falsy/empty middle names.
 *
 * @example
 *   getFullName("John", null, "Doe")       // "John Doe"
 *   getFullName("John", "William", "Doe")  // "John William Doe"
 *   getFullName("John", "  ", "Doe")       // "John Doe"
 */
export function getFullName(
  firstName: string,
  middleName: string | null | undefined,
  lastName: string,
): string {
  const first = (firstName ?? "").trim();
  const middle = (middleName ?? "").trim();
  const last = (lastName ?? "").trim();

  if (middle) {
    return `${first} ${middle} ${last}`.trim();
  }
  return `${first} ${last}`.trim();
}
