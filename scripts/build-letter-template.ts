/**
 * Rebuilds src/templates/accp-letter-template.docx from
 * "Update Fee_Letter ACCP2026 FN.docx" by:
 *
 *   1. Replacing the yellow-highlighted placeholder runs with docxtemplater
 *      tags:
 *        "April 21, "                    → {issueDate}
 *        "2026"  (adjacent run)          → ""  (cleared; {issueDate} already
 *                                              renders the full English date)
 *        "[Insert Participant's Name]"   → {participantName}
 *   2. Removing every <w:r> run whose <w:t> body contains Thai characters
 *      (all Thai runs in this letter are red authoring hints such as
 *      "ระบุวันที่", "เป็นวันที่ผู้เข้าร่วมประชุมชำระเงิน", and
 *      "ระบุชื่อผู้ลงทะเบียนที่ชำระเงินแล้ว").
 *   3. Stripping the yellow highlight + bold and forcing black font colour
 *      on the placeholder runs so they render in the same style as the
 *      surrounding body copy.
 *   4. Forcing the centred "The 25th Asian Conference on Clinical Pharmacy
 *      (2026 ACCP)" heading paragraph to start on a new page so the
 *      conference details / fee schedule is clearly separated from the
 *      letter body.
 *   5. Repacking the zip with proper forward-slash entry names.
 *
 * Usage:
 *   npx tsx scripts/build-letter-template.ts [path/to/source.docx]
 */
import fs from "fs";
import path from "path";
import PizZip from "pizzip";

const srcDocx =
  process.argv[2] ||
  path.resolve(process.cwd(), "..", "Update Fee_Letter ACCP2026 FN.docx");
const outDocx = path.resolve(
  process.cwd(),
  "src/templates/accp-letter-template.docx"
);

if (!fs.existsSync(srcDocx)) {
  console.error(`Source DOCX not found: ${srcDocx}`);
  process.exit(1);
}

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

const buf = fs.readFileSync(srcDocx);
const zip = new PizZip(buf);
const xmlFile = zip.file("word/document.xml");
if (!xmlFile) {
  console.error("Invalid template: word/document.xml not found.");
  process.exit(1);
}

let xml = xmlFile.asText();
const before = xml.length;

// 1) Swap visible placeholder text for docxtemplater tags.
//    The original yellow-highlighted date is split across two runs in the
//    source: "April 21, " and "2026". The {issueDate} placeholder fills in
//    the full English date (e.g. "April 21, 2026") so we clear the trailing
//    "2026" run.
xml = mustReplace(
  xml,
  '<w:t xml:space="preserve">April 21, </w:t>',
  "<w:t>{issueDate}</w:t>"
);
// Remove only the "2026" run that immediately follows the {issueDate} marker
// (there are other paragraphs in the document that mention 2026).
{
  const marker = "<w:t>{issueDate}</w:t>";
  const idx = xml.indexOf(marker);
  if (idx < 0) {
    console.error("[FAIL] {issueDate} marker missing after replacement");
    process.exit(1);
  }
  const head = xml.slice(0, idx + marker.length);
  const tail = xml.slice(idx + marker.length);
  const re = /^([\s\S]{0,2500}?<w:t[^>]*>)2026(<\/w:t>)/;
  const replacedTail = tail.replace(re, "$1$2");
  if (replacedTail === tail) {
    console.error("[FAIL] could not locate adjacent '2026' run to clear");
    process.exit(1);
  }
  xml = head + replacedTail;
}
xml = mustReplace(
  xml,
  "<w:t>[Insert Participant's Name]</w:t>",
  "<w:t>{participantName}</w:t>"
);

// 2) Remove every <w:r> run whose <w:t> body contains Thai characters.
//    Every Thai run in this letter is a red authoring hint.
{
  const re =
    /<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:t[^>]*>[^<]*[\u0e00-\u0e7f][^<]*<\/w:t>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g;
  let removed = 0;
  xml = xml.replace(re, () => {
    removed += 1;
    return "";
  });
  console.log(`[thai] removed ${removed} hint run(s)`);
}

// 2a) Strip trailing empty <w:p> paragraphs from each <w:tc> table cell.
//     The source has cells (e.g. the "Students" category cell) where the
//     intended label is followed by ~7 empty paragraphs used to manually
//     pad the row height. With vAlign=center, Word/LibreOffice centres the
//     combined block (label + padding) — making the label appear glued to
//     the top of the cell instead of vertically centred. Removing the
//     trailing padding paragraphs lets vAlign=center actually centre the
//     visible label.
{
  const reP = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let cellsTrimmed = 0;
  let parasRemoved = 0;
  xml = xml.replace(/<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, (cell) => {
    const paras: { start: number; end: number; text: string }[] = [];
    let pm: RegExpExecArray | null;
    reP.lastIndex = 0;
    while ((pm = reP.exec(cell))) {
      paras.push({
        start: pm.index,
        end: pm.index + pm[0].length,
        text: pm[0],
      });
    }
    if (paras.length < 2) return cell;
    let lastWithText = -1;
    for (let i = paras.length - 1; i >= 0; i--) {
      if (/<w:t[^>]*>[^<]+<\/w:t>/.test(paras[i].text)) {
        lastWithText = i;
        break;
      }
    }
    if (lastWithText < 0 || lastWithText === paras.length - 1) return cell;
    cellsTrimmed += 1;
    parasRemoved += paras.length - 1 - lastWithText;
    const head = cell.slice(0, paras[lastWithText].end);
    const tail = cell.slice(paras[paras.length - 1].end);
    return head + tail;
  });
  console.log(
    `[cell-trim] removed ${parasRemoved} trailing empty paragraph(s) from ${cellsTrimmed} cell(s)`
  );
}

// 2b) Normalise fonts: the source uses "TH SarabunPSK" (a Thai sans-serif
//     font) in scattered table cells (e.g. the word "fee" in the header
//     row and most fee-schedule amount cells), which renders inconsistently
//     against the Times New Roman body when LibreOffice converts to PDF.
//
//     TH SarabunPSK runs use larger w:sz values (sz=28 for header words like
//     "fee", sz=32 for amount cells like "*12,200 TH") because Thai fonts
//     have a smaller x-height — visually those ≈ Times New Roman sz=24
//     (12pt body text). When we swap the font to Times New Roman we MUST
//     also drop the size back to 24, otherwise those cells render
//     noticeably larger than the surrounding body copy.
//
//     We first walk every <w:rPr> block that references TH SarabunPSK and
//     normalise the size inside it; then we rename the font.
{
  let resizedBlocks = 0;
  xml = xml.replace(
    /<w:rPr>((?:(?!<\/w:rPr>)[\s\S])*?)<\/w:rPr>/g,
    (full, inner: string) => {
      if (!inner.includes("TH SarabunPSK")) return full;
      let n = inner;
      // Any w:sz/w:szCs value inside a TH SarabunPSK rPr should be brought
      // down to 24 (12pt) to match the Times New Roman body copy.
      n = n.replace(/<w:sz\s+w:val="\d+"\s*\/>/g, '<w:sz w:val="24"/>');
      n = n.replace(/<w:szCs\s+w:val="\d+"\s*\/>/g, '<w:szCs w:val="24"/>');
      // Ensure both sz and szCs exist so Word/LibreOffice pick the correct
      // size regardless of script.
      if (!/<w:sz\b/.test(n)) n = n + '<w:sz w:val="24"/>';
      if (!/<w:szCs\b/.test(n)) {
        n = n.replace(
          /(<w:sz\s+w:val="24"\s*\/>)/,
          '$1<w:szCs w:val="24"/>'
        );
      }
      if (n !== inner) resizedBlocks += 1;
      return `<w:rPr>${n}</w:rPr>`;
    }
  );
  const before = xml.length;
  xml = xml.split("TH SarabunPSK").join("Times New Roman");
  console.log(
    `[font] normalised ${resizedBlocks} TH SarabunPSK rPr block(s) to sz=24, then renamed TH SarabunPSK → Times New Roman (Δ = ${
      xml.length - before
    } chars)`
  );
}

// 3) Strip yellow highlight + bold + reset colour to black on placeholder
//    runs so they blend with body copy.
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
xml = cleanRunForTag(xml, "{issueDate}");
xml = cleanRunForTag(xml, "{participantName}");

// 4) Force the centred "The 25th Asian Conference on Clinical Pharmacy
//    (2026 ACCP)" heading paragraph to start on a new page.
function addPageBreakBeforeTitle(input: string): string {
  const paraRe =
    /<w:p\b[^>]*>\s*<w:pPr>(?!\s*<w:pageBreakBefore\s*\/>)([\s\S]*?)<\/w:pPr>([\s\S]*?)<\/w:p>/g;
  let replacedCount = 0;
  const out = input.replace(paraRe, (match, pPrInner, body) => {
    const isCentered = /<w:jc\s+w:val="center"\s*\/>/.test(pPrInner);
    const hasTitle = /Asian Conference on Clinical Pharmacy/.test(body);
    if (!isCentered || !hasTitle) return match;
    replacedCount += 1;
    const newPPr = `<w:pageBreakBefore/>${pPrInner}`;
    return match.replace(
      `<w:pPr>${pPrInner}</w:pPr>`,
      `<w:pPr>${newPPr}</w:pPr>`
    );
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
if (xml.includes("April 21, ") || xml.includes("[Insert Participant")) {
  console.error("[FAIL] Original placeholder text still present");
  process.exit(1);
}
if (/[\u0e00-\u0e7f]/.test(xml)) {
  console.warn("[warn] Thai characters still present after stripping hint runs");
}

zip.file("word/document.xml", xml);

const out = zip.generate({
  type: "nodebuffer",
  compression: "DEFLATE",
});

fs.mkdirSync(path.dirname(outDocx), { recursive: true });
fs.writeFileSync(outDocx, out);
console.log(`[OK] Wrote ${outDocx} (${out.length} bytes)`);
