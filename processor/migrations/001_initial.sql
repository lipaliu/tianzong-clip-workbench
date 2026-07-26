CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  project_date date NOT NULL,
  source_name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('聊播', '带货')),
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'uploading', 'queued', 'processing', 'review_ready', 'failed')),
  stage text NOT NULL DEFAULT 'intake',
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  clip_count integer NOT NULL DEFAULT 0 CHECK (clip_count >= 0),
  error_public text,
  core_version text,
  core_sha256 text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_key text NOT NULL UNIQUE,
  source_name text NOT NULL,
  content_type text NOT NULL,
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes > 0),
  expected_sha256 text NOT NULL CHECK (expected_sha256 ~ '^[a-f0-9]{64}$'),
  actual_size_bytes bigint,
  etag text,
  status text NOT NULL DEFAULT 'presigned'
    CHECK (status IN ('presigned', 'uploaded', 'verified', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS media_uploads_project_idx ON media_uploads(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS processing_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL REFERENCES media_uploads(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled')),
  stage text NOT NULL DEFAULT 'queued',
  progress smallint NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  clip_count integer NOT NULL DEFAULT 0 CHECK (clip_count >= 0),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  worker_id text,
  error_public text,
  error_internal text,
  core_version text,
  core_sha256 text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS processing_jobs_poll_idx
  ON processing_jobs(status, available_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS processing_jobs_one_active_per_project_idx
  ON processing_jobs(project_id)
  WHERE status IN ('queued', 'running', 'retrying');

CREATE TABLE IF NOT EXISTS job_events (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  stage text NOT NULL,
  progress smallint NOT NULL CHECK (progress BETWEEN 0 AND 100),
  message text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, id);

CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  source_start_ms bigint NOT NULL CHECK (source_start_ms >= 0),
  source_end_ms bigint NOT NULL CHECK (source_end_ms > source_start_ms),
  score numeric(5,2) NOT NULL CHECK (score BETWEEN 0 AND 100),
  priority text NOT NULL CHECK (priority IN ('S', 'A', 'B')),
  review_status text NOT NULL DEFAULT 'machine_av_checked'
    CHECK (review_status IN ('editorial_candidate', 'machine_av_checked', 'human_approved', 'human_rejected')),
  payload jsonb NOT NULL,
  preview_object_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, ordinal)
);
CREATE INDEX IF NOT EXISTS candidates_project_idx ON candidates(project_id, ordinal);

CREATE TABLE IF NOT EXISTS candidate_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  decision text NOT NULL
    CHECK (decision IN ('approve', 'reject', 'adjust', 'note')),
  submitted_by text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS candidate_feedback_candidate_idx
  ON candidate_feedback(candidate_id, created_at DESC);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  owner_token uuid NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(scope, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idempotency_records_expiry_idx ON idempotency_records(expires_at);

CREATE TABLE IF NOT EXISTS internal_request_nonces (
  key_id text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(key_id, nonce)
);
CREATE INDEX IF NOT EXISTS internal_request_nonces_expiry_idx
  ON internal_request_nonces(expires_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
