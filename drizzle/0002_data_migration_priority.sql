-- Data Migration: Set priority for existing tickets based on name patterns
-- Run after 0001_famous_maddog.sql migration

-- Early Bird tickets
UPDATE ticket_types SET priority = 'early_bird'
  WHERE name ILIKE '%early bird%' AND priority = 'regular';

-- Late registration tickets
UPDATE ticket_types SET priority = 'late'
  WHERE name ILIKE '%late%' AND priority = 'regular';

-- On-site tickets
UPDATE ticket_types SET priority = 'onsite'
  WHERE (name ILIKE '%on-site%' OR name ILIKE '%onsite%') AND priority = 'regular';

-- Super Early Bird tickets
UPDATE ticket_types SET priority = 'super_early_bird'
  WHERE name ILIKE '%super early%' AND priority = 'regular';

-- Recalculate displayOrder for all tickets using the formula:
-- priority_weight * 10000 + MMDD(sale_start_date)
UPDATE ticket_types SET display_order = (
  CASE priority
    WHEN 'super_early_bird' THEN 100
    WHEN 'early_bird' THEN 200
    WHEN 'regular' THEN 300
    WHEN 'late' THEN 400
    WHEN 'onsite' THEN 500
    ELSE 300
  END
) * 10000 + COALESCE(
  EXTRACT(MONTH FROM sale_start_date)::int * 100 + EXTRACT(DAY FROM sale_start_date)::int,
  0
);
