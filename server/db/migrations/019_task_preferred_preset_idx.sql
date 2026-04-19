-- Add missing index for tasks.preferred_preset_id (column added in 018 without index).
CREATE INDEX IF NOT EXISTS idx_tasks_preferred_preset_id
  ON tasks(preferred_preset_id)
  WHERE preferred_preset_id IS NOT NULL;
