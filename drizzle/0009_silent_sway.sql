CREATE TABLE "verification_rejection_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"reason" text NOT NULL,
	"rejected_by" integer,
	"rejected_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "abstracts" ALTER COLUMN "category" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."abstract_category";--> statement-breakpoint
CREATE TYPE "public"."abstract_category" AS ENUM('clinical_pharmacy', 'social_administrative', 'community_pharmacy', 'pharmacology_toxicology', 'pharmacy_education', 'digital_pharmacy');--> statement-breakpoint
ALTER TABLE "abstracts" ALTER COLUMN "category" SET DATA TYPE "public"."abstract_category" USING "category"::"public"."abstract_category";--> statement-breakpoint
ALTER TABLE "verification_rejection_history" ADD CONSTRAINT "verification_rejection_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_rejection_history" ADD CONSTRAINT "verification_rejection_history_rejected_by_backoffice_users_id_fk" FOREIGN KEY ("rejected_by") REFERENCES "public"."backoffice_users"("id") ON DELETE no action ON UPDATE no action;