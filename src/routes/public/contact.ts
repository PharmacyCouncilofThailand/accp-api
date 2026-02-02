import { FastifyInstance } from "fastify";
import { sendContactFormEmail } from "../../services/emailService.js";

interface ContactFormBody {
  name: string;
  email: string;
  phone?: string;
  subject: string;
  message: string;
}

export default async function publicContactRoutes(fastify: FastifyInstance) {
  // Submit contact form
  fastify.post<{ Body: ContactFormBody }>("", async (request, reply) => {
    const { name, email, phone, subject, message } = request.body;

    // Validate required fields
    if (!name || !email || !subject || !message) {
      return reply.status(400).send({
        error: "Missing required fields",
        details: "Name, email, subject, and message are required",
      });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return reply.status(400).send({
        error: "Invalid email format",
      });
    }

    try {
      await sendContactFormEmail(name, email, phone || "", subject, message);

      return reply.send({
        success: true,
        message: "Your message has been sent successfully. We will get back to you soon.",
      });
    } catch (error) {
      fastify.log.error(error, "Failed to send contact form email");
      return reply.status(500).send({
        error: "Failed to send message",
        details: "Please try again later or contact us directly via email.",
      });
    }
  });
}
