-- Preserve the meaning of projects created by the earlier three-model proof of
-- concept, which persisted its comparison mode as `compare_all`. The current
-- product contract uses `compare`; normalize only that legacy alias before the
-- stricter compatibility constraint is restored.
UPDATE projects
SET editor_mode = 'compare'
WHERE editor_mode = 'compare_all';

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_editor_mode_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_editor_mode_check
  CHECK (editor_mode IN ('openai', 'doubao', 'kimi', 'compare'));
