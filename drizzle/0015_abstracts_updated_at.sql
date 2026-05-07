-- 0015: Add updated_at timestamp to abstracts table
-- Used as the acceptance date for the abstract-accepted letter; gets bumped
-- whenever the row is updated (notably when admin changes status to 'accepted').

ALTER TABLE "abstracts"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamp NOT NULL DEFAULT now();
