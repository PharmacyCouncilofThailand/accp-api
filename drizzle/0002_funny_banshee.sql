ALTER TABLE "ticket_types" ALTER COLUMN "priority" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "ticket_types" ALTER COLUMN "priority" SET DEFAULT 'regular'::text;--> statement-breakpoint
DROP TYPE "public"."ticket_priority";--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('early_bird', 'regular');--> statement-breakpoint
ALTER TABLE "ticket_types" ALTER COLUMN "priority" SET DEFAULT 'regular'::"public"."ticket_priority";--> statement-breakpoint
ALTER TABLE "ticket_types" ALTER COLUMN "priority" SET DATA TYPE "public"."ticket_priority" USING "priority"::"public"."ticket_priority";