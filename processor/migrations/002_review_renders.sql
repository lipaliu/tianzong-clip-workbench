ALTER TABLE media_uploads
  ALTER COLUMN expected_sha256 DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS actual_sha256 text;

ALTER TABLE media_uploads
  DROP CONSTRAINT IF EXISTS media_uploads_expected_sha256_check,
  DROP CONSTRAINT IF EXISTS media_uploads_actual_sha256_check;

ALTER TABLE media_uploads
  ADD CONSTRAINT media_uploads_expected_sha256_check
    CHECK (expected_sha256 IS NULL OR expected_sha256 ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT media_uploads_actual_sha256_check
    CHECK (actual_sha256 IS NULL OR actual_sha256 ~ '^[a-f0-9]{64}$');

ALTER TABLE candidates
  DROP CONSTRAINT IF EXISTS candidates_review_status_check;

UPDATE candidates
SET review_status = CASE review_status
  WHEN 'human_rejected' THEN 'human_review_rejected'
  WHEN 'editorial_candidate' THEN 'editorial_candidate_needs_av_review'
  ELSE 'proxy_rendered_needs_human_normal_playback'
END
WHERE review_status IN (
  'human_rejected',
  'human_approved',
  'editorial_candidate',
  'machine_av_checked'
);

ALTER TABLE candidates
  ADD CONSTRAINT candidates_review_status_check CHECK (
    review_status IN (
      'editorial_candidate_needs_av_review',
      'proxy_rendered_needs_human_normal_playback',
      'human_review_needs_changes',
      'human_review_rejected',
      'human_av_verified_normal_playback'
    )
  );

ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS render_status text NOT NULL DEFAULT 'rough_ready',
  ADD COLUMN IF NOT EXISTS revision_object_key text,
  ADD COLUMN IF NOT EXISTS latest_feedback_id uuid;

ALTER TABLE candidates
  DROP CONSTRAINT IF EXISTS candidates_render_status_check;

ALTER TABLE candidates
  ADD CONSTRAINT candidates_render_status_check CHECK (
    render_status IN (
      'rough_ready',
      'revision_queued',
      'revision_rendering',
      'revision_ready',
      'render_failed'
    )
  );

CREATE TABLE IF NOT EXISTS candidate_renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  upload_id uuid NOT NULL REFERENCES media_uploads(id) ON DELETE RESTRICT,
  feedback_id uuid REFERENCES candidate_feedback(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'failed', 'cancelled')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  worker_id text,
  render_spec jsonb NOT NULL,
  approval_target boolean NOT NULL DEFAULT false,
  output_object_key text,
  error_internal text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS candidate_renders_poll_idx
  ON candidate_renders(status, available_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS candidate_renders_one_active_idx
  ON candidate_renders(candidate_id)
  WHERE status IN ('queued', 'running', 'retrying');

ALTER TABLE candidates
  DROP CONSTRAINT IF EXISTS candidates_latest_feedback_id_fkey,
  ADD CONSTRAINT candidates_latest_feedback_id_fkey
    FOREIGN KEY (latest_feedback_id)
    REFERENCES candidate_feedback(id)
    ON DELETE SET NULL;
