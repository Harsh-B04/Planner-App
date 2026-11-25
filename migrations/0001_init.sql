-- Milestone 1: accounts, sessions, settings, journal entries, preferences.
-- Every row that belongs to someone carries user_id, so friends' data never mixes.

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash   TEXT NOT NULL,            -- "pbkdf2$<iterations>$<salt>$<hash>"
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Which AI each person uses. The API key is stored encrypted and never sent back to the browser.
CREATE TABLE user_settings (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  ai_provider TEXT,
  ai_model    TEXT,
  ai_base_url TEXT,
  ai_key_enc  TEXT,
  timezone    TEXT,
  updated_at  INTEGER NOT NULL
);

-- Synced tables share the same pattern:
--   id         made on the device, so an entry written offline keeps its id (retries never duplicate)
--   updated_at device clock, decides which edit wins
--   server_ts  server clock, used only to ask "what changed since I last synced"
--   deleted    deletions are synced too; the text is wiped on the server

CREATE TABLE entries (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  entry_date  TEXT NOT NULL,            -- local date YYYY-MM-DD
  energy      INTEGER,                  -- optional: 1 low, 2 okay, 3 high
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  server_ts   INTEGER NOT NULL
);
CREATE INDEX idx_entries_sync ON entries(user_id, server_ts, id);

-- "Things to know about me", e.g. "I don't work on Fridays".
-- rule_json stays empty for now; the planner step will turn text into a structured rule (after you confirm).
CREATE TABLE prefs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  rule_json   TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  server_ts   INTEGER NOT NULL
);
CREATE INDEX idx_prefs_sync ON prefs(user_id, server_ts, id);
