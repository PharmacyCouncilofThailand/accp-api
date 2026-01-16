import { FastifyInstance } from "fastify";
import { registerBodySchema } from "../../schemas/auth.schema.js";
import { db } from "../../database/index.js";
import { users } from "../../database/schema.js";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { uploadToGoogleDrive } from "../../services/googleDrive.js";
import { sendPendingApprovalEmail } from "../../services/emailService.js";

const roleMapping = {
  thaiStudent: "thstd",
  internationalStudent: "interstd",
  thaiProfessional: "thpro",
  internationalProfessional: "interpro",
} as const;

// Allowed file types for verification documents
const ALLOWED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
];

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post("/register", {}, async (request, reply) => {
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

      // Validate form fields using schema
      const result = registerBodySchema.safeParse(formFields);
      if (!result.success) {
        return reply.status(400).send({
          success: false,
          error: result.error.errors[0].message,
        });
      }

      const {
        firstName,
        lastName,
        email,
        password,
        accountType,
        organization,
        idCard,
        passportId,
        pharmacyLicenseId,
        country,
        phone,
      } = result.data;

      // 1. Check duplicate email
      const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);

      if (existingUser.length > 0) {
        return reply.status(409).send({
          success: false,
          error: "Email already exists",
        });
      }

      // 2. Check duplicate ID Card (if provided)
      if (idCard) {
        const existingIdCard = await db
          .select()
          .from(users)
          .where(eq(users.thaiIdCard, idCard))
          .limit(1);

        if (existingIdCard.length > 0) {
          return reply.status(409).send({
            success: false,
            error: "Thai ID Card already registered",
          });
        }
      }

      // 3. Check duplicate Passport (if provided)
      if (passportId) {
        const existingPassport = await db
          .select()
          .from(users)
          .where(eq(users.passportId, passportId))
          .limit(1);

        if (existingPassport.length > 0) {
          return reply.status(409).send({
            success: false,
            error: "Passport ID already registered",
          });
        }
      }

      // Check duplicate Pharmacy License (if provided)
      if (pharmacyLicenseId) {
        const existingLicense = await db
          .select()
          .from(users)
          .where(eq(users.pharmacyLicenseId, pharmacyLicenseId))
          .limit(1);

        if (existingLicense.length > 0) {
          return reply.status(409).send({
            success: false,
            error: "Pharmacy License Number already registered",
          });
        }
      }

      // 4. Upload verification document to Google Drive (if file exists)
      let verificationDocUrl: string | null = null;
      if (fileBuffer) {
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
      }

      // 5. Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      // 6. Determine role & country
      const role = roleMapping[accountType];
      const userCountry =
        accountType === "thaiStudent" || accountType === "thaiProfessional"
          ? "Thailand"
          : country;

      // Auto-approve professionals
      const initialStatus =
        role === "thpro" || role === "interpro" ? "active" : "pending_approval";

      // 7. Insert user
      const [newUser] = await db
        .insert(users)
        .values({
          email,
          passwordHash,
          role,
          firstName,
          lastName,
          country: userCountry,
          institution: organization || null,
          phone: phone || null,
          thaiIdCard: idCard || null,
          passportId: passportId || null,
          pharmacyLicenseId: pharmacyLicenseId || null,
          verificationDocUrl,
          status: initialStatus,
        })
        .returning();

      // 8. Send auto-reply email for students (pending approval)
      if (role === "thstd" || role === "interstd") {
        try {
          await sendPendingApprovalEmail(email, firstName, lastName);
          fastify.log.info(`Pending approval email sent to ${email}`);
        } catch (emailError) {
          // Log error but don't fail registration
          fastify.log.error({ err: emailError }, "Failed to send pending approval email");
        }
      }

      return reply.status(201).send({
        success: true,
        user: {
          id: newUser.id,
          email: newUser.email,
          firstName: newUser.firstName,
          lastName: newUser.lastName,
          role: newUser.role,
          status: newUser.status,
        },
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
