import { FastifyInstance } from "fastify";

const API_KEY = process.env.GOOGLE_DRIVE_API_KEY || "";

export default async function driveFolderRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/drive-folder/:folderId
   * Public endpoint that lists files in a Google Drive folder.
   * Uses API Key to access publicly shared folders.
   */
  fastify.get("/:folderId", async (request, reply) => {
    const { folderId } = request.params as { folderId: string };

    if (!folderId || folderId.length < 10) {
      return reply.status(400).send({ error: "Invalid folder ID" });
    }

    if (!API_KEY) {
      return reply.status(500).send({ error: "GOOGLE_DRIVE_API_KEY not configured" });
    }

    try {
      const url =
        `https://www.googleapis.com/drive/v3/files` +
        `?q='${folderId}'+in+parents+and+trashed=false` +
        `&fields=files(id,name,mimeType)` +
        `&orderBy=createdTime` +
        `&pageSize=100` +
        `&key=${API_KEY}`;

      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.text();
        fastify.log.error(`Drive API error: ${err}`);
        return reply.status(502).send({ error: "Drive API error" });
      }

      const data = (await res.json()) as { files?: { id: string; name: string; mimeType: string }[] };
      const files = (data.files || []).map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
      }));

      reply.header("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");

      return { files };
    } catch (error: any) {
      fastify.log.error(error, `Failed to list folder: ${folderId}`);
      return reply.status(500).send({ error: "Failed to list folder files" });
    }
  });
}
