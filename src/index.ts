import "dotenv/config";
import Fastify, { FastifyRequest, FastifyReply, FastifyError } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { ApiError } from "./errors/ApiError.js";

// JWT Secret validation - always required
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ FATAL: JWT_SECRET environment variable is required!");
  console.error("   Please set JWT_SECRET in your .env file");
  process.exit(1);
}

const fastify = Fastify({ logger: true });

// ============================================================================
// CORS Configuration
// ============================================================================
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://127.0.0.1:3001'];

fastify.register(cors, {
  origin: corsOrigins,
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
});

// ============================================================================
// Rate Limiting - Global default
// ============================================================================
fastify.register(rateLimit, {
  max: 600,  // Increased for shared network support (hospitals/universities)
  timeWindow: "1 minute",
  errorResponseBuilder: () => ({
    success: false,
    code: "RATE_LIMIT_EXCEEDED",
    error: "Too many requests. Please try again later.",
  }),
});

// ============================================================================
// Multipart & JWT
// ============================================================================
fastify.register(multipart, {
  limits: {
    fileSize: 30 * 1024 * 1024, // 30MB
  },
});
fastify.register(jwt, {
  secret: JWT_SECRET,
});

// ============================================================================
// Authentication Decorator
// ============================================================================
fastify.decorate("authenticate", async function (request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    reply.status(401).send({
      success: false,
      code: "AUTH_UNAUTHORIZED",
      error: "Unauthorized - Invalid or missing token",
    });
  }
});

// Extend Fastify types for TypeScript
declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

// ============================================================================
// Global Error Handler
// ============================================================================
fastify.setErrorHandler((error: FastifyError | ApiError, request, reply) => {
  // Handle multipart file size limit errors
  if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply.status(400).send({
      success: false,
      code: "FILE_TOO_LARGE",
      error: "File too large. Maximum size allowed is 30MB.",
    });
  }

  // Handle ApiError instances
  if (error instanceof ApiError) {
    return reply.status(error.statusCode).send(error.toJSON());
  }

  // Handle validation errors from Fastify
  if ('validation' in error && error.validation) {
    return reply.status(400).send({
      success: false,
      code: "VALIDATION_ERROR",
      error: "Invalid input",
      details: error.validation,
    });
  }

  // Log unexpected errors
  fastify.log.error(error);

  // Return generic error for unexpected errors
  return reply.status(500).send({
    success: false,
    code: "INTERNAL_ERROR",
    error: "Internal server error",
  });
});

// ============================================================================
// Route Imports
// ============================================================================
import { authRoutes } from "./routes/auth/register.js";
import loginRoutes from "./routes/auth/login.js";
import forgotPasswordRoutes from "./routes/auth/forgot-password.js";
import resetPasswordRoutes from "./routes/auth/reset-password.js";
import resubmitDocumentRoutes from "./routes/auth/resubmit-document.js";
import { uploadRoutes } from "./routes/upload/index.js";
import backofficeLoginRoutes from "./routes/backoffice/login.js";
import backofficeUsersRoutes from "./routes/backoffice/users.js";
import backofficeVerificationsRoutes from "./routes/backoffice/verifications.js";
import backofficeEventsRoutes from "./routes/backoffice/events.js";
import backofficeSpeakersRoutes from "./routes/backoffice/speakers.js";
import backofficeRegistrationsRoutes from "./routes/backoffice/registrations.js";
import backofficeAbstractsRoutes from "./routes/backoffice/abstracts.js";
import backofficeCheckinsRoutes from "./routes/backoffice/checkins.js";
import backofficeTicketsRoutes from "./routes/backoffice/tickets.js";
import backofficeSessionsRoutes from "./routes/backoffice/sessions.js";
import backofficePromoCodesRoutes from "./routes/backoffice/promoCodes.js";
import backofficeMembersRoutes from "./routes/backoffice/members.js";
import publicSpeakersRoutes from "./routes/public/speakers.js";
import publicEventsRoutes from "./routes/public/events.js";
import abstractSubmitRoutes from "./routes/public/abstracts/submit.js";
import userProfileRoutes from "./routes/public/users/profile.js";
import userAbstractsRoutes from "./routes/public/abstracts/user.js";
import publicWorkshopsRoutes from "./routes/public/workshops.js";
import publicTicketsRoutes from "./routes/public/tickets.js";
import publicContactRoutes from "./routes/public/contact.js";

// ============================================================================
// Public Routes (No Auth Required)
// ============================================================================

// Auth routes with stricter rate limiting for login
fastify.register(async (authPlugin) => {
  // Hybrid rate limit: Email-based (if available) or IP-based fallback
  authPlugin.register(rateLimit, {
    max: 30,  // Allow 30 attempts/min to support multiple users on same IP
    timeWindow: "1 minute",
    // Must use preHandler hook to read parsed body
    hook: 'preHandler',
    // If email exists, rate limit by email; otherwise by IP
    keyGenerator: (request) => {
      const body = request.body as { email?: string };
      return body?.email || request.ip;
    },
    errorResponseBuilder: () => ({
      success: false,
      code: "AUTH_RATE_LIMIT",
      error: "คุณพยายามเข้าสู่ระบบบ่อยเกินไป กรุณารอ 1 นาทีก่อนลองใหม่",
    }),
  });
  authPlugin.register(loginRoutes);
}, { prefix: "/auth" });

fastify.register(authRoutes, { prefix: "/auth" });
fastify.register(forgotPasswordRoutes, { prefix: "/auth" });
fastify.register(resetPasswordRoutes, { prefix: "/auth" });
fastify.register(resubmitDocumentRoutes, { prefix: "/auth" });
fastify.register(uploadRoutes, { prefix: "/upload" });
fastify.register(backofficeLoginRoutes, { prefix: "/backoffice" });

// Public API routes
fastify.register(publicEventsRoutes, { prefix: "/api/events" });
fastify.register(publicSpeakersRoutes, { prefix: "/api/speakers" });
fastify.register(abstractSubmitRoutes, { prefix: "/api/abstracts" });
fastify.register(userProfileRoutes, { prefix: "/api/users" });
fastify.register(userAbstractsRoutes, { prefix: "/api/abstracts/user" });
fastify.register(publicWorkshopsRoutes, { prefix: "/api/workshops" });
fastify.register(publicTicketsRoutes, { prefix: "/api/tickets" });
fastify.register(publicContactRoutes, { prefix: "/api/contact" });

// ============================================================================
// Protected Backoffice Routes (Auth Required)
// ============================================================================
fastify.register(async (protectedRoutes) => {
  // Add authentication hook to all routes in this plugin
  protectedRoutes.addHook("preHandler", fastify.authenticate);

  // Register all backoffice routes
  protectedRoutes.register(backofficeUsersRoutes, { prefix: "/users" });
  protectedRoutes.register(backofficeVerificationsRoutes, { prefix: "/verifications" });
  protectedRoutes.register(backofficeEventsRoutes, { prefix: "/events" });
  protectedRoutes.register(backofficeSpeakersRoutes, { prefix: "/speakers" });
  protectedRoutes.register(backofficeRegistrationsRoutes, { prefix: "/registrations" });
  protectedRoutes.register(backofficeAbstractsRoutes, { prefix: "/abstracts" });
  protectedRoutes.register(backofficeCheckinsRoutes, { prefix: "/checkins" });
  protectedRoutes.register(backofficeTicketsRoutes, { prefix: "/tickets" });
  protectedRoutes.register(backofficeSessionsRoutes, { prefix: "/sessions" });
  protectedRoutes.register(backofficePromoCodesRoutes, { prefix: "/promo-codes" });
  protectedRoutes.register(backofficeMembersRoutes, { prefix: "/members" });
}, { prefix: "/api/backoffice" });

// ============================================================================
// Health Check & Root
// ============================================================================
fastify.get("/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
}));

fastify.get("/", async () => ({
  name: "ACCP Conference API",
  version: "1.0.0",
}));

// ============================================================================
// Start Server
// ============================================================================
const start = async () => {
  try {
    await fastify.listen({ port: 3002, host: "0.0.0.0" });
    fastify.log.info("🚀 API running on http://localhost:3002");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

