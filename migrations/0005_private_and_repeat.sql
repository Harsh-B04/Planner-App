-- Repeating tasks and the private journal.

-- JSON: { "days": [0-6], "time": "HH:MM" or null }. NULL = a normal one-off task.
ALTER TABLE tasks ADD COLUMN repeat TEXT;

-- Private journal: the person's journal key, locked with their passphrase and with their recovery code.
-- The server only ever sees these locked copies, never the passphrase or the key itself.
ALTER TABLE user_settings ADD COLUMN vault TEXT;
