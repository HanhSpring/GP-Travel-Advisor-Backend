-- =============================================================================
-- Migration: Thêm cột tracking_active vào travel.itineraries
-- =============================================================================
-- Mục đích: Phân biệt "trip đang diễn ra (status=ongoing)" vs
-- "GPS tracking đang bật trên thiết bị (tracking_active=true)".
--
-- Khi user bấm "Bắt đầu" → tracking_active = true
-- Khi user bấm "Dừng"    → tracking_active = false
-- Khi hết ngày cuối      → tracking_active = false
-- Sang ngày tiếp theo    → tracking_active = true (vẫn đang theo dõi)
-- =============================================================================

alter table travel.itineraries
  add column if not exists tracking_active boolean not null default false;

create index if not exists idx_itineraries_tracking_active
  on travel.itineraries (tracking_active)
  where tracking_active = true;

notify pgrst, 'reload schema';
