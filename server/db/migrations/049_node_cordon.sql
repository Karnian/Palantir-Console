-- Fleet N3-1: node cordon/drain mode.
-- Additive ALTER keeps existing node rows and defaults them to uncordoned.

ALTER TABLE nodes
  ADD COLUMN cordoned INTEGER NOT NULL DEFAULT 0 CHECK (cordoned IN (0,1));
