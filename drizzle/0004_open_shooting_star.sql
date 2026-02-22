CREATE TABLE "registration_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"registration_id" integer NOT NULL,
	"session_id" integer NOT NULL,
	"ticket_type_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "order_id" integer;--> statement-breakpoint
ALTER TABLE "registration_sessions" ADD CONSTRAINT "registration_sessions_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_sessions" ADD CONSTRAINT "registration_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_sessions" ADD CONSTRAINT "registration_sessions_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;