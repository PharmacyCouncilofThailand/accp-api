/**
 * Scan 1024x710 certificate screenshots to measure name-rule gaps.
 * Usage: npx tsx scripts/scan-cert-screenshots.ts [assetsDir]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_H = 510.24;

const IMAGE_MAP: Record<string, string> = {
  "best-oral-silver": "1783741735050",
  "appreciation-sponsor": "1783741733346",
  "best-poster-gold": "1783741734852",
  "appreciation-speaker": "1783741732247",
  "best-oral-gold": "1783741734536",
  "appreciation-session-moderator": "1783741736758",
  "appreciation-organizing-committee": "1783741736221",
  "oral-presentation": "1783741734926",
  "appreciation-pr": "1783741739121",
  "best-poster-silver": "1783741732903",
  "appreciation-ceremony-performances": "1783741734539",
  participation: "1783741738402",
  "poster-presentation": "1783741734990",
  "oral-evaluator": "1783741736082",
  "poster-evaluator": "1783741735448",
};

function loadPng(filePath: string): Promise<PNG> {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(new PNG())
      .on("parsed", function onParsed(this: PNG) {
        resolve(this);
      })
      .on("error", reject);
  });
}

function px(png: PNG, x: number, y: number): [number, number, number, number] {
  const i = (png.width * y + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]];
}

function isDark([r, g, b, a]: [number, number, number, number], thr = 55): boolean {
  return a > 128 && r < thr && g < thr && b < thr;
}

function isBlue([r, g, b, a]: [number, number, number, number]): boolean {
  return a > 128 && r < 80 && g < 80 && b > 60 && b > r + 20;
}

function pxToPdfY(py: number, imgH: number): number {
  return PAGE_H - (py / imgH) * PAGE_H;
}

function findHorizontalRules(png: PNG, y0: number, y1: number) {
  const hits: number[] = [];
  for (let y = y0; y < y1; y++) {
    let run = 0;
    let maxRun = 0;
    for (let x = Math.floor(png.width * 0.12); x < Math.floor(png.width * 0.88); x++) {
      if (isDark(px(png, x, y))) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
    if (maxRun > png.width * 0.25) hits.push(y);
  }
  const clusters: Array<{ start: number; end: number; mid: number }> = [];
  for (const y of hits) {
    const last = clusters[clusters.length - 1];
    if (!last || y > last.end + 1) clusters.push({ start: y, end: y, mid: y });
    else {
      last.end = y;
      last.mid = (last.start + last.end) / 2;
    }
  }
  return clusters;
}

function pickNameRule(rules: Array<{ mid: number }>, png: PNG) {
  if (!rules.length) return null;
  let best = rules[0];
  let bestScore = 0;
  for (const r of rules) {
    const y = Math.round(r.mid);
    let maxRun = 0;
    let run = 0;
    for (let x = Math.floor(png.width * 0.12); x < Math.floor(png.width * 0.88); x++) {
      if (isDark(px(png, x, y))) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else run = 0;
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

function findBlueBottom(png: PNG, y0: number, y1: number): number | null {
  let maxY = -1;
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = 0; x < png.width; x++) if (isBlue(px(png, x, y))) c++;
    if (c > 10) maxY = y;
  }
  return maxY >= 0 ? maxY : null;
}

async function main() {
  const assetsDir =
    process.argv[2] ??
    path.resolve(__dirname, "../../.cursor/projects/d-confer-confer-confer/assets");

  const altAssets = path.resolve(
    "C:/Users/JaoNo/.cursor/projects/d-confer-confer-confer/assets",
  );
  const dir = fs.existsSync(assetsDir) ? assetsDir : altAssets;

  console.log(`Assets: ${dir}\n`);
  console.log(
    "code".padEnd(38) +
      "rulePx  nameBot  gapPx  gapPt  rulePdfY  namePdfY",
  );
  console.log("-".repeat(95));

  let refGapPx: number | null = null;
  let refGapPt: number | null = null;

  for (const [code, ts] of Object.entries(IMAGE_MAP)) {
    const files = fs.readdirSync(dir).filter((f) => f.includes(ts));
    if (!files.length) {
      console.log(`${code}: image not found (${ts})`);
      continue;
    }
    const png = await loadPng(path.join(dir, files[0]!));
    const y0 = Math.floor(png.height * 0.28);
    const y1 = Math.floor(png.height * 0.58);
    const rules = findHorizontalRules(png, y0, y1);
    const rule = pickNameRule(rules, png);
    const nameBot = findBlueBottom(png, y0, y1);

    if (!rule || nameBot == null) {
      console.log(`${code}: measure failed rules=${rules.length}`);
      continue;
    }

    const gapPx = nameBot - rule.mid;
    const rulePdfY = pxToPdfY(rule.mid, png.height);
    const namePdfY = pxToPdfY(nameBot, png.height);
    const gapPt = namePdfY - rulePdfY;

    if (code === "poster-evaluator") {
      refGapPx = gapPx;
      refGapPt = gapPt;
    }

    console.log(
      `${code.padEnd(38)}${rule.mid.toFixed(0).padStart(6)}  ${String(nameBot).padStart(7)}  ${gapPx.toFixed(1).padStart(5)}  ${gapPt.toFixed(2).padStart(5)}  ${rulePdfY.toFixed(1).padStart(8)}  ${namePdfY.toFixed(1).padStart(8)}`,
    );
  }

  console.log(`\nReference poster-evaluator gap: ${refGapPx?.toFixed(1)}px / ${refGapPt?.toFixed(2)}pt`);
}

main().catch(console.error);
