-- Thêm filter theo category (travel.categories.name) cho chart Top/Flop 20 địa điểm.
-- travel.places không có category_id trực tiếp, phải đi qua travel.places.type_id -> travel.types.category_id.
-- Đổi điều kiện đếm lượt ghé thăm: dùng gv.status = 'visited' thay vì gv.checked_in_at IS NOT NULL,
-- vì checked_in_at có thể không được set đồng bộ với status khi dữ liệu được cập nhật thủ công.
DROP FUNCTION IF EXISTS public.get_place_popularity_stats(integer, text);

CREATE OR REPLACE FUNCTION public.get_place_popularity_stats(p_limit integer DEFAULT 20, p_mode text DEFAULT 'top'::text, p_category_name text DEFAULT NULL::text)
 RETURNS TABLE(place_id uuid, place_name text, visit_count bigint, completed_count bigint, planning_count bigint, ongoing_count bigint, total_count bigint)
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF p_mode NOT IN ('top', 'flop') THEN
    RAISE EXCEPTION 'p_mode phải là ''top'' hoặc ''flop''';
  END IF;

  IF p_mode = 'top' THEN
    RETURN QUERY
    SELECT
      p.id,
      p.name::TEXT,
      COUNT(DISTINCT gv.tourist_id)::BIGINT                                         AS visit_count,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'completed')::BIGINT   AS completed_count,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'pending')::BIGINT     AS planning_count,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'ongoing')::BIGINT     AS ongoing_count,
      COUNT(gv.itinerary_detail_id)::BIGINT                                         AS total_count
    FROM   tracking.geofence_visits  gv
    JOIN   travel.itinerary_details  id  ON id.id = gv.itinerary_detail_id
    JOIN   travel.places             p   ON p.id  = id.place_id
    JOIN   travel.itineraries        i   ON i.id  = gv.itinerary_id
    WHERE  gv.status       = 'visited'
      AND  gv.tourist_id    IS NOT NULL
      AND  (
        p_category_name IS NULL
        OR p.type_id IN (
          SELECT t.id
          FROM   travel.types t
          JOIN   travel.categories c ON c.id = t.category_id
          WHERE  c.name = p_category_name
        )
      )
    GROUP  BY p.id, p.name
    ORDER  BY COUNT(DISTINCT gv.tourist_id) DESC
    LIMIT  p_limit;

  ELSE
    RETURN QUERY
    SELECT
      p.id,
      p.name::TEXT,
      COUNT(DISTINCT gv.tourist_id)::BIGINT,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'completed')::BIGINT,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'pending')::BIGINT,
      COUNT(gv.itinerary_detail_id) FILTER (WHERE i.status = 'ongoing')::BIGINT,
      COUNT(gv.itinerary_detail_id)::BIGINT
    FROM   tracking.geofence_visits  gv
    JOIN   travel.itinerary_details  id  ON id.id = gv.itinerary_detail_id
    JOIN   travel.places             p   ON p.id  = id.place_id
    JOIN   travel.itineraries        i   ON i.id  = gv.itinerary_id
    WHERE  gv.status       = 'visited'
      AND  gv.tourist_id    IS NOT NULL
      AND  (
        p_category_name IS NULL
        OR p.type_id IN (
          SELECT t.id
          FROM   travel.types t
          JOIN   travel.categories c ON c.id = t.category_id
          WHERE  c.name = p_category_name
        )
      )
    GROUP  BY p.id, p.name
    ORDER  BY COUNT(DISTINCT gv.tourist_id) ASC
    LIMIT  p_limit;
  END IF;
END;
$function$;

GRANT ALL ON FUNCTION public.get_place_popularity_stats(integer, text, text) TO anon;
GRANT ALL ON FUNCTION public.get_place_popularity_stats(integer, text, text) TO authenticated;
GRANT ALL ON FUNCTION public.get_place_popularity_stats(integer, text, text) TO service_role;
