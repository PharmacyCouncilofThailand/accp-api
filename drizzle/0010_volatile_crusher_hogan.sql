ALTER TABLE "abstracts" ADD COLUMN "objective" text NOT NULL;--> statement-breakpoint
ALTER TABLE "backoffice_users" ADD COLUMN "assigned_presentation_types" jsonb DEFAULT '[]'::jsonb;