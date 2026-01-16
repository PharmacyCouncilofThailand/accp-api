ALTER TABLE "abstracts" ALTER COLUMN "category" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."abstract_category";--> statement-breakpoint
CREATE TYPE "public"."abstract_category" AS ENUM('clinical_pharmacy', 'social_administrative', 'pharmaceutical_sciences', 'pharmacology_toxicology', 'pharmacy_education', 'digital_pharmacy');--> statement-breakpoint
ALTER TABLE "abstracts" ALTER COLUMN "category" SET DATA TYPE "public"."abstract_category" USING "category"::"public"."abstract_category";