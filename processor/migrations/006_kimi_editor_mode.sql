ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_editor_mode_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_editor_mode_check
  CHECK (editor_mode IN ('openai', 'doubao', 'kimi', 'compare', 'compare_all'));
