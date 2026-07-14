import fs from "fs";
import { PNG } from "pngjs";

const file = process.argv[2]!;
const png = await new Promise<PNG>((res, rej) =>
  fs
    .createReadStream(file)
    .pipe(new PNG())
    .on("parsed", function onParsed(this: PNG) {
      res(this);
    })
    .on("error", rej),
);

const px = (x: number, y: number) => {
  const i = (png.width * y + x) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2], png.data[i + 3]] as const;
};

for (let y = 270; y <= 400; y++) {
  let dark = 0;
  let blue = 0;
  let gray = 0;
  for (let x = 200; x < 824; x++) {
    const [r, g, b, a] = px(x, y);
    if (a < 128) continue;
    if (r < 80 && g < 80 && b > 60) blue++;
    else if (r + g + b < 200) dark++;
    else if (Math.abs(r - g) < 15 && Math.abs(g - b) < 15 && r < 180) gray++;
  }
  if (dark > 80 || blue > 80 || gray > 150) {
    console.log(`y=${y} dark=${dark} blue=${blue} gray=${gray}`);
  }
}
