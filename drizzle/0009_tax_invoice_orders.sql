ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "need_tax_invoice" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_name" varchar(200);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_id" varchar(50);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_address" varchar(500);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_sub_district" varchar(100);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_district" varchar(100);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_province" varchar(100);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_postal_code" varchar(20);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_full_address" text;
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "tax_created_at" timestamp;
