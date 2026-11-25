-- A task can wait until a start date ("not before"), and can ask for revision sessions after it's finished.
ALTER TABLE tasks ADD COLUMN start_date TEXT;
ALTER TABLE tasks ADD COLUMN revise TEXT;
