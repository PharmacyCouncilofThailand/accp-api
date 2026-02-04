-- Performance Indexes Migration
-- This migration adds indexes to frequently filtered/searched columns
-- to improve query performance significantly

-- ============================================================================
-- ABSTRACTS TABLE INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_abstracts_status" ON "abstracts" ("status");
CREATE INDEX IF NOT EXISTS "idx_abstracts_category" ON "abstracts" ("category");
CREATE INDEX IF NOT EXISTS "idx_abstracts_presentation_type" ON "abstracts" ("presentation_type");
CREATE INDEX IF NOT EXISTS "idx_abstracts_user_id" ON "abstracts" ("user_id");
CREATE INDEX IF NOT EXISTS "idx_abstracts_event_id" ON "abstracts" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_abstracts_created_at" ON "abstracts" ("created_at" DESC);

-- ============================================================================
-- REGISTRATIONS TABLE INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_registrations_status" ON "registrations" ("status");
CREATE INDEX IF NOT EXISTS "idx_registrations_event_id" ON "registrations" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_registrations_email" ON "registrations" ("email");
CREATE INDEX IF NOT EXISTS "idx_registrations_created_at" ON "registrations" ("created_at" DESC);

-- ============================================================================
-- EVENTS TABLE INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_events_status" ON "events" ("status");
CREATE INDEX IF NOT EXISTS "idx_events_event_type" ON "events" ("event_type");
CREATE INDEX IF NOT EXISTS "idx_events_created_at" ON "events" ("created_at" DESC);

-- ============================================================================
-- USERS TABLE INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_users_verification_status" ON "users" ("verification_status");

-- ============================================================================
-- STAFF EVENT ASSIGNMENTS INDEXES (for role-based filtering)
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_staff_assignments_staff_id" ON "staff_event_assignments" ("staff_id");
CREATE INDEX IF NOT EXISTS "idx_staff_assignments_event_id" ON "staff_event_assignments" ("event_id");

-- ============================================================================
-- EVENT SPEAKERS INDEXES (for N+1 batch query optimization)
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_event_speakers_session_id" ON "event_speakers" ("session_id");
CREATE INDEX IF NOT EXISTS "idx_event_speakers_event_id" ON "event_speakers" ("event_id");

-- ============================================================================
-- TICKET SESSIONS INDEXES (for N+1 batch query optimization)
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_ticket_sessions_ticket_type_id" ON "ticket_sessions" ("ticket_type_id");
CREATE INDEX IF NOT EXISTS "idx_ticket_sessions_session_id" ON "ticket_sessions" ("session_id");

-- ============================================================================
-- ABSTRACT CO-AUTHORS INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_co_authors_abstract_id" ON "abstract_co_authors" ("abstract_id");

-- ============================================================================
-- SESSIONS TABLE INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_sessions_event_id" ON "sessions" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_sessions_start_time" ON "sessions" ("start_time");

-- ============================================================================
-- TICKET TYPES TABLE INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS "idx_ticket_types_event_id" ON "ticket_types" ("event_id");
