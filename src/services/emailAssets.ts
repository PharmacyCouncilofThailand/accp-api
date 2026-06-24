import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SIGNATURE_PUBLIC_PATH = "/public/email/thanompong-signature.png";
const SIGNATURE_ASSET_PARTS = ["email", "thanompong-signature.png"] as const;

let cachedThanompongSignatureDataUri: string | null = null;
let cachedThanompongSignaturePng: Buffer | null = null;

function resolveAssetPath(...segments: string[]): string {
  const relative = path.join(...segments);
  const candidates = [
    path.resolve(__dirname, "..", "assets", relative),
    path.resolve(__dirname, "..", "..", "src", "assets", relative),
    path.resolve(__dirname, "..", "..", "dist", "assets", relative),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Email asset not found (${relative}). Looked in:\n${candidates.join("\n")}`,
  );
}

function getPublicApiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL || "http://localhost:3002").trim().replace(/\/$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** Public URL for email clients (NipaMail strips data: URIs). */
export function getThanompongSignatureImageUrl(): string {
  return `${getPublicApiBaseUrl()}${SIGNATURE_PUBLIC_PATH}`;
}

/** PNG bytes for HTTP route / email inline preview. */
export function readThanompongSignaturePng(): Buffer {
  if (cachedThanompongSignaturePng) return cachedThanompongSignaturePng;
  const assetPath = resolveAssetPath(...SIGNATURE_ASSET_PARTS);
  cachedThanompongSignaturePng = fs.readFileSync(assetPath);
  return cachedThanompongSignaturePng;
}

export const thanompongSignaturePublicPath = SIGNATURE_PUBLIC_PATH;

/** Inline data-URI — reliable in browser preview iframes only. */
export function getThanompongSignatureDataUri(): string {
  if (cachedThanompongSignatureDataUri) return cachedThanompongSignatureDataUri;
  const assetPath = resolveAssetPath("email", "thanompong-signature.png");
  const buf = fs.readFileSync(assetPath);
  cachedThanompongSignatureDataUri = `data:image/png;base64,${buf.toString("base64")}`;
  return cachedThanompongSignatureDataUri;
}

/**
 * Signature image block for HTML emails — placed between "Yours sincerely," and typed name.
 * Use inline=true for backoffice preview; actual sends must use a public HTTPS URL.
 */
export function buildThanompongSignatureHtml(options?: { inline?: boolean }): string {
  const src = options?.inline ? getThanompongSignatureDataUri() : getThanompongSignatureImageUrl();
  return `<img src="${src}" alt="Signature of Asst. Prof. Dr. Thanompong Sathienluckana" width="200" style="display:block;width:200px;max-width:100%;height:auto;margin:12px 0 8px;border:0;" />`;
}
