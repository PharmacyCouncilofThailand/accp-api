import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

// Only load .env in development (Railway injects env vars directly)
if (!process.env.DATABASE_URL) {
  config({ path: "./.env" });
}

export default defineConfig({
  schema: "./src/database/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});

