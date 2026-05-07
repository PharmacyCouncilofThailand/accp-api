/**
 * Rebuilds src/templates/accp-letter-template.docx from the original
 * "Letter ACCP2026 FN.docx" by:
 *   1. Replacing literal placeholders with docxtemplater tags
 *   2. Stripping the Thai hint runs
 *   3. Repacking the zip with proper forward-slash entry names
 *
 * Usage:
 *   npx tsx scripts/build-letter-template.ts [path/to/Letter.docx]
 */
import fs from "fs";
import path from "path";
import PizZip from "pizzip";

const srcDocx =
  process.argv[2] ||
  path.resolve(
    process.cwd(),
    "..",
    "Letter ACCP2026 FN.docx"
  );
const outDocx = path.resolve(
  process.cwd(),
  "src/templates/accp-letter-template.docx"
);

if (!fs.existsSync(srcDocx)) {
  console.error(`Source DOCX not found: ${srcDocx}`);
  process.exit(1);
}

const THAI_HINT_DATE =
  "\u0e23\u0e30\u0e1a\u0e38\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48 \u0e40\u0e1b\u0e47\u0e19\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48\u0e1c\u0e39\u0e49\u0e40\u0e02\u0e49\u0e32\u0e23\u0e48\u0e27\u0e21\u0e1b\u0e23\u0e30\u0e0a\u0e38\u0e21\u0e0a\u0e33\u0e23\u0e30\u0e40\u0e07\u0e34\u0e19";
const THAI_HINT_NAME =
  "\u0e23\u0e30\u0e1a\u0e38\u0e0a\u0e37\u0e48\u0e2d\u0e1c\u0e39\u0e49\u0e25\u0e07\u0e17\u0e30\u0e40\u0e1a\u0e35\u0e22\u0e19\u0e17\u0e35\u0e48\u0e0a\u0e33\u0e23\u0e30\u0e40\u0e07\u0e34\u0e19\u0e41\u0e25\u0e49\u0e27";

const buf = fs.readFileSync(srcDocx);
const zip = new PizZip(buf);

const xmlFile = zip.file("word/document.xml");
if (!xmlFile) {
  console.error("Invalid template: word/document.xml not found.");
  process.exit(1);
}

let xml = xmlFile.asText();

const before = xml.length;
xml = xml.replace("April 21, 2026", "{issueDate}");
xml = xml.replace("[Insert Participant's Name]", "{participantName}");
xml = xml.split(THAI_HINT_DATE).join("");
xml = xml.split(THAI_HINT_NAME).join("");

// Normalise the run that wraps each placeholder so the rendered text matches
// surrounding body copy: drop yellow highlight, drop bold, force black colour.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function cleanRunForTag(input: string, tag: string): string {
  // Anchor inner capture to a single rPr block: forbid </w:rPr> inside,
  // forcing the engine to backtrack to the run that actually wraps the tag.
  const re = new RegExp(
    `(<w:r\\b[^>]*>\\s*<w:rPr>)((?:(?!</w:rPr>)[\\s\\S])*?)(</w:rPr>\\s*<w:t[^>]*>${escapeRegex(
      tag
    )}</w:t>)`,
    "g"
  );
  return input.replace(re, (_m, head, inner, tail) => {
    let rPr = inner as string;
    rPr = rPr.replace(/<w:highlight\b[^/]*\/>/g, "");
    rPr = rPr.replace(/<w:b\b\s*\/>/g, "");
    rPr = rPr.replace(/<w:bCs\b\s*\/>/g, "");
    if (/<w:color\b[^/]*\/>/.test(rPr)) {
      rPr = rPr.replace(/<w:color\b[^/]*\/>/, '<w:color w:val="000000"/>');
    } else {
      rPr = '<w:color w:val="000000"/>' + rPr;
    }
    return head + rPr + tail;
  });
}
xml = cleanRunForTag(xml, "{issueDate}");
xml = cleanRunForTag(xml, "{participantName}");

// Force the "The 25th Asian Conference on Clinical Pharmacy (2026 ACCP)" title
// (the centered + bold heading that introduces the Theme / Date / Venue block)
// to start on a new page, so the letter body is clearly separated from the
// conference detail section.
function addPageBreakBeforeTitle(input: string): string {
  // Match a <w:p> paragraph whose pPr includes <w:jc w:val="center"/> AND
  // whose body contains the conference title text. Insert <w:pageBreakBefore/>
  // as the first child of its <w:pPr>.
  const paraRe =
    /<w:p\b[^>]*>\s*<w:pPr>(?!\s*<w:pageBreakBefore\s*\/>)([\s\S]*?)<\/w:pPr>([\s\S]*?)<\/w:p>/g;
  let replacedCount = 0;
  const out = input.replace(paraRe, (match, pPrInner, body) => {
    const isCentered = /<w:jc\s+w:val="center"\s*\/>/.test(pPrInner);
    const hasTitle = /Asian Conference on Clinical Pharmacy/.test(body);
    if (!isCentered || !hasTitle) return match;
    replacedCount += 1;
    // Inject <w:pageBreakBefore/> at start of pPr contents. Ordering rules in
    // the OOXML schema put pageBreakBefore near the top of pPr, before
    // numPr/framePr/etc.; placing it first is safe.
    const newPPr = `<w:pageBreakBefore/>${pPrInner}`;
    return match
      .replace(`<w:pPr>${pPrInner}</w:pPr>`, `<w:pPr>${newPPr}</w:pPr>`);
  });
  console.log(`[pageBreak] inserted before ${replacedCount} title paragraph(s)`);
  return out;
}
xml = addPageBreakBeforeTitle(xml);

const after = xml.length;

console.log(
  `Patched word/document.xml (Δ = ${after - before} chars, ${before} → ${after})`
);

// Assertions
if (!xml.includes("{issueDate}")) {
  console.error("[FAIL] {issueDate} tag missing after patch");
  process.exit(1);
}
if (!xml.includes("{participantName}")) {
  console.error("[FAIL] {participantName} tag missing after patch");
  process.exit(1);
}
if (xml.includes("April 21, 2026")) {
  console.error("[FAIL] Raw April 21, 2026 still in XML");
  process.exit(1);
}
if (xml.includes("[Insert Participant")) {
  console.error("[FAIL] Insert Participant still in XML");
  process.exit(1);
}

zip.file("word/document.xml", xml);

const out = zip.generate({
  type: "nodebuffer",
  compression: "DEFLATE",
});

fs.mkdirSync(path.dirname(outDocx), { recursive: true });
fs.writeFileSync(outDocx, out);
console.log(`[OK] Wrote ${outDocx} (${out.length} bytes)`);
