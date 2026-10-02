/*
# Add durable capture sessions and live numeric events

1. Purpose
- Keep numeric values safe in Supabase while a screen capture is in progress.
- Allow the app to restore the captured values after a browser refresh or unexpected interruption.
- Preserve every confirmed event, including a value that appears again later.

2. New Tables
- `capture_sessions`
  - `id` (uuid, primary key) — durable identifier for one capture attempt.
  - `started_at` (timestamptz) — when the capture began.
  - `last_seen_at` (timestamptz) — most recent time the app successfully wrote capture data.
  - `status` (text) — `active`, `completed`, or `interrupted`.
  - `region_x`, `region_y`, `region_width`, `region_height` (integer, nullable) — selected screen area.
  - `source_width`, `source_height` (integer, nullable) — source screen dimensions.
  - `created_at` (timestamptz) — row creation time.
- `capture_session_numbers`
  - `id` (uuid, primary key) — event identifier.
  - `session_id` (uuid) — parent capture session.
  - `value` (text) — exact confirmed OCR value.
  - `numeric_value` (numeric, nullable) — parsed numeric value.
  - `captured_at` (timestamptz) — event time.
  - `elapsed_ms` (bigint) — time since capture began.
  - `confidence` (real, nullable) — minimum OCR confidence used for the event.
  - `source` (text) — event source, currently `ocr`.

3. Security
- Enable row-level security on both tables.
- This app has no sign-in screen and is intentionally single-tenant, so anon and authenticated clients receive separate CRUD policies.

4. Data safety
- Existing recording and captured-number rows are unchanged.
- Child live events are removed only when their parent capture session is removed.
- No existing columns are deleted, renamed, or type-changed.
*/

CREATE TABLE IF NOT EXISTS capture_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'interrupted')),
  region_x integer,
  region_y integer,
  region_width integer,
  region_height integer,
  source_width integer,
  source_height integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS capture_session_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES capture_sessions(id) ON DELETE CASCADE,
  value text NOT NULL,
  numeric_value numeric,
  captured_at timestamptz NOT NULL DEFAULT now(),
  elapsed_ms bigint NOT NULL,
  confidence real,
  source text NOT NULL DEFAULT 'ocr'
);

CREATE INDEX IF NOT EXISTS capture_sessions_status_idx ON capture_sessions(status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS capture_session_numbers_session_time_idx ON capture_session_numbers(session_id, elapsed_ms);

ALTER TABLE capture_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_session_numbers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_select_capture_sessions" ON capture_sessions;
CREATE POLICY "anon_select_capture_sessions" ON capture_sessions FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_capture_sessions" ON capture_sessions;
CREATE POLICY "anon_insert_capture_sessions" ON capture_sessions FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_capture_sessions" ON capture_sessions;
CREATE POLICY "anon_update_capture_sessions" ON capture_sessions FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_capture_sessions" ON capture_sessions;
CREATE POLICY "anon_delete_capture_sessions" ON capture_sessions FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_select_capture_session_numbers" ON capture_session_numbers;
CREATE POLICY "anon_select_capture_session_numbers" ON capture_session_numbers FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "anon_insert_capture_session_numbers" ON capture_session_numbers;
CREATE POLICY "anon_insert_capture_session_numbers" ON capture_session_numbers FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "anon_update_capture_session_numbers" ON capture_session_numbers;
CREATE POLICY "anon_update_capture_session_numbers" ON capture_session_numbers FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "anon_delete_capture_session_numbers" ON capture_session_numbers;
CREATE POLICY "anon_delete_capture_session_numbers" ON capture_session_numbers FOR DELETE TO anon, authenticated USING (true);
