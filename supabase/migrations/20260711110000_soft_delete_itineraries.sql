-- Xóa lịch trình 'pending' (chưa từng bắt đầu) → xóa cứng như trước.
-- Xóa lịch trình 'ongoing'/'completed'/'uncompleted' (đã từng bắt đầu) → chỉ ẩn khỏi
-- danh sách của user (is_deleted=true), giữ nguyên dữ liệu tracking/review/lịch sử
-- vì các bảng con (geofence_visits, itinerary_reviews, itinerary_details) tham chiếu
-- itinerary_id với ON DELETE CASCADE — xóa cứng sẽ xóa luôn lịch sử chuyến đi thật.

alter table "travel"."itineraries"
  add column "is_deleted" boolean not null default false;

alter table "travel"."itineraries"
  add column "deleted_at" timestamp with time zone;

-- Tăng tốc truy vấn "lịch trình còn hiển thị của tôi" (get_my_itineraries lọc theo creator_id + is_deleted).
create index "idx_itineraries_creator_active"
  on "travel"."itineraries" ("creator_id")
  where is_deleted = false;

-- RPC nguyên tử: đọc status rồi quyết định hard/soft-delete trong cùng 1 transaction
-- (FOR UPDATE khóa row) để tránh race condition và chỉ tốn 1 round-trip từ backend.
create or replace function travel.delete_itinerary(p_id uuid)
returns jsonb
language plpgsql
as $function$
declare
  v_status travel.itinerary_status_enum;
  v_is_deleted boolean;
  v_mode text;
begin
  select status, is_deleted into v_status, v_is_deleted
  from travel.itineraries
  where id = p_id
  for update;

  if not found or v_is_deleted then
    return jsonb_build_object('found', false);
  end if;

  -- status NULL = lịch trình nháp (draft, chưa hoàn tất tạo) — coi như 'pending', xóa cứng luôn.
  if v_status = 'pending' or v_status is null then
    delete from travel.itineraries where id = p_id;
    v_mode := 'hard';
  else
    update travel.itineraries
    set is_deleted = true, deleted_at = now()
    where id = p_id;
    v_mode := 'soft';
  end if;

  return jsonb_build_object('found', true, 'mode', v_mode);
end;
$function$;

grant all on function travel.delete_itinerary(uuid) to service_role;

-- Loại lịch trình đã xóa mềm khỏi danh sách "Lịch trình của tôi".
create or replace function travel.get_my_itineraries(p_user_id uuid, p_query text default null::text)
 returns json
 language plpgsql
as $function$
declare result JSON;
begin
  with user_itineraries as (
    select *
    from travel.itineraries
    where creator_id = p_user_id
      and is_deleted = false
  ),
  filtered_itineraries as (
    select *
    from user_itineraries
    where
      NULLIF(BTRIM(p_query), '') IS NULL
      OR description ILIKE '%' || BTRIM(p_query) || '%'
  )
  select json_build_object(
    'stats', (
      select json_build_object(
        'total', COUNT(*),
        'completed', COUNT(*) FILTER (WHERE status = 'completed'),
        'upcoming', COUNT(*) FILTER (WHERE status = 'ongoing'),
        'draft', COUNT(*) FILTER (WHERE status IS NULL)
      )
      from user_itineraries
    ),
    'itineraries', COALESCE((
      select json_agg(json_build_object(
        'id', i.id,
        'description', i.description,
        'destination', i.destination,
        'start_date', i.start_date,
        'end_date', i.end_date,
        'status', i.status,
        'days', (i.end_date - i.start_date),
        'estimated_cost', i.estimated_cost,
        'total_locations', metrics.total_locs,
        'visited_locations', metrics.visited_locs,
        'progress', CASE
          WHEN i.status = 'completed' THEN 100
          ELSE COALESCE(
            ROUND(100.0 * metrics.visited_locs / NULLIF(metrics.total_locs, 0))::int,
            0
          )
        END,
        'place_images', ARRAY(
          select p.image_url[1]
          from travel.itinerary_details d
          join travel.places p on p.id = d.place_id
          where d.itinerary_id = i.id
            and array_length(p.image_url, 1) > 0
            and p.slot_type IS DISTINCT FROM 'accommodation'
          order by d.sequence_order
          limit 5
        ),
        'rating', ir.rating
      ))
      from filtered_itineraries i
      cross join lateral (
        select
          COUNT(*) AS total_locs,
          COUNT(DISTINCT gv.itinerary_detail_id) AS visited_locs
        from travel.itinerary_details d
        left join tracking.geofence_visits gv
          on gv.itinerary_detail_id = d.id
          and gv.itinerary_id = i.id
          and gv.status = 'visited'
        where d.itinerary_id = i.id
      ) metrics
      left join lateral (
        select rating
        from review_ai.itinerary_reviews
        where itinerary_id = i.id
          and tourist_id = p_user_id
        limit 1
      ) ir on true
    ), '[]'::json)
  )
  into result;

  return result;
end;
$function$;

grant all on function travel.get_my_itineraries(uuid, text) to service_role;
