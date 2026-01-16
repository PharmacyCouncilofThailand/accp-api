import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";

// JWT Secret validation
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET && process.env.NODE_ENV === "production") {
  console.error("❌ FATAL: JWT_SECRET required in production!");
  process.exit(1);
}
if (!JWT_SECRET) {
  console.warn("⚠️ WARNING: JWT_SECRET not set. Using default for development.");
}

const fastify = Fastify({ logger: true });

// Register plugins
// Parse CORS origins from environment variable (comma-separated) or use dev defaults
const corsOrigins = process.env.CORS_ORIGIN 
  ? process.env.CORS_ORIGIN.split(',').map(origin => origin.trim())
  : ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001', 'http://127.0.0.1:3001'];

fastify.register(cors, { 
  origin: corsOrigins,
  allowedHeaders: ['Content-Type', 'Authorization', 'x-user-email'],
  exposedHeaders: ['x-user-email'],
  credentials: true
});

// Rate limiting
fastify.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute",
  errorResponseBuilder: () => ({
    success: false,
    error: "Too many requests. Please try again later.",
  }),
});

fastify.register(multipart, {
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
  },
});
fastify.register(jwt, {
  secret: JWT_SECRET || "change-me-in-production",
});

// Register routes
import { authRoutes } from "./routes/auth/register.js";
import loginRoutes from "./routes/auth/login.js";
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
import publicSpeakersRoutes from "./routes/public/speakers.js";
import abstractSubmitRoutes from "./routes/public/abstracts/submit.js";
import userProfileRoutes from "./routes/public/users/profile.js";

fastify.register(authRoutes, { prefix: "/auth" });
fastify.register(loginRoutes, { prefix: "/auth" });
fastify.register(uploadRoutes, { prefix: "/upload" });
fastify.register(backofficeLoginRoutes, { prefix: "/backoffice" });
fastify.register(backofficeUsersRoutes, { prefix: "/api/backoffice/users" });
fastify.register(backofficeVerificationsRoutes, { prefix: "/api/backoffice/verifications" });
fastify.register(backofficeEventsRoutes, { prefix: "/api/backoffice/events" });
fastify.register(backofficeSpeakersRoutes, { prefix: "/api/backoffice/speakers" });
fastify.register(backofficeRegistrationsRoutes, { prefix: "/api/backoffice/registrations" });
fastify.register(backofficeAbstractsRoutes, { prefix: "/api/backoffice/abstracts" });
fastify.register(backofficeCheckinsRoutes, { prefix: "/api/backoffice/checkins" });
fastify.register(backofficeTicketsRoutes, { prefix: "/api/backoffice/tickets" });
fastify.register(backofficeSessionsRoutes, { prefix: "/api/backoffice/sessions" });
fastify.register(backofficePromoCodesRoutes, { prefix: "/api/backoffice/promo-codes" });

// Public API routes (no auth required)
fastify.register(publicSpeakersRoutes, { prefix: "/api/speakers" });
fastify.register(abstractSubmitRoutes, { prefix: "/api/abstracts" });
fastify.register(userProfileRoutes, { prefix: "/api/users" });

// User abstracts route (requires authentication via cookies)
import userAbstractsRoutes from "./routes/public/abstracts/user.js";
fastify.register(userAbstractsRoutes, { prefix: "/api/abstracts/user" });

// Health check
fastify.get("/health", async () => ({
  status: "ok",
  timestamp: new Date().toISOString(),
}));

// API root
fastify.get("/", async () => ({
  name: "ACCP Conference API",
  version: "1.0.0",
}));

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: 3002, host: "0.0.0.0" });
    console.log("🚀 API running on http://localhost:3002");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
