ALTER TABLE travel.activity_logs
  ADD COLUMN IF NOT EXISTS session_id uuid;

COMMENT ON COLUMN travel.activity_logs.session_id IS
  'Do app sinh ra mỗi phiên sử dụng (không phải phiên đăng nhập) — dùng để nhóm interaction theo session cho session-based CF re-ranking. Nullable vì log cũ không có giá trị này.';

-- Bảng hiện KHÔNG có index nào ngoài PK — cần thiết để export training data + due-check
-- không phải quét toàn bộ bảng mỗi lần chạy.
CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at
  ON travel.activity_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_logs_tourist_created_at
  ON travel.activity_logs (tourist_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_activity_logs_place_id
  ON travel.activity_logs (place_id)
  WHERE place_id IS NOT NULL;
