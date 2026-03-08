ALTER TYPE "public"."user_role" ADD VALUE 'general';--> statement-breakpoint
CREATE TABLE "promo_code_rule_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_set_id" integer NOT NULL,
	"ticket_type_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_code_rule_sets" (
	"id" serial PRIMARY KEY NOT NULL,
	"promo_code_id" integer NOT NULL,
	"match_type" varchar(10) DEFAULT 'all' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_code_usages" (
	"id" serial PRIMARY KEY NOT NULL,
	"promo_code_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"order_id" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"discount_amount" numeric(10, 2),
	"reserved_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"cancelled_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "subtotal_amount" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "discount_amount" numeric(10, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "promo_code_id" integer;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "promo_code" varchar(50);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "promo_discount_type" varchar(20);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "promo_discount_value" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "need_tax_invoice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_name" varchar(200);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_id" varchar(50);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_address" varchar(500);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_sub_district" varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_district" varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_province" varchar(100);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_postal_code" varchar(20);--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_full_address" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tax_created_at" timestamp;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "payment_provider" varchar(30) DEFAULT 'stripe' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_ref" varchar(255);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "provider_status" varchar(50);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "pay_solutions_refno" varchar(12);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "pay_solutions_order_no" varchar(50);--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "pay_solutions_channel" varchar(20);--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "fixed_value_thb" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "fixed_value_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "min_purchase" numeric(10, 2) DEFAULT '0';--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "max_discount" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "promo_codes" ADD COLUMN "max_uses_per_user" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "registration_sessions" ADD COLUMN "source" varchar(20) DEFAULT 'purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE "registration_sessions" ADD COLUMN "added_by" integer;--> statement-breakpoint
ALTER TABLE "registration_sessions" ADD COLUMN "added_note" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "source" varchar(20) DEFAULT 'purchase' NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "added_by" integer;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "added_note" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agenda" jsonb;--> statement-breakpoint
ALTER TABLE "promo_code_rule_items" ADD CONSTRAINT "promo_code_rule_items_rule_set_id_promo_code_rule_sets_id_fk" FOREIGN KEY ("rule_set_id") REFERENCES "public"."promo_code_rule_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_rule_items" ADD CONSTRAINT "promo_code_rule_items_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_rule_sets" ADD CONSTRAINT "promo_code_rule_sets_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_usages" ADD CONSTRAINT "promo_code_usages_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_usages" ADD CONSTRAINT "promo_code_usages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_code_usages" ADD CONSTRAINT "promo_code_usages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_promo_code_id_promo_codes_id_fk" FOREIGN KEY ("promo_code_id") REFERENCES "public"."promo_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_sessions" ADD CONSTRAINT "registration_sessions_added_by_backoffice_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."backoffice_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_added_by_backoffice_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."backoffice_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "agenda_time";