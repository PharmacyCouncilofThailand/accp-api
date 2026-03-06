-- 0010: Add manual registration tracking columns
-- Additive-only, safe for production

ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS source      varchar(20) NOT NULL DEFAULT 'purchase',
  ADD COLUMN IF NOT EXISTS added_by    integer REFERENCES backoffice_users(id),
  ADD COLUMN IF NOT EXISTS added_note  text;

ALTER TABLE registration_sessions
  ADD COLUMN IF NOT EXISTS source      varchar(20) NOT NULL DEFAULT 'purchase',
  ADD COLUMN IF NOT EXISTS added_by    integer REFERENCES backoffice_users(id),
  ADD COLUMN IF NOT EXISTS added_note  text;

-- Indexes for filtering
CREATE INDEX IF NOT EXISTS idx_registrations_source ON registrations(source);
CREATE INDEX IF NOT EXISTS idx_registration_sessions_source ON registration_sessions(source);
