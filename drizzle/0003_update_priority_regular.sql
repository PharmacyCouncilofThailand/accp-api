-- Update existing tickets to use only early_bird or regular priority
-- Set all non-early_bird tickets to 'regular'
UPDATE ticket_types SET priority = 'regular' WHERE priority NOT IN ('early_bird', 'regular');

-- Recalculate displayOrder with new weight system
-- early_bird = 100, regular = 200
UPDATE ticket_types SET display_order = (
  CASE priority
    WHEN 'early_bird' THEN 100
    WHEN 'regular' THEN 200
    ELSE 200
  END
) * 10000 + COALESCE(
  EXTRACT(MONTH FROM sale_start_date)::int * 100 + EXTRACT(DAY FROM sale_start_date)::int,
  0
);
