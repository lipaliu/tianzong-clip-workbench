ALTER TABLE media_uploads
  ADD COLUMN IF NOT EXISTS upload_purpose text NOT NULL DEFAULT 'source_video'
  CHECK (upload_purpose IN ('source_video', 'subtitle_srt'));

ALTER TABLE processing_jobs
  ADD COLUMN IF NOT EXISTS subtitle_upload_id uuid REFERENCES media_uploads(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS transcript_source text NOT NULL DEFAULT 'automatic_asr'
  CHECK (transcript_source IN ('uploaded_srt', 'automatic_asr'));

CREATE UNIQUE INDEX IF NOT EXISTS processing_jobs_one_subtitle_per_project_idx
  ON processing_jobs(project_id)
  WHERE subtitle_upload_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS media_uploads_project_purpose_idx
  ON media_uploads(project_id, upload_purpose, created_at DESC);
