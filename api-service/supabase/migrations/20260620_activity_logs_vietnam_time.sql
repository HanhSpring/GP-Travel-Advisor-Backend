-- activity_logs.created_at is intentionally kept as timestamp without time zone.
-- Ensure inserts that omit created_at also use Vietnam wall-clock time.
alter table travel.activity_logs
  alter column created_at
  set default timezone('Asia/Ho_Chi_Minh', now());
