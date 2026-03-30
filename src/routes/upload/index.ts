import { FastifyInstance, FastifyRequest } from "fastify";
import { uploadToGoogleDrive, UploadFolderType, getFileStream, extractFileIdFromUrl, uploadEventMedia, EventMediaType } from "../../services/googleDrive.js";
import fs from "fs/promises";
import path from "path";

// Allowed file types
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "application/msword", // .doc
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
];

// Max file size: 50MB
const MAX_FILE_SIZE = 50 * 1024 * 1024;

// Helper function to handle file upload
async function handleFileUpload(
  request: FastifyRequest,
  folderType: UploadFolderType
) {
  const data = await request.file();

  if (!data) {
    return { success: false, status: 400, error: "No file uploaded" };
  }

  // Validate file type
  if (!ALLOWED_MIME_TYPES.includes(data.mimetype)) {
    return {
      success: false,
      status: 400,
      error: "Invalid file type. Only PDF, DOC/X, XLS/X, JPG, PNG, WEBP, MP4, and WEBM are allowed.",
    };
  }

  // Read file buffer
  const chunks: Buffer[] = [];
  for await (const chunk of data.file) {
    chunks.push(chunk);
  }
  const fileBuffer = Buffer.concat(chunks);

  // Validate file size
  if (fileBuffer.length > MAX_FILE_SIZE) {
    return {
      success: false,
      status: 400,
      error: "File too large. Maximum size is 50MB.",
    };
  }

  try {
    // Upload to Google Drive
    const url = await uploadToGoogleDrive(
      fileBuffer,
      data.filename,
      data.mimetype,
      folderType
    );

    return {
      success: true,
      status: 200,
      url,
      filename: data.filename,
    };
  } catch (error: any) {
    const errorMsg = error.message?.toLowerCase() || "";
    if (
      errorMsg.includes("environment variable not set") ||
      errorMsg.includes("invalid_client") ||
      errorMsg.includes("invalid_grant") ||
      errorMsg.includes("unauthorized_client") ||
      errorMsg.includes("no refresh token")
    ) {
      const uploadDir = path.join(process.cwd(), 'public', 'uploads', folderType);
      await fs.mkdir(uploadDir, { recursive: true });

      const uniqueFilename = `${Date.now()}-${data.filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
      const filePath = path.join(uploadDir, uniqueFilename);

      await fs.writeFile(filePath, fileBuffer);

      const baseUrl = process.env.API_URL || "http://localhost:3002";
      const url = `${baseUrl}/public/uploads/${folderType}/${uniqueFilename}`;

      return {
        success: true,
        status: 200,
        url,
        filename: data.filename,
      };
    }
    throw error;
  }
}

export async function uploadRoutes(fastify: FastifyInstance) {
  /**
   * GET /upload/proxy
   * Proxy file from Google Drive (securely)
   */
  fastify.get("/proxy", async (request, reply) => {
    const { url } = request.query as { url: string };

    if (!url) {
      return reply.status(400).send({ error: "Missing url parameter" });
    }

    const fileId = extractFileIdFromUrl(url);

    if (!fileId) {
      return reply.status(400).send({ error: "Invalid Google Drive URL" });
    }

    try {
      const { stream, mimeType } = await getFileStream(fileId);

      reply.header("Content-Type", mimeType);
      // Cache for 1 hour
      reply.header("Cache-Control", "public, max-age=3600");

      return reply.send(stream);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch file" });
    }
  });

  /**
   * POST /upload/verify-doc
   * Upload student verification document to Google Drive (student_docs folder)
   */
  fastify.post("/verify-doc", async (request, reply) => {
    try {
      const result = await handleFileUpload(request, "student_docs");
      return reply.status(result.status).send(result);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to upload file. Please try again.",
      });
    }
  });

  /**
   * POST /upload/abstract
   * Upload abstract document to Google Drive (abstracts folder)
   */
  fastify.post("/abstract", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const result = await handleFileUpload(request, "abstracts");
      return reply.status(result.status).send(result);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to upload abstract. Please try again.",
      });
    }
  });

  /**
   * POST /upload/event-image
   * Upload event thumbnail/cover to Google Drive (event_images folder)
   */
  fastify.post("/event-image", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const result = await handleFileUpload(request, "event_images");
      return reply.status(result.status).send(result);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to upload event image",
      });
    }
  });

  /**
   * POST /upload/venue-image
   * Upload venue image to Google Drive (venue_images folder)
   */
  fastify.post("/venue-image", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const result = await handleFileUpload(request, "venue_images");
      return reply.status(result.status).send(result);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to upload venue image",
      });
    }
  });

  /**
   * POST /upload/event-document
   * Upload event document to Google Drive (event_documents folder)
   */
  fastify.post("/event-document", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const result = await handleFileUpload(request, "event_documents");
      return reply.status(result.status).send(result);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to upload event document",
      });
    }
  });

  /**
   * POST /upload/event-media
   * Upload event media (thumbnail, cover image, cover video, venue image, document)
   * to per-event Google Drive folder structure.
   *
   * Multipart form fields:
   *   - file: the file to upload
   *   - eventCode: event code (used as folder name)
   *   - eventName: event name (used in file naming)
   *   - mediaType: "thumbnail" | "cover_img" | "cover_vdo" | "venue" | "document"
   *   - sortOrder: (optional) sort order for venue images
   */
  fastify.post("/event-media", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      const parts = request.parts();
      let fileBuffer: Buffer | null = null;
      let fileName = "";
      let fileMimeType = "";
      let eventCode = "";
      let eventName = "";
      let mediaType: EventMediaType = "thumbnail";
      let sortOrder = 0;

      for await (const part of parts) {
        if (part.type === "file" && part.fieldname === "file") {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          fileBuffer = Buffer.concat(chunks);
          fileName = part.filename;
          fileMimeType = part.mimetype;
        } else if (part.type === "field") {
          const value = String(part.value ?? "");
          switch (part.fieldname) {
            case "eventCode": eventCode = value; break;
            case "eventName": eventName = value; break;
            case "mediaType": mediaType = value as EventMediaType; break;
            case "sortOrder": sortOrder = parseInt(value) || 0; break;
          }
        }
      }

      if (!fileBuffer || !fileName) {
        return reply.status(400).send({ success: false, error: "No file uploaded" });
      }

      if (!eventCode) {
        return reply.status(400).send({ success: false, error: "eventCode is required" });
      }

      if (!eventName) {
        return reply.status(400).send({ success: false, error: "eventName is required" });
      }

      const validMediaTypes: EventMediaType[] = ["thumbnail", "cover_img", "cover_vdo", "venue", "document"];
      if (!validMediaTypes.includes(mediaType)) {
        return reply.status(400).send({ success: false, error: `Invalid mediaType. Must be one of: ${validMediaTypes.join(", ")}` });
      }

      // Validate file type
      if (!ALLOWED_MIME_TYPES.includes(fileMimeType)) {
        return reply.status(400).send({
          success: false,
          error: "Invalid file type. Only PDF, DOC/X, XLS/X, JPG, PNG, WEBP, MP4, and WEBM are allowed.",
        });
      }

      // Validate file size
      if (fileBuffer.length > MAX_FILE_SIZE) {
        return reply.status(400).send({
          success: false,
          error: "File too large. Maximum size is 50MB.",
        });
      }

      const url = await uploadEventMedia(
        fileBuffer,
        fileName,
        fileMimeType,
        eventCode,
        eventName,
        mediaType,
        sortOrder,
      );

      return reply.send({
        success: true,
        url,
        filename: fileName,
        mediaType,
      });
    } catch (error: any) {
      fastify.log.error(error);

      // Fallback to local storage if Google Drive is not configured
      const errorMsg = error.message?.toLowerCase() || "";
      if (
        errorMsg.includes("environment variable not set") ||
        errorMsg.includes("invalid_client") ||
        errorMsg.includes("invalid_grant")
      ) {
        return reply.status(503).send({
          success: false,
          error: "Google Drive not configured. Please set GOOGLE_DRIVE_EVENT_ROOT_FOLDER.",
        });
      }

      return reply.status(500).send({
        success: false,
        error: "Failed to upload event media",
      });
    }
  });

  /**
   * POST /upload
   * Generic upload (defaults to speakers for now)
   */
  fastify.post("/", { preHandler: [fastify.authenticate] }, async (request, reply) => {
    try {
      // Defaulting to "speakers" as generic upload type for this route
      const result = await handleFileUpload(request, "speakers");
      return reply.status(result.status).send(result);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Failed to upload file. Please try again.",
      });
    }
  });
}
