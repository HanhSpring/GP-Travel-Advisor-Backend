-- RPC nguyên tử: insert travel.itineraries + travel.itinerary_details trong
-- cùng 1 transaction (1 round-trip từ NestJS) — thay cho 2 insert rời +
-- rollback thủ công trong itinerary.service.ts, vốn để lại itinerary mồ côi
-- nếu client crash/mất mạng đúng lúc giữa 2 bước.
create or replace function travel.create_itinerary_with_details(
  p_itinerary jsonb,
  p_details jsonb
)
returns jsonb
language plpgsql
as $function$
declare
  v_itinerary_id uuid;
  v_total_details integer;
begin
  insert into travel.itineraries (
    creator_id, description, start_date, end_date, estimated_cost, status,
    departure_point, destination, is_public, adult_count, children_count,
    trip_intent, daily_start_time, daily_end_time, travel_mode,
    proceeded_over_budget
  )
  values (
    (p_itinerary->>'creator_id')::uuid,
    p_itinerary->>'description',
    (p_itinerary->>'start_date')::date,
    (p_itinerary->>'end_date')::date,
    (p_itinerary->>'estimated_cost')::numeric,
    coalesce(p_itinerary->>'status', 'pending')::travel.itinerary_status_enum,
    p_itinerary->>'departure_point',
    p_itinerary->>'destination',
    coalesce((p_itinerary->>'is_public')::boolean, false),
    (p_itinerary->>'adult_count')::integer,
    coalesce((p_itinerary->>'children_count')::integer, 0),
    p_itinerary->>'trip_intent',
    coalesce((p_itinerary->>'daily_start_time')::time, '07:00'),
    coalesce((p_itinerary->>'daily_end_time')::time, '22:00'),
    coalesce(p_itinerary->>'travel_mode', 'DRIVING'),
    coalesce((p_itinerary->>'proceeded_over_budget')::boolean, false)
  )
  returning id into v_itinerary_id;

  -- jsonb_to_recordset: bulk insert toàn bộ detail rows (hotel + activities)
  -- trong 1 câu SQL, không lặp round-trip theo từng dòng.
  insert into travel.itinerary_details (
    itinerary_id, place_id, visit_date, arrival_time, duration_minutes,
    estimated_cost, sequence_order, detail_type, is_locked, notes,
    travel_distance_km, travel_minutes, transport_cost
  )
  select
    v_itinerary_id, d.place_id, d.visit_date, d.arrival_time, d.duration_minutes,
    d.estimated_cost, d.sequence_order, d.detail_type,
    coalesce(d.is_locked, false), d.notes, d.travel_distance_km,
    d.travel_minutes, d.transport_cost
  from jsonb_to_recordset(p_details) as d(
    place_id uuid, visit_date date, arrival_time time, duration_minutes integer,
    estimated_cost numeric, sequence_order integer, detail_type varchar,
    is_locked boolean, notes text, travel_distance_km numeric,
    travel_minutes integer, transport_cost numeric
  );

  get diagnostics v_total_details = row_count;

  -- Không có detail nào để lưu → raise exception tự rollback TOÀN BỘ
  -- function (kể cả insert itineraries ở trên), đúng hành vi "rollback thủ
  -- công" cũ nhưng giờ Postgres tự làm, không cần code NestJS gọi DELETE.
  if v_total_details = 0 then
    raise exception 'no_details_to_persist';
  end if;

  return jsonb_build_object('id', v_itinerary_id, 'total_details', v_total_details);
end;
$function$;

grant all on function travel.create_itinerary_with_details(jsonb, jsonb) to service_role;
