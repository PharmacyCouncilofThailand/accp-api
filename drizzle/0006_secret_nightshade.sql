CREATE TYPE "public"."session_type" AS ENUM('workshop', 'gala_dinner', 'lecture', 'ceremony', 'break', 'other');--> statement-breakpoint
ALTER TABLE "backoffice_users" ADD COLUMN "assigned_categories" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "session_type" "session_type" DEFAULT 'other';