CREATE TABLE profile_memory_revision (
  profile_id TEXT PRIMARY KEY REFERENCES operator_profiles(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL DEFAULT 0,
  owner_type TEXT NOT NULL DEFAULT 'profile',
  owner_id   TEXT
);
