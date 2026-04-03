import { FastifyInstance } from "fastify";

export default async function driveImageRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/drive-image/:fileId
   * Public proxy that fetches a Google Drive image via plain HTTP
   * and streams it to the browser. No OAuth2 needed — works with
   * any publicly shared file.
   */
  fastify.get("/:fileId", async (request, reply) => {
    const { fileId } = request.params as { fileId: string };

    if (!fileId || fileId.length < 10) {
      return reply.status(400).send({ error: "Invalid file ID" });
    }

    // Try multiple URL patterns (lh3 CDN first, then uc download, then thumbnail for PDFs)
    const urls = [
      `https://lh3.googleusercontent.com/d/${fileId}=s1200`,
      `https://drive.google.com/uc?id=${fileId}&export=download`,
      `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          },
          redirect: "follow",
        });

        const contentType = res.headers.get("content-type") || "";
        if (res.ok && contentType.startsWith("image/")) {
          const buffer = Buffer.from(await res.arrayBuffer());

          reply
            .header("Content-Type", contentType)
            .header("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
            .header("Access-Control-Allow-Origin", "*");

          return reply.send(buffer);
        }
      } catch {
        // Try next URL
      }
    }

    return reply.status(404).send({ error: "Image not found or not accessible" });
  });
}
