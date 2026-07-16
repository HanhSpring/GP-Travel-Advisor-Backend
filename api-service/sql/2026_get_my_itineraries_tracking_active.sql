-- =============================================================================
-- Migration: Cập nhật RPC get_my_itineraries → thêm tracking_active
-- =============================================================================
-- QUAN TRỌNG: Trước khi chạy, xem function hiện tại trong Supabase:
--   Dashboard → Database → Functions → travel.get_my_itineraries
-- Rồi thêm dòng 'tracking_active' vào json_build_object của itinerary item.
--
-- Ví dụ dòng cần thêm vào trong json_agg:
--   'tracking_active', coalesce(i.tracking_active, false)
-- =============================================================================

-- Bước 1: Xem function hiện tại (chỉ SELECT, không thay đổi gì)
-- Chạy query này để xem body của function:
--
-- SELECT pg_get_functiondef(p.oid)
-- FROM pg_proc p
-- JOIN pg_namespace n ON n.oid = p.pronamespace
-- WHERE n.nspname = 'travel' AND p.proname = 'get_my_itineraries';

-- Bước 2: Sau khi xem body, copy ra và thêm dòng tracking_active vào,
-- rồi CREATE OR REPLACE FUNCTION với body đã cập nhật.

-- Template nếu function của bạn dùng json_agg:
-- Tìm dòng cuối cùng trong json_build_object của mỗi itinerary item và thêm:
--
--   'tracking_active', coalesce(i.tracking_active, false)
--
-- Ví dụ đầy đủ (chỉ dùng nếu cấu trúc function của bạn giống thế này):
/*
create or replace function travel.get_my_itineraries(p_user_id uuid)
returns json
language sql
security definer
stable
as $$
  select json_build_object(
    'stats', json_build_object(
      'total',     count(*),
      'completed', count(*) filter (where status = 'completed'),
      'upcoming',  count(*) filter (where status in ('upcoming', 'ongoing', 'pending')),
      'draft',     count(*) filter (where status = 'draft')
    ),
    'itineraries', coalesce(
      json_agg(
        json_build_object(
          'id',              i.id,
          'description',     coalesce(i.title, i.description, ''),
          'destination',     i.destination,
          'start_date',      to_char(i.start_date, 'YYYY-MM-DD'),
          'end_date',        to_char(i.end_date,   'YYYY-MM-DD'),
          'status',          i.status,
          'days',            (i.end_date - i.start_date + 1),
          'progress',        coalesce(i.progress, 0),
          'tracking_active', coalesce(i.tracking_active, false)
        )
        order by i.created_at desc
      ),
      '[]'::json
    )
  )
  from travel.itineraries i
  where i.creator_id = p_user_id;
$$;
*/

notify pgrst, 'reload schema';
