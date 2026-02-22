-- Function to automatically deactivate tickets when sale_end_date passes
CREATE OR REPLACE FUNCTION update_expired_tickets()
RETURNS void AS $$
BEGIN
  UPDATE ticket_types 
  SET is_active = false 
  WHERE is_active = true 
    AND sale_end_date IS NOT NULL
    AND sale_end_date < NOW();
END;
$$ LANGUAGE plpgsql;

-- Create a trigger to automatically check expired tickets
-- This will run on every update to ticket_types table
CREATE OR REPLACE FUNCTION check_expired_tickets_trigger()
RETURNS trigger AS $$
BEGIN
  -- If sale_end_date is set and in the past, deactivate the ticket
  IF NEW.sale_end_date IS NOT NULL AND NEW.sale_end_date < NOW() THEN
    NEW.is_active := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS ticket_expired_check ON ticket_types;

-- Create trigger
CREATE TRIGGER ticket_expired_check
  BEFORE INSERT OR UPDATE ON ticket_types
  FOR EACH ROW EXECUTE FUNCTION check_expired_tickets_trigger();
