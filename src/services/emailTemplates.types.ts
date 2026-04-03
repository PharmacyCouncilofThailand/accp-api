/**
 * EventEmailContext — ข้อมูล event ที่ generic email template ต้องใช้
 * ดึงจาก events table หรือสร้างจาก buildEventEmailContext()
 */
export interface EventEmailContext {
  /** ชื่อเต็ม e.g. "25th ASIAN CONFERENCE ON CLINICAL PHARMACY" */
  eventName: string;
  /** ชื่อย่อสำหรับ subject line e.g. "ACCP 2026" */
  shortName: string;
  /** วันที่จัดงาน e.g. "July 9-11, 2026" */
  dates: string;
  /** สถานที่ e.g. "Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand" */
  venue: string;
  /** URL เว็บไซต์ e.g. "https://accp2026.com" */
  websiteUrl: string;
}

/**
 * Raw event row จาก DB ที่ buildEventEmailContext() รองรับ
 */
export interface EventEmailRow {
  eventName: string;
  startDate: Date;
  endDate: Date;
  location: string | null;
  websiteUrl: string | null;
  shortName: string | null;
}

/**
 * Format date range เป็น human-readable string
 * e.g. "July 9-11, 2026" (same month) or "June 30 - July 2, 2026" (cross month)
 */
function formatDateRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = {
    month: "long",
    day: "numeric",
    timeZone: "Asia/Bangkok",
  };
  const yearOpts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    timeZone: "Asia/Bangkok",
  };

  const startMonth = start.toLocaleDateString("en-US", { month: "long", timeZone: "Asia/Bangkok" });
  const endMonth = end.toLocaleDateString("en-US", { month: "long", timeZone: "Asia/Bangkok" });
  const startDay = start.toLocaleDateString("en-US", { day: "numeric", timeZone: "Asia/Bangkok" });
  const endDay = end.toLocaleDateString("en-US", { day: "numeric", timeZone: "Asia/Bangkok" });
  const year = end.toLocaleDateString("en-US", yearOpts);

  if (startMonth === endMonth) {
    // Same month: "July 9-11, 2026"
    return `${startMonth} ${startDay}-${endDay}, ${year}`;
  }
  // Cross month: "June 30 - July 2, 2026"
  const startStr = start.toLocaleDateString("en-US", opts);
  const endStr = end.toLocaleDateString("en-US", opts);
  return `${startStr} - ${endStr}, ${year}`;
}

/**
 * สร้าง EventEmailContext จาก event DB row
 * ถ้า column ใหม่ (shortName, organizerName ฯลฯ) ยังเป็น null จะ derive จากข้อมูลที่มี
 */
export function buildEventEmailContext(event: EventEmailRow): EventEmailContext {
  const fallbackWebsite = process.env.CONFER_URL || "https://conference-hub.pharmacycouncil.org";

  return {
    eventName: event.eventName,
    shortName: event.shortName || event.eventName,
    dates: formatDateRange(event.startDate, event.endDate),
    venue: event.location || "TBA",
    websiteUrl: event.websiteUrl || fallbackWebsite,
  };
}
