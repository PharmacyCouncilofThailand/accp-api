/**
 * Smoke-test the abstract-accepted letter template by rendering a .docx and
 * (if LibreOffice is available) a PDF to the current working directory.
 */
import fs from "fs";
import path from "path";
import {
  renderAbstractAcceptDocx,
  renderAbstractAcceptPdf,
  formatIssueDate,
  titleCasePresentationType,
} from "../src/services/letter.service.js";

const data = {
  participantName: "Somchai Jaidee",
  acceptDate: formatIssueDate(new Date("2026-04-23")),
  presentationType: titleCasePresentationType("oral"),
  abstractTitle:
    "A Pilot Study on Pharmacist-Led Medication Reconciliation in a Thai Tertiary Hospital",
};

const outDir = path.resolve(process.cwd());

console.log("[1/2] Rendering abstract-accept DOCX...");
const docx = await renderAbstractAcceptDocx(data);
fs.writeFileSync(path.join(outDir, "_test-abstract-accept.docx"), docx);
console.log(`  wrote _test-abstract-accept.docx (${docx.length} bytes)`);

console.log("[2/2] Rendering abstract-accept PDF (requires LibreOffice)...");
try {
  const pdf = await renderAbstractAcceptPdf(data);
  fs.writeFileSync(path.join(outDir, "_test-abstract-accept.pdf"), pdf);
  console.log(`  wrote _test-abstract-accept.pdf (${pdf.length} bytes)`);
} catch (err) {
  console.warn(`  [skip] PDF render failed: ${(err as Error).message}`);
}
