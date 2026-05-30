/**
 * Builds the abstract acceptance letter templates from the two source
 * .docx files provided by the organising committee:
 *
 *   - "Oral_ตอบรับบทความและแจ้งอัตราค่าลงทะเบียน FN (1).docx"
 *       →  src/templates/accp-abstract-accept-oral-template.docx
 *   - "Poster_ตอบรับบทความและแจ้งอัตราค่าลงทะเบียน FN.docx"
 *       →  src/templates/accp-abstract-accept-poster-template.docx
 *
 * For each source file the script:
 *   1. Replaces the yellow-highlighted placeholder runs with docxtemplater
 *      tags:
 *        "23 April"                                 → {acceptDate}
 *        " 2026"                                    → ""  (cleared; date is
 *                                                          fully rendered by
 *                                                          {acceptDate})
 *        "....................................,"   → {participantName}
 *        "....................................."   → {abstractTitle}
 *      The presentation-type literal ("Oral" / "poster") is left in place
 *      since each template targets a single type.
 *   2. Removes every <w:r> run whose <w:t> body contains Thai characters
 *      (every Thai run in these letters is a red authoring hint such as
 *      "(ระบุวันที่ได้รับการอนุมัติ)", "ระบุชื่อผู้ส่งบทความ ...",
 *      and "ระบุชื่อบทความ ").
 *   3. Strips yellow highlight + bold and resets the font colour to black
 *      on the runs that wrap the placeholder tokens so they render in the
 *      same style as the surrounding body copy.
 *   4. Repacks the .docx zip with proper forward-slash entry names.
 *
 * Usage:
 *   npx tsx scripts/build-abstract-template.ts
 *
 * Optional positional override: pass a single source path to rebuild only
 * the matching template (auto-detected from the filename).
 */
import fs from "fs";
import path from "path";
import PizZip from "pizzip";

interface Target {
  type: "oral" | "poster";
  src: string;
  out: string;
}

const REPO_ROOT = path.resolve(process.cwd(), "..");

const TARGETS: Target[] = [
  {
    type: "oral",
    src: path.resolve(
      REPO_ROOT,
      "Oral_ตอบรับบทความและแจ้งอัตราค่าลงทะเบียน FN (1).docx"
    ),
    out: path.resolve(
      process.cwd(),
      "src/templates/accp-abstract-accept-oral-template.docx"
    ),
  },
  {
    type: "poster",
    src: path.resolve(
      REPO_ROOT,
      "Poster_ตอบรับบทความและแจ้งอัตราค่าลงทะเบียน FN.docx"
    ),
    out: path.resolve(
      process.cwd(),
      "src/templates/accp-abstract-accept-poster-template.docx"
    ),
  },
];

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

/** Strip every <w:r> run whose <w:t> text body contains Thai characters. */
function stripThaiRuns(xml: string): { xml: string; removed: number } {
  // Match a <w:r ...> ... </w:r> block whose inner <w:t> body has any
  // Thai-script character. We forbid </w:r> inside the lookahead so the
  // engine doesn't accidentally swallow neighbouring runs.
  const re =
    /<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:t[^>]*>[^<]*[\u0e00-\u0e7f][^<]*<\/w:t>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g;
  let removed = 0;
  const out = xml.replace(re, () => {
    removed += 1;
    return "";
  });
  return { xml: out, removed };
}

/**
 * Clean the run that wraps `tag`: drop yellow highlight, drop bold, force
 * black font colour so the rendered placeholder text matches body copy.
 */
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

function processSource(target: Target): void {
  if (!fs.existsSync(target.src)) {
    console.error(`Source DOCX not found: ${target.src}`);
    process.exit(1);
  }
  console.log(`\n=== Building ${target.type} template ===`);
  console.log(`  src: ${target.src}`);
  console.log(`  out: ${target.out}`);

  const zip = new PizZip(fs.readFileSync(target.src));
  const xmlFile = zip.file("word/document.xml");
  if (!xmlFile) {
    console.error("Invalid template: word/document.xml not found.");
    process.exit(1);
  }
  let xml = xmlFile.asText();
  const before = xml.length;

  // 1) Swap visible placeholder text for docxtemplater tags.
  //    The acceptance date is rendered as a single English string by
  //    formatIssueDate() (e.g. "April 23, 2026"), so we clear the trailing
  //    " 2026" run that originally completed the literal date.
  xml = mustReplace(
    xml,
    '<w:t xml:space="preserve">23 April</w:t>',
    "<w:t>{acceptDate}</w:t>"
  );
  xml = mustReplace(
    xml,
    '<w:t xml:space="preserve"> 2026</w:t>',
    '<w:t xml:space="preserve"></w:t>'
  );
  xml = mustReplace(
    xml,
    '<w:t xml:space="preserve">.....................................,</w:t>',
    "<w:t>{participantName}</w:t>"
  );
  xml = mustReplace(
    xml,
    '<w:t xml:space="preserve">.......................................</w:t>',
    "<w:t>{abstractTitle}</w:t>"
  );

  // 2) Remove every Thai-language run (all Thai runs in these files are
  //    red authoring hints).
  const { xml: stripped, removed } = stripThaiRuns(xml);
  xml = stripped;
  console.log(`  [thai] removed ${removed} hint run(s)`);

  // 3) Strip yellow highlight + bold + reset colour on our placeholder runs
  //    AND on the presentation-type literal ("Oral" / "poster") that the
  //    organising committee originally highlighted in yellow as a hint.
  const literalForType = target.type === "oral" ? "Oral" : "poster";
  for (const tag of [
    "{acceptDate}",
    "{participantName}",
    "{abstractTitle}",
    literalForType,
  ]) {
    xml = cleanRunForTag(xml, tag);
  }

  const after = xml.length;
  console.log(
    `  patched word/document.xml (Δ = ${after - before} chars, ${before} → ${after})`
  );

  // Assertions
  for (const tag of [
    "{acceptDate}",
    "{participantName}",
    "{abstractTitle}",
  ]) {
    if (!xml.includes(tag)) {
      console.error(`  [FAIL] tag missing after patch: ${tag}`);
      process.exit(1);
    }
  }
  if (/[\u0e00-\u0e7f]/.test(xml)) {
    console.warn(
      "  [warn] Thai characters still present after stripping hint runs"
    );
  }
  if (xml.includes('<w:highlight w:val="yellow"/>')) {
    console.warn("  [warn] yellow highlight still present elsewhere");
  }

  zip.file("word/document.xml", xml);
  const out = zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
  fs.mkdirSync(path.dirname(target.out), { recursive: true });
  fs.writeFileSync(target.out, out);
  console.log(`  [OK] Wrote ${target.out} (${out.length} bytes)`);
}

// Optional override: a single source path on argv => only rebuild matching
// template (auto-detect by filename prefix).
const overrideSrc = process.argv[2];
const targets: Target[] = overrideSrc
  ? (() => {
      const base = path.basename(overrideSrc).toLowerCase();
      const match = TARGETS.find((t) => base.startsWith(t.type));
      if (!match) {
        console.error(
          `Cannot infer type (oral/poster) from filename: ${overrideSrc}`
        );
        process.exit(1);
      }
      return [{ ...match, src: path.resolve(overrideSrc) }];
    })()
  : TARGETS;

for (const t of targets) processSource(t);
