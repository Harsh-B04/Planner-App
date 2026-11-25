-- Step 4: notifications. One row per device that turned notifications on.

CREATE TABLE push_subs (
  endpoint    TEXT PRIMARY KEY,        -- the push service address for that device
  user_id     TEXT NOT NULL,
  p256dh      TEXT NOT NULL,           -- the device's public key (to encrypt messages for it)
  auth        TEXT NOT NULL,
  label       TEXT,                    -- e.g. "Android phone"
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_push_user ON push_subs(user_id);

-- What was already sent, so nobody gets the same reminder twice.
CREATE TABLE notify_log (
  user_id  TEXT NOT NULL,
  key      TEXT NOT NULL,
  sent_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

ALTER TABLE user_settings ADD COLUMN notify TEXT;   -- JSON: reminder lead time, evening and morning times
