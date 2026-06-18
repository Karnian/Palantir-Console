CREATE INDEX IF NOT EXISTS idx_memory_xproject_scan
  ON memory_items(content_hash, project_id)
  WHERE status='active' AND kind!='fact';
