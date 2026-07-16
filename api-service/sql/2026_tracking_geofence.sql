-- ============================================================================
-- Migration: Theo dõi lịch trình theo schema `tracking` (geofences + visits)
-- Chạy MỘT LẦN trong Supabase Dashboard -> SQL Editor.
--
-- Tiền đề: đã có sẵn
--   tracking.geofences(id, name, polygon geometry(Polygon,4326), created_at, is_active)
--   tracking.geofence_visits(geofence_id, itinerary_detail_id, status visit_status_enum, recorded_at)
--   enum tracking.visit_status_enum = ('visited','skipped','not_visited')  -- default not_visited
--
-- Migration này BỔ SUNG cột để giữ nguyên logic dwell time + truy vấn theo ngày.
-- ============================================================================

create extension if not exists postgis;

-- 1) geofences: liên kết 1-1 với place + lưu bán kính cho geofence hình tròn ở mobile.
alter table tracking.geofences
  add column if not exists place_id uuid references travel.places(id) on delete cascade,
  add column if not exists radius_m integer not null default 100;

create unique index if not exists uq_geofences_place_id
  on tracking.geofences (place_id);

-- 2) geofence_visits: bổ sung cột dwell/audit + khoá truy vấn theo ngày.
alter table tracking.geofence_visits
  add column if not exists itinerary_id              uuid,
  add column if not exists tourist_id                uuid,
  add column if not exists track_date                date,
  add column if not exists dwell_seconds             integer     not null default 0,
  add column if not exists dwell_threshold_seconds   integer     not null default 120,
  add column if not exists expected_duration_minutes integer,
  add column if not exists entered_at                timestamptz,
  add column if not exists exited_at                 timestamptz,
  add column if not exists enter_count               integer     not null default 0,
  add column if not exists checked_in_at             timestamptz,
  add column if not exists last_event_type           text,
  add column if not exists created_at                timestamptz not null default now(),
  add column if not exists updated_at                timestamptz not null default now();

-- recorded_at có default để insert không cần truyền tay (nếu chưa có default).
alter table tracking.geofence_visits
  alter column recorded_at set default now();

create index if not exists idx_gv_itin_date
  on tracking.geofence_visits (itinerary_id, track_date);

create index if not exists idx_gv_detail
  on tracking.geofence_visits (itinerary_detail_id);

-- 3) Cấp quyền ghi cho các role API dùng (service_role/authenticated/anon).
--    Bảng tracking gốc chỉ có quyền SELECT nên INSERT/UPDATE bị "permission denied".
grant usage on schema tracking to anon, authenticated, service_role;
grant select, insert, update, delete
  on all tables in schema tracking to anon, authenticated, service_role;
grant usage, select
  on all sequences in schema tracking to anon, authenticated, service_role;
alter default privileges in schema tracking
  grant select, insert, update, delete on tables to anon, authenticated, service_role;

-- 4) Buộc PostgREST nạp lại schema cache để API thấy cột mới.
notify pgrst, 'reload schema';
