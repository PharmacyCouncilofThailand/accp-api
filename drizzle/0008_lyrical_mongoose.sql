ALTER TABLE "users" ADD COLUMN "resubmission_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "speakers" DROP COLUMN "email";