-- 0013: Add email-template columns to events table
-- These columns allow generic email templates to pull event-specific info
-- instead of hardcoding conference name/venue/organizer.

ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "short_name" varchar(100);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "organizer_name" varchar(255);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "organizer_location" varchar(255);
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "contact_email" varchar(255);
