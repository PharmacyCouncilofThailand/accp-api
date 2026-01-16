ALTER TABLE "users" ADD COLUMN "pharmacy_license_id" varchar(20);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_pharmacy_license_id_unique" UNIQUE("pharmacy_license_id");