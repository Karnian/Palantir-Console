-- Claude resume must reuse the exact profile-derived runtime restrictions from
-- the fresh spawn boundary. NULL marks a pre-migration run and deliberately
-- retains the legacy fallback to the current profile; '{}' means a new run
-- explicitly had no template options and must not inherit later profile edits.
ALTER TABLE runs ADD COLUMN session_claude_options_json TEXT
  CHECK (
    session_claude_options_json IS NULL
    OR CASE
      WHEN json_valid(session_claude_options_json)
        THEN json_type(session_claude_options_json) = 'object'
      ELSE 0
    END
  );
