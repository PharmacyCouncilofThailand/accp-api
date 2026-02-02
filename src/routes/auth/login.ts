import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import { users } from "../../database/schema.js";
import { loginBodySchema } from "../../schemas/auth.schema.js";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { verifyRecaptcha, isRecaptchaEnabled } from "../../utils/recaptcha.js";

export default async function (fastify: FastifyInstance) {
  fastify.post("/login", async (request, reply) => {
    // 1. Validate request body
    const result = loginBodySchema.safeParse(request.body);
    if (!result.success) {
      return reply.status(400).send({
        success: false,
        error: "Invalid input",
        details: result.error.flatten(),
      });
    }

    const { email, password, recaptchaToken } = result.data;

    // Verify reCAPTCHA if enabled
    if (isRecaptchaEnabled()) {
      if (!recaptchaToken) {
        return reply.status(400).send({
          success: false,
          error: "reCAPTCHA verification required",
        });
      }

      const isValidRecaptcha = await verifyRecaptcha(recaptchaToken);
      if (!isValidRecaptcha) {
        return reply.status(400).send({
          success: false,
          error: "reCAPTCHA verification failed",
        });
      }
    }

    try {
      // 2. Find user
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

      // 3. Verify password
      const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

      if (!isPasswordValid) {
        return reply.status(401).send({
          success: false,
          error: "Invalid email or password",
        });
      }

      // 4. Check account status
      if (user.status === 'pending_approval') {
        return reply.status(403).send({
            success: false,
            error: "ACCOUNT_PENDING",
        });
      }

      if (user.status === 'rejected') {
        return reply.status(403).send({
            success: false,
            error: "ACCOUNT_REJECTED",
        });
      }

      // 5. Map delegate type
      let delegateType = "";
      let isThai = false;

      switch (user.role) {
        case "thstd":
          delegateType = "thai_student";
          isThai = true;
          break;
        case "interstd":
          delegateType = "international_student";
          isThai = false;
          break;
        case "thpro":
          delegateType = "thai_pharmacist";
          isThai = true;
          break;
        case "interpro":
          delegateType = "international_pharmacist";
          isThai = false;
          break;
        default:
          delegateType = "unknown";
      }

      // 6. Return user data
      return reply.send({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          country: user.country,
          // Frontend specific fields
          delegateType,
          isThai: isThai,
          idCard: user.thaiIdCard,
        },
      });

    } catch (error) {
      console.error("Login error:", error);
      return reply.status(500).send({
        success: false,
        error: "Internal server error",
      });
    }
  });
}
