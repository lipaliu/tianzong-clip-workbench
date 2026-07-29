ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS editor_mode text NOT NULL DEFAULT 'compare'
  CHECK (editor_mode IN ('openai', 'doubao', 'compare'));
