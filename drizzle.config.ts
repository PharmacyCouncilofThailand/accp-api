import { defineConfig } from "drizzle-kit";
import { config } from "dotenv";

// Load .env from current directory
config({ path: "./.env" });

export default defineConfig({
  schema: "./src/database/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
