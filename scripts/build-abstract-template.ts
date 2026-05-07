/**
 * Builds src/templates/accp-abstract-accept-template.docx from the original
 * "Oral_ตอบรับบทความและแจ้งอัตราค่าลงทะเบียน FN.docx" by:
 *
 *   1. Swapping yellow-highlighted placeholder runs for docxtemplater tags:
 *        - "23" + " April" + " 2026"  →  {acceptDate}
 *        - "...,"                      →  {participantName}
 *        - "Oral" (×2)                 →  {presentationType}
 *        - "...."                      →  {abstractTitle}
 *   2. Removing the Thai hint runs (ระบุ…) that follow each highlight.
 *   3. Stripping yellow highlight + resetting font colour to black on the
 *      placeholder runs so the rendered text matches surrounding body copy.
 *   4. Forcing the "Conference Registration Fee Schedule" heading paragraph
 *      to start on a new page so the rate table is always cleanly separated
 *      from the acceptance letter body.
 *   5. Repacking the zip with proper forward-slash entry names.
 *
 * Usage:
 *   npx tsx scripts/build-abstract-template.ts [path/to/source.docx]
 *
 * The single template is reused for both Oral and Poster acceptance letters
 * by passing different values into {presentationType}.
 */
import fs from "fs";
import path from "path";
import PizZip from "pizzip";

const srcDocx =
  process.argv[2] ||
  path.resolve(
    process.cwd(),
    "..",
    "Oral_ตอบรับบทความและแจ้งอัตราค่าลงทะเบียน FN.docx"
  );
const outDocx = path.resolve(
  process.cwd(),
  "src/templates/accp-abstract-accept-template.docx"
);

if (!fs.existsSync(srcDocx)) {
  console.error(`Source DOCX not found: ${srcDocx}`);
  process.exit(1);
}

const zip = new PizZip(fs.readFileSync(srcDocx));
const xmlFile = zip.file("word/document.xml");
if (!xmlFile) {
  console.error("Invalid template: word/document.xml not found.");
  process.exit(1);
}
let xml = xmlFile.asText();
const before = xml.length;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mustReplace(input: string, from: string, to: string): string {
  if (!input.includes(from)) {
    console.error(`[FAIL] expected literal not found: ${from}`);
    process.exit(1);
  }
  return input.replace(from, to);
}
function mustReplaceAll(input: string, from: string, to: string): string {
  if (!input.includes(from)) {
    console.error(`[FAIL] expected literal not found (replaceAll): ${from}`);
    process.exit(1);
  }
  return input.split(from).join(to);
}

// 1) Swap visible text inside <w:t> tags for placeholder tokens.
xml = mustReplace(xml, "<w:t>23</w:t>", "<w:t>{acceptDate}</w:t>");
xml = mustReplace(
  xml,
  '<w:t xml:space="preserve"> April</w:t>',
  '<w:t xml:space="preserve"></w:t>'
);
xml = mustReplace(
  xml,
  '<w:t xml:space="preserve"> 2026</w:t>',
  '<w:t xml:space="preserve"></w:t>'
);
xml = mustReplace(
  xml,
  "<w:t>.....................................,</w:t>",
  "<w:t>{participantName}</w:t>"
);
xml = mustReplace(
  xml,
  "<w:t>.......................................</w:t>",
  "<w:t>{abstractTitle}</w:t>"
);
xml = mustReplaceAll(
  xml,
  "<w:t>Oral</w:t>",
  "<w:t>{presentationType}</w:t>"
);

// 2) Remove Thai hint runs entirely (the parenthesised guidance text in red).
const THAI_HINTS = [
  "(\u0e23\u0e30\u0e1a\u0e38\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48\u0e44\u0e14\u0e49\u0e23\u0e31\u0e1a\u0e01\u0e32\u0e23\u0e2d\u0e19\u0e38\u0e21\u0e31\u0e15\u0e34)", // (ระบุวันที่ได้รับการอนุมัติ)
  "\u0e23\u0e30\u0e1a\u0e38\u0e0a\u0e37\u0e48\u0e2d\u0e1c\u0e39\u0e49\u0e2a\u0e48\u0e07\u0e1a\u0e17\u0e04\u0e27\u0e32\u0e21", // ระบุชื่อผู้ส่งบทความ
  "\u0e23\u0e30\u0e1a\u0e38\u0e0a\u0e37\u0e48\u0e2d\u0e1a\u0e17\u0e04\u0e27\u0e32\u0e21", // ระบุชื่อบทความ
];
for (const hint of THAI_HINTS) {
  // The hint text typically lives in its own <w:r>...</w:r>. Match the
  // smallest run that wraps the hint and drop the whole run.
  const re = new RegExp(
    `<w:r\\b[^>]*>(?:(?!</w:r>)[\\s\\S])*?${escapeRegex(
      hint
    )}(?:(?!</w:r>)[\\s\\S])*?</w:r>`,
    "g"
  );
  const beforeLen = xml.length;
  xml = xml.replace(re, "");
  if (xml.length === beforeLen) {
    console.warn(`[warn] Thai hint not removed (run regex missed): ${hint}`);
  }
}

// 3) Strip yellow highlight, drop bold, and reset colour to black on the
//    runs that wrap our placeholder tokens, so they render in the same style
//    as the rest of the body copy.
function cleanRunForTag(input: string, tag: string): string {
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
for (const tag of [
  "{acceptDate}",
  "{participantName}",
  "{abstractTitle}",
  "{presentationType}",
]) {
  xml = cleanRunForTag(xml, tag);
}

// 4) Force the "Conference Registration Fee Schedule" heading paragraph to
//    always start on a new page.
function addPageBreakBefore(input: string, headingText: string): string {
  const paraRe = new RegExp(
    `(<w:p\\b[^>]*><w:pPr>)(?!\\s*<w:pageBreakBefore\\s*/>)((?:(?!</w:pPr>)[\\s\\S])*?)(</w:pPr>(?:(?!</w:p>)[\\s\\S])*?${escapeRegex(
      headingText
    )})`,
    ""
  );
  let count = 0;
  const out = input.replace(paraRe, (_m, head, pPrInner, tail) => {
    count += 1;
    return `${head}<w:pageBreakBefore/>${pPrInner}${tail}`;
  });
  console.log(
    `[pageBreak] inserted before ${count} paragraph(s) containing "${headingText}"`
  );
  return out;
}
xml = addPageBreakBefore(xml, "Conference Registration Fee Schedule");

const after = xml.length;
console.log(
  `Patched word/document.xml (Δ = ${after - before} chars, ${before} → ${after})`
);

// Assertions
const required = [
  "{acceptDate}",
  "{participantName}",
  "{presentationType}",
  "{abstractTitle}",
];
for (const tag of required) {
  if (!xml.includes(tag)) {
    console.error(`[FAIL] tag missing after patch: ${tag}`);
    process.exit(1);
  }
}
if (xml.includes('<w:highlight w:val="yellow"/>')) {
  console.warn("[warn] yellow highlight still present elsewhere in document");
}

zip.file("word/document.xml", xml);
const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
fs.mkdirSync(path.dirname(outDocx), { recursive: true });
fs.writeFileSync(outDocx, out);
console.log(`[OK] Wrote ${outDocx} (${out.length} bytes)`);
