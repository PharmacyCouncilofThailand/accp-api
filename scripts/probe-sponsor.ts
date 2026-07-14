import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";
import { pdf } from "pdf-to-img";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = process.argv[2] ?? "appreciation-sponsor";
const pdfPath = path.resolve(__dirname, `../src/templates/certificates/${code}.pdf`);
const doc = await pdf(fs.readFileSync(pdfPath), { scale: 1024 / 737.04 });
let raw: Buffer | null = null;
for await (const page of doc) {
  raw = page;
  break;
}
const png = await new Promise<PNG>((res, rej) =>
  new PNG().parse(raw!, (e, d) => (e ? rej(e) : res(d))),
);

const px = (x: number, y: number) => {
  const i = (png.width * y + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] as const;
};

// sample center row around expected name line
for (const y of [283, 284, 285, 286, 287, 288, 289, 290, 330, 331, 332]) {
  const samples: string[] = [];
  for (const x of [200, 400, 512, 624, 800]) {
    const [r, g, b, a] = px(x, y);
    samples.push(`${x}:${r},${g},${b},${a}`);
  }
  console.log(`y=${y}`, samples.join(" | "));
}
