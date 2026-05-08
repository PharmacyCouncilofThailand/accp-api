/**
 * Quick smoke test for the letter renderer. Run with:
 *   npx tsx scripts/test-letter.ts
 *
 * Outputs _test-letter.docx (and _test-letter.pdf if LibreOffice present)
 * next to the project root.
 */
import fs from "fs";
import path from "path";
import {
  renderLetterDocx,
  renderLetterPdf,
  formatIssueDate,
} from "../src/services/letter.service.js";

const data = {
  participantName: "Somchai Jaidee",
  issueDate: formatIssueDate(new Date("2026-04-21")),
};

const outDir = path.resolve(process.cwd());

console.log("[1/2] Rendering DOCX...");
const docx = await renderLetterDocx(data);
fs.writeFileSync(path.join(outDir, "_test-letter.docx"), docx);
console.log(`  wrote _test-letter.docx (${docx.length} bytes)`);

console.log("[2/2] Rendering PDF (requires LibreOffice)...");
try {
  const pdf = await renderLetterPdf(data);
  fs.writeFileSync(path.join(outDir, "_test-letter.pdf"), pdf);
  console.log(`  wrote _test-letter.pdf (${pdf.length} bytes)`);
} catch (err) {
  console.error("  PDF failed:", (err as Error).message);
  console.error(
    "  (skip if libreoffice isn't installed locally; it will work on the Docker image)"
  );
}
