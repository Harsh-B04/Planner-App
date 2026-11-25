-- Private calendar link (/cal/<token>.ics) that Google/Apple/Outlook calendars can subscribe to.
ALTER TABLE user_settings ADD COLUMN cal_token TEXT;
CREATE UNIQUE INDEX idx_cal_token ON user_settings(cal_token);
