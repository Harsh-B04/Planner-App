-- Habits ride on tasks (a small JSON setting); each tick or "+1" is its own row so two devices never overwrite each other.
ALTER TABLE tasks ADD COLUMN habit TEXT;

CREATE TABLE habit_logs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL,
  date        TEXT NOT NULL,              -- YYYY-MM-DD, the day it counts for
  amount      INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  server_ts   INTEGER NOT NULL
);
CREATE INDEX idx_habit_logs_sync ON habit_logs(user_id, server_ts, id);

-- Exams and other dated goals you count down to.
CREATE TABLE exams (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  date        TEXT NOT NULL,
  subject     TEXT,                       -- tasks with this subject count towards it
  status      TEXT NOT NULL DEFAULT 'upcoming', -- upcoming | done
  note        TEXT,                       -- "How did it go?"
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0,
  server_ts   INTEGER NOT NULL
);
CREATE INDEX idx_exams_sync ON exams(user_id, server_ts, id);
