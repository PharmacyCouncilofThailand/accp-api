import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { users } from "../../database/schema.js";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { uploadToGoogleDrive } from "../../services/googleDrive.js";
import { sendDocumentResubmittedEmail } from "../../services/emailService.js";
import z from "zod";

// Allowed file types for verification documents
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
];

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const resubmitSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
});

export default async function (fastify: FastifyInstance) {
  /**
   * POST /auth/resubmit-document
   * Allow rejected users to resubmit their verification document
   * No JWT required - uses email/password verification
   */
  fastify.post("/resubmit-document", async (request, reply) => {
    try {
      // Parse multipart form data
      const parts = request.parts();
      const formFields: Record<string, string> = {};
      let fileBuffer: Buffer | null = null;
      let fileName: string = "";
      let mimeType: string = "";

      for await (const part of parts) {
        if (part.type === "file" && part.fieldname === "verificationDoc") {
          // Validate file type
          if (!ALLOWED_MIME_TYPES.includes(part.mimetype)) {
            return reply.status(400).send({
              success: false,
              error: "Invalid file type. Only PDF, JPG, and PNG are allowed.",
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
          formFields[part.fieldname] = part.value as string;
        }
      }

      // Validate required fields
      const result = resubmitSchema.safeParse(formFields);
      if (!result.success) {
        return reply.status(400).send({
          success: false,
          error: result.error.errors[0].message,
        });
      }

      const { email, password } = result.data;

      // Check if file was provided
      if (!fileBuffer) {
        return reply.status(400).send({
          success: false,
          error: "Verification document is required.",
        });
      }

      // 1. Find user by email
      const userList = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (userList.length === 0) {
        return reply.status(401).send({
          success: false,
          error: "Invalid email or password",
        });
      }

      const user = userList[0];

      // 2. Verify password
      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
      if (!isPasswordValid) {
        return reply.status(401).send({
          success: false,
          error: "Invalid email or password",
        });
      }

      // 3. Check that user status is rejected
      if (user.status !== "rejected") {
        return reply.status(400).send({
          success: false,
          error: "Only rejected accounts can resubmit documents.",
        });
      }

      // 4. Check that user is a student
      if (user.role !== "thstd" && user.role !== "interstd") {
        return reply.status(400).send({
          success: false,
          error: "Document resubmission is only available for student accounts.",
        });
      }

      // 5. Upload new document to Google Drive
      let verificationDocUrl: string;
      try {
        verificationDocUrl = await uploadToGoogleDrive(
          fileBuffer,
          fileName,
          mimeType
        );
      } catch (error) {
        fastify.log.error({ err: error }, "Google Drive upload failed");
        return reply.status(500).send({
          success: false,
          error: "Failed to upload verification document. Please try again.",
        });
      }

      // 6. Update user record - increment resubmissionCount
      const [updatedUser] = await db
        .update(users)
        .set({
          verificationDocUrl,
          status: "pending_approval",
          rejectionReason: null, // Clear rejection reason
          resubmissionCount: (user.resubmissionCount ?? 0) + 1,
        })
        .where(eq(users.id, user.id))
        .returning();

      // 7. Send email notification
      try {
        await sendDocumentResubmittedEmail(
          updatedUser.email,
          updatedUser.firstName,
          updatedUser.lastName
        );
        fastify.log.info(`Document resubmission email sent to ${updatedUser.email}`);
      } catch (emailError) {
        // Log error but don't fail the request
        fastify.log.error({ err: emailError }, "Failed to send resubmission email");
      }

      return reply.status(200).send({
        success: true,
        message: "Document resubmitted successfully. Your account is now pending review.",
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
