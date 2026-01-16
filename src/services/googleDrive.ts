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

/**
 * Upload a file to Google Drive and return shareable link
 * @param folderType - Which folder to upload to (student_docs or abstracts)
 */
export async function uploadToGoogleDrive(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  folderType: UploadFolderType = "student_docs"
): Promise<string> {
  const drive = getDriveClient();

  const envKey = FOLDER_ENV_MAP[folderType];
  const folderId = process.env[envKey];

  if (!folderId) {
    throw new Error(`${envKey} environment variable not set`);
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

  // Return the thumbnail link (reliable for <img> tags)
  // sz=w1000 requests a large thumbnail (width 1000px)
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000`;
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

