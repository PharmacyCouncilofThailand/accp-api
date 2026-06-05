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

function centerHeaderImage(input: string): string {
  const re =
    /<wp:positionH relativeFrom="column">\s*<wp:posOffset>-?\d+<\/wp:posOffset>\s*<\/wp:positionH>/;
  if (!re.test(input)) {
    console.warn("  [warn] header image horizontal anchor not found");
    return input;
  }
  return input.replace(
    re,
    '<wp:positionH relativeFrom="page"><wp:align>center</wp:align></wp:positionH>'
  );
}

function titleParagraphXml(): string {
  return [
    '<w:p w:rsidR="00000000" w:rsidDel="00000000" w:rsidP="00000000" w:rsidRDefault="00000000" w:rsidRPr="00000000">',
    "<w:pPr>",
    '<w:spacing w:after="0" w:before="240" w:line="240" w:lineRule="auto"/>',
    '<w:ind w:firstLine="720"/>',
    '<w:jc w:val="left"/>',
    "<w:rPr>",
    '<w:rFonts w:ascii="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman"/>',
    '<w:sz w:val="24"/>',
    '<w:szCs w:val="24"/>',
    "</w:rPr>",
    "</w:pPr>",
    '<w:r w:rsidDel="00000000" w:rsidR="00000000" w:rsidRPr="00000000">',
    "<w:rPr>",
    '<w:rFonts w:ascii="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman"/>',
    '<w:sz w:val="24"/>',
    '<w:szCs w:val="24"/>',
    '<w:rtl w:val="0"/>',
    "</w:rPr>",
    '<w:t xml:space="preserve">&quot;</w:t>',
    "</w:r>",
  ].join("");
}

function splitAbstractTitleIntoLeftParagraph(input: string): string {
  const re = new RegExp(
    [
      '(<w:r\\b[^>]*>(?:(?!</w:r>)[\\s\\S])*?<w:t xml:space="preserve">)',
      "titled &quot;",
      "(</w:t>(?:(?!</w:r>)[\\s\\S])*?</w:r>)",
      "(\\s*<w:r\\b[^>]*>(?:(?!</w:r>)[\\s\\S])*?<w:t>\\{abstractTitle\\}</w:t>(?:(?!</w:r>)[\\s\\S])*?</w:r>)",
    ].join(""),
    "g"
  );
  let replaced = 0;
  const out = input.replace(re, (_m, head, tail, abstractTitleRun) => {
    replaced += 1;
    return `${head}titled${tail}</w:p>${titleParagraphXml()}${abstractTitleRun}`;
  });
  if (replaced !== 1) {
    console.warn(
      `  [warn] expected to split one abstract-title paragraph, split ${replaced}`
    );
  }
  return out;
}

function titleCaseFirstPosterLiteral(input: string): string {
  return input.replace(
    '<w:t xml:space="preserve">poster</w:t>',
    '<w:t xml:space="preserve">Poster</w:t>'
  );
}

function ensureDoNotExpandShiftReturn(zip: PizZip): void {
  const settingsFile = zip.file("word/settings.xml");
  if (!settingsFile) {
    console.warn("  [warn] word/settings.xml not found");
    return;
  }

  let settingsXml = settingsFile.asText();
  if (settingsXml.includes("<w:doNotExpandShiftReturn")) return;

  const compatRe = /<w:compat\b[^>]*>/;
  if (compatRe.test(settingsXml)) {
    settingsXml = settingsXml.replace(
      compatRe,
      (match) => `${match}<w:doNotExpandShiftReturn/>`
    );
  } else {
    settingsXml = settingsXml.replace(
      "</w:settings>",
      "<w:compat><w:doNotExpandShiftReturn/></w:compat></w:settings>"
    );
  }

  zip.file("word/settings.xml", settingsXml);
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

  if (target.type === "poster") {
    xml = titleCaseFirstPosterLiteral(xml);
  }

  xml = splitAbstractTitleIntoLeftParagraph(xml);

  // Keep the committee header centred on the physical page. The source files
  // anchor the header image to the text column, which makes it sit slightly
  // to the right when converted by LibreOffice.
  xml = centerHeaderImage(xml);

  // Prevent Word/LibreOffice from stretching spaces on manual line breaks.
  // This lets long all-caps paper titles sit on their own left-aligned lines
  // while the surrounding body paragraphs remain justified.
  ensureDoNotExpandShiftReturn(zip);

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
