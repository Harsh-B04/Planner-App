-- Step 3: tasks, planned time blocks, and each person's weekly routine.

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal         TEXT,                     -- group name, e.g. "Project report"
  title        TEXT NOT NULL,
  notes        TEXT,                     -- e.g. "done when: draft sent to guide"
  category     TEXT NOT NULL DEFAULT 'other',
  est_minutes  INTEGER NOT NULL,
  deadline     TEXT,                     -- YYYY-MM-DD
  priority     INTEGER NOT NULL DEFAULT 2, -- 1 high, 2 normal, 3 low
  status       TEXT NOT NULL DEFAULT 'open', -- open | done | dropped
  done_at      INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  server_ts    INTEGER NOT NULL
);
CREATE INDEX idx_tasks_sync ON tasks(user_id, server_ts, id);

-- One block = one planned working session on a day. Times are minutes after midnight (local time).
CREATE TABLE blocks (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL,
  date            TEXT NOT NULL,
  start_min       INTEGER NOT NULL,
  end_min         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'planned', -- planned | done | skipped
  actual_minutes  INTEGER,                  -- how long it really took (for learning your estimates later)
  started_at      INTEGER,                  -- set while the timer runs
  reason          TEXT,                     -- why it was skipped, if you said
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted         INTEGER NOT NULL DEFAULT 0,
  server_ts       INTEGER NOT NULL
);
CREATE INDEX idx_blocks_sync ON blocks(user_id, server_ts, id);

ALTER TABLE user_settings ADD COLUMN routine TEXT;   -- JSON: working hours, busy times, limits
