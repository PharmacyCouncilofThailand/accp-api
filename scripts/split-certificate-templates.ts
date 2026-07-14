/**
 * Split merged certificate PDF into individual template files.
 *
 * Usage:
 *   npx tsx scripts/split-certificate-templates.ts [sourcePdfPath]
 *
 * Default source: ../../../Users/JaoNo/Downloads/Temp 1-01_merged.pdf
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PDFDocument } from "pdf-lib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEMPLATE_FILES = [
  "participation.pdf",
  "oral-presentation.pdf",
  "poster-presentation.pdf",
  "appreciation-pr.pdf",
  "best-poster-silver.pdf",
  "best-poster-gold.pdf",
  "best-oral-gold.pdf",
  "best-oral-silver.pdf",
  "oral-evaluator.pdf",
  "poster-evaluator.pdf",
  "appreciation-sponsor.pdf",
  "appreciation-organizing-committee.pdf",
  "appreciation-speaker.pdf",
  "appreciation-session-moderator.pdf",
  "appreciation-ceremony-performances.pdf",
];

async function main() {
  const defaultSource = path.resolve(
    "C:/Users/JaoNo/Downloads/Temp 1-01_merged.pdf"
  );
  const sourcePath = process.argv[2]
    ? path.resolve(process.argv[2])
    : defaultSource;

  if (!fs.existsSync(sourcePath)) {
    console.error(`Source PDF not found: ${sourcePath}`);
    process.exit(1);
  }

  const outDir = path.resolve(__dirname, "../src/templates/certificates");
  fs.mkdirSync(outDir, { recursive: true });

  const bytes = fs.readFileSync(sourcePath);
  const srcDoc = await PDFDocument.load(bytes);
  const pageCount = srcDoc.getPageCount();

  if (pageCount < TEMPLATE_FILES.length) {
    console.error(
      `Expected at least ${TEMPLATE_FILES.length} pages, got ${pageCount}`
    );
    process.exit(1);
  }

  for (let i = 0; i < TEMPLATE_FILES.length; i++) {
    const newDoc = await PDFDocument.create();
    const [page] = await newDoc.copyPages(srcDoc, [i]);
    newDoc.addPage(page);
    const pdfBytes = await newDoc.save();
    const outPath = path.join(outDir, TEMPLATE_FILES[i]);
    fs.writeFileSync(outPath, pdfBytes);

    const { width, height } = page.getSize();
    console.log(
      `Wrote ${TEMPLATE_FILES[i]} (${width.toFixed(0)}x${height.toFixed(0)})`
    );
  }

  console.log(`Done — ${TEMPLATE_FILES.length} templates in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
