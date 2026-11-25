-- Subject (from #tags, e.g. "thermo") and effort (1 light, 2 normal, 3 hard) on tasks.
ALTER TABLE tasks ADD COLUMN subject TEXT;
ALTER TABLE tasks ADD COLUMN effort INTEGER;
