-- NULL preserves OpenSSH's default port (22) and keeps existing node rows unchanged.

ALTER TABLE nodes
  ADD COLUMN ssh_port INTEGER CHECK (ssh_port IS NULL OR (ssh_port >= 1 AND ssh_port <= 65535));
