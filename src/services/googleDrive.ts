import { google } from "googleapis";
import { Readable } from "stream";

// Create authenticated Drive client using OAuth2
function getDriveClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing Google OAuth2 credentials (CLIENT_ID, CLIENT_SECRET, or REFRESH_TOKEN)");
  }

  const oauth2Client = new google.auth.OAuth2(
    clientId,
    clientSecret,
    "https://developers.google.com/oauthplayground" // Redirect URL
  );

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return google.drive({ version: "v3", auth: oauth2Client });
}

// Folder type mapping
export type UploadFolderType = "student_docs" | "abstracts" | "speakers" | "venue_images";

const FOLDER_ENV_MAP: Record<UploadFolderType, string> = {
  student_docs: "GOOGLE_DRIVE_FOLDER_STUDENT_DOCS",
  abstracts: "GOOGLE_DRIVE_FOLDER_ABSTRACTS",
  speakers: "GOOGLE_DRIVE_FOLDER_SPEAKERS",
  venue_images: "GOOGLE_DRIVE_FOLDER_VENUE_IMAGES",
};

// Abstract category type (matches database enum)
export type AbstractCategory =
  | "clinical_pharmacy"
  | "social_administrative"
  | "pharmaceutical_sciences"
  | "pharmacology_toxicology"
  | "pharmacy_education"
  | "digital_pharmacy";

// Presentation type (matches database enum)
export type PresentationType = "oral" | "poster";

// Map presentation type to human-readable folder name
const PRESENTATION_TYPE_FOLDER_NAMES: Record<PresentationType, string> = {
  poster: "Poster presentation",
  oral: "Oral presentation",
};

// Map category to human-readable folder name
const CATEGORY_FOLDER_NAMES: Record<AbstractCategory, string> = {
  clinical_pharmacy: "1. Clinical Pharmacy",
  social_administrative: "2. Social and Administrative Pharmacy",
  pharmaceutical_sciences: "3. Pharmaceutical Sciences",
  pharmacology_toxicology: "4. Pharmacology and Toxicology",
  pharmacy_education: "5. Pharmacy Education",
  digital_pharmacy: "6. Digital Pharmacy and Innovation",
};

// Direct subfolder ENV mapping for faster uploads (bypasses folder lookup)
// Format: GOOGLE_DRIVE_FOLDER_{PRESENTATION_TYPE}_{CATEGORY}
const DIRECT_SUBFOLDER_ENV_MAP: Record<PresentationType, Record<AbstractCategory, string>> = {
  poster: {
    clinical_pharmacy: "GOOGLE_DRIVE_FOLDER_POSTER_CLINICAL_PHARMACY",
    social_administrative: "GOOGLE_DRIVE_FOLDER_POSTER_SOCIAL_ADMINISTRATIVE",
    pharmaceutical_sciences: "GOOGLE_DRIVE_FOLDER_POSTER_PHARMACEUTICAL_SCIENCES",
    pharmacology_toxicology: "GOOGLE_DRIVE_FOLDER_POSTER_PHARMACOLOGY_TOXICOLOGY",
    pharmacy_education: "GOOGLE_DRIVE_FOLDER_POSTER_PHARMACY_EDUCATION",
    digital_pharmacy: "GOOGLE_DRIVE_FOLDER_POSTER_DIGITAL_PHARMACY",
  },
  oral: {
    clinical_pharmacy: "GOOGLE_DRIVE_FOLDER_ORAL_CLINICAL_PHARMACY",
    social_administrative: "GOOGLE_DRIVE_FOLDER_ORAL_SOCIAL_ADMINISTRATIVE",
    pharmaceutical_sciences: "GOOGLE_DRIVE_FOLDER_ORAL_PHARMACEUTICAL_SCIENCES",
    pharmacology_toxicology: "GOOGLE_DRIVE_FOLDER_ORAL_PHARMACOLOGY_TOXICOLOGY",
    pharmacy_education: "GOOGLE_DRIVE_FOLDER_ORAL_PHARMACY_EDUCATION",
    digital_pharmacy: "GOOGLE_DRIVE_FOLDER_ORAL_DIGITAL_PHARMACY",
  },
};

/**
 * Get direct subfolder ID from ENV if available
 * Returns null if ENV not set (will fallback to folder lookup)
 */
export function getDirectSubfolderFromEnv(
  presentationType: PresentationType,
  category: AbstractCategory
): string | null {
  const envKey = DIRECT_SUBFOLDER_ENV_MAP[presentationType]?.[category];
  if (!envKey) return null;
  const folderId = process.env[envKey];
  return folderId && folderId.trim() !== "" ? folderId : null;
}

// Cache for subfolder IDs to avoid repeated API calls
const subfolderCache: Record<string, string> = {};

/**
 * Get or create a subfolder inside a parent folder
 * Returns the subfolder ID
 */
async function getOrCreateFolder(parentFolderId: string, folderName: string): Promise<string> {
  const cacheKey = `${parentFolderId}/${folderName}`;

  // Check cache first
  if (subfolderCache[cacheKey]) {
    return subfolderCache[cacheKey];
  }

  const drive = getDriveClient();

  // Search for existing folder
  const searchResponse = await drive.files.list({
    q: `name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
    spaces: "drive",
  });

  if (searchResponse.data.files && searchResponse.data.files.length > 0) {
    const folderId = searchResponse.data.files[0].id!;
    subfolderCache[cacheKey] = folderId;
    return folderId;
  }

  // Create new folder if not exists
  const createResponse = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
  });

  const newFolderId = createResponse.data.id!;
  subfolderCache[cacheKey] = newFolderId;
  return newFolderId;
}

/**
 * Upload a file to Google Drive and return shareable link
 * @param folderType - Which folder to upload to (student_docs or abstracts)
 * @param subfolder - Optional subfolder path (e.g., "Poster presentation" for abstracts)
 * @param nestedSubfolder - Optional nested subfolder inside subfolder (e.g., "1. Clinical Pharmacy")
 * @param presentationType - Optional presentation type for direct ENV lookup (faster)
 * @param category - Optional category for direct ENV lookup (faster)
 */
export async function uploadToGoogleDrive(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  folderType: UploadFolderType = "student_docs",
  subfolder?: string,
  nestedSubfolder?: string,
  presentationType?: PresentationType,
  category?: AbstractCategory
): Promise<string> {
  const drive = getDriveClient();

  const envKey = FOLDER_ENV_MAP[folderType];
  let folderId = process.env[envKey];

  if (!folderId) {
    throw new Error(`${envKey} environment variable not set`);
  }

  // For abstracts: Try to get direct subfolder ID from ENV (faster - skips folder lookup)
  if (folderType === "abstracts" && presentationType && category) {
    const directFolderId = getDirectSubfolderFromEnv(presentationType, category);
    if (directFolderId) {
      // Use direct folder ID from ENV (fast path - no API calls)
      folderId = directFolderId;
    } else {
      // Fallback: use folder lookup (slower but automatic)
      if (subfolder) {
        folderId = await getOrCreateFolder(folderId, subfolder);
      }
      if (nestedSubfolder) {
        folderId = await getOrCreateFolder(folderId, nestedSubfolder);
      }
    }
  } else {
    // Non-abstract uploads: use folder lookup as before
    if (subfolder) {
      folderId = await getOrCreateFolder(folderId, subfolder);
    }
    if (nestedSubfolder) {
      folderId = await getOrCreateFolder(folderId, nestedSubfolder);
    }
  }

  // Generate unique filename with timestamp
  const timestamp = Date.now();
  const uniqueFileName = `${timestamp}_${fileName}`;

  // Upload file
  const response = await drive.files.create({
    requestBody: {
      name: uniqueFileName,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: Readable.from(fileBuffer),
    },
    fields: "id, webViewLink",
  });

  const fileId = response.data.id;

  if (!fileId) {
    throw new Error("Failed to upload file to Google Drive");
  }

  // Set permission to "anyone with link can view"
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
  });

  // Return appropriate URL based on file type
  // For images: use thumbnail URL (reliable for <img> tags)
  // For PDFs/documents: use the actual file view link
  const isImage = mimeType.startsWith("image/");

  if (isImage) {
    // sz=w1000 requests a large thumbnail (width 1000px)
    return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
  } else {
    // For PDFs and other documents, return the view link
    return `https://drive.google.com/file/d/${fileId}/view`;
  }
}

/**
 * Get folder name for abstract category
 */
export function getCategoryFolderName(category: AbstractCategory): string {
  return CATEGORY_FOLDER_NAMES[category] || category;
}

/**
 * Get folder name for presentation type
 */
export function getPresentationTypeFolderName(presentationType: PresentationType): string {
  return PRESENTATION_TYPE_FOLDER_NAMES[presentationType] || presentationType;
}

/**
 * Delete a file from Google Drive by ID
 */
export async function deleteFromGoogleDrive(fileId: string): Promise<void> {
  const drive = getDriveClient();
  await drive.files.delete({ fileId });
}

/**
 * Extract file ID from Google Drive URL (supports multiple formats)
 */
export function extractFileIdFromUrl(url: string): string | null {
  // Format: /d/FILE_ID/
  const dMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (dMatch) return dMatch[1];

  // Format: id=FILE_ID (used in thumbnail and uc links)
  const idMatch = url.match(/id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];

  return null;
}

/**
 * Get file stream from Google Drive
 */
export async function getFileStream(fileId: string): Promise<{ stream: Readable; mimeType: string }> {
  const drive = getDriveClient();

  // Get file metadata for MIME type
  const metadata = await drive.files.get({
    fileId,
    fields: "mimeType",
  });

  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  return {
    stream: response.data as Readable,
    mimeType: metadata.data.mimeType || "application/octet-stream",
  };
}

