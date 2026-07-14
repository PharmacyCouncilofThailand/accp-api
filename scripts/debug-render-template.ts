import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import { pdf } from "pdf-to-img";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = process.argv[2] ?? "poster-evaluator";
const pdfPath = path.resolve(__dirname, `../src/templates/certificates/${code}.pdf`);
const bytes = fs.readFileSync(pdfPath);

const doc = await pdf(bytes, { scale: 1024 / 737.04 });
for await (const page of doc) {
  const out = path.resolve(__dirname, `../calibration-output/_debug-${code}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page);
  const png = await new Promise<PNG>((res, rej) =>
    new PNG().parse(page, (e, d) => (e ? rej(e) : res(d))),
  );
  console.log("saved", out, png.width, "x", png.height);

  const px = (x: number, y: number) => {
    const i = (png.width * y + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] as const;
  };

  for (let y = 200; y < 500; y++) {
    let run = 0;
    let maxRun = 0;
    for (let x = 150; x < 874; x++) {
      const [r, g, b, a] = px(x, y);
      if (a < 128) {
        run = 0;
        continue;
      }
      const line = r + g + b < 165 || (Math.abs(r - g) < 25 && Math.abs(g - b) < 25 && r < 210 && r > 80);
      if (line) {
        run++;
        maxRun = Math.max(maxRun, run);
      } else run = 0;
    }
    if (maxRun > 250) console.log(`y=${y} maxRun=${maxRun}`);
  }
  break;
}
