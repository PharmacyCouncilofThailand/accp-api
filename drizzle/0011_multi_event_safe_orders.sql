-- 0011: Add orders.event_id and backfill order scope for multi-event-safe checkout/payment
-- Additive-first migration. Leaves ambiguous legacy rows as NULL.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS event_id integer REFERENCES events(id);

CREATE INDEX IF NOT EXISTS idx_orders_user_event_status
  ON orders(user_id, event_id, status);

CREATE INDEX IF NOT EXISTS idx_registrations_user_event_status
  ON registrations(user_id, event_id, status);

CREATE INDEX IF NOT EXISTS idx_ticket_types_event_category_currency_active
  ON ticket_types(event_id, category, currency, is_active);

-- Backfill orders with a single primary-ticket event.
WITH primary_ticket_events AS (
  SELECT
    oi.order_id,
    MIN(tt.event_id) AS event_id
  FROM order_items oi
  INNER JOIN ticket_types tt ON tt.id = oi.ticket_type_id
  WHERE oi.item_type = 'ticket'
  GROUP BY oi.order_id
  HAVING COUNT(DISTINCT tt.event_id) = 1
)
UPDATE orders o
SET event_id = pte.event_id
FROM primary_ticket_events pte
WHERE o.id = pte.order_id
  AND o.event_id IS NULL;

-- Backfill addon-only orders from existing registrations when the order maps to exactly one event.
WITH registration_events AS (
  SELECT
    r.order_id,
    MIN(r.event_id) AS event_id
  FROM registrations r
  WHERE r.order_id IS NOT NULL
  GROUP BY r.order_id
  HAVING COUNT(DISTINCT r.event_id) = 1
)
UPDATE orders o
SET event_id = re.event_id
FROM registration_events re
WHERE o.id = re.order_id
  AND o.event_id IS NULL;

-- Final deterministic backfill for orders whose order items all belong to one event.
WITH single_event_item_orders AS (
  SELECT
    oi.order_id,
    MIN(tt.event_id) AS event_id
  FROM order_items oi
  INNER JOIN ticket_types tt ON tt.id = oi.ticket_type_id
  GROUP BY oi.order_id
  HAVING COUNT(DISTINCT tt.event_id) = 1
)
UPDATE orders o
SET event_id = seio.event_id
FROM single_event_item_orders seio
WHERE o.id = seio.order_id
  AND o.event_id IS NULL;
