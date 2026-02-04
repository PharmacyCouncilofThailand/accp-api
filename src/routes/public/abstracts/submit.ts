import { FastifyInstance } from "fastify";
import { abstractSubmissionSchema } from "../../../schemas/abstracts.schema.js";
import { db } from "../../../database/index.js";
import {
  abstracts,
  abstractCoAuthors,
  users,
} from "../../../database/schema.js";
import {
  uploadToGoogleDrive,
  getCategoryFolderName,
  getPresentationTypeFolderName,
  AbstractCategory,
  PresentationType,
} from "../../../services/googleDrive.js";
import { eq } from "drizzle-orm";

// Allowed file types for abstract documents
const ALLOWED_MIME_TYPES = ["application/pdf"];

// Max file size: 30MB
const MAX_FILE_SIZE = 30 * 1024 * 1024;

// Default event ID for ACCP 2026 (adjust this based on your actual event ID)
const DEFAULT_EVENT_ID = 1;

/**
 * Helper function to count words in text
 */
function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

/**
 * Validate total word count for abstract sections
 */
function validateWordCount(
  background: string,
  objective: string,
  methods: string,
  results: string,
  conclusion: string,
): { valid: boolean; count: number } {
  const totalText = [background, objective, methods, results, conclusion].join(" ");
  const wordCount = countWords(totalText);

  // Word count should be max 250 words
  return {
    valid: wordCount <= 250,
    count: wordCount,
  };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default async function (fastify: FastifyInstance) {
  /**
   * Submit Abstract
   * POST /api/abstracts/submit
   * * Accepts multipart/form-data with abstract information and PDF file
   */
  fastify.post("/submit", {}, async (request, reply) => {
    try {
      // Parse multipart form data
      const parts = request.parts();
      const formFields: Record<string, string> = {};
      let fileBuffer: Buffer | null = null;
      let fileName: string = "";
      let mimeType: string = "";
      let coAuthorsData: any[] = [];

      for await (const part of parts) {
        if (part.type === "file" && part.fieldname === "abstractFile") {
          // Validate file type
          if (!ALLOWED_MIME_TYPES.includes(part.mimetype)) {
            return reply.status(400).send({
              success: false,
              error: "Invalid file type. Only PDF files are allowed.",
            });
          }

          // Read file into buffer
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          fileBuffer = Buffer.concat(chunks);
          fileName = part.filename;
          mimeType = part.mimetype;

          // Validate file size
          if (fileBuffer.length > MAX_FILE_SIZE) {
            return reply.status(400).send({
              success: false,
              error: "File too large. Maximum size is 10MB.",
            });
          }
        } else if (part.type === "field") {
          // Handle special case for coAuthors (JSON string)
          if (part.fieldname === "coAuthors") {
            try {
              const value = part.value as string;
              if (value && value.trim()) {
                coAuthorsData = JSON.parse(value);
              }
            } catch (e) {
              return reply.status(400).send({
                success: false,
                error: "Invalid co-authors data format",
              });
            }
          } else {
            formFields[part.fieldname] = part.value as string;
          }
        }
      }

      // Add co-authors to form fields for validation
      const dataToValidate = {
        ...formFields,
        coAuthors: coAuthorsData,
      };

      // Validate form fields using schema
      const result = abstractSubmissionSchema.safeParse(dataToValidate);
      if (!result.success) {
        return reply.status(400).send({
          success: false,
          error: result.error.errors[0].message,
          details: result.error.errors,
        });
      }

      const {
        firstName,
        lastName,
        email,
        affiliation,
        country,
        phone,
        title,
        category,
        presentationType,
        keywords,
        background,
        objective,
        methods,
        results,
        conclusion,
        coAuthors,
        eventId,
      } = result.data;

      // Validate word count
      const wordValidation = validateWordCount(
        background,
        objective,
        methods,
        results,
        conclusion,
      );
      if (!wordValidation.valid) {
        return reply.status(400).send({
          success: false,
          error: `Abstract word count must not exceed 250 words. Current: ${wordValidation.count} words`,
        });
      }

      // Check if file was uploaded
      if (!fileBuffer) {
        return reply.status(400).send({
          success: false,
          error: "Abstract file (PDF) is required",
        });
      }

      // Upload file to Google Drive (BLOCKING - Keep this to ensure file safety)
      // Files are organized into: ABSTRACT/{Presentation Type}/{Category}
      let fullPaperUrl: string;
      try {
        const presentationFolderName = getPresentationTypeFolderName(
          presentationType as PresentationType,
        );
        const categoryFolderName = getCategoryFolderName(
          category as AbstractCategory,
        );
        fullPaperUrl = await uploadToGoogleDrive(
          fileBuffer,
          fileName,
          mimeType,
          "abstracts",
          presentationFolderName, // First subfolder: "Poster presentation" or "Oral presentation"
          categoryFolderName, // Nested subfolder: "1. Clinical Pharmacy", etc.
          presentationType as PresentationType, // For direct ENV lookup (fast path)
          category as AbstractCategory, // For direct ENV lookup (fast path)
        );
      } catch (error) {
        fastify.log.error({ err: error }, "Google Drive upload failed");
        return reply.status(500).send({
          success: false,
          error: "Failed to upload abstract file. Please try again.",
        });
      }

      // Try to find user by email (if they registered before)
      const [existingUser] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      const finalEventId = eventId || DEFAULT_EVENT_ID;

      // Prepare abstract data
      const abstractData: any = {
        eventId: finalEventId,
        title,
        category,
        presentationType,
        keywords,
        background,
        objective,
        methods,
        results,
        conclusion,
        fullPaperUrl,
        status: "pending" as const,
      };

      // Only add userId if user exists
      if (existingUser) {
        abstractData.userId = existingUser.id;
      }

      // Insert abstract
      const [newAbstract] = await db
        .insert(abstracts)
        .values(abstractData)
        .returning();

      // Insert co-authors if any
      if (coAuthors && coAuthors.length > 0) {
        const coAuthorsToInsert = coAuthors.map((coAuthor, index) => ({
          abstractId: newAbstract.id,
          firstName: coAuthor.firstName,
          lastName: coAuthor.lastName,
          email: coAuthor.email,
          institution: coAuthor.institution,
          country: coAuthor.country,
          sortOrder: index,
        }));

        await db.insert(abstractCoAuthors).values(coAuthorsToInsert);
      }

      // -----------------------------------------------------------------------
      // Email Sending
      // -----------------------------------------------------------------------
      const runEmailTasksInBackground = async () => {
        try {
          const { sendAbstractSubmissionEmail, sendCoAuthorNotificationEmail } =
            await import("../../../services/emailService.js");

          // 1. Send to Main Author
          await sendAbstractSubmissionEmail(
            email,
            firstName,
            lastName,
            newAbstract.id,
            title,
          );

          fastify.log.info(
            `Background: Abstract submission email sent to ${email}`,
          );

          // 2. Send to Co-authors (with delay to prevent Rate Limit)
          if (coAuthors && coAuthors.length > 0) {
            const mainAuthorName = `${firstName} ${lastName}`;

            for (const coAuthor of coAuthors) {
              await delay(800);

              try {
                await sendCoAuthorNotificationEmail(
                  coAuthor.email,
                  coAuthor.firstName,
                  coAuthor.lastName,
                  mainAuthorName,
                  newAbstract.id,
                  title,
                );
                fastify.log.info(
                  `Background: Co-author notification sent to ${coAuthor.email}`,
                );
              } catch (emailError) {
                // Log error but don't stop the loop
                fastify.log.error(
                  { err: emailError },
                  `Failed to send co-author email to ${coAuthor.email}`,
                );
              }
            }
          }
        } catch (emailError) {
          // Log general email failure
          fastify.log.error(
            { err: emailError },
            "Background email task encountered an error",
          );
        }
      };

      // Execute background task without awaiting it
      runEmailTasksInBackground();

      // Return response immediately after DB insert (Response time ~3-5s)
      return reply.status(201).send({
        success: true,
        abstract: {
          id: newAbstract.id,
          title: newAbstract.title,
          status: newAbstract.status,
          submittedAt: newAbstract.createdAt,
        },
        message: "Abstract submitted successfully",
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: "Internal server error",
      });
    }
  });
}
