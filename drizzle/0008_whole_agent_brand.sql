CREATE TABLE "sso_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" varchar(255) NOT NULL,
	"user_id" integer NOT NULL,
	"event_id" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"used" boolean DEFAULT false NOT NULL,
	"source_app" varchar(50) NOT NULL,
	"target_app" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "map_url" SET DATA TYPE varchar(2000);--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "video_url" varchar(2000);--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "website_url" varchar(500);--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "short_name" varchar(100);--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "documents" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "event_id" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "documents" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "university" varchar(255);--> statement-breakpoint
ALTER TABLE "sso_tokens" ADD CONSTRAINT "sso_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_tokens" ADD CONSTRAINT "sso_tokens_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;