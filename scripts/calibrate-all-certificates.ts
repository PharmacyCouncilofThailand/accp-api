/**
 * Generate calibration preview PDFs for all certificate templates.
 *
 * Usage:
 *   npx tsx scripts/calibrate-all-certificates.ts
 *
 * Output: accp-api/calibration-output/{template-code}.pdf
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateCertificatePdf, loadCertificateTemplates } from "../src/services/certificatePdf.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLE_NAMES: Record<string, { titlePrefix: string; firstName: string; lastName: string }> = {
  participation: { titlePrefix: "DR.", firstName: "John", lastName: "Smith" },
  "oral-presentation": { titlePrefix: "MR.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "poster-presentation": { titlePrefix: "MR.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "appreciation-pr": { titlePrefix: "DR.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "best-poster-silver": { titlePrefix: "MR.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "best-poster-gold": { titlePrefix: "MR.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "best-oral-gold": { titlePrefix: "ASSOC. PROF.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "best-oral-silver": { titlePrefix: "นาย", firstName: "ณัฐกานต์", lastName: "กลองกระโทก" },
  "oral-evaluator": { titlePrefix: "MR.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "poster-evaluator": { titlePrefix: "MRS.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "appreciation-sponsor": { titlePrefix: "ASSOC. PROF.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "appreciation-organizing-committee": { titlePrefix: "ดร.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "appreciation-speaker": { titlePrefix: "PROF.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "appreciation-session-moderator": { titlePrefix: "MR.", firstName: "Nattakarn", lastName: "Klongkratok" },
  "appreciation-ceremony-performances": { titlePrefix: "ASSOC. PROF.", firstName: "Nattakarn", lastName: "Klongkratok" },
};

async function main() {
  const outDir = path.resolve(__dirname, "../calibration-output");
  fs.mkdirSync(outDir, { recursive: true });

  const templates = loadCertificateTemplates();
  const summary: Array<{ code: string; y: number; fontSize: number; name: string }> = [];

  for (const template of templates) {
    const sample = SAMPLE_NAMES[template.code] ?? {
      titlePrefix: "DR.",
      firstName: "Sample",
      lastName: "Recipient",
    };

    const { buffer, certificateName } = await generateCertificatePdf(
      template.code,
      sample,
    );

    const outPath = path.join(outDir, `${template.code}.pdf`);
    fs.writeFileSync(outPath, buffer);

    summary.push({
      code: template.code,
      y: template.namePlacement.y,
      fontSize: template.namePlacement.defaultFontSize,
      name: certificateName,
    });

    console.log(`✓ ${template.code} → ${outPath}`);
    console.log(`  y=${template.namePlacement.y}, size=${template.namePlacement.defaultFontSize}pt, name="${certificateName}"`);
  }

  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log(`\nDone — ${templates.length} previews in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
