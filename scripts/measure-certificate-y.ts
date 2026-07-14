/**
 * Pixel-measure name placement vs template rule line.
 *
 * Usage:
 *   npx tsx scripts/measure-certificate-y.ts poster-evaluator [screenshot.png]
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import { PDFDocument } from "pdf-lib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_W = 737.04;
const PAGE_H = 510.24;

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

function isDark([r, g, b, a]: [number, number, number, number], thr = 50): boolean {
  return a > 128 && r < thr && g < thr && b < thr;
}

function isBlue([r, g, b, a]: [number, number, number, number]): boolean {
  return a > 128 && r < 80 && g < 80 && b > 60 && b > r + 20;
}

function pxToPdfY(py: number, imgH: number): number {
  return PAGE_H - (py / imgH) * PAGE_H;
}

function findHorizontalRules(png: PNG, y0: number, y1: number): Array<{ start: number; end: number }> {
  const hits: number[] = [];
  for (let y = y0; y < y1; y++) {
    let run = 0;
    let maxRun = 0;
    for (let x = Math.floor(png.width * 0.15); x < Math.floor(png.width * 0.85); x++) {
      if (isDark(px(png, x, y))) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else {
        run = 0;
      }
    }
    if (maxRun > png.width * 0.25) hits.push(y);
  }

  const clusters: Array<{ start: number; end: number }> = [];
  for (const y of hits) {
    const last = clusters[clusters.length - 1];
    if (!last || y > last.end + 1) clusters.push({ start: y, end: y });
    else last.end = y;
  }
  return clusters;
}

function findColorClusters(
  png: PNG,
  y0: number,
  y1: number,
  test: (px: [number, number, number, number]) => boolean,
): Array<{ start: number; end: number }> {
  const rows: number[] = [];
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = 0; x < png.width; x++) {
      if (test(px(png, x, y))) c++;
    }
    if (c > 15) rows.push(y);
  }

  const clusters: Array<{ start: number; end: number }> = [];
  for (const y of rows) {
    const last = clusters[clusters.length - 1];
    if (!last || y > last.end + 2) clusters.push({ start: y, end: y });
    else last.end = y;
  }
  return clusters;
}

async function main() {
  const templateCode = process.argv[2] ?? "poster-evaluator";
  const screenshot = process.argv[3];

  const tplPath = path.resolve(__dirname, `../src/templates/certificates/${templateCode}.pdf`);
  const tplBytes = fs.readFileSync(tplPath);
  const pdf = await PDFDocument.load(tplBytes);
  const size = pdf.getPage(0).getSize();
  console.log(`Template ${templateCode}: ${size.width.toFixed(2)} x ${size.height.toFixed(2)} pt`);

  if (!screenshot) {
    console.log("Provide a rendered screenshot PNG as 2nd argument for pixel measurement.");
    return;
  }

  const png = await loadPng(path.resolve(screenshot));
  console.log(`Screenshot: ${png.width} x ${png.height} px`);
  console.log(`Scale Y: ${(PAGE_H / png.height).toFixed(4)} pt/px\n`);

  const rules = findHorizontalRules(png, Math.floor(png.height * 0.3), Math.floor(png.height * 0.55));
  console.log("Horizontal rules:");
  for (const r of rules) {
    const mid = (r.start + r.end) / 2;
    console.log(`  px y=${r.start}-${r.end}  →  pdfY=${pxToPdfY(mid, png.height).toFixed(2)}`);
  }

  const blue = findColorClusters(png, Math.floor(png.height * 0.35), Math.floor(png.height * 0.5), isBlue);
  console.log("\nBlue name text:");
  for (const b of blue) {
    console.log(
      `  px top=${b.start} bot=${b.end}  →  pdfY_baseline≈${pxToPdfY(b.end, png.height).toFixed(2)}`,
    );
  }

  const ruleMid = rules[0] ? (rules[0].start + rules[0].end) / 2 : null;
  const nameBot = blue[0]?.end ?? null;
  if (ruleMid != null && nameBot != null) {
    const rulePdfY = pxToPdfY(ruleMid, png.height);
    const namePdfY = pxToPdfY(nameBot, png.height);
    const recommended = Math.round((rulePdfY + 3) * 10) / 10;
    console.log(`\nCurrent name baseline pdfY≈${namePdfY.toFixed(2)}`);
    console.log(`Template rule pdfY≈${rulePdfY.toFixed(2)}`);
    console.log(`Recommended config y (baseline ~3pt above rule): ${recommended}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
