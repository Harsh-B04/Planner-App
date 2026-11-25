-- Which journal entry a task came from, so deleting the entry can take its unfinished plans with it.
ALTER TABLE tasks ADD COLUMN entry_id TEXT;
