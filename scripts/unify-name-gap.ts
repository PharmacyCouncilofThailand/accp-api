/**
 * Measure name-rule gap on poster-evaluator (reference) and compute y for all other templates.
 *
 * Usage: npx tsx scripts/unify-name-gap.ts [--apply]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import { pdf } from "pdf-to-img";
import { generateCertificatePdf, loadCertificateTemplates } from "../src/services/certificatePdf.service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_W = 737.04;
const PAGE_H = 510.24;
const RENDER_W = 1024;
const RENDER_H = 710;
const REF_CODE = "poster-evaluator";
const REF_Y = 283;

function px(png: PNG, x: number, y: number): [number, number, number, number] {
  const i = (png.width * y + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

function isLinePixel([r, g, b, a]: [number, number, number, number]): boolean {
  if (a < 128) return false;
  if (r + g + b < 165) return true;
  return Math.abs(r - g) < 25 && Math.abs(g - b) < 25 && r < 210 && r > 80;
}

function isBlue([r, g, b, a]: [number, number, number, number]): boolean {
  return a > 128 && r < 80 && g < 80 && b > 60 && b > r + 20;
}

function pxToPdfY(py: number, imgH: number): number {
  return PAGE_H - (py / imgH) * PAGE_H;
}

function findHorizontalRules(
  png: PNG,
  y0: number,
  y1: number,
  minWidthRatio = 0.45,
): Array<{ start: number; end: number; mid: number }> {
  const hits: number[] = [];
  for (let y = y0; y < y1; y++) {
    let run = 0;
    let maxRun = 0;
    for (let x = Math.floor(png.width * 0.12); x < Math.floor(png.width * 0.88); x++) {
      if (isLinePixel(px(png, x, y))) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
    if (maxRun > png.width * minWidthRatio) hits.push(y);
  }

  const clusters: Array<{ start: number; end: number; mid: number }> = [];
  for (const y of hits) {
    const last = clusters[clusters.length - 1];
    if (!last || y > last.end + 1) {
      clusters.push({ start: y, end: y, mid: y });
    } else {
      last.end = y;
      last.mid = (last.start + last.end) / 2;
    }
  }
  return clusters;
}

function findBlueNameBottom(png: PNG, y0: number, y1: number): number | null {
  let maxY = -1;
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = 0; x < png.width; x++) {
      if (isBlue(px(png, x, y))) c++;
    }
    if (c > 15) maxY = y;
  }
  return maxY >= 0 ? maxY : null;
}

async function renderPdfToPng(pdfBytes: Buffer): Promise<PNG> {
  const doc = await pdf(pdfBytes, { scale: RENDER_W / 737.04 });
  let raw: Buffer | null = null;
  for await (const page of doc) {
    raw = page;
    break;
  }
  if (!raw) throw new Error("Empty PDF");
  return new Promise((resolve, reject) => {
    new PNG().parse(raw, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

/** Pick the name-area rule: widest cluster in the name band, prefer lower half of search zone. */
function pickNameRule(
  rules: Array<{ start: number; end: number; mid: number }>,
  png: PNG,
): { start: number; end: number; mid: number } | null {
  if (rules.length === 0) return null;
  if (rules.length === 1) return rules[0];

  // Score by horizontal span width at cluster mid
  let best = rules[0];
  let bestScore = 0;
  for (const r of rules) {
    const y = Math.round(r.mid);
    let run = 0;
    let maxRun = 0;
    for (let x = Math.floor(png.width * 0.12); x < Math.floor(png.width * 0.88); x++) {
      if (isLinePixel(px(png, x, y))) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
    const bandBonus = r.mid > png.height * 0.36 && r.mid < png.height * 0.52 ? 500 : 0;
    const score = maxRun + bandBonus;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

const APPRECIATION_FALLBACK_RULE_PDFY = 303.4; // appreciation-pr @ px 287

async function measureTemplate(
  code: string,
  pdfBytes: Buffer,
): Promise<{ rulePx: number; rulePdfY: number }> {
  const isAward = code.startsWith("best-");
  const searchTop = isAward ? 0.42 : 0.28;
  const searchBot = isAward ? 0.58 : 0.55;
  const png = await renderPdfToPng(pdfBytes);
  const y0 = Math.floor(png.height * searchTop);
  const y1 = Math.floor(png.height * searchBot);
  const rules = findHorizontalRules(png, y0, y1);
  let rule = pickNameRule(rules, png);
  if (!rule) {
    const relaxed = findHorizontalRules(png, y0, y1, 0.32);
    rule = pickNameRule(relaxed, png);
  }
  if (!rule && code.startsWith("appreciation-")) {
    return { rulePx: NaN, rulePdfY: APPRECIATION_FALLBACK_RULE_PDFY };
  }
  if (!rule) throw new Error(`${code}: no name-area rule found (${rules.length} clusters)`);
  return { rulePx: rule.mid, rulePdfY: pxToPdfY(rule.mid, png.height) };
}

async function measureGeneratedGap(code: string): Promise<{ gapPt: number; rulePdfY: number; namePdfY: number; gapPx: number }> {
  const isAward = code.startsWith("best-");
  const searchTop = isAward ? 0.42 : 0.28;
  const searchBot = isAward ? 0.58 : 0.55;
  const sample =
    code === "participation"
      ? { titlePrefix: "DR.", firstName: "John", lastName: "Smith" }
      : code === "best-oral-silver"
        ? { titlePrefix: "นาย", firstName: "ณัฐกานต์", lastName: "กลองกระโทก" }
        : code === "appreciation-organizing-committee"
          ? { titlePrefix: "ดร.", firstName: "Nattakarn", lastName: "Klongkratok" }
          : { titlePrefix: "MR.", firstName: "Nattakarn", lastName: "Klongkratok" };

  const { buffer } = await generateCertificatePdf(code, sample);
  const png = await renderPdfToPng(buffer);

  const y0 = Math.floor(png.height * searchTop);
  const y1 = Math.floor(png.height * searchBot);
  const rules = findHorizontalRules(png, y0, y1);
  let rule = pickNameRule(rules, png);
  if (!rule) {
    const relaxed = findHorizontalRules(png, y0, y1, 0.32);
    rule = pickNameRule(relaxed, png);
  }
  const nameBot = findBlueNameBottom(png, y0, y1);

  if (!rule && code.startsWith("appreciation-")) {
    const rulePdfY = APPRECIATION_FALLBACK_RULE_PDFY;
    if (nameBot == null) throw new Error(`${code}: no blue name in generated PDF`);
    const namePdfY = pxToPdfY(nameBot, png.height);
    return { gapPt: namePdfY - rulePdfY, rulePdfY, namePdfY, gapPx: NaN };
  }

  if (!rule || nameBot == null) {
    throw new Error(`${code}: could not measure generated gap (rule=${!!rule}, name=${nameBot})`);
  }

  const rulePdfY = pxToPdfY(rule.mid, png.height);
  const namePdfY = pxToPdfY(nameBot, png.height);
  const gapPx = nameBot - rule.mid;
  const gapPt = namePdfY - rulePdfY;

  return { gapPt, rulePdfY, namePdfY, gapPx };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const templatesDir = path.resolve(__dirname, "../src/templates/certificates");
  const configPath = path.join(templatesDir, "config.json");
  const templates = loadCertificateTemplates();

  console.log(`Reference: ${REF_CODE} y=${REF_Y} (unchanged)\n`);

  // 1. Rule position on blank poster-evaluator template
  const refBlankPath = path.join(templatesDir, "poster-evaluator.pdf");
  const refBlank = await measureTemplate(REF_CODE, fs.readFileSync(refBlankPath));
  const refGapPt = REF_Y - refBlank.rulePdfY;

  console.log(`Reference blank rule: px=${refBlank.rulePx.toFixed(1)} pdfY=${refBlank.rulePdfY.toFixed(2)}`);
  console.log(`Reference gap (baseline - rule): ${refGapPt.toFixed(2)} pt\n`);

  // 2. Verify reference generated PDF matches intended gap
  const refGen = await measureGeneratedGap(REF_CODE);
  console.log(
    `Reference generated: namePdfY=${refGen.namePdfY.toFixed(2)} rulePdfY=${refGen.rulePdfY.toFixed(2)} gap=${refGen.gapPt.toFixed(2)}pt (${refGen.gapPx.toFixed(1)}px)\n`,
  );

  const results: Array<{
    code: string;
    oldY: number;
    newY: number;
    rulePdfY: number;
    currentGapPt: number;
    targetGapPt: number;
  }> = [];

  console.log("Template".padEnd(40) + "rulePdfY  oldY  newY   curGap  tgtGap");
  console.log("-".repeat(88));

  for (const t of templates) {
    if (t.code === REF_CODE) continue;

    const blankPath = path.join(templatesDir, t.pdfFile);
    const blank = await measureTemplate(t.code, fs.readFileSync(blankPath));
    const newY = Math.round((blank.rulePdfY + refGapPt) * 10) / 10;

    let currentGapPt = NaN;
    try {
      const gen = await measureGeneratedGap(t.code);
      currentGapPt = gen.gapPt;
    } catch {
      currentGapPt = NaN;
    }

    results.push({
      code: t.code,
      oldY: t.namePlacement.y,
      newY,
      rulePdfY: blank.rulePdfY,
      currentGapPt,
      targetGapPt: refGapPt,
    });

    console.log(
      `${t.code.padEnd(40)}${blank.rulePdfY.toFixed(1).padStart(8)}  ${String(t.namePlacement.y).padStart(4)}  ${String(newY).padStart(5)}  ${(Number.isNaN(currentGapPt) ? "?" : currentGapPt.toFixed(1)).padStart(6)}  ${refGapPt.toFixed(1).padStart(6)}`,
    );
  }

  if (!apply) {
    console.log("\nDry run — pass --apply to update config.json");
    return;
  }

  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as typeof templates extends infer U ? U : never;
  for (const row of results) {
    const entry = config.find((c: { code: string }) => c.code === row.code);
    if (entry) {
      entry.namePlacement.y = row.newY;
      entry.namePlacement._calibrationNote = `Unified gap with ${REF_CODE} (y=${REF_Y}): baseline +${row.targetGapPt.toFixed(1)}pt above rule (rulePdfY≈${row.rulePdfY.toFixed(1)}). Was ${row.oldY}.`;
    }
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log("\nUpdated config.json");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
