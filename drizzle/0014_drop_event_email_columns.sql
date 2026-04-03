-- 0014: Drop unused email context columns from events table
-- organizerName, organizerLocation, contactEmail are now hardcoded in emailTemplates.ts
-- Only shortName remains (used for email subject lines)

ALTER TABLE "events" DROP COLUMN IF EXISTS "organizer_name";
ALTER TABLE "events" DROP COLUMN IF EXISTS "organizer_location";
ALTER TABLE "events" DROP COLUMN IF EXISTS "contact_email";
