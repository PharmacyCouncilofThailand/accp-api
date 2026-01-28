CREATE TABLE "ticket_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_type_id" integer NOT NULL,
	"session_id" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ticket_sessions" ADD CONSTRAINT "ticket_sessions_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_sessions" ADD CONSTRAINT "ticket_sessions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;