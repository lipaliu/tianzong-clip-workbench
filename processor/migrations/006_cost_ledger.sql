-- Cost ledger.
--
-- One row per billable model call group, written as each stage finishes so a
-- job that fails halfway still shows what it already spent. Token counters are
-- always stored; cost_cny is NULL when no published rate was on file, which is
-- how an unpriced model stays visible instead of silently reading as free.

CREATE TABLE IF NOT EXISTS job_cost_entries (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  priced boolean NOT NULL,
  cost_cny numeric(12, 4),
  unpriced_reason text,
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cached_input_tokens bigint NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
  billed_seconds numeric(12, 3),
  rate_source text,
  rate_checked_on text,
  usd_to_cny numeric(8, 4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A priced row must carry a number and an unpriced row must carry a reason.
  -- Without this the two states blur and a zero starts looking like free.
  CONSTRAINT job_cost_entries_priced_shape CHECK (
    (priced AND cost_cny IS NOT NULL AND unpriced_reason IS NULL)
    OR (NOT priced AND cost_cny IS NULL AND unpriced_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS job_cost_entries_job_idx
  ON job_cost_entries(job_id, id);
CREATE INDEX IF NOT EXISTS job_cost_entries_project_idx
  ON job_cost_entries(project_id, created_at);

-- Delivered output is recorded on the job so cost-per-second stays computable
-- from one row after candidates are re-rendered or trimmed.
ALTER TABLE processing_jobs
  ADD COLUMN IF NOT EXISTS delivered_clip_seconds numeric(12, 3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_media_seconds numeric(12, 3) NOT NULL DEFAULT 0;
