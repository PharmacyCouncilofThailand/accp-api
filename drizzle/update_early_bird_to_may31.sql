-- =============================================================================
-- Manual data update: Extend Early Bird ticket end date to 31 May 2026
-- =============================================================================
-- Original Early Bird sale_end_date: 2026-04-30 17:00:00 UTC
--   (= 2026-05-01 00:00:00 Bangkok / GMT+7, i.e. valid through April 30 BKK)
--
-- New Early Bird sale_end_date:      2026-05-31 17:00:00 UTC
--   (= 2026-06-01 00:00:00 Bangkok / GMT+7, i.e. valid through May 31 BKK)
--
-- Regular tickets sale_start_date is also shifted to start exactly when
-- Early Bird ends, to keep continuity with no gap or overlap.
--
-- Run this once after deployment:
--   psql $DATABASE_URL -f drizzle/update_early_bird_to_may31.sql
-- =============================================================================

BEGIN;

-- 1) Push Early Bird sale_end_date to end of 31 May 2026 (Bangkok time)
UPDATE ticket_types
SET sale_end_date = '2026-05-31 17:00:00'::timestamp
WHERE priority = 'early_bird'
  AND sale_end_date IS NOT NULL
  AND sale_end_date >= '2026-04-25 00:00:00'::timestamp
  AND sale_end_date <  '2026-05-05 00:00:00'::timestamp;

-- 2) Shift Regular tickets sale_start_date to match new Early Bird end
UPDATE ticket_types
SET sale_start_date = '2026-05-31 17:00:00'::timestamp
WHERE priority = 'regular'
  AND sale_start_date IS NOT NULL
  AND sale_start_date >= '2026-04-25 00:00:00'::timestamp
  AND sale_start_date <  '2026-05-05 00:00:00'::timestamp;

-- 3) Reactivate Early Bird tickets that were auto-disabled by the
--    `check_expired_tickets_trigger` trigger if their old end date passed
UPDATE ticket_types
SET is_active = true
WHERE priority = 'early_bird'
  AND is_active = false
  AND sale_end_date = '2026-05-31 17:00:00'::timestamp;

COMMIT;

-- =============================================================================
-- Verification queries (run separately to confirm changes):
-- =============================================================================
-- SELECT id, name, priority, sale_start_date, sale_end_date, is_active
-- FROM ticket_types
-- WHERE priority IN ('early_bird', 'regular')
-- ORDER BY priority, display_order;
