ALTER TABLE "abstracts" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "backoffice_users" ADD COLUMN "conference_code" varchar(100);