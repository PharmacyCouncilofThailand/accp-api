import { FastifyInstance, FastifyRequest } from "fastify";
import { uploadToGoogleDrive, UploadFolderType, getFileStream, extractFileIdFromUrl } from "../../services/googleDrive.js";
import fs from "fs/promises";
import path from "path";

// Allowed file types
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
];

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

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
      error: "Invalid file type. Only PDF, JPG, and PNG are allowed.",
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
      error: "File too large. Maximum size is 10MB.",
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
