import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("❌ FATAL: DATABASE_URL environment variable is required!");
  console.error("   Please set DATABASE_URL in your .env file");
  process.exit(1);
}

const client = postgres(connectionString, {
  max: 20, // Maximum number of connections in the pool
  idle_timeout: 20, // Close idle connections after 20 seconds
  connect_timeout: 30, // Connection timeout in seconds
});
export const db = drizzle(client, { schema });

export * from "./schema.js";
