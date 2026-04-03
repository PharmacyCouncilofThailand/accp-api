import { FastifyInstance } from "fastify";
import { getFileStream } from "../../services/googleDrive.js";

export default async function fileProxyRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/files/:fileId
   * Public proxy that streams a Google Drive file directly to the browser.
   * Supports images, videos, and documents with proper caching headers.
   */
  fastify.get("/:fileId", async (request, reply) => {
    const { fileId } = request.params as { fileId: string };

    if (!fileId || fileId.length < 10) {
      return reply.status(400).send({ error: "Invalid file ID" });
    }

    try {
      const { stream, mimeType } = await getFileStream(fileId);

      // Cache images/videos for 1 hour, documents for 10 minutes
      const isMedia = mimeType.startsWith("image/") || mimeType.startsWith("video/");
      const maxAge = isMedia ? 3600 : 600;

      reply
        .header("Content-Type", mimeType)
        .header("Cache-Control", `public, max-age=${maxAge}`)
        .header("Access-Control-Allow-Origin", "*");

      return reply.send(stream);
    } catch (error: any) {
      fastify.log.error(error, `Failed to proxy file: ${fileId}`);

      if (error.code === 404 || error.message?.includes("not found")) {
        return reply.status(404).send({ error: "File not found" });
      }

      return reply.status(500).send({ error: "Failed to retrieve file" });
    }
  });
}
