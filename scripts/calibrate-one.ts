import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateCertificatePdf } from "../src/services/certificatePdf.service.js";
import { loadCertificateTemplates } from "../src/services/certificatePdf.service.js";

const code = process.argv[2];
if (!code) {
  console.error("Usage: npx tsx scripts/calibrate-one.ts <template-code>");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templates = loadCertificateTemplates();
const template = templates.find((t) => t.code === code);
if (!template) {
  console.error(`Unknown template: ${code}`);
  process.exit(1);
}

const samples: Record<string, { titlePrefix: string; firstName: string; lastName: string }> = {
  "participation": {
    titlePrefix: "DR.",
    firstName: "John",
    lastName: "Smith",
  },
  "poster-presentation": {
    titlePrefix: "MR.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "poster-evaluator": {
    titlePrefix: "MRS.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "best-poster-gold": {
    titlePrefix: "MR.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "best-poster-silver": {
    titlePrefix: "MR.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "oral-evaluator": {
    titlePrefix: "MR.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "oral-presentation": {
    titlePrefix: "MR.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "appreciation-sponsor": {
    titlePrefix: "ASSOC. PROF.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "appreciation-speaker": {
    titlePrefix: "PROF.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "appreciation-session-moderator": {
    titlePrefix: "MR.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "appreciation-pr": {
    titlePrefix: "DR.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "appreciation-organizing-committee": {
    titlePrefix: "ดร.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
  "appreciation-ceremony-performances": {
    titlePrefix: "ASSOC. PROF.",
    firstName: "Nattakarn",
    lastName: "Klongkratok",
  },
};

const sample = samples[code] ?? { titlePrefix: "DR.", firstName: "Sample", lastName: "Recipient" };
const outDir = path.resolve(__dirname, "../calibration-output");
fs.mkdirSync(outDir, { recursive: true });

const { buffer, certificateName } = await generateCertificatePdf(code, sample);
const outPath = path.join(outDir, `${code}.pdf`);
fs.writeFileSync(outPath, buffer);
console.log(`✓ ${code} → ${outPath}`);
console.log(`  y=${template.namePlacement.y}, size=${template.namePlacement.defaultFontSize}pt, name="${certificateName}"`);
