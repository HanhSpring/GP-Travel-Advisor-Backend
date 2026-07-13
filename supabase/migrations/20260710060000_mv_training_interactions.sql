CREATE MATERIALIZED VIEW travel.mv_training_interactions AS
SELECT
  al.tourist_id,
  al.place_id,
  al.session_id,
  al.action_type,
  al.created_at,
  CASE al.action_type
    WHEN 'rating'   THEN 5.0   -- trọng số cơ sở, điều chỉnh thêm bằng rating thật ở review_ai.reviews
    WHEN 'review'   THEN 4.0
    WHEN 'visited'  THEN 3.5
    WHEN 'save'     THEN 2.0
    WHEN 'view'     THEN 1.0
    WHEN 'click'    THEN 0.8
    WHEN 'search'   THEN 0.3
    WHEN 'unsave'   THEN -2.0  -- tín hiệu âm, KHÔNG fallback thành dương
    ELSE 0.0
  END AS implicit_weight,
  'activity_log' AS source
FROM travel.activity_logs al
WHERE al.place_id IS NOT NULL

UNION ALL

SELECT
  r.tourist_id,
  r.place_id,
  NULL::uuid AS session_id,
  'rating' AS action_type,
  r.created_at,
  r.rating::numeric AS implicit_weight,   -- explicit rating thật, ưu tiên cao nhất
  'review' AS source
FROM review_ai.reviews r
WHERE r.status = 'approved'

UNION ALL

SELECT
  gv.tourist_id,
  g.place_id,
  NULL::uuid AS session_id,
  'visited' AS action_type,
  COALESCE(gv.checked_in_at, gv.entered_at) AS created_at,
  4.0 AS implicit_weight,                 -- "đã thật sự đến nơi" — tín hiệu implicit mạnh nhất
  'geofence_visit' AS source
FROM tracking.geofence_visits gv
JOIN tracking.geofences g ON g.id = gv.geofence_id
WHERE gv.status = 'visited';

CREATE UNIQUE INDEX idx_mv_training_interactions_unique
  ON travel.mv_training_interactions (tourist_id, place_id, action_type, created_at, source);

CREATE INDEX idx_mv_training_interactions_created_at
  ON travel.mv_training_interactions (created_at DESC);

COMMENT ON MATERIALIZED VIEW travel.mv_training_interactions IS
  'Nguồn dữ liệu hợp nhất cho export training (Phase 0/1 của tính năng trigger retrain). Refresh off-peak qua pg_cron, KHÔNG query trực tiếp từ export script để tránh tải lên bảng OLTP đang phục vụ user.';

-- Bật extension nếu chưa có (Supabase Pro cho phép bật qua Dashboard > Database > Extensions,
-- hoặc chạy trực tiếp nếu project đã cấp quyền)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Refresh mỗi ngày lúc 3h sáng giờ VN (giờ server Supabase thường là UTC — 3h VN = 20h UTC hôm trước)
SELECT cron.schedule(
  'refresh-mv-training-interactions',
  '0 20 * * *',
  $$ REFRESH MATERIALIZED VIEW CONCURRENTLY travel.mv_training_interactions $$
);

-- Seed 2 row còn thiếu (nếu chưa có sẵn qua ensureAlgorithm() lazily) trong ai_config.algorithms
insert into ai_config.algorithms (name, description, is_active)
values
  ('two_tower_retrieval', 'Two Tower retrieval configuration for POST /recommendation/candidates', true)
on conflict (name) do update set updated_at = current_timestamp;
