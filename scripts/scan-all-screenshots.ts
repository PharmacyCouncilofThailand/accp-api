import fs from "fs";
import path from "path";
import { PNG } from "pngjs";

const dir = "C:/Users/JaoNo/.cursor/projects/d-confer-confer-confer/assets";
const PAGE_H = 510.24;

function px(png: PNG, x: number, y: number) {
  const i = (png.width * y + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] as const;
}

function isLinePixel(r: number, g: number, b: number, a: number) {
  return a > 128 && (r + g + b < 120 || (r < 80 && g < 80 && b > 60));
}

function loadPng(file: string): Promise<PNG> {
  return new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .pipe(new PNG())
      .on("parsed", function onParsed(this: PNG) {
        resolve(this);
      })
      .on("error", reject);
  });
}

function pxToPdfY(py: number, imgH: number) {
  return PAGE_H - (py / imgH) * PAGE_H;
}

async function analyze(file: string) {
  const png = await loadPng(path.join(dir, file));
  const y0 = Math.floor(png.height * 0.28);
  const y1 = Math.floor(png.height * 0.58);

  const ruleRows: Array<{ y: number; run: number }> = [];
  for (let y = y0; y < y1; y++) {
    let run = 0;
    let maxRun = 0;
    for (let x = Math.floor(png.width * 0.15); x < Math.floor(png.width * 0.85); x++) {
      const [r, g, b, a] = px(png, x, y);
      if (isLinePixel(r, g, b, a)) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else run = 0;
    }
    if (maxRun > png.width * 0.2) ruleRows.push({ y, run: maxRun });
  }

  // cluster rule rows
  const clusters: Array<{ start: number; end: number; maxRun: number }> = [];
  for (const row of ruleRows) {
    const last = clusters[clusters.length - 1];
    if (!last || row.y > last.end + 2) clusters.push({ start: row.y, end: row.y, maxRun: row.run });
    else {
      last.end = row.y;
      last.maxRun = Math.max(last.maxRun, row.run);
    }
  }

  // pick cluster in name band with widest run
  let best = clusters[0];
  for (const c of clusters) {
    const mid = (c.start + c.end) / 2;
    const bandBonus = mid > png.height * 0.36 && mid < png.height * 0.52 ? 1e6 : 0;
    const score = c.maxRun + bandBonus;
    const bestMid = best ? (best.start + best.end) / 2 : 0;
    const bestScore = best.maxRun + (bestMid > png.height * 0.36 && bestMid < png.height * 0.52 ? 1e6 : 0);
    if (!best || score > bestScore) best = c;
  }

  let blueBot = -1;
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = 0; x < png.width; x++) {
      const [r, g, b, a] = px(png, x, y);
      if (a > 128 && r < 80 && g < 80 && b > 60 && b > r + 20) c++;
    }
    if (c > 10) blueBot = y;
  }

  const ts = file.match(/images_(\d+)/)?.[1] ?? "?";
  const ruleMid = best ? (best.start + best.end) / 2 : NaN;
  const gapPx = blueBot >= 0 && best ? blueBot - ruleMid : NaN;
  const rulePdfY = pxToPdfY(ruleMid, png.height);
  const namePdfY = pxToPdfY(blueBot, png.height);
  const gapPt = namePdfY - rulePdfY;

  console.log(
    `${ts}\t${png.width}x${png.height}\trulePx=${ruleMid.toFixed(1)}\tblueBot=${blueBot}\tgapPx=${gapPx.toFixed(1)}\tgapPt=${gapPt.toFixed(2)}\trulePdfY=${rulePdfY.toFixed(1)}`,
  );
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
for (const f of files) await analyze(f);
