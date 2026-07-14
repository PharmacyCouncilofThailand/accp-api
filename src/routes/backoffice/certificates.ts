import { FastifyInstance } from "fastify";
import {
  certificateGenerateSchema,
  certificatePreviewSchema,
  certificateResolveSchema,
  certificateSendEmailSchema,
  type CertificateRecipientInput,
} from "../../schemas/certificates.schema.js";
import {
  generateCertificatePdf,
  generateCertificateZip,
  getCertificateTemplate,
  loadCertificateTemplates,
  previewCertificatePdf,
} from "../../services/certificatePdf.service.js";
import {
  deduplicateRecipients,
  finalizeRecipients,
  parseCertificateCsv,
  resolveDatabaseRecipients,
} from "../../services/certificateRecipient.service.js";
import {
  buildCertificateFilename,
  formatCertificateName,
} from "../../utils/certificateName.js";
import {
  buildEmailHtmlFromText,
  sendCertificateDeliveryEmail,
} from "../../services/emailService.js";

const EMAIL_DELAY_MS = 700;

function validateRecipientsForGenerate(
  recipients: CertificateRecipientInput[],
): string | null {
  if (!recipients.length) return "At least one recipient is required";
  const missingPrefix = recipients.filter((r) => !r.titlePrefix?.trim());
  if (missingPrefix.length > 0) {
    return `${missingPrefix.length} recipient(s) are missing title prefix`;
  }
  return null;
}

export default async function (fastify: FastifyInstance) {
  fastify.get("/templates", async (_request, reply) => {
    const templates = loadCertificateTemplates().map((template) => ({
      code: template.code,
      name: template.name,
      nameLabel: template.nameLabel,
      dbSourceEnabled: Boolean(template.dbSource?.enabled),
      dbSourceType: template.dbSource?.sourceType ?? "manual",
      defaultFilters: template.dbSource?.defaultFilters ?? {},
    }));

    return reply.send({ success: true, data: templates });
  });

  fastify.post("/recipients/parse-upload", async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({
        success: false,
        code: "CERTIFICATE_UPLOAD_INVALID_FORMAT",
        error: "No file uploaded",
      });
    }

    const buffer = await data.toBuffer();
    if (buffer.length > 5 * 1024 * 1024) {
      return reply.status(400).send({
        success: false,
        code: "CERTIFICATE_UPLOAD_TOO_LARGE",
        error: "Upload exceeds 5 MB limit",
      });
    }

    const filename = data.filename.toLowerCase();
    if (!filename.endsWith(".csv")) {
      return reply.status(400).send({
        success: false,
        code: "CERTIFICATE_UPLOAD_INVALID_FORMAT",
        error: "Only CSV uploads are supported currently",
      });
    }

    const parsed = parseCertificateCsv(buffer.toString("utf8"));
    const recipients = finalizeRecipients(parsed.recipients);

    return reply.send({
      success: true,
      data: {
        recipients,
        errors: parsed.errors,
        warnings: parsed.warnings,
      },
    });
  });

  fastify.post("/recipients/resolve", async (request, reply) => {
    const parsed = certificateResolveSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        code: "VALIDATION_ERROR",
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const template = getCertificateTemplate(parsed.data.templateCode);
    if (!template) {
      return reply.status(404).send({
        success: false,
        code: "CERTIFICATE_TEMPLATE_NOT_FOUND",
        error: "Certificate template not found",
      });
    }

    let combined: CertificateRecipientInput[] = [];

    for (const source of parsed.data.sources) {
      if (source.type === "database") {
        const rows = await resolveDatabaseRecipients(
          parsed.data.templateCode,
          source.filter ?? {},
        );
        combined = combined.concat(rows);
      } else {
        combined = combined.concat(
          source.rows.map((row) => ({
            ...row,
            sourceType: "manual" as const,
          })),
        );
      }
    }

    const { recipients, duplicatesRemoved } = deduplicateRecipients(
      combined,
      parsed.data.deduplicateBy,
    );
    const finalized = finalizeRecipients(recipients);
    const missingTitlePrefix = finalized.filter((r) =>
      r.warnings.includes("missing_title_prefix"),
    ).length;

    return reply.send({
      success: true,
      data: {
        recipients: finalized,
        stats: {
          total: finalized.length,
          duplicatesRemoved,
          missingTitlePrefix,
        },
      },
    });
  });

  fastify.post("/preview", async (request, reply) => {
    const parsed = certificatePreviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        code: "VALIDATION_ERROR",
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const template = getCertificateTemplate(parsed.data.templateCode);
    if (!template) {
      return reply.status(404).send({
        success: false,
        code: "CERTIFICATE_TEMPLATE_NOT_FOUND",
        error: "Certificate template not found",
      });
    }

    const recipients = finalizeRecipients(parsed.data.recipients);
    return reply.send({ success: true, data: { recipients } });
  });

  fastify.get("/preview/:templateCode/sample.pdf", async (request, reply) => {
    const { templateCode } = request.params as { templateCode: string };
    const { name } = request.query as { name?: string };
    const template = getCertificateTemplate(templateCode);

    if (!template) {
      return reply.status(404).send({
        success: false,
        code: "CERTIFICATE_TEMPLATE_NOT_FOUND",
        error: "Certificate template not found",
      });
    }

    const sampleName = name?.trim() || "DR. SAMPLE RECIPIENT";
    const pdf = await previewCertificatePdf(templateCode, sampleName);

    return reply
      .header("Content-Type", "application/pdf")
      .header(
        "Content-Disposition",
        `inline; filename="${templateCode}-sample.pdf"`,
      )
      .send(pdf);
  });

  fastify.post("/generate", async (request, reply) => {
    const parsed = certificateGenerateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        code: "VALIDATION_ERROR",
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const template = getCertificateTemplate(parsed.data.templateCode);
    if (!template) {
      return reply.status(404).send({
        success: false,
        code: "CERTIFICATE_TEMPLATE_NOT_FOUND",
        error: "Certificate template not found",
      });
    }

    const validationError = validateRecipientsForGenerate(parsed.data.recipients);
    if (validationError) {
      return reply.status(400).send({
        success: false,
        code: "CERTIFICATE_MISSING_TITLE_PREFIX",
        error: validationError,
      });
    }

    try {
      const zip = await generateCertificateZip(
        parsed.data.templateCode,
        parsed.data.recipients,
      );
      const date = new Date().toISOString().slice(0, 10);

      return reply
        .header("Content-Type", "application/zip")
        .header(
          "Content-Disposition",
          `attachment; filename="certificates-${parsed.data.templateCode}-${date}.zip"`,
        )
        .send(zip);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        code: "CERTIFICATE_GENERATION_FAILED",
        error: "Failed to generate certificates",
      });
    }
  });

  fastify.post("/send-email", async (request, reply) => {
    const parsed = certificateSendEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        success: false,
        code: "VALIDATION_ERROR",
        error: "Invalid request body",
        details: parsed.error.flatten(),
      });
    }

    const template = getCertificateTemplate(parsed.data.templateCode);
    if (!template) {
      return reply.status(404).send({
        success: false,
        code: "CERTIFICATE_TEMPLATE_NOT_FOUND",
        error: "Certificate template not found",
      });
    }

    const prefixError = validateRecipientsForGenerate(parsed.data.recipients);
    if (prefixError) {
      return reply.status(400).send({
        success: false,
        code: "CERTIFICATE_MISSING_TITLE_PREFIX",
        error: prefixError,
      });
    }

    const missingEmail = parsed.data.recipients.filter((r) => !r.email?.trim());
    if (missingEmail.length > 0) {
      return reply.status(400).send({
        success: false,
        code: "CERTIFICATE_MISSING_EMAIL",
        error: `${missingEmail.length} recipient(s) are missing email`,
      });
    }

    const subject =
      parsed.data.subject?.trim() ||
      `Your ACCP 2026 Certificate — ${template.name}`;
    const defaultBody = `Dear recipient,\n\nPlease find attached your certificate from the 25th Asian Conference on Clinical Pharmacy (ACCP 2026).\n\nThank you for your participation.\n\nBest regards,\nACCP 2026 Organizing Committee`;
    const bodyHtml = parsed.data.bodyHtml
      ? buildEmailHtmlFromText(parsed.data.bodyHtml)
      : buildEmailHtmlFromText(defaultBody);

    const results: Array<{
      email: string;
      name: string;
      status: "sent" | "failed" | "skipped";
      reason?: string;
    }> = [];

    if (parsed.data.dryRun) {
      for (const recipient of parsed.data.recipients) {
        results.push({
          email: recipient.email!.trim(),
          name: formatCertificateName(recipient),
          status: "skipped",
          reason: "dry_run",
        });
      }

      return reply.send({
        success: true,
        data: {
          summary: {
            sent: 0,
            failed: 0,
            skipped: results.length,
          },
          results,
        },
      });
    }

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const recipient of parsed.data.recipients) {
      const email = recipient.email!.trim();
      const certificateName = formatCertificateName(recipient);

      try {
        const { buffer } = await generateCertificatePdf(
          parsed.data.templateCode,
          recipient,
        );
        const filename = buildCertificateFilename(
          parsed.data.templateCode,
          recipient,
        );

        await sendCertificateDeliveryEmail(email, subject, bodyHtml, {
          content: buffer,
          fileName: filename,
        });

        sent++;
        results.push({ email, name: certificateName, status: "sent" });
      } catch (error) {
        failed++;
        results.push({
          email,
          name: certificateName,
          status: "failed",
          reason: error instanceof Error ? error.message : "Unknown error",
        });
      }

      await new Promise((resolve) => setTimeout(resolve, EMAIL_DELAY_MS));
    }

    return reply.send({
      success: true,
      data: {
        summary: { sent, failed, skipped },
        results,
      },
    });
  });
}
