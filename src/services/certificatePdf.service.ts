import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import {
  buildCertificateFilename,
  formatCertificateName,
  type CertificateNameParts,
} from "../utils/certificateName.js";
import { splitIntoScriptRuns, type CertificateScript } from "../utils/certificateScript.js";
import type { CertificateRecipientInput } from "../schemas/certificates.schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const archiver = require("archiver") as (
  format: string,
  options?: { zlib?: { level?: number } },
) => import("archiver").Archiver;

export const CERTIFICATE_NAME_COLOR = rgb(0, 32 / 255, 96 / 255);

export interface CertificateNamePlacement {
  x: number;
  y: number;
  maxWidth: number;
  defaultFontSize: number;
  minFontSize: number;
  align: "left" | "center" | "right";
}

export interface CertificateTemplateConfig {
  code: string;
  name: string;
  pdfFile: string;
  nameLabel: string;
  namePlacement: CertificateNamePlacement;
  dbSource?: {
    enabled: boolean;
    sourceType: string;
    defaultFilters?: Record<string, unknown>;
  };
}

interface FontSet {
  latin: PDFFont;
  thai: PDFFont;
  cjk: PDFFont;
  korean: PDFFont;
}

let templateConfigs: CertificateTemplateConfig[] | null = null;

/** Clear cached templates (useful after config.json changes in dev). */
export function resetCertificateTemplateCache(): void {
  templateConfigs = null;
}

function resolveTemplatesDir(): string {
  const candidates = [
    path.resolve(__dirname, "..", "templates", "certificates"),
    path.resolve(__dirname, "..", "..", "src", "templates", "certificates"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "config.json"))) return candidate;
  }
  throw new Error("Certificate templates directory not found");
}

function resolveGaramondDir(): string | null {
  const candidates = [
    path.resolve(__dirname, "..", "..", "public", "Font", "garamond"),
    path.resolve(__dirname, "..", "public", "Font", "garamond"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "GARABD.TTF"))) return candidate;
  }
  return null;
}

function resolveFontsDir(): string {
  const candidates = [
    path.resolve(__dirname, "..", "assets", "fonts"),
    path.resolve(__dirname, "..", "..", "src", "assets", "fonts"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("Certificate fonts directory not found");
}


function isValidFontBytes(bytes: Buffer): boolean {
  if (bytes.length < 1000) return false;
  // TrueType: 0x00010000, OpenType: 'OTTO', Mac: 'true'/'typ1'
  const sig = bytes.readUInt32BE(0);
  return (
    sig === 0x00010000 ||
    bytes.toString("ascii", 0, 4) === "OTTO" ||
    bytes.toString("ascii", 0, 4) === "true" ||
    bytes.toString("ascii", 0, 4) === "typ1"
  );
}

async function embedFirstAvailableFont(
  pdfDoc: PDFDocument,
  fontPaths: string[],
): Promise<PDFFont> {
  let lastError: unknown;
  for (const fullPath of fontPaths) {
    if (!fs.existsSync(fullPath)) continue;
    if (fullPath.endsWith(".ttc")) continue;
    try {
      const bytes = fs.readFileSync(fullPath);
      if (!isValidFontBytes(bytes)) {
        lastError = new Error(`Invalid font file (not TTF/OTF): ${fullPath}`);
        continue;
      }
      return await pdfDoc.embedFont(bytes, { subset: true });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Font not found. Tried: ${fontPaths.join(", ")}`);
}

function fontPath(dir: string, filename: string): string {
  return path.join(dir, filename);
}

export function loadCertificateTemplates(): CertificateTemplateConfig[] {
  if (templateConfigs) return templateConfigs;
  const templatesDir = resolveTemplatesDir();
  const raw = fs.readFileSync(path.join(templatesDir, "config.json"), "utf8");
  templateConfigs = JSON.parse(raw) as CertificateTemplateConfig[];
  return templateConfigs;
}

export function getCertificateTemplate(
  code: string,
): CertificateTemplateConfig | undefined {
  return loadCertificateTemplates().find((t) => t.code === code);
}

async function embedFonts(pdfDoc: PDFDocument): Promise<FontSet> {
  pdfDoc.registerFontkit(fontkit);
  const fontsDir = resolveFontsDir();
  const garamondDir = resolveGaramondDir();

  const latinPaths = [
    ...(garamondDir
      ? [fontPath(garamondDir, "GARABD.TTF"), fontPath(garamondDir, "GARA.TTF")]
      : []),
    fontPath(fontsDir, "EBGaramond-Bold.ttf"),
    fontPath(fontsDir, "EBGaramond-Regular.ttf"),
    fontPath(fontsDir, "NotoSerif-Regular.ttf"),
  ];

  const thaiPaths = [
    fontPath(fontsDir, "NotoSerifThai-Bold.ttf"),
    fontPath(fontsDir, "NotoSerifThai-Regular.ttf"),
    fontPath(fontsDir, "NotoSerif-Regular.ttf"),
  ];

  const cjkPaths = [
    fontPath(fontsDir, "NotoSerifSC-Regular.otf"),
    fontPath(fontsDir, "NotoSerif-Regular.ttf"),
  ];

  const koreanPaths = [
    fontPath(fontsDir, "malgunbd.ttf"),
    fontPath(fontsDir, "malgun.ttf"),
    fontPath(fontsDir, "NotoSerif-Regular.ttf"),
  ];

  const [latin, thai, cjk, korean] = await Promise.all([
    embedFirstAvailableFont(pdfDoc, latinPaths),
    embedFirstAvailableFont(pdfDoc, thaiPaths),
    embedFirstAvailableFont(pdfDoc, cjkPaths),
    embedFirstAvailableFont(pdfDoc, koreanPaths),
  ]);

  return { latin, thai, cjk, korean };
}

function fontForScript(fonts: FontSet, script: CertificateScript): PDFFont {
  switch (script) {
    case "thai":
      return fonts.thai;
    case "cjk":
      return fonts.cjk;
    case "korean":
      return fonts.korean;
    default:
      return fonts.latin;
  }
}

function measureRunsWidth(
  runs: ReturnType<typeof splitIntoScriptRuns>,
  fonts: FontSet,
  fontSize: number,
): number {
  return runs.reduce((total, run) => {
    const font = fontForScript(fonts, run.script);
    return total + font.widthOfTextAtSize(run.text, fontSize);
  }, 0);
}

function resolveFontSize(
  text: string,
  fonts: FontSet,
  placement: CertificateNamePlacement,
): { fontSize: number; tooLong: boolean } {
  const runs = splitIntoScriptRuns(text);
  let fontSize = placement.defaultFontSize;
  let width = measureRunsWidth(runs, fonts, fontSize);

  while (width > placement.maxWidth && fontSize > placement.minFontSize) {
    fontSize -= 0.5;
    width = measureRunsWidth(runs, fonts, fontSize);
  }

  return {
    fontSize,
    tooLong: width > placement.maxWidth,
  };
}

function drawCertificateName(
  page: PDFPage,
  text: string,
  fonts: FontSet,
  placement: CertificateNamePlacement,
): { tooLong: boolean } {
  const runs = splitIntoScriptRuns(text);
  const { fontSize, tooLong } = resolveFontSize(text, fonts, placement);
  const totalWidth = measureRunsWidth(runs, fonts, fontSize);
  const { width: pageWidth } = page.getSize();

  let cursorX = placement.x;
  if (placement.align === "center") {
    cursorX = (pageWidth - totalWidth) / 2;
  } else if (placement.align === "right") {
    cursorX = placement.x - totalWidth;
  }

  for (const run of runs) {
    const font = fontForScript(fonts, run.script);
    page.drawText(run.text, {
      x: cursorX,
      y: placement.y,
      size: fontSize,
      font,
      color: CERTIFICATE_NAME_COLOR,
    });
    cursorX += font.widthOfTextAtSize(run.text, fontSize);
  }

  return { tooLong };
}

export async function generateCertificatePdf(
  templateCode: string,
  recipient: CertificateNameParts,
): Promise<{ buffer: Buffer; certificateName: string; tooLong: boolean }> {
  const template = getCertificateTemplate(templateCode);
  if (!template) {
    throw new Error(`Unknown certificate template: ${templateCode}`);
  }

  const templatesDir = resolveTemplatesDir();
  const templatePath = path.join(templatesDir, template.pdfFile);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template PDF not found: ${template.pdfFile}`);
  }

  const certificateName = formatCertificateName(recipient);
  const templateBytes = fs.readFileSync(templatePath);
  const srcDoc = await PDFDocument.load(templateBytes);
  const pdfDoc = await PDFDocument.create();
  const [copiedPage] = await pdfDoc.copyPages(srcDoc, [0]);
  const page = pdfDoc.addPage(copiedPage);
  const fonts = await embedFonts(pdfDoc);
  const drawResult = drawCertificateName(
    page,
    certificateName,
    fonts,
    template.namePlacement,
  );

  const bytes = await pdfDoc.save();
  return {
    buffer: Buffer.from(bytes),
    certificateName,
    tooLong: drawResult.tooLong,
  };
}

export async function generateCertificateZip(
  templateCode: string,
  recipients: CertificateRecipientInput[],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const chunks: Buffer[] = [];

    archive.on("data", (chunk: Buffer) => chunks.push(chunk));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);

    void (async () => {
      const usedNames = new Map<string, number>();

      for (const recipient of recipients) {
        const { buffer } = await generateCertificatePdf(templateCode, recipient);
        const baseFilename = buildCertificateFilename(templateCode, recipient);
        const count = usedNames.get(baseFilename) ?? 0;
        const filename =
          count > 0
            ? baseFilename.replace(/\.pdf$/, `_${count + 1}.pdf`)
            : baseFilename;
        usedNames.set(baseFilename, count + 1);
        archive.append(buffer, { name: filename });
      }

      await archive.finalize();
    })().catch(reject);
  });
}

export async function previewCertificatePdf(
  templateCode: string,
  certificateName: string,
): Promise<Buffer> {
  const parts: CertificateNameParts = {
    titlePrefix: "",
    firstName: certificateName,
    lastName: "",
    certificateNameOverride: certificateName,
  };
  const { buffer } = await generateCertificatePdf(templateCode, parts);
  return buffer;
}
