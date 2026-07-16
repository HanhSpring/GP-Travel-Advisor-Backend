-- =============================================================================
-- Itinerary Tracking (Theo dõi lịch trình) — Migration
-- =============================================================================
-- Mục đích: lưu trạng thái geofence + dwell time của từng địa điểm trong lịch
-- trình khi người dùng "Bắt đầu" theo dõi chuyến đi.
--
-- Cách chạy: mở Supabase Dashboard -> SQL Editor -> dán toàn bộ file này -> Run.
-- Script idempotent: chạy lại nhiều lần không gây lỗi.
-- =============================================================================

create extension if not exists "pgcrypto";

-- 1 dòng = 1 địa điểm cần theo dõi trong 1 ngày (ánh xạ 1-1 với itinerary_details)
create table if not exists travel.itinerary_tracking (
  id                         uuid primary key default gen_random_uuid(),
  itinerary_id               uuid not null
                               references travel.itineraries(id) on delete cascade,
  itinerary_detail_id        uuid
                               references travel.itinerary_details(id) on delete cascade,
  place_id                   uuid not null
                               references travel.places(id) on delete cascade,
  tourist_id                 uuid not null,
  track_date                 date not null,

  -- Trạng thái: pending = "Chưa ghé", visited = "Đã ghé", skipped = "Bỏ qua"
  status                     text not null default 'pending',

  -- Cấu hình geofence + dwell
  geofence_radius_m          integer not null default 100,   -- bán kính 80-150m
  dwell_threshold_seconds    integer not null default 120,   -- ngưỡng lưu lại tối thiểu
  expected_duration_minutes  integer,                         -- thời lượng dự kiến

  -- Dữ liệu thu thập runtime
  entered_at                 timestamptz,   -- timestamp_enter (geofence ENTER)
  exited_at                  timestamptz,   -- geofence EXIT
  dwell_seconds              integer not null default 0,
  enter_count                integer not null default 0,
  checked_in_at              timestamptz,   -- thời điểm thực tế được đánh dấu "Đã ghé"
  last_event_type            text,

  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),

  constraint itinerary_tracking_status_chk
    check (status in ('pending', 'visited', 'skipped')),
  -- mỗi itinerary_detail chỉ có tối đa 1 dòng theo dõi (dùng cho upsert)
  constraint itinerary_tracking_detail_uk unique (itinerary_detail_id)
);

create index if not exists idx_itintrack_itin_date
  on travel.itinerary_tracking (itinerary_id, track_date);

create index if not exists idx_itintrack_tourist
  on travel.itinerary_tracking (tourist_id);

create index if not exists idx_itintrack_place
  on travel.itinerary_tracking (place_id);

-- Yêu cầu PostgREST nạp lại schema cache để API thấy bảng mới ngay lập tức.
notify pgrst, 'reload schema';

-- =============================================================================
-- (Tuỳ chọn) Bật RLS cho môi trường production. Backend dùng service_role key
-- nên bỏ qua RLS; bỏ comment khối dưới nếu cần policy cho client trực tiếp.
-- =============================================================================
-- alter table travel.itinerary_tracking enable row level security;
-- create policy "owner can read own tracking"
--   on travel.itinerary_tracking for select
--   using (auth.uid() = tourist_id);
