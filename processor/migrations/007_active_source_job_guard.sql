ALTER TABLE processing_jobs
  ADD COLUMN IF NOT EXISTS source_fingerprint text;

ALTER TABLE processing_jobs
  DROP CONSTRAINT IF EXISTS processing_jobs_source_fingerprint_check;

ALTER TABLE processing_jobs
  ADD CONSTRAINT processing_jobs_source_fingerprint_check CHECK (
    source_fingerprint IS NULL
    OR source_fingerprint ~ '^[a-f0-9]{64}$'
  );

-- Historical rows stay nullable so this migration never cancels or mutates an
-- already-running delivery. Every newly admitted job receives a fingerprint.
-- The index is the race-proof backstop for simultaneous requests.
CREATE UNIQUE INDEX IF NOT EXISTS processing_jobs_one_active_per_source_idx
  ON processing_jobs(source_fingerprint)
  WHERE status IN ('queued', 'running', 'retrying')
    AND source_fingerprint IS NOT NULL;
