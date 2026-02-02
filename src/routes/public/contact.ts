import { FastifyInstance } from "fastify";
import { sendContactFormEmail } from "../../services/emailService.js";
import { verifyRecaptcha, isRecaptchaEnabled } from "../../utils/recaptcha.js";

interface ContactFormBody {
  name: string;
  email: string;
  phone?: string;
  subject: string;
  message: string;
  recaptchaToken?: string;
}

export default async function publicContactRoutes(fastify: FastifyInstance) {
  // Submit contact form
  fastify.post<{ Body: ContactFormBody }>("", async (request, reply) => {
    const { name, email, phone, subject, message, recaptchaToken } = request.body;

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

    // Verify reCAPTCHA if enabled
    if (isRecaptchaEnabled()) {
      if (!recaptchaToken) {
        fastify.log.warn("No reCAPTCHA token provided but verification is enabled");
        return reply.status(400).send({
          error: "Security verification required",
          details: "Please complete the reCAPTCHA verification.",
        });
      }

      const isValid = await verifyRecaptcha(recaptchaToken);
      if (!isValid) {
        fastify.log.warn("reCAPTCHA verification failed");
        return reply.status(400).send({
          error: "Security verification failed",
          details: "Please complete the reCAPTCHA and try again.",
        });
      }

      fastify.log.info("reCAPTCHA verified successfully");
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
