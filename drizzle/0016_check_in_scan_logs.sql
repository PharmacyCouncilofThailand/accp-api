CREATE TABLE IF NOT EXISTS "check_in_scan_logs" (
  "id" serial PRIMARY KEY NOT NULL,
  "registration_session_id" integer NOT NULL,
  "registration_id" integer NOT NULL,
  "event_id" integer NOT NULL,
  "session_id" integer NOT NULL,
  "is_duplicate" boolean DEFAULT false NOT NULL,
  "scanned_at" timestamp DEFAULT now() NOT NULL,
  "scanned_by" integer
);
--> statement-breakpoint
ALTER TABLE "check_in_scan_logs" ADD CONSTRAINT "check_in_scan_logs_registration_session_id_registration_sessions_id_fk" FOREIGN KEY ("registration_session_id") REFERENCES "public"."registration_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "check_in_scan_logs" ADD CONSTRAINT "check_in_scan_logs_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "check_in_scan_logs" ADD CONSTRAINT "check_in_scan_logs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "check_in_scan_logs" ADD CONSTRAINT "check_in_scan_logs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "check_in_scan_logs" ADD CONSTRAINT "check_in_scan_logs_scanned_by_backoffice_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."backoffice_users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "check_in_scan_logs_event_id_idx" ON "check_in_scan_logs" ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "check_in_scan_logs_registration_session_id_idx" ON "check_in_scan_logs" ("registration_session_id");
