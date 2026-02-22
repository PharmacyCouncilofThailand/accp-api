CREATE SEQUENCE IF NOT EXISTS pay_solutions_refno_seq START WITH 1 INCREMENT BY 1 MINVALUE 1 NO MAXVALUE CACHE 1;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "payment_provider" varchar(30);
--> statement-breakpoint
UPDATE "payments" SET "payment_provider" = 'stripe' WHERE "payment_provider" IS NULL;
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "payment_provider" SET DEFAULT 'stripe';
--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "payment_provider" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "provider_ref" varchar(255);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "provider_status" varchar(50);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "pay_solutions_refno" varchar(12);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "pay_solutions_order_no" varchar(50);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "pay_solutions_channel" varchar(20);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payments_pay_solutions_refno_unique"
ON "payments" ("pay_solutions_refno")
WHERE "pay_solutions_refno" IS NOT NULL;
