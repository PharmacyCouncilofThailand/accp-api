CREATE TYPE "public"."staff_role" AS ENUM('admin', 'organizer', 'reviewer', 'staff', 'verifier');--> statement-breakpoint
CREATE TABLE "backoffice_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"role" "staff_role" NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "backoffice_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "staff_event_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"staff_id" integer NOT NULL,
	"event_id" integer NOT NULL,
	"session_id" integer,
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_event_assignments" ADD CONSTRAINT "staff_event_assignments_staff_id_backoffice_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."backoffice_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_event_assignments" ADD CONSTRAINT "staff_event_assignments_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_event_assignments" ADD CONSTRAINT "staff_event_assignments_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;