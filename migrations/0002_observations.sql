-- Step 2: facts the AI pulls out of journal entries, waiting for the user to confirm.
-- Raw entries are never changed by the AI; these rows point back to them.

CREATE TABLE observations (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,                     -- activity | intention | preference
  data        TEXT NOT NULL,                     -- JSON, shape depends on kind
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | confirmed | rejected
  source      TEXT NOT NULL DEFAULT 'ai',        -- ai | user (user = corrected by hand)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  server_ts   INTEGER NOT NULL
);
CREATE INDEX idx_obs_sync  ON observations(user_id, server_ts, id);
CREATE INDEX idx_obs_entry ON observations(user_id, entry_id);

-- Which version of an entry (its updated_at) the AI last read. Only the server writes this.
ALTER TABLE entries ADD COLUMN extracted_version INTEGER;

-- AI calls per person per day (UTC), so one person can't run up the bill or use up the free allowance.
CREATE TABLE ai_usage (
  user_id  TEXT NOT NULL,
  day      TEXT NOT NULL,
  calls    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
