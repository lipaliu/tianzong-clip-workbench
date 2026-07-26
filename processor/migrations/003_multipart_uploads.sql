ALTER TABLE media_uploads
  ADD COLUMN IF NOT EXISTS upload_strategy text NOT NULL DEFAULT 'single',
  ADD COLUMN IF NOT EXISTS multipart_upload_id text,
  ADD COLUMN IF NOT EXISTS multipart_part_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS multipart_part_count integer;

ALTER TABLE media_uploads
  DROP CONSTRAINT IF EXISTS media_uploads_status_check,
  DROP CONSTRAINT IF EXISTS media_uploads_upload_strategy_check,
  DROP CONSTRAINT IF EXISTS media_uploads_multipart_shape_check;

ALTER TABLE media_uploads
  ADD CONSTRAINT media_uploads_status_check CHECK (
    status IN (
      'presigned',
      'multipart_initiated',
      'uploading',
      'completing',
      'uploaded',
      'verified',
      'failed',
      'aborted'
    )
  ),
  ADD CONSTRAINT media_uploads_upload_strategy_check CHECK (
    upload_strategy IN ('single', 'multipart')
  ),
  ADD CONSTRAINT media_uploads_multipart_shape_check CHECK (
    (
      upload_strategy = 'single'
      AND multipart_upload_id IS NULL
      AND multipart_part_size_bytes IS NULL
      AND multipart_part_count IS NULL
    )
    OR (
      upload_strategy = 'multipart'
      AND (
        status IN ('presigned', 'failed', 'aborted')
        OR (
          multipart_upload_id IS NOT NULL
          AND multipart_part_size_bytes >= 5242880
          AND multipart_part_count BETWEEN 2 AND 10000
        )
      )
    )
  );

CREATE TABLE IF NOT EXISTS multipart_upload_parts (
  upload_id uuid NOT NULL REFERENCES media_uploads(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 10000),
  expected_size_bytes bigint NOT NULL CHECK (expected_size_bytes > 0),
  actual_size_bytes bigint,
  etag text,
  status text NOT NULL DEFAULT 'expected'
    CHECK (status IN ('expected', 'uploaded')),
  uploaded_at timestamptz,
  PRIMARY KEY(upload_id, part_number)
);

CREATE INDEX IF NOT EXISTS multipart_upload_parts_project_idx
  ON multipart_upload_parts(project_id, upload_id, part_number);
